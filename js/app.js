import { SLCAN } from './slcan.js';
import * as mav from './mavlink.js';
import { DTID, SVC, SIG, messageId, serviceId, parseId, packTransfer, transferCrc, Reassembler } from './dronecan.js';

const READ_CHUNK = 256;
const MODE_NAMES = ['OPERATIONAL', 'INIT', 'MAINTENANCE', 'SOFTWARE_UPDATE', '4', '5', '6', 'OFFLINE'];
const HEALTH_NAMES = ['OK', 'WARNING', 'ERROR', 'CRITICAL'];

const $ = id => document.getElementById(id);

const state = {
  slcan: null,
  reasm: new Reassembler(),
  nodes: new Map(),          // nodeId -> info
  ourNodeId: 127,          // above the DNA range (ArduPilot allocates 125 downwards)
  transferIds: new Map(),    // key -> counter
  firmware: null,            // { name, bytes }
  update: null,              // { target, served, lastActivity, done }
  pendingBfu: null,          // resolver for BeginFirmwareUpdate response
  startTime: Date.now(),
  timers: [],
};

function log(msg) {
  const el = $('log');
  const t = new Date().toLocaleTimeString();
  el.textContent += `[${t}] ${msg}\n`;
  el.scrollTop = el.scrollHeight;
}

// Raw SLCAN line view: distinguishes "no data at all" from "data we failed to parse".
function onRawLine(line) {
  if (/^V[0-9a-fA-F]{4}$/.test(line)) {
    state.slcanProbeSeen = true;
    log(`Adapter version reply ${line} — SLCAN is routed to this port.`);
  }
}

// Watches the link and explains a silent port once, rather than leaving it blank.
function checkLink() {
  const s = state.slcan?.stats;
  if (!s) return;
  if (s.bytes === 0 && !state.warnedNoData && Date.now() - state.startTime > 5000) {
    state.warnedNoData = true;
    log('No bytes received. Check CAN_SLCAN_CPORT (1 or 2) and CAN_SLCAN_SERNUM (the ' +
        'serial port index, or set SERIALn_PROTOCOL=22), and note SLCAN is disabled while armed.');
  } else if (s.bytes > 0 && s.frames === 0 && !state.warnedNoFrames && Date.now() - state.startTime > 8000) {
    state.warnedNoFrames = true;
    log('Serial data is arriving but no CAN frames — the port is talking, but nothing is ' +
        'being routed from the CAN bus. Check CAN_SLCAN_CPORT and that CAN_P1_DRIVER is set.');
  }
}

function nextTransferId(key) {
  const n = ((state.transferIds.get(key) || 0) + 1) & 0x1f;
  state.transferIds.set(key, n);
  return n;
}

async function sendTransfer(canId, payload, transferId, signature) {
  for (const f of packTransfer(canId, payload, transferId, signature)) {
    await state.slcan.sendFrame(f.id, f.data);
  }
}

// ---------- outgoing messages ----------

async function broadcastNodeStatus() {
  if (!state.slcan?.connected) return;
  const uptime = Math.floor((Date.now() - state.startTime) / 1000);
  const p = new Uint8Array(7);
  new DataView(p.buffer).setUint32(0, uptime, true);
  p[4] = 0; // health OK, mode OPERATIONAL, sub_mode 0
  const id = messageId(20, DTID.NODE_STATUS, state.ourNodeId);
  await sendTransfer(id, p, nextTransferId('ns'), SIG.NODE_STATUS);
}

async function requestNodeInfo(nodeId) {
  const id = serviceId(20, SVC.GET_NODE_INFO, true, nodeId, state.ourNodeId);
  await sendTransfer(id, new Uint8Array(0), nextTransferId('gni' + nodeId), SIG.GET_NODE_INFO);
}

async function beginFirmwareUpdate(nodeId, path) {
  const pathBytes = new TextEncoder().encode(path);
  const p = new Uint8Array(1 + pathBytes.length);
  p[0] = state.ourNodeId;
  p.set(pathBytes, 1);
  const id = serviceId(20, SVC.BEGIN_FIRMWARE_UPDATE, true, nodeId, state.ourNodeId);
  await sendTransfer(id, p, nextTransferId('bfu' + nodeId), SIG.BEGIN_FIRMWARE_UPDATE);
}

async function sendReadResponse(destNode, transferId, errorCode, chunk) {
  const p = new Uint8Array(2 + chunk.length);
  p[0] = errorCode & 0xff;
  p[1] = (errorCode >> 8) & 0xff;
  p.set(chunk, 2);
  const id = serviceId(20, SVC.FILE_READ, false, destNode, state.ourNodeId);
  await sendTransfer(id, p, transferId, SIG.FILE_READ);
}

