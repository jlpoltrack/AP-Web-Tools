// Loads app.js under a stub DOM: catches missing element ids, broken wiring, and
// exercises the firmware-selection path end to end.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const html = readFileSync(fileURLToPath(new URL('index.html', root)), 'utf8');
const FIXTURE = fileURLToPath(new URL('fixtures/CubeOrange.apj', import.meta.url));
if (!existsSync(FIXTURE)) { console.error('Missing fixtures. Run test/fixtures.sh first.'); process.exit(2); }

const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
const missing = [];
const cache = new Map();
const listeners = {};

const make = id => ({
  id, textContent: '', style: {}, files: [], hidden: false, disabled: false,
  scrollTop: 0, scrollHeight: 0,
  addEventListener: (ev, fn) => { (listeners[id] ||= {})[ev] = fn; },
});

globalThis.document = {
  getElementById(id) {
    if (!ids.has(id)) { missing.push(id); return null; }
    if (!cache.has(id)) cache.set(id, make(id));
    return cache.get(id);
  },
};
Object.defineProperty(globalThis, 'navigator', {
  value: { serial: { getPorts: async () => [] } }, configurable: true });

await import(new URL('js/app.js', root));

let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS' : 'FAIL') + ' ' + m); if (!c) fails++; };

ok(missing.length === 0, missing.length ? 'missing ids: ' + missing.join(', ')
                                        : 'every getElementById id exists in index.html');
ok(['file', 'reboot', 'connect', 'disconnect', 'flash'].every(id => listeners[id]),
   'all five controls have handlers');
ok(cache.get('flash').disabled === true, 'flash starts disabled');

// Selecting a firmware file must describe it and leave flash disabled until a board is found.
const buf = readFileSync(FIXTURE);
cache.get('file').files = [{ text: async () => buf.toString('utf8'), name: 'arducopter.apj' }];
await listeners.file.change();
ok(/^arducopter\.apj — CubeOrange, board ID 140, /.test(cache.get('fwinfo').textContent),
   'firmware described as: ' + cache.get('fwinfo').textContent);
ok(cache.get('flash').disabled === true, 'flash still disabled with no board connected');

// A file that is not an apj must be reported, not thrown.
cache.get('file').files = [{ text: async () => 'not json', name: 'x.bin' }];
await listeners.file.change();
ok(/Not a \.apj file/.test(cache.get('fwinfo').textContent), 'non-apj file rejected cleanly');

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
