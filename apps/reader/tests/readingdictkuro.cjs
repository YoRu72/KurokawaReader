// node tests/readingdictkuro.cjs: the reading dictionary with the REAL kuromoji 0.1.2 (its browser build and its twelve
// IPADIC files), loaded the way the PHONE loads it: a page on https://localhost, every CDN request answered locally from the
// package's own files with the headers a CDN sends. Two forms of the .dat.gz bodies: (a) the gzip bytes as they are
// (Content-Type application/gzip, no Content-Encoding); (b) the UN-gzipped bytes (what a WebView that already decoded
// Content-Encoding: gzip hands over). Each: download through the app's own function (its self-check runs), then the app's
// own furigana (annotate) reads «日本語を勉強する» and the readings must hold にほんご and べんきょう; then the page is reloaded
// (the cache kept) and the readings come again with every request to the CDN refused (offline).
// kuromoji is found by $KUROMOJI_DIR, else the reader's own node_modules, else the scratch copy; not found: SKIP, exit 0.
const fs = require('fs'); const path = require('path'); const zlib = require('zlib');
function findKuromoji() {
  const cands = [];
  if (process.env.KUROMOJI_DIR) cands.push(process.env.KUROMOJI_DIR);
  try { cands.push(path.dirname(require.resolve('kuromoji/package.json', { paths: [path.resolve(__dirname, '..')] }))); } catch { /* not installed */ }
  cands.push('/tmp/claude-0/-home-claude/31db5f1c-a6c2-54e2-a5c4-2730cae2d727/scratchpad/kuro/node_modules/kuromoji');
  return cands.find((d) => fs.existsSync(path.join(d, 'build/kuromoji.js')) && fs.existsSync(path.join(d, 'dict/base.dat.gz')));
}
const KDIR = findKuromoji();
if (!KDIR) { console.log('SKIP: kuromoji not installed'); process.exit(0); }
const { chromium } = require('playwright'); const esbuild = require('esbuild');
const PINYIN = `window.pinyinPro = { pinyin: () => [] };`;
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const BLANK = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
const code = esbuild.buildSync({ stdin: { contents: `export * from './src/readingdict'; export * as F from './src/furigana';`, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'RD', write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
const READ = async (p) => p.evaluate(async () => {
  const tk = await RD.F.ensureTokenizer(); const root = document.createElement('p'); root.textContent = '日本語を勉強する'; document.body.appendChild(root);
  RD.F.annotate(root, tk); return { rt: [...root.querySelectorAll('rt')].map((r) => r.textContent).join('|'), text: root.textContent };
});

async function variant(br, label, gunzipped) {
  const ctx = await br.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const net = { cdn: [], own: [], offline: false };
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost') { if (u.pathname !== '/blank') net.own.push(u.pathname); return route.fulfill({ contentType: 'text/html', body: u.pathname === '/blank' ? BLANK : '<html>the app\'s own page</html>' }); }
    if (u.hostname !== 'cdn.jsdelivr.net') return route.abort();
    net.cdn.push(u.pathname);
    if (net.offline) return route.abort('internetdisconnected');
    const pre = '/npm/kuromoji@0.1.2/'; if (!u.pathname.startsWith(pre)) return route.fulfill({ status: 404, body: 'no' });
    const f = path.join(KDIR, u.pathname.slice(pre.length)); if (!f.startsWith(KDIR) || !fs.existsSync(f) || !fs.statSync(f).isFile()) return route.fulfill({ status: 404, body: 'no' });
    const cors = { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=31536000, immutable' };
    let body = fs.readFileSync(f);
    if (f.endsWith('.dat.gz')) return route.fulfill({ headers: { ...cors, 'content-type': 'application/gzip' }, body: gunzipped ? zlib.gunzipSync(body) : body });
    return route.fulfill({ headers: { ...cors, 'content-type': 'application/javascript; charset=utf-8' }, body });
  });
  const boot = async () => { await p.goto('https://localhost/blank'); await p.addScriptTag({ content: code }); };
  await boot();
  const state = () => p.evaluate(() => { const s = RD.getDictState('ja'); return { phase: s.phase, fail: s.fail, detail: s.detail }; });
  const d = await p.evaluate(() => RD.downloadDict('ja')); const s = await state();
  ok(`${label}: download passes the real self-check and is ready`, d === true && s.phase === 'ready', s);
  ok(`${label}: 13 files fetched, none asked of the app's own host`, net.cdn.length === 13 && net.own.length === 0, { n: net.cdn.length, own: net.own });
  const r1 = await READ(p);
  ok(`${label}: readings hold にほんご and べんきょう`, r1.rt.includes('にほんご') && r1.rt.includes('べんきょう'), r1);
  // reload: cache kept, the CDN unreachable
  net.offline = true; net.cdn.length = 0; await boot();
  const s2 = await p.evaluate(async () => { await RD.refreshDictState('ja'); const s = RD.getDictState('ja'); return { phase: s.phase }; });
  ok(`${label}: after reload the dictionary is still on the device`, s2.phase === 'ready', s2);
  const r2 = await READ(p);
  ok(`${label}: offline after reload the readings still come (from the device copy, no request to the CDN)`, r2.rt.includes('にほんご') && r2.rt.includes('べんきょう') && net.cdn.length === 0 && net.own.length === 0, { r2, cdn: net.cdn, own: net.own });
  ok(`${label}: no page errors`, errors.length === 0, errors);
  await ctx.close();
}
(async () => {
  const br = await chromium.launch();
  try { await variant(br, '(a) gzip bytes', false); await variant(br, '(b) un-gzipped bytes', true); }
  finally { await br.close(); }
  console.log(fails ? `FAILED: ${fails}` : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