// ---------- incoming ----------

function onFrame(id, data, extended) {
  if (!extended) return;
  const res = state.reasm.push(id, data);
  if (!res) return;
  const h = parseId(id);
  if (h.service) {
    if (h.dest !== state.ourNodeId) return;
    const tid = data[data.length - 1] & 0x1f;
    if (h.serviceTypeId === SVC.FILE_READ && h.request) handleReadRequest(h, res.payload, tid);
    else if (h.serviceTypeId === SVC.BEGIN_FIRMWARE_UPDATE && !h.request) handleBfuResponse(h, res.payload);
    else if (h.serviceTypeId === SVC.GET_NODE_INFO && !h.request) handleNodeInfo(h, res);
  } else if (h.dtid === DTID.NODE_STATUS) {
    handleNodeStatus(h, res.payload);
  }
}

function handleNodeStatus(h, p) {
  if (p.length < 7 || h.src === 0) return;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  let n = state.nodes.get(h.src);
  if (!n) {
    n = { id: h.src, name: '', hw: '', sw: '', uid: '' , infoTries: 0 };
    state.nodes.set(h.src, n);
    log(`Node ${h.src} discovered`);
  }
  n.uptime = dv.getUint32(0, true);
  n.health = (p[4] >> 6) & 0x3;
  n.mode = (p[4] >> 3) & 0x7;
  n.lastSeen = Date.now();
  renderNodes();
}

function handleNodeInfo(h, res) {
  const p = res.payload;
  if (p.length < 41) return;
  if (!res.singleFrame && res.crc !== transferCrc(SIG.GET_NODE_INFO, p)) {
    log(`Node ${h.src}: GetNodeInfo CRC mismatch`);
    return;
  }
  const n = state.nodes.get(h.src);
  if (!n) return;
  const swMaj = p[7], swMin = p[8];
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const vcs = dv.getUint32(10, true);
  const hwMaj = p[22], hwMin = p[23];
  const uid = Array.from(p.subarray(24, 40)).map(b => b.toString(16).padStart(2, '0')).join('');
  const certLen = p[40];
  const name = new TextDecoder().decode(p.subarray(41 + certLen));
  n.name = name;
  n.sw = `${swMaj}.${swMin}` + (vcs ? ` (${vcs.toString(16)})` : '');
  n.hw = `${hwMaj}.${hwMin}`;
  n.uid = uid;
  log(`Node ${h.src}: ${name} hw ${n.hw} sw ${n.sw}`);
  renderNodes();
}

function handleBfuResponse(h, p) {
  if (state.pendingBfu) {
    state.pendingBfu({ error: p[0], message: new TextDecoder().decode(p.subarray(1)) });
    state.pendingBfu = null;
  }
}

async function handleReadRequest(h, p, transferId) {
  const u = state.update;
  if (!u || !state.firmware) {
    await sendReadResponse(h.src, transferId, 2 /* NOT_FOUND */, new Uint8Array(0));
    return;
  }
  if (p.length < 5) return;
  const offset = p[0] + p[1] * 256 + p[2] * 65536 + p[3] * 16777216 + p[4] * 4294967296;
  const bytes = state.firmware.bytes;
  const chunk = bytes.subarray(Math.min(offset, bytes.length), Math.min(offset + READ_CHUNK, bytes.length));
  await sendReadResponse(h.src, transferId, 0, chunk);

  u.served = Math.max(u.served, Math.min(offset + chunk.length, bytes.length));
  u.lastActivity = Date.now();
  if (!u.started) { u.started = true; log(`Node ${h.src} started reading firmware`); }
  renderProgress();
  if (chunk.length < READ_CHUNK && !u.done) {
    u.done = true;
    log(`Firmware transfer complete (${bytes.length} bytes). Node is verifying and rebooting.`);
    $('status').textContent = 'Transfer complete — node rebooting';
  }
}

// ---------- MAVLink: put the FC's serial port into SLCAN mode ----------

// SERIAL0 is the USB port we are connected on; Mission Planner blind-sets the same value.
const SLCAN_SERIAL_NUM = 0;
const CAN_PORT = 1;

function onMavBytes(chunk) {
  if (!state.mav) return;
  for (const m of state.mav.parser.push(chunk)) {
    if (m.msgid === mav.MSG.HEARTBEAT && !state.mav.target) {
      state.mav.target = { sysid: m.sysid, compid: m.compid };
      log(`MAVLink heartbeat from system ${m.sysid}/${m.compid}`);
    } else if (m.msgid === mav.MSG.PARAM_VALUE) {
      const pv = mav.decodeParamValue(m.payload);
      state.mav.params.set(pv.id, pv.value);
      log(`  PARAM_VALUE ${pv.id} = ${pv.value}`);
    } else if (m.msgid === mav.MSG.STATUSTEXT) {
      log(`  FC says: ${mav.decodeStatustext(m.payload)}`);
    }
  }
}

