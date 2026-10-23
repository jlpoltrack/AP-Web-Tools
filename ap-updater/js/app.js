import { Serial, delay } from './serial.js';
import { Bootloader } from './bootloader.js';
import { parseApj } from './apj.js';
import { boardLabel } from './boards.js';
import { MavParser, MSG, rebootToBootloader, NSH_REBOOT_BL } from './mavlink.js';

const $ = id => document.getElementById(id);

const ui = {
  status: $('status'),
  file: $('file'),
  fwinfo: $('fwinfo'),
  reboot: $('reboot'),
  connect: $('connect'),
  disconnect: $('disconnect'),
  board: $('board'),
  flash: $('flash'),
  bar: $('bar'),
  pct: $('pct'),
  log: $('log'),
};

const serial = new Serial({ onLog: log });
let bl = null;
let fw = null;
let busy = false;

function log(msg) {
  const t = new Date().toTimeString().slice(0, 8);
  ui.log.textContent += `[${t}] ${msg}\n`;
  ui.log.scrollTop = ui.log.scrollHeight;
}

function status(s) { ui.status.textContent = s; }

function progress(done, total) {
  const pct = total ? (done / total) * 100 : 0;
  ui.bar.style.width = pct.toFixed(1) + '%';
  ui.pct.textContent = total
    ? `${pct.toFixed(1)}% — ${done.toLocaleString()} / ${total.toLocaleString()} bytes`
    : '0%';
}

function refresh() {
  const ready = !!fw && !!bl?.info && !busy;
  ui.flash.disabled = !ready;
  ui.connect.disabled = busy;
  ui.reboot.disabled = busy;
  ui.disconnect.hidden = !serial.connected;
}

async function guard(what, fn) {
  if (busy) return;
  busy = true;
  refresh();
  try {
    await fn();
  } catch (e) {
    log(`${what} failed: ${e.message}`);
    status(`${what} failed`);
  } finally {
    busy = false;
    refresh();
  }
}

// --- firmware file ---------------------------------------------------------

ui.file.addEventListener('change', async () => {
  const f = ui.file.files[0];
  if (!f) return;
  fw = null;
  try {
    fw = await parseApj(f);
  } catch (e) {
    ui.fwinfo.textContent = e.message;
    log('Could not read firmware: ' + e.message);
    refresh();
    return;
  }
  const kb = (fw.image.length / 1024).toFixed(0);
  const extf = fw.extfImage ? `, ext flash ${(fw.extfImage.length / 1024).toFixed(0)} KB` : '';
  ui.fwinfo.textContent =
    `${fw.name} — ${fw.summary || 'unnamed board'}, board ID ${fw.boardId}, ${kb} KB${extf}` +
    (fw.gitIdentity ? `, git ${fw.gitIdentity}` : '');
  log(`Loaded ${fw.name}: ${boardLabel(fw.boardId)}, ${fw.image.length} bytes`);
  refresh();
});

// --- reboot a running FC into its bootloader --------------------------------

ui.reboot.addEventListener('click', () => guard('Reboot', async () => {
  if (serial.connected) await serial.close();
  status('Select the flight controller port…');
  await serial.request();
  const { vid, pid } = serial.usbId;
  log(`Opened ${hex(vid)}:${hex(pid)}, listening for MAVLink…`);

  // A heartbeat gives us the real target IDs; without one we fall back to the
  // 1/1 and 0/0 pairs uploader.py uses blind.
  const target = await sniffHeartbeat(1500);
  if (target) log(`Heartbeat from system ${target.sysid} component ${target.compid}`);
  else log('No heartbeat seen; sending reboot to the default target IDs anyway.');

  // Component 0 is MAV_COMP_ID_ALL; uploader.py sends these same two blind pairs.
  const targets = target ? [target] : [{ sysid: 1, compid: 0 }, { sysid: 0, compid: 0 }];
  let seq = 0;
  for (const t of targets) await serial.write(rebootToBootloader(t, seq++));
  await serial.write(NSH_REBOOT_BL);
  await delay(300);
  await serial.close();

  log('Reboot commanded. The board re-enumerates as a different USB device, so '
    + 'press "Connect to bootloader" and pick the port that appeared.');
  status('Rebooted — now connect to the bootloader');
}));

async function sniffHeartbeat(ms) {
  const parser = new MavParser();
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (!serial.available) { await delay(50); continue; }
    const chunk = await serial.read(serial.available, 100).catch(() => null);
    if (!chunk) continue;
    for (const m of parser.push(chunk)) {
      if (m.msgid === MSG.HEARTBEAT && m.sysid !== 0) return { sysid: m.sysid, compid: m.compid };
    }
  }
  return null;
}

