// Minimal MAVLink: enough to spot a heartbeat and command a reboot into the
// bootloader, which is how Mission Planner hands a running FC over to the uploader.

export const MSG = { HEARTBEAT: 0, COMMAND_LONG: 76, COMMAND_ACK: 77, STATUSTEXT: 253 };
const CRC_EXTRA = { 0: 50, 76: 152, 77: 143, 253: 83 };

const MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN = 246;

function crcAccum(crc, byte) {
  let tmp = byte ^ (crc & 0xff);
  tmp = (tmp ^ (tmp << 4)) & 0xff;
  return ((crc >> 8) ^ (tmp << 8) ^ (tmp << 3) ^ (tmp >> 4)) & 0xffff;
}

function checksum(bytes, crcExtra) {
  let crc = 0xffff;
  for (const b of bytes) crc = crcAccum(crc, b);
  return crcAccum(crc, crcExtra);
}

// MAVLink v1; ArduPilot accepts it on any link.
export function pack(msgid, payload, seq, sysid = 255, compid = 190) {
  const head = new Uint8Array([payload.length, seq & 0xff, sysid, compid, msgid]);
  const body = new Uint8Array(head.length + payload.length);
  body.set(head, 0);
  body.set(payload, head.length);
  const crc = checksum(body, CRC_EXTRA[msgid]);
  const frame = new Uint8Array(1 + body.length + 2);
  frame[0] = 0xfe;
  frame.set(body, 1);
  frame[frame.length - 2] = crc & 0xff;
  frame[frame.length - 1] = (crc >> 8) & 0xff;
  return frame;
}

// param1 = 3 reboots and holds in the bootloader (RTC_BOOT_HOLD), so the board waits
// indefinitely rather than timing out while the user grants access to the new port.
export function rebootToBootloader(target, seq, sysid = 255, compid = 0) {
  const p = new Uint8Array(33);
  const dv = new DataView(p.buffer);
  dv.setFloat32(0, 3, true);
  dv.setUint16(28, MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN, true);
  p[30] = target.sysid;
  p[31] = target.compid;
  return pack(MSG.COMMAND_LONG, p, seq, sysid, compid);
}

// NSH fallback for boards running a shell rather than ArduPilot, as uploader.py does.
export const NSH_REBOOT_BL = new TextEncoder().encode('\r\r\rreboot -b\n');

// Incremental parser; yields { msgid, sysid, compid, payload } per complete frame.
export class MavParser {
  constructor() { this.buf = new Uint8Array(0); }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    const out = [];
    let i = 0;
    while (i < this.buf.length) {
      const stx = this.buf[i];
      if (stx !== 0xfe && stx !== 0xfd) { i++; continue; }
      const v2 = stx === 0xfd;
      const hdr = v2 ? 10 : 6;
      if (i + hdr > this.buf.length) break;
      const len = this.buf[i + 1];
      const signed = v2 && (this.buf[i + 2] & 0x01);
      const total = hdr + len + 2 + (signed ? 13 : 0);
      if (i + total > this.buf.length) break;
      const msgid = v2
        ? this.buf[i + 7] | (this.buf[i + 8] << 8) | (this.buf[i + 9] << 16)
        : this.buf[i + 5];
      const extra = CRC_EXTRA[msgid];
      if (extra === undefined) { i++; continue; }
      const crc = checksum(this.buf.subarray(i + 1, i + hdr + len), extra);
      const got = this.buf[i + hdr + len] | (this.buf[i + hdr + len + 1] << 8);
      if (crc !== got) { i++; continue; }
      const payload = new Uint8Array(v2 ? Math.max(len, 32) : len);
      payload.set(this.buf.subarray(i + hdr, i + hdr + len), 0); // v2 truncation
      out.push({ msgid, sysid: this.buf[i + (v2 ? 5 : 3)], compid: this.buf[i + (v2 ? 6 : 4)], payload });
      i += total;
    }
    this.buf = this.buf.slice(i);
    if (this.buf.length > 8192) this.buf = new Uint8Array(0);
    return out;
  }
}