const wait = ms => new Promise(r => setTimeout(r, ms));

async function mavSend(frame) { await state.slcan.writeBytes(frame); }

async function readParam(name, timeout = 2000) {
  const t = state.mav.target;
  state.mav.params.delete(name);
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await mavSend(mav.paramRequestRead(name, t, state.mav.seq++));
    for (let i = 0; i < 10; i++) {
      await wait(50);
      if (state.mav.params.has(name)) return state.mav.params.get(name);
    }
  }
  return null;
}

async function setParam(name, value) {
  await mavSend(mav.paramSet(name, value, state.mav.target, state.mav.seq++));
  await wait(150);
}

// Returns true once the port has been handed over to SLCAN.
async function switchToSlcan() {
  state.mav = { parser: new mav.MavParser(), target: null, params: new Map(), seq: 0 };
  state.slcan.expectBinary = true;
  state.slcanProbeSeen = false;

  // Ask for a version first: if the port is already SLCAN, sitting silent here would let
  // CAN_SLCAN_TIMOUT expire and drop it back to MAVLink.
  await state.slcan.writeRaw('\rV\r');
  for (let i = 0; i < 8 && !state.slcanProbeSeen && !state.mav.target; i++) await wait(100);
  if (state.slcanProbeSeen) {
    state.mav = null;
    state.slcan.expectBinary = false;
    return false;
  }

  log('Listening for MAVLink…');
  for (let i = 0; i < 25 && !state.mav.target; i++) await wait(100);
  if (!state.mav.target) {
    state.slcan.expectBinary = false;
    log('No MAVLink heartbeat — assuming the port is already in SLCAN mode.');
    return false;
  }

  const cport = await readParam('CAN_SLCAN_CPORT');
  log(`CAN_SLCAN_CPORT is currently ${cport === null ? 'unknown' : cport}`);
  await setParam('CAN_SLCAN_CPORT', CAN_PORT);
  await setParam(`CAN_P${CAN_PORT}_DRIVER`, 1);
  await setParam('CAN_SLCAN_TIMOUT', 2);

  if (cport === 0) {
    // The CAN interface was not routed at boot, so the change only takes effect after a reboot.
    state.mav.needsReboot = true;
    $('reboot').hidden = false;
    log('CAN_SLCAN_CPORT was 0. A reboot is required before SLCAN can start — press "Reboot FC".');
    return false;
  }

  // Blind send: the port flips to SLCAN immediately, so there is no ack to wait for.
  log(`Setting CAN_SLCAN_SERNUM=${SLCAN_SERIAL_NUM} (SLCAN takes over this port)`);
  const f = mav.paramSet('CAN_SLCAN_SERNUM', SLCAN_SERIAL_NUM, state.mav.target, state.mav.seq++);
  await mavSend(f);
  await mavSend(f);
  await wait(1500); // CAN_SLCAN_SDELAY defaults to 1 second
  state.mav = null;
  state.slcan.expectBinary = false;
  return true;
}

async function rebootFc() {
  if (!state.mav?.target) return log('No MAVLink connection to reboot.');
  log('Rebooting flight controller…');
  await mavSend(mav.reboot(state.mav.target, state.mav.seq++));
  $('reboot').hidden = true;
  log('The USB port will re-enumerate — press Connect again once it reappears.');
}

// ---------- UI ----------

function renderNodes() {
  const tbody = $('nodes');
  const sel = state.selectedNode;
  tbody.innerHTML = '';
  for (const n of [...state.nodes.values()].sort((a, b) => a.id - b.id)) {
    const tr = document.createElement('tr');
    tr.className = (sel === n.id ? 'sel' : '') + (Date.now() - n.lastSeen > 4000 ? ' stale' : '');
    tr.innerHTML = `<td>${n.id}</td><td>${n.name || '—'}</td><td>${n.hw || '—'}</td>` +
      `<td>${n.sw || '—'}</td><td>${MODE_NAMES[n.mode] || '?'}</td><td>${HEALTH_NAMES[n.health] || '?'}</td>`;
    tr.onclick = () => { state.selectedNode = n.id; renderNodes(); updateButtons(); };
    tbody.appendChild(tr);
  }
  if (!state.nodes.size) tbody.innerHTML = '<tr><td colspan="6" class="empty">No nodes seen yet…</td></tr>';
}

function renderProgress() {
  const u = state.update;
  if (!u || !state.firmware) return;
  const pct = Math.round(100 * u.served / state.firmware.bytes.length);
  $('bar').style.width = pct + '%';
  $('pct').textContent = `${pct}% (${u.served} / ${state.firmware.bytes.length} bytes)`;
}

