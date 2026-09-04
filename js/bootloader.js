// The PX4/ArduPilot serial bootloader protocol, as implemented by
// ArduPilot's Tools/scripts/uploader.py and Tools/AP_Bootloader.
//
// Every command ends with EOC and is answered with INSYNC followed by a status byte.

import { Timeout, delay } from './serial.js';
import { imageCrc, crc32 } from './apj.js';

const INSYNC = 0x12;
const EOC    = 0x20;

const OK              = 0x10;
const FAILED          = 0x11;
const INVALID         = 0x13;
const BAD_SILICON_REV = 0x14;

const CMD = {
  GET_SYNC:        0x21,
  GET_DEVICE:      0x22,
  CHIP_ERASE:      0x23,
  PROG_MULTI:      0x27,
  GET_CRC:         0x29,
  GET_CHIP_DES:    0x2e,
  GET_SOFTWARE:    0x2f,
  REBOOT:          0x30,
  EXTF_ERASE:      0x34,
  EXTF_PROG_MULTI: 0x35,
  EXTF_GET_CRC:    0x37,
  CHIP_FULL_ERASE: 0x40,
};

const INFO = {
  BL_REV:     0x01,
  BOARD_ID:   0x02,
  BOARD_REV:  0x03,
  FLASH_SIZE: 0x04,
  EXTF_SIZE:  0x06,
};

export const BL_REV_MIN = 2;
export const BL_REV_MAX = 5;

// Protocol max is 255; must stay a multiple of 4.
const PROG_MULTI_MAX = 252;

const ERASE_TIMEOUT_MS = 30000;

// Boards whose bootloader ID differs from the firmware's, per uploader.py.
const COMPATIBLE_IDS = { 33: 9 };

export class BootloaderError extends Error {}

export class Bootloader {
  constructor(serial, { onLog } = {}) {
    this.s = serial;
    this.onLog = onLog || (() => {});
    this.info = null;
  }

