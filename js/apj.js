// .apj firmware files: JSON with the image as base64-encoded zlib data.

function b64ToBytes(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 'deflate' is the zlib wrapper format, which is what apj images use.
async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Images are always a multiple of 4 bytes in practice; pad defensively so the
// word-oriented PROG_MULTI and the CRC agree with the bootloader.
function pad4(img) {
  if (img.length % 4 === 0) return img;
  const out = new Uint8Array(img.length + (4 - img.length % 4)).fill(0xff);
  out.set(img, 0);
  return out;
}

export async function parseApj(file) {
  let desc;
  try {
    desc = JSON.parse(await file.text());
  } catch {
    throw new Error('Not a .apj file (could not parse it as JSON).');
  }
  if (!desc.image) throw new Error('Not a .apj file (no "image" field).');

  const image = pad4(await inflate(b64ToBytes(desc.image)));
  let extfImage = null;
  if (desc.extf_image && desc.extf_image_size > 0) {
    extfImage = pad4(await inflate(b64ToBytes(desc.extf_image)));
  }
  return {
    desc,
    image,
    extfImage,
    boardId: desc.board_id,
    boardRevision: desc.board_revision ?? 0,
    summary: desc.summary || '',
    gitIdentity: desc.git_identity || '',
    usbId: desc.USBID || '',
    name: file.name,
  };
}

// CRC-32 as in ArduPilot's crc_crc32() — the standard reflected polynomial.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, state = 0) {
  let s = state >>> 0;
  for (let i = 0; i < bytes.length; i++) s = (CRC_TABLE[(s ^ bytes[i]) & 0xff] ^ (s >>> 8)) >>> 0;
  return s >>> 0;
}

// The bootloader CRCs the whole flash region, so the image is padded with 0xFF
// out to padLen before comparing.
export function imageCrc(image, padLen) {
  let state = crc32(image, 0);
  const pad = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
  for (let i = image.length; i < padLen; i += 4) state = crc32(pad, state);
  return state >>> 0;
}