function updateButtons() {
  $('flash').disabled = !(state.slcan?.connected && state.selectedNode != null && state.firmware && !state.update);
}

async function connect() {
  const slcan = new SLCAN({ onFrame, onLog: log, onRaw: onRawLine, onBytes: onMavBytes });
  try {
    await slcan.connect({ allPorts: state.showAllPorts });
    state.showAllPorts = false;
    state.slcan = slcan;
    await switchToSlcan();
    if (!state.mav?.needsReboot) await slcan.beginSlcan();
  } catch (e) {
    if (e.name === 'NotFoundError' && !state.showAllPorts) {
      // Either the dialog was cancelled or the board is not in the ArduPilot USB ID list.
      state.showAllPorts = true;
      log('No ArduPilot port selected. Press Connect again to list every serial port.');
    } else {
      log('Connect failed: ' + e.message);
    }
    try { await slcan.disconnect(); } catch {}
    state.slcan = null;
    return;
  }
  state.startTime = Date.now();
  state.warnedNoData = state.warnedNoFrames = false;
  $('connect').textContent = 'Disconnect';
  state.timers.push(setInterval(() => broadcastNodeStatus().catch(() => {}), 1000));
  state.timers.push(setInterval(pollNodeInfo, 1000));
  state.timers.push(setInterval(renderNodes, 2000));
  state.timers.push(setInterval(checkLink, 1000));
  updateButtons();
}

async function pollNodeInfo() {
  for (const n of state.nodes.values()) {
    if (!n.name && n.infoTries < 20 && Date.now() - (n.lastInfoReq || 0) > 2000) {
      n.lastInfoReq = Date.now();
      n.infoTries++;
      try { await requestNodeInfo(n.id); } catch {}
    }
  }
}

async function disconnect() {
  state.timers.forEach(clearInterval);
  state.timers = [];
  if (state.slcan) await state.slcan.disconnect();
  state.slcan = null;
  state.nodes.clear();
  state.update = null;
  renderNodes();
  $('connect').textContent = 'Connect';
  updateButtons();
}

async function flash() {
  const target = state.selectedNode;
  const fw = state.firmware;
  const path = fw.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(-60);
  state.update = { target, served: 0, lastActivity: Date.now(), started: false, done: false };
  updateButtons();
  $('status').textContent = 'Requesting firmware update…';
  $('bar').style.width = '0%';
  log(`BeginFirmwareUpdate -> node ${target}, path "${path}"`);

  const answer = await new Promise(resolve => {
    const t = setTimeout(() => { state.pendingBfu = null; resolve(null); }, 3000);
    state.pendingBfu = v => { clearTimeout(t); resolve(v); };
    beginFirmwareUpdate(target, path).catch(e => log('Send failed: ' + e.message));
  });

  if (answer && answer.error !== 0 && answer.error !== 2) {
    log(`Node refused update: error ${answer.error} ${answer.message}`);
    $('status').textContent = 'Node refused the update';
    state.update = null;
    updateButtons();
    return;
  }
  if (!answer) log('No BeginFirmwareUpdate response (node may have rebooted straight into the bootloader) — waiting for file reads…');
  $('status').textContent = 'Waiting for the node to request the firmware…';

  // Watchdog: warn if the bootloader never starts reading.
  const wd = setInterval(() => {
    const u = state.update;
    if (!u) return clearInterval(wd);
    if (u.done && Date.now() - u.lastActivity > 5000) { clearInterval(wd); state.update = null; updateButtons(); return; }
    if (!u.started && Date.now() - u.lastActivity > 20000) {
      clearInterval(wd);
      log('Timed out waiting for the node to request the firmware.');
      $('status').textContent = 'Timed out';
      state.update = null;
      updateButtons();
    }
  }, 1000);
}

// ---------- wiring ----------

window.addEventListener('DOMContentLoaded', () => {
  if (!('serial' in navigator)) {
    $('status').textContent = 'No Web Serial API in this browser — use a Chromium browser or Firefox 151+, over HTTPS or localhost.';
    $('connect').disabled = true;
  }
  $('connect').onclick = () => (state.slcan?.connected ? disconnect() : connect());
  $('file').onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    state.firmware = { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) };
    $('fwinfo').textContent = `${f.name} — ${state.firmware.bytes.length} bytes`;
    updateButtons();
  };
  $('reboot').onclick = () => rebootFc().catch(e => log('Reboot failed: ' + e.message));
  $('flash').onclick = () => flash().catch(e => log('Update failed: ' + e.message));
  renderNodes();
  updateButtons();
});
