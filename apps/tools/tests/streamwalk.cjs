// node tests/streamwalk.cjs : playing something that is not a finished local file, against a source that misbehaves
// on purpose. Everything is on 127.0.0.1 with made-up data: a clip made here by ffmpeg's test pattern, served the way a
// download still coming is (a torrent's file through the phone's / computer's stream server) by a server this test
// can tell to be slow, stall, drop, ignore or refuse ranges, lie about its length, redirect, end early, never answer
// or expire; plus a made-up HLS list served here for the computer's HLS remux (ffmpeg with the shell's arguments).
// For each case: what the viewer sees (the state line, the spinner, an error with a way out), that playback recovers
// when it can, that nothing is left behind after close (connections still open, intervals), that the position is
// kept, and that the words are the UI language's (en + ar). Phone 360x800 and computer 1280x800.
// Env: WALK_SIZES=360,1280  WALK_LANGS=en,ar  WALK_SHOTS=<dir>  WALK_ONLY=<case,case>
const { chromium, devices } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto'); const { execFileSync, spawn } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-swalk-'));
const SHOTS = process.env.WALK_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-swalkshots-'));
const CLIP = path.join(MEDIA, 'clip.webm');
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '40', '-c:v', 'libvpx', '-b:v', '260k', '-g', '25', '-c:a', 'libopus', '-b:a', '32k', CLIP]); }
catch { if (process.env.KT_REQUIRE_FFMPEG) { console.log('FAIL ffmpeg is required here (KT_REQUIRE_FFMPEG)'); process.exit(1); } console.log('ffmpeg not available - skipped'); process.exit(0); }
const DATA = fs.readFileSync(CLIP); const SIZE = DATA.length;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let fails = 0, passes = 0; const faultLog = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIZES = (process.env.WALK_SIZES || '360,1280').split(',').map(Number); const LANGS = (process.env.WALK_LANGS || 'en,ar').split(',');
const ONLY = process.env.WALK_ONLY ? process.env.WALK_ONLY.split(',') : null;
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 1500000).unref();

// ---- the source that misbehaves (one mode at a time; «first» faults hit only the first connection of an open)
const SRC = { mode: 'ok', rate: 90 * 1024, conns: new Set(), reqs: [], expired: false, firstDone: false };
const RANGE = (h, size) => { const m = /bytes=(\d*)-(\d*)/.exec(h || ''); if (!m) return null; const a = m[1] ? Number(m[1]) : 0; const b = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1; return { a, b }; };
async function source(q, r) {
  const mode = SRC.mode; SRC.reqs.push({ mode, range: q.headers.range || '', at: Date.now() });
  r.on('close', () => SRC.conns.delete(r)); SRC.conns.add(r); r.info = `${mode} ${q.url} ${q.headers.range || ''}`; r.caseNo = SRC.caseNo;
  const red = /[?&]hop=(\d)/.exec(q.url); const hop = red ? Number(red[1]) : 0;
  if (mode === 'redir' && hop < 5) { r.writeHead(302, { location: q.url.replace(/[?&]hop=\d/, '') + (q.url.includes('?') && !/[?&]hop=/.test(q.url.split('?')[1]) ? '&' : '?') + `hop=${hop + 1}` }); r.end(); return; }
  if (SRC.expired) { r.writeHead(403, { 'content-length': 0 }); r.end(); return; }
  const first = !SRC.firstDone; SRC.firstDone = true;
  if (mode === 'slow' && first) await sleep(5000);
  if (r.destroyed) return;
  const size = mode === 'short' ? Math.floor(SIZE * 0.6) : SIZE;
  let span = RANGE(q.headers.range, size);
  if (span && mode === 'r416' && span.a > 0) { r.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 }); r.end(); return; }
  if (span && (span.a >= size || span.a > span.b)) { r.writeHead(416, { 'content-range': `bytes */${size}`, 'content-length': 0 }); r.end(); return; }
  if (mode === 'r200') span = null;
  const a = span ? span.a : 0, b = span ? span.b : size - 1;
  const lie = mode === 'badlen' ? 400000 : 0;
  r.writeHead(span ? 206 : 200, { 'content-type': 'video/webm', 'accept-ranges': mode === 'r200' ? 'none' : 'bytes', 'content-length': b - a + 1 + lie, ...(span ? { 'content-range': `bytes ${a}-${b + lie}/${size + lie}` } : {}) });
  if (q.method === 'HEAD') { r.end(); return; }
  if (mode === 'never') return; // (the head, then nothing until the reader leaves)
  let pos = a; const chunk = 16384; const tick = Math.max(5, Math.round((chunk / SRC.rate) * 1000));
  while (pos <= b && !r.destroyed) {
    if (first && mode === 'stall' && pos >= SIZE * 0.15 && !r.stalled) { r.stalled = true; await sleep(20000); if (r.destroyed) return; }
    if (first && mode === 'drop' && pos >= SIZE * 0.4) { r.destroy(); return; }
    const n = Math.min(chunk, b - pos + 1); r.sent = (r.sent | 0) + n; if (!r.write(DATA.subarray(pos, pos + n))) await new Promise((ok) => r.once('drain', ok)); pos += n; await sleep(tick);
  }
  if (!r.destroyed) { if (lie) r.destroy(); else r.end(); }
}
const serve = () => http.createServer((q, r) => {
  if (q.url.startsWith('/t/')) { void source(q, r); return; }
  let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});

