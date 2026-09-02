// SLCAN transport over the Web Serial API.

// USB CDC ignores the line rate; the bitrate is whatever the flight controller's
// CAN port is configured for, so we never send an "S" command.
const CDC_BAUD = 115200;

// USB IDs from ArduPilot's hwdef: 0x1209/0x5740 (dual USB) and 0x5741 are the ChibiOS
// defaults; the rest are per-vendor overrides (Cube, Holybro, ThePeach, 3DR, VRBrain).
const ARDUPILOT_FILTERS = [
  { usbVendorId: 0x1209, usbProductId: 0x5740 },
  { usbVendorId: 0x1209, usbProductId: 0x5741 },
  { usbVendorId: 0x2dae },  // CubePilot
  { usbVendorId: 0x27ac },  // ProfiCNC / VRBrain
  { usbVendorId: 0x3162 },  // Holybro
  { usbVendorId: 0x35a7 },  // ThePeach
  { usbVendorId: 0x26ac },  // 3DR
  { usbVendorId: 0x16d0 },
];

export class SLCAN {
  constructor({ onFrame, onLog, onRaw, onBytes }) {
    this.onFrame = onFrame;
    this.onBytes = onBytes || (() => {});
    this.onLog = onLog || (() => {});
    this.onRaw = onRaw || (() => {});
    this.stats = { bytes: 0, lines: 0, frames: 0 };
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.rxBuf = '';
    this.closing = false;
  }

  get connected() { return !!this.port; }

  // Opens the port only. The FC may still be speaking MAVLink here.
  async connect({ allPorts = false } = {}) {
    this.port = await navigator.serial.requestPort(
      allPorts ? {} : { filters: ARDUPILOT_FILTERS });
    await this.port.open({ baudRate: CDC_BAUD, bufferSize: 65536 });
    // Chrome does not raise DTR/RTS on open; without them a USB CDC device may ignore
    // everything we send, which looks like a working link that never answers.
    try { await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); }
    catch (e) { this.onLog('Could not set DTR/RTS: ' + e.message); }
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.closing = false;
    this.readLoop();
  }

  // Resets the adapter into a known state and opens the CAN channel.
  async beginSlcan() {
    await this.writeRaw('\r\r\r');
    await this.delay(100);
    await this.writeRaw('C\r');
    await this.delay(50);
    await this.writeRaw('O\r');
    await this.delay(50);
    // ArduPilot answers 'V' with "V1010"; a reply proves SLCAN is routed to this port.
    await this.writeRaw('V\r');
    this.onLog('SLCAN channel open, probing adapter…');
  }

  delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  async disconnect() {
    this.closing = true;
    try { if (this.writer) await this.writeRaw('C\r'); } catch {}
    try { if (this.reader) await this.reader.cancel(); } catch {}
    try { if (this.reader) this.reader.releaseLock(); } catch {}
    try { if (this.writer) this.writer.releaseLock(); } catch {}
    try { if (this.port) await this.port.close(); } catch {}
    this.port = this.reader = this.writer = null;
  }

  async writeRaw(str) {
    if (!this.writer) throw new Error('not connected');
    await this.writer.write(new TextEncoder().encode(str));
  }

  async writeBytes(bytes) {
    if (!this.writer) throw new Error('not connected');
    await this.writer.write(bytes);
  }

  frameLine(id, data) {
    const hexId = (id >>> 0).toString(16).toUpperCase().padStart(8, '0');
    let s = 'T' + hexId + data.length;
    for (const b of data) s += b.toString(16).toUpperCase().padStart(2, '0');
    return s + '\r';
  }

  async sendFrame(id, data) {
    await this.writeRaw(this.frameLine(id, data));
  }

  // One write per transfer: 38 separate ~25-byte writes each cost a USB frame interval,
  // which capped throughput at roughly 7 KB/s regardless of CAN bus speed.
  async sendFrames(frames) {
    let s = '';
    for (const f of frames) s += this.frameLine(f.id, f.data);
    await this.writeRaw(s);
  }

  async readLoop() {
    const dec = new TextDecoder();
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.stats.bytes += value.length;
        this.onBytes(value);
        this.sniff(value);
        this.rxBuf += dec.decode(value, { stream: true });
        let i;
        while ((i = this.rxBuf.indexOf('\r')) >= 0) {
          const line = this.rxBuf.slice(0, i);
          this.rxBuf = this.rxBuf.slice(i + 1);
          if (line) this.handleLine(line);
        }
        if (this.rxBuf.length > 4096) this.rxBuf = '';
      }
    } catch (e) {
      if (!this.closing) this.onLog('Serial read error: ' + e.message);
    }
  }

  // SLCAN is pure ASCII; a stream full of binary means we are on the wrong port.
  sniff(bytes) {
    if (this.binaryWarned || this.expectBinary) return;
    let binary = 0;
    for (const b of bytes) if (b < 9 || (b > 13 && b < 32) || b > 126) binary++;
    this.binaryBytes = (this.binaryBytes || 0) + binary;
    if (this.binaryBytes > 64) {
      this.binaryWarned = true;
      const mav = bytes.includes(0xfd) || bytes.includes(0xfe);
      this.onLog(mav
        ? 'This port is streaming MAVLink, not SLCAN. Enable SLCAN on it (CAN_SLCAN_SERNUM) or pick the SLCAN port.'
        : 'This port is streaming binary data, not SLCAN. Wrong port, or SLCAN is not enabled on it.');
    }
  }

  handleLine(line) {
    this.stats.lines++;
    this.onRaw(line);
    const kind = line[0];
    let idLen;
    if (kind === 'T') idLen = 8;
    else if (kind === 't') idLen = 3;
    else return; // ignore acks, 'R'/'r' remote frames, version strings
    if (line.length < 1 + idLen + 1) return;
    const id = parseInt(line.substr(1, idLen), 16);
    const dlc = parseInt(line.substr(1 + idLen, 1), 16);
    if (!Number.isFinite(id) || !Number.isFinite(dlc)) return;
    const hex = line.substr(2 + idLen, dlc * 2);
    if (hex.length < dlc * 2) return;
    const data = new Uint8Array(dlc);
    for (let i = 0; i < dlc; i++) data[i] = parseInt(hex.substr(i * 2, 2), 16);
    this.stats.frames++;
    this.onFrame(id >>> 0, data, kind === 'T');
  }
}
