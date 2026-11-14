// Torrent streaming on the Tauri shell (stage P4). Two parts:
// 1. The page, through the real desktop-tauri/bridge.js over a pretend Tauri IPC: a torrent still downloading offers
//    «Play while downloading» (the bridge has streamUrl); the player reads the address kt_stream_url gave (a clip served
//    here with ranges, as the stream server serves it) and plays; while it waits, the waiting line shows streamStats'
//    speed and peers; closing the player sends kt_stream_done for that download. The same in Arabic.
// 2. The self-test's P4 checks (selftest.js runP4) against a stream server written here with the Rust server's rules
//    (token, session, ranges, 416, pieces let in by the test, streamDone ending a waiting reader, stop), so the script's
//    own logic is known to pass before CI runs it — and to fail when the server answers wrongly.
// Run: NODE_PATH=$(npm root -g) node tests/streamtauri.cjs   (part 1 needs ffmpeg for its clip; skipped without)
'use strict';
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const vm = require('node:vm'); const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist');
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'bridge.js'), 'utf8');
const SELFTEST = fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'selftest.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webm': 'video/webm' };
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };

/* ---------- part 2's server: the Rust stream server's rules, in Node ---------- */
function fakeStreamServer(opts) {
  const token = crypto.randomBytes(16).toString('hex'); const sessions = new Map(); let live = 0; let port = 0; let server = null;
  const span = (h, size) => { const m = /bytes=(\d*)-(\d*)/.exec(h || ''); if (!m) return { code: 200, from: 0, to: size - 1 }; let from = m[1] ? Number(m[1]) : 0; let to = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1; if (!m[1] && m[2]) { from = Math.max(0, size - Number(m[2])); to = size - 1; } if (from >= size || from > to) return { code: 416 }; return { code: 206, from, to }; };
  const head = (res, code, h) => res.writeHead(code, { 'access-control-allow-origin': '*', connection: 'close', ...h });
  const onReq = async (req, res) => {
    live++; res.on('close', () => { live--; });
    const u = new URL(req.url, 'http://x'); const parts = u.pathname.split('/');
    if (req.method === 'OPTIONS') { head(res, 204, {}); res.end(); return; }
    if (parts[1] !== token) { head(res, 403, { 'content-length': 0 }); res.end(); return; }
    const route = parts[2]; const headOnly = req.method === 'HEAD';
    if (route === 'f') {
      const p = u.searchParams.get('p'); let st = null; try { st = fs.statSync(p); } catch { /* none */ }
      if (!st || !st.isFile()) { head(res, 404, { 'content-length': 0 }); res.end(); return; }
      const s = span(req.headers.range, st.size); const type = /\.(srt|ass)$/i.test(p) ? 'text/plain; charset=utf-8' : 'application/octet-stream';
      if (s.code === 416) { head(res, 416, { 'content-range': `bytes */${st.size}`, 'content-length': 0 }); res.end(); return; }
      head(res, s.code, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': s.to - s.from + 1, ...(s.code === 206 ? { 'content-range': `bytes ${s.from}-${s.to}/${st.size}` } : {}) });
      if (headOnly) { res.end(); return; } fs.createReadStream(p, { start: s.from, end: s.to }).pipe(res); return;
    }
    if (route === 'audio') { head(res, 200, { 'content-type': 'audio/aac' }); res.end(); return; }
    if (route === 'video') { const src = u.searchParams.get('src'); head(res, src ? 200 : 400, { 'content-type': u.searchParams.get('c') === 'vp9' ? 'video/webm' : 'video/mp4', 'content-length': 0 }); res.end(); return; }
    if (route === 'p') {
      const target = u.searchParams.get('u'); const hs = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36' };
      for (const [k, v] of Object.entries(JSON.parse(u.searchParams.get('h') || '{}'))) hs[k.toLowerCase()] = String(v);
      if (req.headers.range) hs.range = req.headers.range;
      const r = await fetch(target, { headers: hs, method: headOnly ? 'HEAD' : 'GET' }); const pass = {};
      for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) pass[k] = v; }
      head(res, r.status, pass); res.end(Buffer.from(await r.arrayBuffer())); return;
    }
    if (route === 't') {
      const sess = sessions.get(parts[3]); if (!sess || sess.cancelled) { head(res, 404, { 'content-length': 0 }); res.end(); return; }
      const e = sess.engine; const s = span(req.headers.range, e.data.length);
      if (s.code === 416) { head(res, 416, { 'content-range': `bytes */${e.data.length}`, 'content-length': 0 }); res.end(); return; }
      head(res, s.code, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': s.to - s.from + 1, ...(s.code === 206 ? { 'content-range': `bytes ${s.from}-${s.to}/${e.data.length}` } : {}) });
      if (headOnly) { res.end(); return; }
      res.flushHeaders(); // (the head goes at once, as the Rust server writes it before waiting for pieces)
      let pos = s.from; let gone = false; res.on('close', () => { gone = true; });
      while (pos <= s.to) {
        const n = Math.min(262144, s.to - pos + 1); const a = Math.floor(pos / e.piece), b = Math.floor((pos + n - 1) / e.piece);
        for (;;) { if (gone || sess.cancelled) { res.destroy(); return; } let all = true; for (let i = a; i <= b; i++) if (!e.have[i]) all = false; if (all) break; await new Promise((r) => setTimeout(r, 10)); }
        if (!res.write(e.data.subarray(pos, pos + n))) await new Promise((r) => res.once('drain', r)); pos += n;
      }
      res.end(); return;
    }
    head(res, 404, { 'content-length': 0 }); res.end();
  };
  const start = () => new Promise((r) => { if (server) return r(); server = http.createServer((q, s) => void onReq(q, s)); server.listen(0, '127.0.0.1', () => { port = server.address().port; r(); }); });
  let fake = null;
  return {
    get port() { return port; }, token, start, sessions,
    async invoke(o) {
      if (o.op === 'fake') {
        for (const x of sessions.values()) if (x.id === 'kt-selftest-stream') x.cancelled = true;
        const data = crypto.randomBytes(o.size); fake = { data, piece: o.piece, have: new Array(Math.ceil(o.size / o.piece)).fill(false) };
        await start(); const key = crypto.randomBytes(10).toString('hex'); sessions.set(key, { id: 'kt-selftest-stream', engine: fake, cancelled: false });
        return { url: `http://127.0.0.1:${port}/${token}/t/${key}/stream%20test.mp4`, id: 'kt-selftest-stream', size: o.size, b64: data.toString('base64') };
      }
      if (o.op === 'release') { for (let i = o.from; i <= Math.min(o.to, fake.have.length - 1); i++) fake.have[i] = true; return {}; }
      if (o.op === 'live') return { live: opts.bad === 'live' ? 1 : live };
      if (o.op === 'serverStop') { const p = port; for (const x of sessions.values()) x.cancelled = true; sessions.clear(); await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); }); server = null; return { ended: true, portFree: true, port: p, live: 0 }; }
      return { skip: 'no swarm here' };
    },
    kt: (fsRoot) => ({
      streamUrl: async () => ({ url: 'x' }),
      streamDone: async (o) => { for (const x of sessions.values()) if (x.id === o.id) x.cancelled = true; return { ok: true }; },
      streamStats: async (o) => { const x = [...sessions.values()].find((y) => y.id === o.id && !y.cancelled); if (!x) return null; const n = x.engine.have.filter(Boolean).length; return { down: 0, up: 0, peers: 0, progress: opts.bad === 'stats' ? 0.5 : n / x.engine.have.length, buffered: [[0, x.engine.data.length - 1]], engine: 'selftest' }; },
      fileUrl: async (p) => { await start(); return `http://127.0.0.1:${port}/${token}/f?p=${encodeURIComponent(p)}`; },
      audioUrl: async () => { await start(); return { url: `http://127.0.0.1:${port}/${token}/audio` }; },
      videoUrl: async () => { await start(); return { url: `http://127.0.0.1:${port}/${token}/video` }; },
      proxyUrl: async (o) => { await start(); return `http://127.0.0.1:${port}/${token}/p?u=${encodeURIComponent(o.url)}&h=${encodeURIComponent(JSON.stringify(o.headers || {}))}`; },
      writeTempBytes: async (o) => { const d = path.join(fsRoot, o.sub || ''); fs.mkdirSync(d, { recursive: true }); const p = path.join(d, o.name); fs.writeFileSync(p, Buffer.from(o.b64, 'base64')); return p; },
    }),
  };
}

