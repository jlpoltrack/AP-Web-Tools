// Minimal MAVLink: parse v1/v2 frames, send PARAM_SET / PARAM_REQUEST_READ / COMMAND_LONG.
// Just enough to flip an ArduPilot FC's serial port into SLCAN mode, as Mission Planner does.

export const MSG = { HEARTBEAT: 0, PARAM_REQUEST_READ: 20, PARAM_VALUE: 22, PARAM_SET: 23,
                     COMMAND_LONG: 76, COMMAND_ACK: 77, STATUSTEXT: 253 };
const CRC_EXTRA = { 0: 50, 20: 214, 22: 220, 23: 168, 76: 152, 77: 143, 253: 83 };
const MAV_PARAM_TYPE_REAL32 = 9;

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

// Builds a MAVLink v1 frame; ArduPilot accepts v1 on any link.
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

function paramIdBytes(name) {
  const b = new Uint8Array(16);
  b.set(new TextEncoder().encode(name).subarray(0, 16), 0);
  return b;
}

export function paramSet(name, value, target, seq) {
  const p = new Uint8Array(23);
  new DataView(p.buffer).setFloat32(0, value, true);
  p[4] = target.sysid; p[5] = target.compid;
  p.set(paramIdBytes(name), 6);
  p[22] = MAV_PARAM_TYPE_REAL32;
  return pack(MSG.PARAM_SET, p, seq);
}

export function paramRequestRead(name, target, seq) {
  const p = new Uint8Array(20);
  new DataView(p.buffer).setInt16(0, -1, true); // by name, not index
  p[2] = target.sysid; p[3] = target.compid;
  p.set(paramIdBytes(name), 4);
  return pack(MSG.PARAM_REQUEST_READ, p, seq);
}

export function reboot(target, seq) {
  const p = new Uint8Array(33);
  const dv = new DataView(p.buffer);
  dv.setFloat32(0, 1, true);           // param1: 1 = reboot autopilot
  dv.setUint16(28, 246, true);         // MAV_CMD_PREFLIGHT_REBOOT_SHUTDOWN
  p[30] = target.sysid; p[31] = target.compid;
  return pack(MSG.COMMAND_LONG, p, seq);
}

// Incremental parser; yields { msgid, sysid, compid, payload } per complete frame.
export class MavParser {
  constructor() { this.buf = new Uint8Array(0); }

  push(chunk) {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0); merged.set(chunk, this.buf.length);
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
      payload.set(this.buf.subarray(i + hdr, i + hdr + len), 0); // v2 truncation: zero-extend
      out.push({ msgid, sysid: this.buf[i + (v2 ? 5 : 3)], compid: this.buf[i + (v2 ? 6 : 4)], payload });
      i += total;
    }
    this.buf = this.buf.slice(i);
    if (this.buf.length > 8192) this.buf = new Uint8Array(0);
    return out;
  }
}

export function decodeStatustext(payload) {
  return new TextDecoder().decode(payload.subarray(1, 51)).replace(/\0.*$/, '');
}

export function decodeParamValue(payload) {
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const id = new TextDecoder().decode(payload.subarray(8, 24)).replace(/\0.*$/, '');
  return { value: dv.getFloat32(0, true), id };
}