  async send(bytes) { await this.s.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)); }

  async getSync(timeoutMs = 1000) {
    const a = (await this.s.read(1, timeoutMs))[0];
    if (a !== INSYNC) throw new BootloaderError(`expected INSYNC, got 0x${a.toString(16)}`);
    const b = (await this.s.read(1, timeoutMs))[0];
    if (b === INVALID) throw new BootloaderError('bootloader reports INVALID OPERATION');
    if (b === FAILED) throw new BootloaderError('bootloader reports OPERATION FAILED');
    if (b === BAD_SILICON_REV) throw new BootloaderError('this silicon revision cannot be programmed');
    if (b !== OK) throw new BootloaderError(`expected OK, got 0x${b.toString(16)}`);
  }

  async recvInt(timeoutMs = 1000) {
    const b = await this.s.read(4, timeoutMs);
    return new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true);
  }

  // Drops anything buffered, then proves the bootloader is listening.
  async sync(timeoutMs = 1000) {
    this.s.discard();
    await this.send([CMD.GET_SYNC, EOC]);
    await this.getSync(timeoutMs);
  }

  async trySync(timeoutMs = 500) {
    try { await this.sync(timeoutMs); return true; }
    catch { return false; }
  }

  async getInfo(param) {
    await this.send([CMD.GET_DEVICE, param, EOC]);
    const value = await this.recvInt();
    await this.getSync();
    return value;
  }

  // Some of these are optional and answer INVALID on older bootloaders; a failed
  // read leaves the stream mid-conversation, so resync before moving on.
  async getInfoOptional(param, fallback = 0) {
    try { return await this.getInfo(param); }
    catch { await this.trySync(); return fallback; }
  }

  async getString(cmd) {
    await this.send([cmd, EOC]);
    const len = await this.recvInt();
    if (len > 256) throw new BootloaderError('implausible string length');
    const value = new TextDecoder().decode(await this.s.read(len, 1000));
    await this.getSync();
    return value;
  }

  async identify() {
    await this.sync(2000);

    const blRev = await this.getInfo(INFO.BL_REV);
    if (blRev < BL_REV_MIN || blRev > BL_REV_MAX) {
      throw new BootloaderError(`unsupported bootloader protocol revision ${blRev}`);
    }
    const extfSize = await this.getInfoOptional(INFO.EXTF_SIZE, 0);
    const boardId = await this.getInfo(INFO.BOARD_ID);
    const boardRev = await this.getInfo(INFO.BOARD_REV);
    const flashSize = await this.getInfo(INFO.FLASH_SIZE);

    let chipDesc = null;
    if (blRev >= 5) {
      try { chipDesc = (await this.getString(CMD.GET_CHIP_DES)).split(',')[0]; }
      catch { await this.trySync(); }
    }
    let blGitHash = null;
    try { blGitHash = await this.getString(CMD.GET_SOFTWARE); }
    catch { await this.trySync(); }

    this.info = { blRev, boardId, boardRev, flashSize, extfSize, chipDesc, blGitHash };
    return this.info;
  }

  // The firmware's board_id may legitimately differ from the bootloader's.
  checkCompatible(fw) {
    const { boardId, flashSize, extfSize } = this.info;
    const want = COMPATIBLE_IDS[boardId] ?? boardId;
    if (fw.boardId !== want && fw.boardId !== boardId) {
      throw new BootloaderError(
        `firmware is for board ID ${fw.boardId} but this board reports ${boardId}`);
    }
    if (fw.image.length > flashSize) {
      throw new BootloaderError(
        `firmware is ${fw.image.length} bytes but the board has ${flashSize} bytes of flash`);
    }
    if (fw.extfImage && fw.extfImage.length > extfSize) {
      throw new BootloaderError(
        `external-flash image is ${fw.extfImage.length} bytes but the board reports ${extfSize}`);
    }
  }

  // Erase is slow (roughly 9 s, sometimes far longer) and answers only when done, so
  // it is polled rather than waited on with one long read.
  async erase({ full = false, onTick } = {}) {
    this.s.discard();
    await this.send([full ? CMD.CHIP_FULL_ERASE : CMD.CHIP_ERASE, EOC]);
    const start = performance.now();
    while (performance.now() - start < ERASE_TIMEOUT_MS) {
      try {
        await this.getSync(250);
        return;
      } catch (e) {
        if (!(e instanceof Timeout)) throw e;
        if (onTick) onTick((performance.now() - start) / 1000);
      }
    }
    throw new BootloaderError('timed out waiting for chip erase');
  }

  async progMulti(cmd, chunk) {
    const frame = new Uint8Array(chunk.length + 3);
    frame[0] = cmd;
    frame[1] = chunk.length;
    frame.set(chunk, 2);
    frame[frame.length - 1] = EOC;
    await this.send(frame);
    await this.getSync(2000);
  }

  async program(image, { extf = false, onProgress } = {}) {
    const cmd = extf ? CMD.EXTF_PROG_MULTI : CMD.PROG_MULTI;
    for (let i = 0; i < image.length; i += PROG_MULTI_MAX) {
      await this.progMulti(cmd, image.subarray(i, Math.min(i + PROG_MULTI_MAX, image.length)));
      if (onProgress && (i % (PROG_MULTI_MAX * 32) === 0)) onProgress(i, image.length);
    }
    if (onProgress) onProgress(image.length, image.length);
  }

  // rev3+ verifies with a CRC over the whole flash region rather than reading it back.
  async verify(fw) {
    if (this.info.blRev < 3) {
      throw new BootloaderError(
        `bootloader revision ${this.info.blRev} predates CRC verification; not supported here`);
    }
    const expect = imageCrc(fw.image, this.info.flashSize);
    await this.send([CMD.GET_CRC, EOC]);
    const got = await this.recvInt(10000);
    await this.getSync(10000);
    if (got !== expect) {
      throw new BootloaderError(
        `CRC mismatch: expected 0x${expect.toString(16)}, got 0x${got.toString(16)}`);
    }
  }

  async eraseExtf(size) {
    const b = new Uint8Array(6);
    b[0] = CMD.EXTF_ERASE;
    new DataView(b.buffer).setUint32(1, size, true);
    b[5] = EOC;
    this.s.discard();
    await this.send(b);
    const deadline = performance.now() + ERASE_TIMEOUT_MS;
    while (performance.now() < deadline) {
      try { await this.getSync(250); return; }
      catch (e) { if (!(e instanceof Timeout)) throw e; }
    }
    throw new BootloaderError('timed out waiting for external flash erase');
  }

  async verifyExtf(fw) {
    const b = new Uint8Array(6);
    b[0] = CMD.EXTF_GET_CRC;
    new DataView(b.buffer).setUint32(1, fw.extfImage.length, true);
    b[5] = EOC;
    await this.send(b);
    const got = await this.recvInt(30000);
    await this.getSync(10000);
    const expect = crc32(fw.extfImage, 0);
    if (got !== expect) {
      throw new BootloaderError(
        `external flash CRC mismatch: expected 0x${expect.toString(16)}, got 0x${got.toString(16)}`);
    }
  }

  // The board reboots immediately, so there is no reply to wait for.
  async reboot() {
    await this.send([CMD.REBOOT, EOC]);
    await delay(100);
  }
}