// ---- the made-up phone / computer: one torrent still coming (its file streamed by the app's stream server). The
// phone's server address is the same each time (/<task>/<file>); the computer's has a new session in it each open.
const FIXTURE = (lang, port, pc, size) => {
  const now = Date.now(); const hash = Array.from(crypto.getRandomValues(new Uint8Array(20)), (x) => x.toString(16).padStart(2, '0')).join('');
  // (s: a file still coming over HTTP; z: a torrent still coming — its waiting line is the swarm's.)
  const mk = (id, kind, name) => ({ id, kind, name, source: kind === 'torrent' ? { magnet: `magnet:?xt=urn:btih:${hash}` } : { url: `https://example.invalid/${id}.webm` }, dir: '/sdcard/Download', state: 'downloading', done: Math.floor(size / 2), total: size, downSpeed: 2e6, upSpeed: 0, peers: kind === 'torrent' ? 9 : undefined, files: [{ index: 0, path: `${name}/clip.webm`, size, done: Math.floor(size / 2), priority: 1 }], addedAt: now - 60e3, engine: 'native' });
  const tasks = [mk('s', 'http', 'Made-up show 01'), mk('z', 'torrent', 'Made-up show 02')];
  window.__opens = 0;
  const api = {
    addListener: async () => ({ remove() {} }), list: async () => ({ tasks }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
    streamUrl: async (o) => { window.__opens++; return { url: pc ? `http://127.0.0.1:${port}/t/${Math.random().toString(36).slice(2, 10)}/${o.id}/clip.webm` : `http://127.0.0.1:${port}/t/${o.id}/0` }; },
    siblings: async () => ({ paths: [] }), orientation: async () => ({}), pip: async () => ({ ok: true }), pipAuto: async () => ({}),
  };
  const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  try { localStorage.setItem('kr.lang', lang); if (!sessionStorage.getItem('walk-init')) { sessionStorage.setItem('walk-init', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], navOrder: ['downloads'], playerWith: 'app', playerEngine: 'web' })); localStorage.setItem('kt.player', JSON.stringify({ controlsTimeout: 2 })); localStorage.setItem('kt.player.hint', '1'); } } catch { /* blank */ }
  // (Intervals started and not cleared, counted: what a closed player leaves behind.)
  const live = new Set(); const si = window.setInterval, ci = window.clearInterval;
  window.setInterval = (...a) => { const id = si(...a); live.add(id); return id; }; window.clearInterval = (id) => { live.delete(id); return ci(id); }; window.__liveIntervals = () => live.size;
  if (pc) document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('pc'));
};

