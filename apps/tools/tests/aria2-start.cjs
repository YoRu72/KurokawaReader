// node tests/aria2-start.cjs: the desktop engine's aria2c coming up — a slow one (as on a first start under Windows'
// antivirus) still taken; one that dies at once gives its own words as the reason; ensure() starts it again later;
// one that stops while in use is started again by itself. A fake aria2c (a Node script) answers JSON-RPC over HTTP.
const fs = require('fs'); const os = require('os'); const path = require('path');
delete globalThis.WebSocket; // (the fake speaks HTTP only)
const { Aria2Engine } = require('../desktop/aria2.cjs');
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
if (process.platform === 'win32') { console.log('skipped on Windows (a shell-script fake)'); process.exit(0); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-aria2-'));
const plat = process.platform === 'darwin' ? 'mac' : 'linux';
const bin = path.join(root, 'res', 'aria2', `${plat}-${process.arch}`, 'aria2c'); fs.mkdirSync(path.dirname(bin), { recursive: true });
const fake = path.join(root, 'fake.cjs'); const mode = path.join(root, 'mode');
fs.writeFileSync(fake, `
const fs = require('fs'); const http = require('http');
const m = fs.readFileSync(${JSON.stringify(mode)}, 'utf8').trim();
if (m === 'die') { process.stderr.write('Exception caught\\nFailed to bind a socket\\n'); process.exit(28); }
const port = Number(process.argv.find((a) => a.startsWith('--rpc-listen-port=')).split('=')[1]);
const delay = m === 'slow' ? 7000 : 0;
setTimeout(() => http.createServer((q, r) => { let b = ''; q.on('data', (c) => (b += c)); q.on('end', () => { const j = JSON.parse(b);
  const res = j.method === 'aria2.getVersion' ? { version: '1.37.0' } : /tell/.test(j.method) ? [] : 'OK';
  r.setHeader('content-type', 'application/json'); r.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result: res })); if (m === 'crash' && j.method === 'aria2.tellActive') setTimeout(() => process.exit(3), 300); }); }).listen(port, '127.0.0.1'), delay);
`);
fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${fake}" "$@"\n`); fs.chmodSync(bin, 0o755);

const make = () => { const ud = fs.mkdtempSync(path.join(root, 'ud-')); return new Aria2Engine({ userData: ud, resources: path.join(root, 'res'), defaultDir: path.join(ud, 'dl') }); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  // A slow start: answered after 7 s — the old 6 s wait gave up.
  fs.writeFileSync(mode, 'slow'); let e = make(); let states = 0; e.onState = () => states++;
  const t0 = Date.now(); let up = await e.ensure();
  ok('a slow aria2c is still taken', up && e.available && Date.now() - t0 >= 6500);
  ok('the page is told', states >= 1);
  e.stop();

  // One that dies at once: why, in its own words, without waiting the half minute.
  fs.writeFileSync(mode, 'die'); e = make(); const t1 = Date.now(); up = await e.ensure();
  ok('a dying aria2c: not available', !up && !e.available);
  ok('its reason has its last words', /exited \(28\)/.test(e.reason) && /bind a socket/.test(e.reason));
  ok('not the long wait', Date.now() - t1 < 5000);
  // Fixed, then asked again (the page's «Try again», or an added download): it runs.
  fs.writeFileSync(mode, 'ok'); up = await e.ensure();
  ok('ensure() starts it again', up && e.available && e.reason === '');
  const p1 = e.ensure(), p2 = e.ensure(); ok('once at a time', (await p1) === true && (await p2) === true);

  // One that stops by itself while in use: started again.
  fs.writeFileSync(mode, 'crash'); e.stop(); e = make(); await e.ensure(); fs.writeFileSync(mode, 'ok');
  await e.list().catch(() => {}); // (the crash follows a tellActive)
  let back = false; for (let i = 0; i < 40 && !back; i++) { await wait(250); back = e.available && !!e.proc; }
  ok('stopped by itself: started again', back);
  e.stop(); await wait(200);
  fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