/** A test server like the shell's own: /headers echoes the request's headers; /big/* is 2 MiB with ranges. */
function testServer() {
  const big = crypto.randomBytes(2 * 1024 * 1024);
  const s = http.createServer((req, res) => {
    if (req.url === '/headers') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\n')); return; }
    if (req.url.startsWith('/big/')) { const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || ''); if (m) { const a = Number(m[1]), b = Number(m[2]); res.writeHead(206, { 'content-range': `bytes ${a}-${b}/${big.length}`, 'content-length': b - a + 1, 'accept-ranges': 'bytes' }); res.end(big.subarray(a, b + 1)); return; } res.writeHead(200, { 'content-length': big.length }); res.end(big); return; }
    res.writeHead(404); res.end();
  });
  return { s, big, sha: crypto.createHash('sha256').update(big).digest('hex') };
}

async function selftestPart() {
  const win = {}; vm.runInContext(SELFTEST, vm.createContext({ window: win, Promise, Object, Array, String, Error, JSON, Uint8Array, Date, setTimeout, clearTimeout, Math }));
  const lib = win.__KT_SELFTEST_LIB__;
  const ts = testServer(); await new Promise((r) => ts.s.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${ts.s.address().port}`;
  for (const bad of [null, 'stats', 'live']) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-p4-')); const srv = fakeStreamServer({ bad }); const results = [];
    const cfg = { base, bigSize: ts.big.length, bigSha256: ts.sha, aria2Bin: null };
    function rec(name, okv, detail, required) { results.push({ name, ok: !!okv, detail: String(detail), required: required !== false }); return !!okv; }
    function within(p, ms) { let t; return Promise.race([p, new Promise((_r, no) => { t = setTimeout(() => no(new Error('timeout')), ms); })]).finally(() => clearTimeout(t)); }
    const check = async (name, required, fn, ms) => { try { const d = await within(Promise.resolve().then(fn), ms || 20000); return rec(name, true, d, required); } catch (e) { return rec(name, false, (e && e.message) || e, required); } };
    const must = (c, w) => { if (!c) throw new Error(w); };
    const env = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), now: () => Date.now(), fetch, invoke: (cmd, a) => (cmd === 'kt_selftest_stream' ? srv.invoke(a.o) : Promise.resolve(null)), sha256: async (u) => crypto.createHash('sha256').update(u).digest('hex') };
    const waitFor = async (fn, ms, what) => { const until = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) throw new Error('timeout: ' + what); await env.sleep(20); } };
    await lib.runP4(srv.kt(tmp), cfg, env, check, must, waitFor, false);
    const req = results.filter((r) => r.required); const failed = req.filter((r) => !r.ok).map((r) => r.name);
    if (!bad) {
      ok('self-test P4 against a right server: every required check passes (' + req.length + ')', req.length >= 10 && failed.length === 0, results.filter((r) => !r.ok));
      ok('… the swarm and ffmpeg checks are reported only', results.filter((r) => !r.required).every((r) => /swarm|ffmpeg/.test(r.name)) && results.some((r) => /swarm/.test(r.name)));
    } else ok(`self-test P4 against a wrong server (${bad}) fails`, failed.length === 1 && (bad === 'stats' ? /streamStats/.test(failed[0]) : /streamDone/.test(failed[0])), failed);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  ts.s.close();
}

/* ---------- part 1: the page ---------- */
async function pagePart() {
  let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('playwright not found — page part skipped'); return; }
  const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-streamtauri-'));
  try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-t', '6', '-c:v', 'libvpx', '-b:v', '200k', path.join(MEDIA, 'ep1.webm')]); }
  catch { console.log('ffmpeg not available — page part skipped'); return; }
  const served = [];
  const web = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
    if (p.startsWith('/stream/')) {
      served.push(req.headers.range || 'whole'); const f = path.join(MEDIA, 'ep1.webm'); const size = fs.statSync(f).size; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
      const a = m ? Number(m[1]) : 0; const b = m && m[2] ? Number(m[2]) : size - 1;
      res.writeHead(m ? 206 : 200, { 'content-type': 'video/webm', 'accept-ranges': 'bytes', 'content-length': b - a + 1, ...(m ? { 'content-range': `bytes ${a}-${b}/${size}` } : {}), 'access-control-allow-origin': '*' });
      if (req.method === 'HEAD') { res.end(); return; } fs.createReadStream(f, { start: a, end: b }).pipe(res); return;
    }
    let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  }).listen(0); const port = web.address().port;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  for (const lang of ['en', 'ar']) {
    const p = await br.newPage({ viewport: { width: 1200, height: 760 } }); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(({ lang, port }) => {
      localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
      window.__calls = [];
      const task = { id: 'g7', kind: 'torrent', name: 'Show', source: { magnet: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567' }, dir: '/home/u/Downloads/Kurokawa', state: 'downloading', done: 1000, total: 5000000, downSpeed: 2048, upSpeed: 0, peers: 2, infoHash: '0123456789abcdef0123456789abcdef01234567', files: [{ index: 0, path: 'Show/ep1.webm', size: 5000000, done: 1000, priority: 1 }], addedAt: Date.now() - 1000 };
      const reply = (cmd, a) => {
        if (cmd === 'kt_state' || cmd === 'kt_engine_retry') return { available: true, reason: '', os: 'linux', arch: 'x64' };
        if (cmd === 'kt_list') return [task];
        if (cmd === 'kt_stream_url') return { url: `http://127.0.0.1:${port}/stream/0123456789abcdef0123456789abcdef/t/s1/ep1.webm` };
        if (cmd === 'kt_stream_stats') return { down: 123456, up: 0, peers: 7, progress: 0.2, buffered: [[0, 999]], engine: 'aria2' };
        if (cmd === 'kt_stream_done') return { ok: true };
        if (cmd === 'kt_siblings') return [];
        return null;
      };
      window.__TAURI__ = { core: { invoke: (cmd, a) => { window.__calls.push({ cmd, a }); return Promise.resolve(reply(cmd, a)); } }, event: { listen: () => Promise.resolve(() => {}) } };
      window.__KT_BOOT__ = { os: 'linux', arch: 'x64' };
    }, { lang, port });
    await p.addInitScript(BRIDGE);
    await p.goto(`http://127.0.0.1:${port}/#/task/g7`);
    const label = lang === 'en' ? 'Play while downloading' : 'تشغيل في أثناء التنزيل';
    await p.waitForSelector('.task-detail-actions button', { timeout: 15000 });
    const btns = await p.$$eval('.task-detail-actions button', (bs) => bs.map((b) => b.textContent.trim()));
    const streamBtn = await p.evaluateHandle((label) => [...document.querySelectorAll('.task-detail-actions button')].find((b) => b.textContent.includes(label)), label);
    ok(`${lang}: «Play while downloading» offered for a torrent still downloading`, !!(await streamBtn.asElement()), btns);
    await streamBtn.asElement().click();
    await p.waitForSelector('.kt-player video.kt-video', { timeout: 15000 });
    const call = await p.evaluate(() => window.__calls.find((c) => c.cmd === 'kt_stream_url'));
    ok(`${lang}: the player asked kt_stream_url for that download's file`, call && call.a.o.id === 'g7' && call.a.o.fileIndex === 0, call);
    const src = await p.$eval('.kt-player video.kt-video', (v) => v.currentSrc || v.src);
    ok(`${lang}: the <video> reads the stream server's address`, /\/stream\/.*\/ep1\.webm$/.test(src), src);
    const played = await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 0.2, null, { timeout: 15000 }).then(() => true, () => false);
    ok(`${lang}: it plays, read with ranges`, played && served.some((r) => /^bytes=/.test(r)), served.slice(0, 5));
    // (A wait: the waiting line asks streamStats and shows its speed and peers.)
    await p.evaluate(() => document.querySelector('.kt-video').dispatchEvent(new Event('waiting')));
    const line = await p.waitForFunction(() => { const w = document.querySelector('.kt-wait'); return w && !w.hidden && w.textContent ? w.textContent : null; }, null, { timeout: 8000 }).then((h) => h.jsonValue(), () => '');
    const asked = await p.evaluate(() => window.__calls.filter((c) => c.cmd === 'kt_stream_stats').map((c) => c.a.o.id));
    ok(`${lang}: the waiting line shows streamStats' speed and peers`, asked.includes('g7') && /12[01]|١٢[٠١]/.test(line) && /7|٧/.test(line), { line, asked });
    // (Closed: kt_stream_done for that download.)
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    if (await p.$('.kt-player')) { const close = await p.$('.kt-player [aria-label="Close"], .kt-player .kt-close, .kt-player button.back'); if (close) await close.click(); else await p.keyboard.press('Escape'); }
    const done = await p.waitForFunction(() => window.__calls.some((c) => c.cmd === 'kt_stream_done'), null, { timeout: 8000 }).then(() => true, () => false);
    const dcall = await p.evaluate(() => window.__calls.find((c) => c.cmd === 'kt_stream_done'));
    ok(`${lang}: closing the player sends kt_stream_done for it`, done && dcall.a.o.id === 'g7', dcall);
    ok(`${lang}: no page errors`, errors.length === 0, errors);
    await p.close();
  }
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
}

(async () => {
  await selftestPart();
  await pagePart();
  console.log(fails ? `streamtauri: ${fails} failed` : 'streamtauri: ok');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