const STATE = () => {
  const v = document.querySelector('.kt-video'); const root = document.querySelector('.kt-player');
  const vis = (e) => !!e && !e.hidden && !e.closest('[hidden]') && e.getBoundingClientRect().width > 0;
  const sheet = document.querySelector('.sheet'); const toastEl = document.querySelector('.toast');
  const wait = root && root.querySelector('.kt-wait'); const notice = root && root.querySelector('.kt-notice'); const centre = root && root.querySelector('.kt-centre');
  let ahead = 0; if (v) for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1) ahead = Math.max(ahead, v.buffered.end(i) - v.currentTime);
  return { open: !!root, t: v ? v.currentTime : -1, d: v ? v.duration : -1, paused: v ? v.paused : true, ended: v ? v.ended : false, rs: v ? v.readyState : -1, err: v && v.error ? v.error.code : 0, ahead,
    busy: !!(centre && centre.classList.contains('busy')), wait: vis(wait) ? wait.textContent : '', notice: vis(notice) ? notice.textContent : '',
    sheet: vis(sheet) ? { title: (sheet.querySelector('.sheet-head, h2, h3') || {}).textContent || '', text: sheet.textContent.slice(0, 300), buttons: [...sheet.querySelectorAll('button')].filter(vis).map((b) => (b.textContent || b.getAttribute('aria-label') || '').trim()).filter(Boolean) } : null,
    toast: vis(toastEl) ? toastEl.textContent : '', src: v ? v.currentSrc : '' };
};

// ---- HLS (the computer's remux): a made-up list served here; ffmpeg run with the shell's arguments (streamlogic.rs's
// remux_args, which this test reads back from the source so a change there is seen).
async function hlsPart() {
  const dir = path.join(MEDIA, 'hls'); fs.mkdirSync(dir);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=330', '-t', '12', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '25', '-c:a', 'aac', '-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', path.join(dir, 'list.m3u8')]);
  const rs = fs.readFileSync(path.join(__dirname, '..', 'core', 'kt-core', 'src', 'streamlogic.rs'), 'utf8');
  const body = /pub fn remux_args[\s\S]*?\n}\n/.exec(rs)[0];
  // (Every strs(&[…]) list of remux_args in order: the first ends with -user_agent (its value given here), the ones
  // before v.push("-i") are input options, the last is the output's.)
  const lists = [...body.matchAll(/strs\(&\[([\s\S]*?)\]\)/g)].map((m) => ({ at: m.index, w: [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]) }));
  const iAt = body.indexOf('v.push("-i"'); const pre = lists.filter((l) => l.at < iAt); const post = lists.filter((l) => l.at > iAt);
  const args = (u) => [...pre[0].w, 'kt-walk', ...pre.slice(1).flatMap((l) => l.w), '-i', u, ...post.flatMap((l) => l.w).map((w) => (w === 'pipe:1' ? path.join(dir, `out-${crypto.randomBytes(3).toString('hex')}.mp4`) : w))];
  const results = {};
  for (const mode of ['ok', '404once', 'never']) {
    let hit = 0; const seen = new Set();
    const srv = http.createServer((q, r) => {
      const f = path.join(dir, path.basename(q.url.split('?')[0]));
      if (/list2\.ts$/.test(f)) { hit++; if (mode === '404once' && !seen.has('2')) { seen.add('2'); r.writeHead(404); r.end(); return; } if (mode === 'never') { r.writeHead(200, { 'content-type': 'video/mp2t' }); return; } }
      if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; } r.writeHead(200); fs.createReadStream(f).pipe(r);
    }).listen(0, '127.0.0.1'); await new Promise((r) => srv.once('listening', r));
    const t0 = Date.now(); const a = args(`http://127.0.0.1:${srv.address().port}/list.m3u8`); const out = a[a.length - 1];
    const code = await new Promise((res) => { const pr = spawn('ffmpeg', a, { stdio: ['ignore', 'ignore', 'pipe'] }); let err = ''; pr.stderr.on('data', (d) => { err += d; }); const kill = setTimeout(() => { pr.kill('SIGKILL'); }, 60000); pr.on('close', (c) => { clearTimeout(kill); res({ c, err: err.slice(-300) }); }); });
    let dur = 0; try { dur = Number(execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_packets', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]).toString().trim()) / 25 || 0; } catch { /* none */ }
    results[mode] = { secs: (Date.now() - t0) / 1000, code: code.c, dur, hit }; srv.close(); srv.closeAllConnections?.();
  }
  return results;
}

