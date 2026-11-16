// node tests/aria2cert.cjs: certificates checked by the real aria2c (0.21 P9 — --check-certificate=false is gone): a
// loopback HTTPS server with a self-signed certificate made here by openssl is refused, tried again too (aria2 checks
// certificates for every download at once: its manual has no per-download check-certificate, so the app offers no way
// round it — the browser, which shows its own warning, is the way out). Needs aria2c (the bundle's —
// node desktop/fetch-aria2.mjs — or one on the PATH) and openssl; without them it says so and stops (not-in-ci.json).
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path'); const https = require('node:https'); const { spawnSync } = require('node:child_process');
delete globalThis.WebSocket;
const { Aria2Engine } = require('../desktop/aria2.cjs');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n, c ? '' : JSON.stringify(x ?? '')); if (!c) fails++; };
const has = (cmd, args) => { try { return spawnSync(cmd, args, { timeout: 5000 }).status === 0; } catch { return false; } };
const res = path.join(__dirname, '..', 'desktop', 'resources');
if (!has('openssl', ['version'])) { console.log('skipped: no openssl here'); process.exit(0); }
const probe = new Aria2Engine({ userData: os.tmpdir(), resources: res, defaultDir: os.tmpdir() });
if (!probe.binary()) { console.log('skipped: no aria2c here (node desktop/fetch-aria2.mjs, or one on the PATH)'); process.exit(0); }

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-cert-'));
  const key = path.join(root, 'k.pem'), crt = path.join(root, 'c.pem');
  spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', crt, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { timeout: 30000 });
  const body = Buffer.alloc(4096, 7);
  const srv = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(crt) }, (q, r) => { r.writeHead(200, { 'content-length': body.length }); r.end(body); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r)); const url = `https://127.0.0.1:${srv.address().port}/self.bin`;
  const ud = fs.mkdtempSync(path.join(root, 'ud-')); const dl = path.join(ud, 'dl');
  const e = new Aria2Engine({ userData: ud, resources: res, defaultDir: dl }); await e.ensure();
  const wait = async (id, done) => { for (let i = 0; i < 100; i++) { const t = (await e.list()).find((x) => x.id === id); if (t && done(t)) return t; await new Promise((r) => setTimeout(r, 200)); } return (await e.list()).find((x) => x.id === id); };
  const t = await e.add({ source: { url }, dir: dl, name: 'self.bin' });
  const failed = await wait(t.id, (x) => x.state === 'failed' || x.state === 'done');
  ok('a self-signed certificate is refused by default', failed?.state === 'failed' && /certificate|SSL|TLS/i.test(failed?.error || ''), failed);
  await e.resume(t.id).catch(() => undefined);
  const again = await wait(t.id, (x) => x.state === 'failed' || x.state === 'done');
  ok('tried again: still refused (no per-download way round)', again?.state === 'failed' && !(fs.existsSync(path.join(dl, 'self.bin')) && fs.statSync(path.join(dl, 'self.bin')).size === body.length), again);
  const t2 = await e.add({ source: { url: url.replace('self.bin', 'other.bin') }, dir: dl, name: 'other.bin' });
  const f2 = await wait(t2.id, (x) => x.state === 'failed' || x.state === 'done');
  ok('another download from it is still refused', f2?.state === 'failed', f2);
  e.stop(); srv.close(); fs.rmSync(root, { recursive: true, force: true });
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
