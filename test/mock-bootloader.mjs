// In-memory stand-in for the PX4 bootloader, speaking the same byte protocol.
const INSYNC = 0x12, EOC = 0x20, OK = 0x10, INVALID = 0x13;

export class MockSerial {
  constructor(opts = {}) {
    this.o = Object.assign({
      blRev: 5, boardId: 140, boardRev: 0, flashSize: 1966080, extfSize: 0,
      erasePolls: 3, chipDes: 'STM32H743xx,evt', software: 'abcdef01',
    }, opts);
    this.flash = new Uint8Array(this.o.flashSize).fill(0xff);
    this.extf = new Uint8Array(this.o.extfSize).fill(0xff);
    this.addr = 0; this.extfAddr = 0;
    this.rx = []; this.cmd = []; this.erasing = 0; this.rebooted = false;
    this.progCalls = 0;
  }
  get available() { return this.rx.length; }
  discard() { this.rx = []; }
  async read(n, timeoutMs = 1000) {
    if (this.erasing > 0) { this.erasing--; if (this.erasing === 0) this.push([INSYNC, OK]); }
    if (this.rx.length < n) { const { Timeout } = await import('../js/serial.js'); throw new Timeout('mock timeout'); }
    return new Uint8Array(this.rx.splice(0, n));
  }
  push(bytes) { for (const b of bytes) this.rx.push(b); }
  pushU32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); this.push(b); }
  pushStr(s) { const b = new TextEncoder().encode(s); this.pushU32(b.length); this.push(b); }
  async write(bytes) { for (const b of bytes) this.cmd.push(b); this.drain(); }

  drain() {
    while (this.cmd.length) {
      const c = this.cmd[0];
      const need = { 0x21: 2, 0x22: 3, 0x23: 2, 0x29: 2, 0x2e: 2, 0x2f: 2, 0x30: 2, 0x34: 6, 0x37: 6, 0x40: 2 }[c];
      if (c === 0x27 || c === 0x35) {           // PROG_MULTI / EXTF_PROG_MULTI
        if (this.cmd.length < 2) return;
        const len = this.cmd[1];
        if (this.cmd.length < len + 3) return;
        const data = this.cmd.splice(0, len + 3).slice(2, 2 + len);
        this.progCalls++;
        if (c === 0x27) { this.flash.set(data, this.addr); this.addr += len; }
        else { this.extf.set(data, this.extfAddr); this.extfAddr += len; }
        this.push([INSYNC, OK]);
        continue;
      }
      if (need === undefined) { this.cmd.shift(); continue; }
      if (this.cmd.length < need) return;
      const frame = this.cmd.splice(0, need);
      if (frame[frame.length - 1] !== EOC) { this.push([INSYNC, INVALID]); continue; }
      this.handle(frame);
    }
  }

  handle(f) {
    switch (f[0]) {
      case 0x21: this.push([INSYNC, OK]); break;
      case 0x22: {
        const map = { 1: this.o.blRev, 2: this.o.boardId, 3: this.o.boardRev, 4: this.o.flashSize, 6: this.o.extfSize };
        if (!(f[1] in map)) { this.push([INSYNC, INVALID]); break; }
        if (f[1] === 6 && this.o.noExtfInfo) { this.push([INSYNC, INVALID]); break; }
        this.pushU32(map[f[1]]); this.push([INSYNC, OK]); break;
      }
      case 0x23: case 0x40:
        this.flash.fill(0xff); this.addr = 0; this.erasing = this.o.erasePolls; break;
      case 0x29: this.pushU32(crc32(this.flash)); this.push([INSYNC, OK]); break;
      case 0x2e: this.pushStr(this.o.chipDes); this.push([INSYNC, OK]); break;
      case 0x2f: this.pushStr(this.o.software); this.push([INSYNC, OK]); break;
      case 0x30: this.rebooted = true; break;
      case 0x34: this.extf.fill(0xff); this.extfAddr = 0; this.erasing = this.o.erasePolls; break;
      case 0x37: {
        const n = new DataView(new Uint8Array(f.slice(1, 5)).buffer).getUint32(0, true);
        this.pushU32(crc32(this.extf.subarray(0, n))); this.push([INSYNC, OK]); break;
      }
    }
  }
}

const T = (() => { const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[i] = c >>> 0; }
  return t; })();
function crc32(b) { let s = 0; for (let i = 0; i < b.length; i++) s = (T[(s ^ b[i]) & 0xff] ^ (s >>> 8)) >>> 0; return s >>> 0; }
