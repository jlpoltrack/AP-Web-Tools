import { Bootloader, BootloaderError } from '../js/bootloader.js';
import { parseApj } from '../js/apj.js';
import { MockSerial } from './mock-bootloader.mjs';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const load = async p => parseApj({ text: async () => (await readFile(p)).toString('utf8'), name: p });

// Firmware to test against, fetched by fixtures.sh: a plain board and one with
// external flash. Their CRCs were checked against ArduPilot's uploader.py.
const PLAIN = fileURLToPath(new URL('fixtures/CubeOrange.apj', import.meta.url));
const EXTF  = fileURLToPath(new URL('fixtures/CubeRedPrimary.apj', import.meta.url));
if (!existsSync(PLAIN) || !existsSync(EXTF)) {
  console.error('Missing fixtures. Run test/fixtures.sh first.');
  process.exit(2);
}
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + m); if (!c) fails++; };

// --- plain internal-flash board ---
{
  const fw = await load(PLAIN);
  const s = new MockSerial({ boardId: 140, flashSize: fw.desc.image_maxsize });
  const bl = new Bootloader(s);
  const info = await bl.identify();
  ok(info.boardId === 140 && info.blRev === 5 && info.flashSize === fw.desc.image_maxsize,
     'identify: ' + JSON.stringify({ ...info, blGitHash: info.blGitHash }));
  bl.checkCompatible(fw);
  await bl.erase();
  await bl.program(fw.image);
  ok(s.progCalls === Math.ceil(fw.image.length / 252), `program chunked into ${s.progCalls} PROG_MULTI calls`);
  ok(Buffer.compare(Buffer.from(s.flash.subarray(0, fw.image.length)), Buffer.from(fw.image)) === 0,
     'flash contents match the image');
  ok(s.flash.subarray(fw.image.length).every(b => b === 0xff), 'remainder of flash left erased');
  await bl.verify(fw);
  ok(true, 'CRC verify accepted');
  await bl.reboot();
  ok(s.rebooted, 'reboot sent');
}

// --- CRC mismatch must be caught ---
{
  const fw = await load(PLAIN);
  const s = new MockSerial({ boardId: 140, flashSize: fw.desc.image_maxsize });
  const bl = new Bootloader(s);
  await bl.identify();
  await bl.erase();
  await bl.program(fw.image);
  s.flash[1234] ^= 0xff;
  let caught = null;
  try { await bl.verify(fw); } catch (e) { caught = e; }
  ok(caught instanceof BootloaderError && /CRC mismatch/.test(caught.message), 'corrupted flash fails verify');
}

// --- wrong board rejected before erasing ---
{
  const fw = await load(PLAIN);
  const s = new MockSerial({ boardId: 1069 });
  const bl = new Bootloader(s);
  await bl.identify();
  let caught = null;
  try { bl.checkCompatible(fw); } catch (e) { caught = e; }
  ok(caught && /board ID 140 but this board reports 1069/.test(caught.message), 'board ID mismatch rejected');
}

// --- oversized image rejected ---
{
  const fw = await load(PLAIN);
  const s = new MockSerial({ boardId: 140, flashSize: 65536 });
  const bl = new Bootloader(s);
  await bl.identify();
  let caught = null;
  try { bl.checkCompatible(fw); } catch (e) { caught = e; }
  ok(caught && /bytes of flash/.test(caught.message), 'image larger than flash rejected');
}

// --- external-flash board ---
{
  const fw = await load(EXTF);
  const s = new MockSerial({ boardId: 1069, flashSize: fw.desc.image_maxsize,
                             extfSize: fw.desc.extflash_total, blRev: 5 });
  const bl = new Bootloader(s);
  const info = await bl.identify();
  ok(info.extfSize === fw.desc.extflash_total, 'external flash size reported');
  bl.checkCompatible(fw);
  await bl.erase();
  await bl.program(fw.image);
  await bl.verify(fw);
  await bl.eraseExtf(fw.extfImage.length);
  await bl.program(fw.extfImage, { extf: true });
  await bl.verifyExtf(fw);
  ok(Buffer.compare(Buffer.from(s.extf.subarray(0, fw.extfImage.length)), Buffer.from(fw.extfImage)) === 0,
     'external flash contents match');
}

// --- bootloader that does not answer INFO_EXTF_SIZE ---
{
  const s = new MockSerial({ boardId: 140, noExtfInfo: true });
  const bl = new Bootloader(s);
  const info = await bl.identify();
  ok(info.extfSize === 0 && info.boardId === 140, 'INVALID on EXTF_SIZE recovers and keeps identifying');
}

// --- unsupported bootloader revision ---
{
  const s = new MockSerial({ blRev: 9 });
  let caught = null;
  try { await new Bootloader(s).identify(); } catch (e) { caught = e; }
  ok(caught && /unsupported bootloader protocol revision 9/.test(caught.message), 'bad bl_rev rejected');
}

// --- rev2 bootloader cannot CRC-verify ---
{
  const fw = await load(PLAIN);
  const s = new MockSerial({ blRev: 2, boardId: 140, flashSize: fw.desc.image_maxsize });
  const bl = new Bootloader(s);
  await bl.identify();
  let caught = null;
  try { await bl.verify(fw); } catch (e) { caught = e; }
  ok(caught && /predates CRC verification/.test(caught.message), 'rev2 verify refused with a clear message');
}

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
