// DroneCAN (UAVCAN v0) transfer layer: CAN ID packing, multi-frame assembly, transfer CRC.

export const DTID = {
  NODE_STATUS: 341,
};

export const SVC = {
  GET_NODE_INFO: 1,
  RESTART_NODE: 5,
  BEGIN_FIRMWARE_UPDATE: 40,
  FILE_READ: 48,
};

// Data type signatures, little-endian seeds for the transfer CRC.
export const SIG = {
  NODE_STATUS: 0x0f0868d0c1a7c6f1n,
  GET_NODE_INFO: 0xee468a8121c46a9en,
  RESTART_NODE: 0x569e05394a3017f0n,
  BEGIN_FIRMWARE_UPDATE: 0xb7d725df72724126n,
  FILE_READ: 0x8dcdca939f33f678n,
};

const CRC_TABLE_POLY = 0x1021;

function crc16Byte(crc, byte) {
  crc ^= (byte & 0xff) << 8;
  for (let i = 0; i < 8; i++) {
    crc = (crc & 0x8000) ? ((crc << 1) ^ CRC_TABLE_POLY) : (crc << 1);
    crc &= 0xffff;
  }
  return crc;
}

// CRC-16-CCITT over the 8 signature bytes (LSB first) followed by the payload.
export function transferCrc(signature, payload) {
  let crc = 0xffff;
  let sig = signature;
  for (let i = 0; i < 8; i++) {
    crc = crc16Byte(crc, Number(sig & 0xffn));
    sig >>= 8n;
  }
  for (const b of payload) crc = crc16Byte(crc, b);
  return crc;
}

export function messageId(priority, dtid, srcNode) {
  return (((priority & 0x1f) << 24) | ((dtid & 0xffff) << 8) | (srcNode & 0x7f)) >>> 0;
}

export function serviceId(priority, svc, isRequest, destNode, srcNode) {
  return (((priority & 0x1f) << 24) | ((svc & 0xff) << 16) | ((isRequest ? 1 : 0) << 15) |
          ((destNode & 0x7f) << 8) | 0x80 | (srcNode & 0x7f)) >>> 0;
}

export function parseId(id) {
  const service = (id & 0x80) !== 0;
  if (service) {
    return {
      service: true,
      priority: (id >>> 24) & 0x1f,
      serviceTypeId: (id >>> 16) & 0xff,
      request: ((id >>> 15) & 1) === 1,
      dest: (id >>> 8) & 0x7f,
      src: id & 0x7f,
    };
  }
  return {
    service: false,
    priority: (id >>> 24) & 0x1f,
    dtid: (id >>> 8) & 0xffff,
    src: id & 0x7f,
  };
}

// Split a payload into CAN frames with UAVCAN v0 tail bytes.
export function packTransfer(canId, payload, transferId, signature) {
  const frames = [];
  const tid = transferId & 0x1f;
  if (payload.length <= 7) {
    const data = new Uint8Array(payload.length + 1);
    data.set(payload, 0);
    data[payload.length] = 0xc0 | tid; // start + end, toggle 0
    frames.push({ id: canId, data });
    return frames;
  }
  const crc = transferCrc(signature, payload);
  const body = new Uint8Array(payload.length + 2);
  body[0] = crc & 0xff;
  body[1] = (crc >> 8) & 0xff;
  body.set(payload, 2);

  let offset = 0, toggle = 0, first = true;
  while (offset < body.length) {
    const n = Math.min(7, body.length - offset);
    const data = new Uint8Array(n + 1);
    data.set(body.subarray(offset, offset + n), 0);
    const last = offset + n >= body.length;
    data[n] = (first ? 0x80 : 0) | (last ? 0x40 : 0) | (toggle ? 0x20 : 0) | tid;
    frames.push({ id: canId, data });
    offset += n;
    toggle ^= 1;
    first = false;
  }
  return frames;
}

// Reassembles multi-frame transfers keyed by source node + transfer descriptor.
export class Reassembler {
  constructor() { this.sessions = new Map(); }

  static key(id, transferId) {
    return `${(id & 0x00ffff80) >>> 0}:${id & 0x7f}:${transferId}`;
  }

  // Returns { id, payload } when a transfer completes, else null.
  push(id, data) {
    if (data.length < 1) return null;
    const tail = data[data.length - 1];
    const start = (tail & 0x80) !== 0;
    const end = (tail & 0x40) !== 0;
    const toggle = (tail & 0x20) !== 0;
    const tid = tail & 0x1f;
    const body = data.subarray(0, data.length - 1);
    const key = Reassembler.key(id, tid);

    if (start && end) return { id, payload: body, singleFrame: true };

    if (start) {
      this.sessions.set(key, { chunks: [body.slice(0)], toggle: true, len: body.length });
      return null;
    }
    const s = this.sessions.get(key);
    if (!s) return null;
    if (toggle !== s.toggle) { this.sessions.delete(key); return null; }
    s.toggle = !s.toggle;
    s.chunks.push(body.slice(0));
    s.len += body.length;
    if (!end) return null;

    this.sessions.delete(key);
    const buf = new Uint8Array(s.len);
    let o = 0;
    for (const c of s.chunks) { buf.set(c, o); o += c.length; }
    if (buf.length < 2) return null;
    const crc = buf[0] | (buf[1] << 8);
    return { id, payload: buf.subarray(2), crc, singleFrame: false };
  }
}
