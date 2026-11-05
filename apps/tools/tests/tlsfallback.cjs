// The phone's own HTTP client refused by a site's TLS (AniList's «SSL handshake failure» on some networks): the
// request goes through the web view's fetch instead, and that route is kept for the site.
const { chromium } = require('playwright'); const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
(async () => {
  const esbuild = require(require.resolve('esbuild', { paths: [path.join(__dirname, '..'), path.join(__dirname, '..', '..', '..')] }));
  const out = path.join(os.tmpdir(), `tls-${process.pid}.js`);
  await esbuild.build({ stdin: { contents: "import { request } from './src/http'; (window as any).__request = request;", resolveDir: path.join(__dirname, '..'), loader: 'ts' }, bundle: true, outfile: out, format: 'iife', logLevel: 'silent' });
  const br = await chromium.launch(); const p = await br.newPage(); const errors = []; let calls = 0;
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.route('https://graphql.anilist.co/**', (r) => { calls++; r.fulfill({ headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, json: { data: { ok: 1 } } }); });
  await p.route('https://app.test/**', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><title>t</title>' })); await p.goto('https://app.test/');
  await p.evaluate(() => { window.__native = 0; window.Capacitor = { Plugins: { KurokawaTools: { httpRequest: async (o) => { window.__native++; if (o.url.includes('other.test')) throw new Error('timeout'); throw new Error('Failure in SSL library, usually a protocol error: SSLV3_ALERT_HANDSHAKE_FAILURE HANDSHAKE_FAILURE_ON_CLIENT_HELLO'); } } } }; });
  await p.addScriptTag({ content: fs.readFileSync(out, 'utf8') });
  const r1 = await p.evaluate(() => window.__request('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).then((r) => r.body));
  check('first request answered through the web route', JSON.parse(r1).data.ok === 1);
  const r2 = await p.evaluate(async () => { const n = window.__native; await window.__request('https://graphql.anilist.co', { method: 'POST', body: '{}' }); return window.__native - n; });
  check('the route is kept: the native client is not tried again', r2 === 0);
  const other = await p.evaluate(() => window.__request('https://other.test/x').then(() => 'answered', (e) => String(e.message)));
  check('other errors still surface as they are', other === 'timeout');
  console.log(errors.length ? 'errors' : 'all passed'); await br.close(); fs.rmSync(out, { force: true }); process.exit(errors.length ? 1 : 0);
})();