(async () => {
  const web = serve().listen(0, '127.0.0.1'); await new Promise((r) => web.once('listening', r)); const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const b = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const cases = ['ok', 'slow', 'stall', 'drop', 'r200', 'r416', 'badlen', 'redir', 'short', 'never', 'seek90', 'seeks10', 'expire', 'closestart', 'twoquick', 'background', 'offline', 'resume'];
  for (const W of SIZES) for (const lang of LANGS) {
    const pc = W >= 1000; const H = 800; const tag = `${pc ? 'pc' : 'phone'}${W}${lang}`;
    const ctx = await b.newContext(pc ? { viewport: { width: W, height: H }, deviceScaleFactor: 1 } : { ...devices['Pixel 7'], viewport: { width: W, height: H }, screen: { width: W, height: H }, deviceScaleFactor: 1 });
    const p = await ctx.newPage(); const pageErrors = []; p.on('pageerror', (e) => pageErrors.push(e.message));
    await p.addInitScript(`(${FIXTURE.toString()})(${JSON.stringify(lang)}, ${port}, ${pc}, ${SIZE})`);
    const ok = (name, c, x) => { if (c) passes++; else { fails++; faultLog.push(`${tag} ${name} ${x === undefined ? '' : JSON.stringify(x).slice(0, 400)}`); } console.log((c ? 'ok   ' : 'FAIL ') + `[${tag}] ` + name + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); };
    const shot = async (name) => { try { await p.screenshot({ path: path.join(SHOTS, `D3-${tag}-${name}.png`) }); } catch { /* gone */ } };
    const st = () => p.evaluate(STATE);
    const until = (fn, arg, ms = 8000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
    const fresh = async () => { await p.goto('about:blank'); await p.goto(base + '#/'); await p.waitForSelector('.task-card', { timeout: 10000 }); await sleep(200); };
    const reset = (mode) => { SRC.caseNo = (SRC.caseNo | 0) + 1; SRC.mode = mode; SRC.expired = false; SRC.firstDone = false; SRC.reqs = []; };
    const open = async (mode, keepMemory, id = 's') => { reset(mode); if (!keepMemory) await p.evaluate(() => { try { localStorage.removeItem('kt.player.memory'); } catch { /* none */ } }); await fresh(); await press(id); };
    // (What the viewer is shown over a while: every line and notice seen, sampled.)
    const seen = async (ms, every = 250) => { const out = new Set(); const end = Date.now() + ms; while (Date.now() < end) { const s = await st(); if (s.wait) out.add(s.wait); if (s.notice) out.add(s.notice); if (s.sheet) out.add('SHEET ' + s.sheet.text.slice(0, 80)); await sleep(every); } return [...out]; };
    const press = async (id = 's') => { if (!(await p.$('.task-detail-actions .btn:has(polygon)'))) await p.click(`.task-card[data-id="${id}"] .task-main`); await p.waitForSelector('.task-detail-actions .btn polygon', { timeout: 8000 }); await p.click('.task-detail-actions .btn:has(polygon)'); await p.waitForSelector('.kt-player video.kt-video', { timeout: 8000, state: 'attached' }); };
    const closePlayer = async () => { await p.evaluate(() => document.querySelector('.kt-player') && document.querySelector('.kt-player').dispatchEvent(new Event('kt-close'))); await until(() => !document.querySelector('.kt-player'), null, 4000); };
    const playing = (from, ms = 15000) => until((f) => { const v = document.querySelector('.kt-video'); return v && !v.paused && v.currentTime > f + 1; }, from, ms);
    const ar = lang === 'ar'; const arabic = (s) => /[؀-ۿ]/.test(s) && !/[a-zA-Z]{4,}/.test(s.replace(/HTTP|\d/g, ''));
    const words = (s) => !s || (ar ? arabic(s) : !/[؀-ۿ]/.test(s));
    // (This case's connections to the source: all ended within 6 s of the close.)
    const afterClose = async (what) => { const end = Date.now() + 6000; let left = []; do { await sleep(250); left = [...SRC.conns].filter((x) => x.caseNo === SRC.caseNo); } while (left.length && Date.now() < end); ok(`${what}: no connection to the source left open after close`, left.length === 0, left.map((x) => `${x.info} socket ${x.socket ? (x.socket.destroyed ? 'gone' : 'open') : 'none'} sent ${x.sent | 0}`)); };
    const run = (c) => (!ONLY || ONLY.includes(c)) && (lang === 'en' || ['ok', 'slow', 'stall', 'r416', 'never', 'expire', 'offline'].includes(c));
    try {
      await fresh(); const iv0 = await p.evaluate(() => window.__liveIntervals());
      for (const c of cases) {
        if (!run(c)) continue; const t0 = Date.now();
        if (c === 'ok') {
          await open('ok'); const went = await playing(0); ok('a stream that behaves plays', went, await st()); await closePlayer();
          await open('slow', false, 'z'); const lines = await seen(4000); ok('a torrent coming slowly: the waiting line is the swarm\'s (speed, peers)', lines.some((x) => /9/.test(x) && words(x)), lines); await closePlayer();
        }
        if (c === 'slow') {
          await open('slow'); await sleep(2500); const s = await st(); await shot('buffering');
          ok('slow first byte (5 s): a spinner while it starts', s.busy, s); ok('slow first byte: a line says what is happening', !!s.wait, s); ok('slow first byte: the line is in the UI language', words(s.wait), s.wait);
          if (lang === 'en' && !pc) fs.copyFileSync(path.join(SHOTS, `D3-${tag}-buffering.png`), path.join(SHOTS, 'D3-buffering-en.png'));
          ok('slow first byte: then it plays', await playing(0, 15000), await st()); await closePlayer();
        }
        if (c === 'stall') {
          await open('stall'); await playing(0, 15000); const got = await until(() => document.querySelector('.kt-centre.busy'), null, 15000); const s = await st();
          ok('stall mid-stream: the spinner shows', got, s); await sleep(1800); const s2 = await st(); ok('stall: the line says it is buffering, in the UI language', !!s2.wait && words(s2.wait), s2);
          ok('stall: the line tells how many seconds are ready (a number)', /[0-9]/.test(s2.wait), s2.wait);
          await shot('stall'); if (lang === 'en' && !pc) fs.copyFileSync(path.join(SHOTS, `D3-${tag}-stall.png`), path.join(SHOTS, 'D3-imp-1.png')); if (lang === 'en' && pc) fs.copyFileSync(path.join(SHOTS, `D3-${tag}-stall.png`), path.join(SHOTS, 'D3-pc-en.png'));
          const at = s2.t; ok('stall: playback goes on by itself (within 25 s)', await playing(at, 25000), await st()); ok('stall: no error shown', !(await st()).sheet, await st()); await closePlayer(); await afterClose('stall');
        }
        if (c === 'drop') { await open('drop'); await playing(0); const s = await st(); const went = await until((f) => { const v = document.querySelector('.kt-video'); return v.currentTime > f + 12; }, s.t, 35000); ok('connection dropped at 40 %: playback goes on past it', went, await st()); await closePlayer(); await afterClose('drop'); }
        if (c === 'r200' || c === 'r416' || c === 'badlen' || c === 'never') {
          await open(c); if (c !== 'never') await playing(0, 12000);
          if (c === 'never') { await sleep(9000); const l = await seen(4000, 200); if (lang === 'en' && !pc) { await sleep(10); } ok('never: the line says the stream is asked again', l.some((x) => words(x) && x.length > 8), l); if (lang === 'en' && !pc) await p.screenshot({ path: path.join(SHOTS, 'D3-imp-2.png') }); }
          if (c !== 'never') await p.evaluate(() => { const v = document.querySelector('.kt-video'); v.currentTime = v.duration * 0.75; });
          const settled = await until((cc) => { const v = document.querySelector('.kt-video'); const sh = document.querySelector('.sheet'); return (sh && !sh.hidden) || (v && !v.paused && v.currentTime > v.duration * 0.75 + 1) || (cc === 'never' && v.currentTime > 1) || (cc === 'r200' && document.querySelector('.kt-notice:not([hidden])')); }, c, 40000);
          await sleep(900); const s = await st(); if (c === 'r416' || c === 'never') await shot(c);
          const told = c === 'r200' && (await p.evaluate(() => !!document.querySelector('.kt-notice:not([hidden])')));
          ok(`${c}: the viewer is never left waiting with nothing (it plays, or is told, or an error with a way out)`, settled || told, s);
          if (c === 'r416' && lang === 'ar' && !pc && s.sheet) fs.copyFileSync(path.join(SHOTS, `D3-${tag}-r416.png`), path.join(SHOTS, 'D3-error-ar.png'));
          if (s.sheet) { ok(`${c}: the error has a way out (retry and back)`, s.sheet.buttons.length >= 2, s.sheet); ok(`${c}: the error is in the UI language`, words(s.sheet.text.replace(/HTTP \d+/g, '')), s.sheet.text); }
          await closePlayer(); await afterClose(c);
        }
        if (c === 'redir') { await open('redir'); ok('a chain of 5 redirects plays', await playing(0), await st()); await closePlayer(); }
        if (c === 'short') {
          await open('short'); await playing(0); const end = await until(() => { const v = document.querySelector('.kt-video'); const sh = document.querySelector('.sheet'); return v.ended || (sh && !sh.hidden) || document.querySelector('.kt-notice:not([hidden])') || document.querySelector('.kt-centre.busy'); }, null, 45000);
          await until(() => document.querySelector('.sheet:not([hidden])'), null, 30000); await sleep(900); const s = await st(); await shot('short'); ok('a stream that ends early: the viewer is told (not a silent stop or a spinner for ever)', end && (!!s.sheet || !!s.notice) && !s.busy, s);
          const w = await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('kt.player.memory') || '{}')).some((m) => m.watched)); ok('a stream that ends early is not counted as watched', !w); await closePlayer();
        }
        if (c === 'seek90') { await open('ok'); await until(() => document.querySelector('.kt-video').duration > 0, null, 10000); await p.evaluate(() => { const v = document.querySelector('.kt-video'); v.currentTime = v.duration * 0.9; }); const went = await until(() => { const v = document.querySelector('.kt-video'); return !v.paused && v.currentTime > v.duration * 0.9 + 0.8; }, null, 15000); ok('a seek to 90 % at once plays from there', went, await st()); await closePlayer(); await afterClose('seek90'); }
        if (c === 'seeks10') {
          await open('ok'); await playing(0); for (let i = 0; i < 10; i++) { await p.evaluate((f) => { const v = document.querySelector('.kt-video'); v.currentTime = v.duration * f; }, [0.2, 0.7, 0.4, 0.9, 0.1, 0.6, 0.3, 0.8, 0.5, 0.55][i]); await sleep(200); }
          const went = await until(() => { const v = document.querySelector('.kt-video'); return !v.paused && Math.abs(v.currentTime - v.duration * 0.55) < 6 && v.readyState >= 3; }, null, 15000); const s = await st();
          ok('ten seeks in two seconds: it plays from the last one', went, s); ok('ten seeks: no error', !s.sheet && !s.err, s); await sleep(1500); { const mine = [...SRC.conns].filter((x) => x.caseNo === SRC.caseNo); ok('ten seeks: at most 3 connections to the source still open', mine.length <= 3, mine.map((x) => x.info)); } await closePlayer(); await afterClose('seeks10');
        }
        if (c === 'expire') {
          await open('ok'); await playing(0); await p.evaluate(() => document.querySelector('.kt-video').pause()); const at = (await st()).t; SRC.expired = true;
          await p.evaluate(() => { const v = document.querySelector('.kt-video'); v.currentTime = Math.min(v.duration - 3, v.currentTime + 25); });
          await sleep(1000); const s0 = await st(); setTimeout(() => { SRC.expired = false; }, 2500);
          await p.evaluate(() => void document.querySelector('.kt-video').play().catch(() => undefined));
          await until(() => { const w = document.querySelector('.kt-wait'); return w && !w.hidden && w.textContent.length > 8; }, null, 5000); if (lang === 'en' && !pc) await p.screenshot({ path: path.join(SHOTS, 'D3-imp-3.png') });
          const lines = await seen(1500, 150); ok('expired link: the viewer is told a new link is being fetched, in the UI language', lines.some((x) => words(x) && x.length > 8), lines);
          const back = await until(() => { const v = document.querySelector('.kt-video'); return v && !v.paused && v.readyState >= 3 && v.currentTime > 5; }, null, 20000); const s = await st();
          if (lang === 'ar') await shot('expired');
          ok('an expired link (403) after a long pause: playback comes back at the place it was', back && Math.abs(s.t - (at + 25)) < 12, { at, s0, s }); await closePlayer();
        }
        if (c === 'closestart') { await open('slow'); await sleep(800); await closePlayer(); await afterClose('close during start'); await sleep(5000); ok('close during start: the source asked nothing after close', SRC.reqs.filter((x) => x.at > Date.now() - 4500).length === 0, SRC.reqs); }
        if (c === 'twoquick') {
          await open('ok'); await sleep(600); await closePlayer(); SRC.firstDone = false; await press();
          ok('two opens one after the other: the second plays', await playing(0), await st()); ok('two opens: one player on screen', (await p.evaluate(() => document.querySelectorAll('.kt-player').length)) === 1); await sleep(1000); { const mine = [...SRC.conns].filter((x) => x.caseNo === SRC.caseNo); ok('two opens: at most 2 connections open (the second one only)', mine.length <= 2, mine.map((x) => x.info)); } await closePlayer(); await afterClose('two opens');
        }
        if (c === 'background') {
          await open('ok'); await playing(0); const hide = (hd) => p.evaluate((x) => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => x }); Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (x ? 'hidden' : 'visible') }); document.dispatchEvent(new Event('visibilitychange')); }, hd);
          await hide(true); await sleep(3000); await hide(false); const s = await st(); ok('background and back: still there, no error', s.open && !s.sheet && !s.err, s);
          ok('background and back: plays on', await playing(s.t, 10000), await st()); await closePlayer();
        }
        if (c === 'offline') {
          await open('ok'); await playing(0); await ctx.setOffline(true); await p.evaluate(() => window.dispatchEvent(new Event('offline'))); for (const x of SRC.conns) x.destroy();
          await sleep(2500); const s = await st(); if (lang === 'en') await shot('offline'); ok('offline: the viewer is told plainly, in the UI language', (!!s.notice || !!s.wait) && words(s.notice || s.wait), s);
          await ctx.setOffline(false); await p.evaluate(() => window.dispatchEvent(new Event('online'))); ok('online again: playback comes back by itself', await playing(s.t, 20000), await st()); await closePlayer();
        }
        if (c === 'resume') {
          await open('ok'); await playing(0); await p.evaluate(() => { const v = document.querySelector('.kt-video'); v.currentTime = 22; }); await until(() => document.querySelector('.kt-video').currentTime > 23, null, 10000); await closePlayer();
          await open('ok', true); await until(() => document.querySelector('.kt-video').currentTime > 1, null, 10000); const s = await st(); ok(`the position is kept for a stream (${pc ? 'a new address each open' : 'the same address'})`, s.t > 18, s); await closePlayer();
        }
        console.log(`     (${c}: ${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      }
      await sleep(1500); const iv1 = await p.evaluate(() => window.__liveIntervals()); ok('no interval left running by the closed players', iv1 <= iv0, { iv0, iv1 });
      ok('no page errors', pageErrors.length === 0, pageErrors.slice(0, 4));
    } catch (e) { ok('walk ran to the end', false, String(e && e.stack || e).slice(0, 600)); }
    await ctx.close();
  }
  if (!ONLY || ONLY.includes('hls')) {
    const h = await hlsPart(); console.log('     hls', JSON.stringify(h));
    const okh = (n, c, x) => { if (c) passes++; else { fails++; faultLog.push(`hls ${n} ${JSON.stringify(x)}`); } console.log((c ? 'ok   ' : 'FAIL ') + '[hls] ' + n + (c ? '' : '  ' + JSON.stringify(x))); };
    okh('a list that behaves is remuxed whole', h.ok.code === 0 && h.ok.dur > 11, h.ok);
    okh('a segment that fails once is asked again (nothing skipped)', h['404once'].code === 0 && h['404once'].dur > 11, h['404once']);
    okh('a segment that never arrives is given up on and the rest comes (no reader waiting for ever)', h.never.code === 0 && h.never.secs < 40 && h.never.dur > 9, h.never);
  }
  // The phone's relay (KtStream.java) answers a range the source ignored with the part asked for: its rule, compiled
  // alone with the cases of kt-core's streamlogic.rs range_from_whole (skipped without javac).
  if ((!ONLY || ONLY.includes('java')) && require('node:child_process').spawnSync('javac', ['-version']).status === 0) {
    const java = fs.readFileSync(path.join(__dirname, '..', 'native', 'android', 'KtStream.java'), 'utf8');
    const fn = /    static long\[\] rangeFromWhole[\s\S]*?\n    }\n/.exec(java);
    const okj = (n, c, x) => { if (c) passes++; else { fails++; faultLog.push(`java ${n} ${x}`); } console.log((c ? 'ok   ' : 'FAIL ') + '[java] ' + n + (c ? '' : '  ' + x)); };
    if (!fn) okj('KtStream.java has rangeFromWhole', false, 'not found');
    else {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-swalk-java-'));
      const cases = [['bytes=1000-', 200, 5000, '1000-4999'], ['bytes=10-19', 200, 5000, '10-19'], ['bytes=-100', 200, 5000, '4900-4999'], ['bytes=9000-', 200, 5000, '416'], ['bytes=0-', 200, 5000, 'pass'], ['bytes=0-4999', 200, 5000, 'pass'], [null, 200, 5000, 'pass'], ['bytes=1000-', 206, 4000, 'pass'], ['bytes=1000-', 403, 10, 'pass'], ['bytes=1000-', 200, -1, 'pass'], ['bytes=1000-', 200, 0, 'pass'], ['items=1-2', 200, 5000, 'pass']];
      fs.writeFileSync(path.join(dir, 'R.java'), `public class R {\n${fn[0]}\n  public static void main(String[] a) {\n${cases.map(([r, c, l]) => `    { long[] x = rangeFromWhole(${r === null ? 'null' : JSON.stringify(r)}, ${c}, ${l}L); System.out.println(x == null ? "pass" : x[0] < 0 ? "416" : x[0] + "-" + x[1]); }`).join('\n')}\n  }\n}\n`);
      try { execFileSync('javac', ['-d', dir, path.join(dir, 'R.java')]); const out = execFileSync('java', ['-cp', dir, 'R']).toString().trim().split('\n'); cases.forEach((c, i) => okj(`range ${c[0]} on a ${c[1]} of ${c[2]} bytes → ${c[3]}`, out[i] === c[3], out[i])); }
      catch (e) { okj('the rule compiles and runs', false, String(e.message).slice(0, 300)); }
    }
  }
  await b.close(); web.close();
  console.log(faultLog.length ? `\nFAULTS:\n${faultLog.join('\n')}` : '');
  console.log(`\nstreamwalk: ${passes} passed, ${fails} failed`); process.exit(fails ? 1 : 0);
})();
