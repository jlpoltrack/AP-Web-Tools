// Web Serial transport: a byte stream with blocking reads, which is what the
// bootloader's strict request/response protocol needs.

// USB IDs from ArduPilot's hwdef. 0x1209/0x5740 is the running firmware and 0x5741 the
// bootloader; the rest are per-vendor overrides (Cube, Holybro, ThePeach, 3DR, VRBrain).
export const AP_FILTERS = [
  { usbVendorId: 0x1209, usbProductId: 0x5740 },
  { usbVendorId: 0x1209, usbProductId: 0x5741 },
  { usbVendorId: 0x2dae },  // CubePilot
  { usbVendorId: 0x27ac },  // ProfiCNC / VRBrain
  { usbVendorId: 0x3162 },  // Holybro
  { usbVendorId: 0x35a7 },  // ThePeach
  { usbVendorId: 0x26ac },  // 3DR
  { usbVendorId: 0x16d0 },
];

export class Timeout extends Error {}

export class Serial {
  constructor({ onLog } = {}) {
    this.onLog = onLog || (() => {});
    this.port = null;
    this.reader = null;
    this.writer = null;
    this.buf = new Uint8Array(0);
    this.wake = null;
    this.closing = false;
  }

  get connected() { return !!this.port; }

  get usbId() {
    if (!this.port) return null;
    const i = this.port.getInfo();
    return { vid: i.usbVendorId, pid: i.usbProductId };
  }

  // Asks for a port and opens it. Baud is ignored by USB CDC but must be given.
  async request({ allPorts = false, baudRate = 115200 } = {}) {
    const port = await navigator.serial.requestPort(
      allPorts ? {} : { filters: AP_FILTERS });
    await this.open(port, baudRate);
  }

  async open(port, baudRate = 115200) {
    this.port = port;
    await this.port.open({ baudRate, bufferSize: 65536 });
    // Chrome does not raise DTR/RTS on open; without them a USB CDC device may ignore
    // everything we send, which looks like a working link that never answers.
    try { await this.port.setSignals({ dataTerminalReady: true, requestToSend: true }); }
    catch (e) { this.onLog('Could not set DTR/RTS: ' + e.message); }
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this.buf = new Uint8Array(0);
    this.closing = false;
    this.readLoop();
  }

  async close() {
    this.closing = true;
    try { if (this.reader) await this.reader.cancel(); } catch {}
    try { if (this.reader) this.reader.releaseLock(); } catch {}
    try { if (this.writer) this.writer.releaseLock(); } catch {}
    try { if (this.port) await this.port.close(); } catch {}
    this.port = this.reader = this.writer = null;
    this.buf = new Uint8Array(0);
  }

  async readLoop() {
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        const merged = new Uint8Array(this.buf.length + value.length);
        merged.set(this.buf, 0);
        merged.set(value, this.buf.length);
        this.buf = merged;
        if (this.wake) { const w = this.wake; this.wake = null; w(); }
      }
    } catch (e) {
      if (!this.closing) this.onLog('Serial read error: ' + e.message);
    }
  }

  async write(bytes) {
    if (!this.writer) throw new Error('not connected');
    await this.writer.write(bytes);
  }

  discard() { this.buf = new Uint8Array(0); }

  get available() { return this.buf.length; }

  // The protocol is strictly sequential, so a single waiter is enough.
  async read(n, timeoutMs = 1000) {
    const deadline = performance.now() + timeoutMs;
    while (this.buf.length < n) {
      if (this.closing || !this.port) throw new Error('port closed');
      const left = deadline - performance.now();
      if (left <= 0) throw new Timeout(`timeout waiting for ${n} byte(s)`);
      await new Promise(res => {
        this.wake = res;
        setTimeout(() => { if (this.wake === res) { this.wake = null; res(); } },
                   Math.min(left, 25));
      });
    }
    const out = this.buf.slice(0, n);
    this.buf = this.buf.slice(n);
    return out;
  }
}

export const delay = ms => new Promise(r => setTimeout(r, ms));