// --- connect to the bootloader ----------------------------------------------

ui.connect.addEventListener('click', () => guard('Connect', async () => {
  if (serial.connected) await serial.close();
  bl = null;
  ui.board.textContent = '';

  // Ports already granted to this origin can be opened without a picker, so a
  // board that has been flashed before needs no extra click.
  status('Looking for a bootloader…');
  if (!await tryKnownPorts()) {
    status('Select the bootloader port…');
    await serial.request();
    bl = new Bootloader(serial, { onLog: log });
    if (!await syncWithRetries(8000)) {
      await serial.close();
      bl = null;
      throw new Error('no response from a bootloader on that port. Is the board in '
        + 'bootloader mode? Try "Reboot board to bootloader" first, or replug it.');
    }
  }

  const info = await bl.identify();
  ui.board.textContent =
    `${boardLabel(info.boardId)}, rev ${info.boardRev}, ` +
    `${(info.flashSize / 1024).toFixed(0)} KB flash` +
    (info.extfSize ? `, ${(info.extfSize / 1024).toFixed(0)} KB ext flash` : '') +
    ` — bootloader rev ${info.blRev}` +
    (info.chipDesc ? ` on ${info.chipDesc}` : '');
  log('Bootloader: ' + ui.board.textContent);
  if (info.blGitHash) log(`Bootloader build: ${info.blGitHash}`);
  status('Bootloader ready');
}));

async function tryKnownPorts() {
  for (const port of await navigator.serial.getPorts()) {
    try {
      await serial.open(port);
    } catch { continue; }
    const probe = new Bootloader(serial, { onLog: log });
    if (await probe.trySync(400)) {
      const { vid, pid } = serial.usbId;
      log(`Found a bootloader on an already-permitted port ${hex(vid)}:${hex(pid)}.`);
      bl = probe;
      return true;
    }
    await serial.close();
  }
  return false;
}

async function syncWithRetries(ms) {
  const deadline = performance.now() + ms;
  while (performance.now() < deadline) {
    if (await bl.trySync(400)) return true;
  }
  return false;
}

ui.disconnect.addEventListener('click', () => guard('Disconnect', async () => {
  await serial.close();
  bl = null;
  ui.board.textContent = '';
  status('Disconnected');
}));

// --- flash -------------------------------------------------------------------

ui.flash.addEventListener('click', () => guard('Flash', async () => {
  bl.checkCompatible(fw);

  status('Erasing…');
  progress(0, 0);
  ui.pct.textContent = 'Erasing flash — this takes up to 30 seconds.';
  let lastTick = -1;
  await bl.erase({ onTick: s => {
    const whole = Math.floor(s);
    if (whole !== lastTick) { lastTick = whole; ui.bar.style.width = Math.min(whole * 10, 95) + '%'; }
  } });
  log('Flash erased.');

  status('Programming…');
  const t0 = performance.now();
  await bl.program(fw.image, { onProgress: progress });
  const secs = (performance.now() - t0) / 1000;
  log(`Programmed ${fw.image.length} bytes in ${secs.toFixed(1)} s ` +
      `(${(fw.image.length / 1024 / secs).toFixed(1)} KB/s).`);

  status('Verifying…');
  ui.pct.textContent = 'Verifying CRC…';
  await bl.verify(fw);
  log('CRC verified.');

  if (fw.extfImage) {
    status('External flash…');
    log(`Erasing ${fw.extfImage.length} bytes of external flash…`);
    await bl.eraseExtf(fw.extfImage.length);
    await bl.program(fw.extfImage, { extf: true, onProgress: progress });
    await bl.verifyExtf(fw);
    log('External flash written and verified.');
  }

  status('Rebooting…');
  await bl.reboot();
  await serial.close();
  bl = null;
  ui.board.textContent = '';
  progress(1, 1);
  ui.pct.textContent = 'Done.';
  log('Board rebooted into the new firmware.');
  status('Flash complete');
}));

// --- startup -----------------------------------------------------------------

const hex = n => '0x' + (n ?? 0).toString(16).padStart(4, '0');

if (!('serial' in navigator)) {
  status('Web Serial is not available in this browser');
  log('This page needs the Web Serial API over a secure context: a Chromium desktop '
    + 'browser (Chrome, Edge, Brave, Opera, Arc) or Firefox 151+ with the Web Serial '
    + 'add-on. Safari and mobile browsers do not support it.');
  for (const b of [ui.connect, ui.reboot, ui.flash]) b.disabled = true;
} else {
  status('Ready');
  refresh();
}
