// The video tools on the Tauri shell (stage P5).
// Part 1 — the self-test's P5 checks (desktop-tauri/selftest.js runP5) against a pretend bridge that behaves as the Rust
// side does (vtools.rs, vtjobs.rs, vtffmpeg.rs, vtstream.rs, vtselftest.rs): every check passes; a shell that keeps a
// broken release instead of rolling it back, one that leaves a cancelled ffmpeg's child running, and one whose pack
// download never resumes each fail the check that guards it; a build without the methods checks nothing.
// Part 2 — the page on the real desktop-tauri/bridge.js over a pretend Tauri IPC: a YouTube link in the Add sheet asks
// kt_video_ready / kt_video_info and offers the qualities; Add sends kt_add with o.video; the video task pushed as
// kt:tasks shows in the list; Settings → Video shows the version and rolls back through kt_video_rollback; a newer
// release the shell rolled back at once (its code) is told in the page's words.
// Run: NODE_PATH=$(npm root -g) node tests/videotauri.cjs
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm'); const http = require('node:http');
const ROOT = path.join(__dirname, '..');
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!cond) fails++; };

function loadLib() {
  const w = { addEventListener() {} };
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'selftest.js'), 'utf8'), vm.createContext({ window: w, Promise, Object, Array, String, Error, JSON, Uint8Array, Date, setTimeout, clearTimeout, encodeURIComponent, Math, RegExp, Number }));
  return w.__KT_SELFTEST_LIB__;
}

/** A pretend shell: programs, versions, jobs, packs and streams kept in memory, answering in the Rust side's shapes. */
function fakeShell(fault) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const subs = { tasks: [], update: [], pack: [], ff: [] };
  const sub = (k) => (cb) => { subs[k].push(cb); return () => { subs[k] = subs[k].filter((f) => f !== cb); }; };
  const emit = (k, x) => setTimeout(() => subs[k].forEach((f) => f(JSON.parse(JSON.stringify(x)))), 0);
  const files = new Map(); const alive = new Set(); const seen = [];
  const st = { yt: null, olds: [], served: { version: '2025.11.20', mode: 'ok', badSum: false }, gdl: null, pack: null, probeBeside: false };
  const tasks = []; const pushTasks = () => emit('tasks', tasks);
  let pid = 100; let cancelFlag = false;
  const TOKEN = '0123456789abcdef0123456789abcdef';
  const lab = { base: 'http://127.0.0.1:9', dir: '/tmp/kt-selftest-vt-1', os: 'linux', gallery: true, version: '2025.11.20', packSha256: 'cafe', packSize: 1000 };
  const fetchYt = async (first) => {
    const s = st.served; seen.push('GET /yt/download/yt-dlp_linux ' + (first ? '' : '')); if (first) seen.push('GET /yt/download/yt-dlp_linux bytes=500-');
    for (let i = 1; i <= 3; i++) { emit('update', { pct: i * 33, got: i * 100, total: 300, what: 'yt-dlp' }); await sleep(2); }
    if (s.badSum) throw new Error('yt-dlp: checksum mismatch');
    const old = st.yt;
    if (old) { st.olds.unshift(old); st.olds = st.olds.slice(0, 3); }
    if (s.mode === 'broken' && !fault.keepBroken) { if (old) { st.olds.shift(); st.yt = old; throw new Error(`kt-video:rolledback:yt-dlp:${old}`); } st.yt = null; throw new Error('kt-video:broken:yt-dlp'); }
    st.yt = s.version;
  };
  const job = async (t) => {
    const set = (o) => { Object.assign(t, o); pushTasks(); };
    const url = t.source.url;
    if ((t.meta.args || []).includes('--exec')) return set({ state: 'failed', error: 'invalid options' });
    set({ state: 'downloading' });
    if (/fail/.test(url)) { await sleep(5); return set({ state: 'failed', error: '[generic] Unsupported URL: ' + url }); }
    if (/slow/.test(url)) { const a = ++pid, b = ++pid; alive.add(a); alive.add(b); t.pids = [a, b]; files.set(t.dir + '/kt-fake-pids.txt', `${a} ${b}`); for (let i = 1; i < 400 && alive.has(a); i++) { set({ done: i * 1000, total: 1e8 }); await sleep(20); } return; }
    for (const [ph, fr] of [['info'], ['video', 40], ['audio'], ['merge'], ['embed']]) { t.meta = { ...t.meta, phase: ph, ...(fr ? { frag: 40, frags: fr } : {}) }; if (!fr) { delete t.meta.frag; delete t.meta.frags; } set({ done: 1, total: 120000 }); await sleep(5); }
    files.set(t.dir + '/Fake video [abc].mp4', 'x'.repeat(120000));
    set({ state: 'done', done: 120000, files: [{ index: 0, path: 'Fake video [abc].mp4', size: 120000, done: 120000, priority: 1 }], name: 'Fake video [abc]', doneAt: Date.now() });
  };
  const ffjobs = {};
  const kt = {
    platform: 'desktop',
    onTasks: (cb) => { const off = sub('tasks')(cb); cb(JSON.parse(JSON.stringify(tasks))); return off; },
    onUpdateProgress: sub('update'), onPackProgress: sub('pack'), onFfmpegProgress: sub('ff'),
    videoVersion: async () => ({ version: st.yt, ready: !!st.yt }),
    videoReady: async () => { if (!st.yt) await fetchYt(true); return { ok: true, version: st.yt }; },
    isVideoHost: async (u) => /youtube\.com|youtu\.be/.test(u),
    videoInfo: async (o) => { if (/fail/.test(o.url)) throw new Error('ERROR: [generic] Unsupported URL: ' + o.url); if (o.playlist) return { kind: 'playlist', title: 'Fake list', entries: [{ id: 'a' }, { id: 'b' }], count: 2 };
      return { kind: 'video', id: 'abc', title: 'Fake video', choices: [{ id: '137+140', label: '1080p' }, { id: '18', label: '360p' }], audio: [{ id: '140' }], subtitles: ['en', 'ar'], chapters: 1 }; },
    add: async (o) => { const t = { id: 'v' + (++pid), kind: 'video', engine: 'native', name: o.video.title, source: o.source, dir: o.dir, state: 'queued', done: 0, total: 0, files: [], meta: { kind: 'video', quality: o.video.label, args: o.video.args } }; tasks.push(t); pushTasks(); void job(t); return JSON.parse(JSON.stringify(t)); },
    list: async () => JSON.parse(JSON.stringify(tasks)),
    remove: async (id, del) => { const i = tasks.findIndex((t) => t.id === id); if (i < 0) return; const t = tasks[i]; t.state = 'removed'; if (t.pids) t.pids.forEach((p) => alive.delete(p)); tasks.splice(i, 1); if (del) for (const k of [...files.keys()]) if (k.startsWith(t.dir + '/Fake video')) files.delete(k); pushTasks(); },
    pathInfo: async (p) => ({ exists: files.has(p), dir: false, size: (files.get(p) || '').length }),
    exists: async (ps) => ps.map((p) => files.has(p)),
    videoUpdate: async () => { const tag = st.served.version; if (tag !== st.yt) await fetchYt(false); return { version: st.yt, latest: tag, updated: true }; },
    videoBinary: async () => ({ path: '/x/bin/yt-dlp', managed: true, olds: [...st.olds], min: '2025.01.01' }),
    videoRollback: async () => { const o = st.olds.shift(); if (!o) throw new Error('nothing to roll back to'); st.yt = o; return { version: o }; },
    galleryReady: async () => ({ ready: !!st.gdl, version: st.gdl }),
    galleryList: async (o) => { st.gdl = '1.30.2'; if (/fail/.test(o.url)) throw new Error("[gallery-dl][error] No suitable extractor found for '" + o.url + "'"); return { title: 'Fake gallery', items: [{ name: 'one.jpg' }, { name: '2.png', headers: { Referer: 'https://fake.test/' } }] }; },
    packStatus: async () => ({ ffmpeg: { version: st.pack, size: st.pack ? 1000 : 0 }, python: { version: null, size: 0 }, platform: 'linux', arch: 'x64' }),
    packInstall: async (o) => {
      cancelFlag = false;
      for (let i = 1; i <= 5; i++) { if (cancelFlag) throw new Error('cancelled'); emit('pack', { name: 'ffmpeg', done: i * 200, total: 1000 }); await sleep(/slow/.test(o.url) ? 30 : 2); }
      if (/cut/.test(o.url) && !fault.noResume) seen.push('GET /pack/cut.gz bytes=333-');
      if (o.sha256 !== lab.packSha256) throw new Error('checksum');
      st.pack = o.version;
    },
    packCancel: async () => { cancelFlag = true; },
    packRemove: async () => { st.pack = null; st.probeBeside = false; },
    ffmpegAvailable: async () => (st.pack ? { ok: true, path: '/p/ffmpeg', version: 'ffmpeg version 7.1-kt-fake Copyright' } : { ok: false, why: 'spawn ffmpeg ENOENT' }),
    writeTempBytes: async (o) => { const p = '/tmp/' + o.sub + '/' + o.name; files.set(p, Buffer.from(o.b64, 'base64').toString('latin1')); return p; },
    readFile: async (p) => new Uint8Array(Buffer.from(files.get(p) || '', 'latin1')).buffer,
    removeFile: async (p) => { files.delete(p); },
    ffmpeg: async (o) => {
      const inp = o.args[o.args.indexOf('-i') + 1]; const out = o.args[o.args.length - 1];
      if (/kt-slow/.test(inp)) { const a = ++pid, b = ++pid; alive.add(a); alive.add(b); files.set(out + '.pids', `${a} ${b}`); ffjobs[o.id] = [a, b]; while (alive.has(a)) await sleep(10); return { code: 1, log: '' }; }
      for (let k = 1; k <= 5; k++) { emit('ff', { id: o.id, time: k, size: k * 1000, speed: k * 0.5, done: k === 5 }); await sleep(2); }
      files.set(out, files.get(inp)); return { code: 0, log: '' };
    },
    ffmpegCancel: async (id) => { const p = ffjobs[id]; if (!p) return; alive.delete(p[0]); if (!fault.childLives) setTimeout(() => alive.delete(p[1]), 30); },
    ffprobe: async (p) => (files.has(p) && st.probeBeside ? { streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'ac3' }], format: { duration: '12.500000' } } : null),
    // (Since the merge the two routes are P4's stream server's: the run's token in the address, a wrong one refused.)
    videoUrl: async () => ({ url: `http://127.0.0.1:5/${TOKEN}/video` }), audioUrl: async () => ({ url: `http://127.0.0.1:5/${TOKEN}/audio` }),
    http: async (o) => {
      const q = new URL(o.url); const src = q.searchParams.get('src');
      const [, tok, route] = q.pathname.split('/');
      if (tok !== TOKEN && !fault.anyToken) return { status: 403, url: o.url, headers: {}, body: '' };
      if (!src) return { status: 400, url: o.url, headers: {}, body: '' };
      if (route === 'video') { const head = Buffer.from(`KTFAKE-STREAM enc=libx264 ss=${q.searchParams.get('ss')} map=0:v:0,0:a:${q.searchParams.get('a')}?\n`); return { status: 200, url: o.url, headers: { 'content-type': 'video/mp4', 'x-kt-encoder': 'libx264' }, body: Buffer.concat([head, Buffer.alloc(524288, 7)]).toString('base64') }; }
      const head = Buffer.from(`KTFAKE-STREAM enc=aac ss=${q.searchParams.get('ss')} map=0:a:${q.searchParams.get('a')}\n`); return { status: 200, url: o.url, headers: { 'content-type': 'audio/aac' }, body: Buffer.concat([head, Buffer.alloc(4096, 1)]).toString('base64') };
    },
  };
  const invoke = async (cmd, args) => {
    if (cmd !== 'kt_selftest_vt') return undefined;
    const o = args.o;
    switch (o.op) {
      case 'setup': return lab;
      case 'serve': st.served = { version: o.version, mode: o.mode || 'ok', badSum: !!o.badSum }; return true;
      case 'seen': return [...seen];
      case 'pids': { const t = files.get(o.file); if (!t) throw new Error('ENOENT'); return t.split(' ').map(Number); }
      case 'alive': return o.pids.map((p) => alive.has(p));
      case 'probeBeside': st.probeBeside = true; return '/p/ffprobe';
      default: throw new Error('op ' + o.op);
    }
  };
  return { kt, invoke };
}

async function runP5(lib, shell) {
  const results = [];
  const rec = (name, okk, detail, required) => { results.push({ name, ok: !!okk, detail: String(detail).slice(0, 300), required: required !== false }); return !!okk; };
  const within = (p, ms) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error('timeout')), ms))]);
  const check = async (name, required, fn, ms) => { try { const d = await within(Promise.resolve().then(fn), Math.min(ms || 20000, 8000)); return rec(name, true, d, required); } catch (e) { return rec(name, false, (e && e.message) || String(e), required); } };
  const must = (c, w) => { if (!c) throw new Error(w); };
  const env = { sleep: (ms) => new Promise((r) => setTimeout(r, ms)), invoke: shell.invoke, now: () => Date.now() };
  const waitFor = async (fn, ms, what) => { const until = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > until) throw new Error('timeout: ' + what); await env.sleep(20); } };
  await lib.runP5(shell.kt, {}, env, check, must, waitFor);
  return results;
}

async function partOne() {
  const lib = loadLib();
  ok('selftest.js exposes runP5', lib && typeof lib.runP5 === 'function');
  const good = await runP5(lib, fakeShell({}));
  const bad = good.filter((r) => r.required && !r.ok);
  ok('every P5 check passes against a shell that behaves', bad.length === 0, bad);
  ok('…and there are all of them (18)', good.length === 18, good.map((r) => r.name));
  for (const [fault, name] of [['keepBroken', 'yt-dlp: a broken newer release is rolled back at once'], ['childLives', 'ffmpeg: cancel ends its whole tree'], ['noResume', 'ffmpeg pack: a wrong checksum refused, a cancel, a resumed install'], ['anyToken', 'transcode stream: the bytes ffmpeg makes, x264 after the cards\' encoders fail']]) {
    const r = await runP5(lib, fakeShell({ [fault]: true }));
    const failed = r.filter((x) => x.required && !x.ok).map((x) => x.name);
    ok(`a shell with «${fault}» fails «${name}»`, failed.includes(name), failed);
  }
  const none = await runP5(lib, { kt: { platform: 'desktop' }, invoke: async () => { throw new Error('should not be asked'); } });
  ok('a build without the video tools checks nothing', none.length === 0, none);
}

/* ---------- part 2: the page ---------- */
const DIST = path.join(ROOT, 'dist'); const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

function pretendIpc() {
  localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1');
  window.__calls = []; const ls = {}; window.__KT_BOOT__ = { os: 'linux', arch: 'x64' };
  const emit = (name, payload) => setTimeout(() => (ls[name] || []).forEach((f) => f({ event: name, payload: JSON.parse(JSON.stringify(payload)) })), 0);
  const raw = { kind: 'video', id: 'abc', title: 'A short film about trains', thumbnail: '', duration: 754, site: 'Youtube', url: 'https://www.youtube.com/watch?v=abc', uploader: 'Rail', subtitles: ['en'], live: false, chapters: 0,
    choices: [{ id: '137+140', kind: 'video', label: '1080p', ext: 'mp4', height: 1080, fps: 30, size: 309e6, vcodec: 'avc1', acodec: 'mp4a.40.2' }, { id: '22', kind: 'video', label: '720p', ext: 'mp4', height: 720, fps: 30, size: 120e6, vcodec: 'avc1', acodec: 'mp4a' }],
    audio: [{ id: '140', kind: 'audio', label: '128 kbps mp4a.40.2', ext: 'm4a', size: 9e6, acodec: 'mp4a.40.2' }] };
  const tasks = []; let olds = ['2025.11.20']; let version = '2025.12.01';
  const answer = (cmd, a) => {
    switch (cmd) {
      case 'kt_state': return { available: true, reason: '', os: 'linux', arch: 'x64' };
      case 'kt_list': return tasks;
      case 'kt_default_dir': return '/home/u/Downloads/Kurokawa';
      case 'kt_roots': return { roots: ['/home/u/Downloads/Kurokawa'] };
      case 'kt_pack_status': return { ffmpeg: { version: '7.1', size: 5e7 }, python: { version: null, size: 0 }, deno: { version: window.__deno || null, size: window.__deno ? 4e7 : 0 }, platform: 'linux', arch: 'x64' };
      // (Part 3: yt-dlp with no JavaScript runtime here — the «deno» pack offered.)
      case 'kt_video_js_runtime': return { missing: !!window.__jsMissing && !window.__deno, seen: !!window.__jsMissing, pack: 'deno', installed: window.__deno || null, runtime: window.__deno ? 'deno' : null };
      case 'kt_http': return /KurokawaTools-packs\.json$/.test(a.o.url) ? { status: 200, headers: {}, body: JSON.stringify({ versions: { deno: '2.5.0' }, packs: { deno: { 'linux-x64': { file: 'KurokawaTools-pack-deno-linux-x64.gz', size: 4e7, sha256: 'ab'.repeat(32) } } } }) } : null;
      case 'kt_pack_install': if (a.o && a.o.name === 'deno') { emit('kt:packProgress', { name: 'deno', done: 4e7, total: 4e7 }); window.__deno = a.o.version; } return null;
      case 'kt_video_ready': return { ok: true, version };
      case 'kt_video_version': return { version, ready: true };
      case 'kt_video_info': return window.__jsMissing && !window.__deno ? { ...raw, jsRuntime: 'missing' } : raw;
      case 'kt_is_video_host': return /youtube\.com/.test(a.u);
      case 'kt_video_binary': return { path: '/home/u/.local/share/kt/bin/yt-dlp', managed: true, olds, min: '2025.01.01' };
      case 'kt_video_rollback': version = olds[0]; olds = []; return { version };
      case 'kt_video_update': return Promise.reject('kt-video:rolledback:yt-dlp:2025.12.01');
      case 'kt_add': {
        if (!a.o.video) return { id: 'g1', kind: 'http', name: 'x', state: 'queued', files: [] };
        const t = { id: 'vabc1', kind: 'video', engine: 'native', name: a.o.video.title || a.o.source.url, source: a.o.source, dir: a.o.dir || '/home/u/Downloads/Kurokawa', state: 'downloading', done: 3e7, total: 12e7, downSpeed: 2e6, upSpeed: 0, files: [], addedAt: Date.now(), meta: { kind: 'video', phase: 'video', frag: 7, frags: 40, quality: a.o.video.label } };
        tasks.push(t); emit('kt:tasks', tasks); return t;
      }
      default: return null;
    }
  };
  window.__TAURI__ = {
    core: { invoke: (cmd, a) => { window.__calls.push([cmd, JSON.parse(JSON.stringify(a || {}))]); return Promise.resolve().then(() => answer(cmd, a || {})); } },
    event: { listen: (n, f) => { (ls[n] = ls[n] || []).push(f); return Promise.resolve(() => { ls[n] = ls[n].filter((x) => x !== f); }); } },
  };
}

async function partTwo() {
  let chromium; try { ({ chromium } = require('playwright')); } catch { ok('playwright present (part 2 skipped)', false); return; }
  if (!fs.existsSync(path.join(DIST, 'index.html'))) { ok('dist built (run node scripts/build.mjs)', false); return; }
  const web = http.createServer((req, r) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(r); }).listen(0);
  const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  try {
    await p.addInitScript(pretendIpc); await p.addInitScript(BRIDGE);
    await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet');
    await p.fill('.add-input', 'https://www.youtube.com/watch?v=abc');
    const chips = await p.waitForSelector('.video-choices', { timeout: 8000 }).then(() => true, () => false);
    ok('a YouTube link: the qualities from kt_video_info offered', chips);
    const calls = await p.evaluate(() => window.__calls.map((c) => c[0]));
    ok('kt_video_ready and kt_video_info asked through the bridge', calls.includes('kt_video_ready') && calls.includes('kt_video_info'), calls.filter((c) => /video/.test(c)));
    if (chips) {
      await p.click('.video-choices .chip:has-text("720")');
      await p.click('.sheet .btn.primary');
      const add = await p.waitForFunction(() => window.__calls.find((c) => c[0] === 'kt_add'), null, { timeout: 5000 }).then((h) => h.jsonValue(), () => null);
      if (!add) console.log('calls:', JSON.stringify(await p.evaluate(() => window.__calls.map((c) => c[0]))));
      ok('Add sends kt_add with o.video (the 720p choice)', add && add[1].o && add[1].o.video && add[1].o.source.url === 'https://www.youtube.com/watch?v=abc' && /res:720/.test(JSON.stringify(add[1].o.video.args)), add);
      const shown = await p.waitForFunction(() => /A short film about trains/.test(document.body.innerText), null, { timeout: 5000 }).then(() => true, () => false);
      ok('the video task pushed as kt:tasks shows in the list', shown);
    }
    await p.goto(base + '#/settings/video'); await p.waitForSelector('#video');
    const ver = await p.waitForFunction(() => /2025\.12\.01/.test(document.querySelector('#video').innerText), null, { timeout: 5000 }).then(() => true, () => false);
    ok('Settings → Video shows the version (kt_video_version)', ver);
    const back = await p.waitForFunction(() => [...document.querySelectorAll('#video button')].find((b) => !b.hidden && /2025\.11\.20/.test(b.innerText)), null, { timeout: 5000 }).then(() => true, () => false);
    ok('the rollback button names the kept version (kt_video_binary)', back);
    if (back) {
      await p.evaluate(() => [...document.querySelectorAll('#video button')].find((b) => !b.hidden && /2025\.11\.20/.test(b.innerText)).click());
      const rolled = await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'kt_video_rollback'), null, { timeout: 5000 }).then(() => true, () => false);
      ok('it rolls back through kt_video_rollback', rolled);
    }
    // (A broken newer release: the shell's code worded by the page.)
    await p.evaluate(() => [...document.querySelectorAll('#video button')].find((b) => /Update yt-dlp/.test(b.innerText)).click());
    const worded = await p.waitForFunction(() => /The new yt-dlp did not start, so 2025\.12\.01 was put back/.test(document.body.innerText), null, { timeout: 5000 }).then(() => true, () => false);
    ok('a release rolled back at once is told in the page\'s words (kt-video:rolledback)', worded, await p.evaluate(() => document.body.innerText.slice(-300)));
    ok('no page errors', errors.length === 0, errors);
  } finally { await br.close(); web.close(); }
}

/* ---------- part 3: yt-dlp without a JavaScript runtime — the «deno» pack offered once ---------- */
async function partThree() {
  let chromium; try { ({ chromium } = require('playwright')); } catch { return; }
  const web = http.createServer((req, r) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(r); }).listen(0);
  const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  try {
    for (const lang of ['en', 'ar']) {
      const p = await br.newPage({ viewport: { width: 420, height: 860 } }); p.on('pageerror', (e) => errors.push(e.message));
      await p.addInitScript(() => { window.__jsMissing = true; }); await p.addInitScript(pretendIpc); await p.addInitScript((l) => { localStorage.setItem('kr.lang', l); }, lang); await p.addInitScript(BRIDGE);
      await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet');
      await p.fill('.add-input', 'https://www.youtube.com/watch?v=abc');
      const offer = await p.waitForSelector('.sheet[data-jsruntime="offer"]', { timeout: 8000 }).then(() => true, () => false);
      const words = offer ? await p.textContent('.sheet[data-jsruntime="offer"]') : '';
      ok(`${lang}: no JavaScript runtime → told in the Add sheet, with «Get deno»`, offer && (lang === 'en' ? /found no JavaScript runtime/.test(words) && /Get deno/.test(words) : /بيئةً لتشغيل JavaScript/.test(words) && /نزِّل deno/.test(words)), words.slice(0, 200));
      if (!offer) { await p.close(); continue; }
      await p.click('[data-act="get-deno"]');
      const inst = await p.waitForFunction(() => window.__calls.find((c) => c[0] === 'kt_pack_install'), null, { timeout: 8000 }).then((h) => h.jsonValue(), () => null);
      ok(`${lang}: the pack fetched through the pack mechanism (this system's entry, its SHA-256 and version)`, inst && inst[1].o.name === 'deno' && /pack-deno-linux-x64\.gz$/.test(inst[1].o.url) && inst[1].o.sha256 === 'ab'.repeat(32) && inst[1].o.version === '2.5.0', inst);
      await p.evaluate(() => { document.querySelectorAll('.sheet').forEach((s) => s.__close && s.__close()); });
      await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet');
      await p.fill('.add-input', 'https://www.youtube.com/watch?v=xyz');
      await p.waitForSelector('.video-choices', { timeout: 8000 }).catch(() => null);
      ok(`${lang}: told once (not again)`, !(await p.$('.sheet[data-jsruntime="offer"]')));
      if (lang === 'en') {
        await p.goto(base + '#/settings/storage'); await p.waitForTimeout(800);
        const row = await p.waitForFunction(() => /deno \(JavaScript for yt-dlp\)/.test(document.body.innerText), null, { timeout: 5000 }).then(() => true, () => false);
        ok('Settings → Storage lists the deno pack (removable)', row);
      }
      await p.close();
    }
    ok('part 3: no page errors', errors.length === 0, errors);
  } finally { await br.close(); web.close(); }
}

// (The release's deno files: scripts/denopack.py's table is kt-core's deno_asset.)
{
  const rs = fs.readFileSync(path.join(ROOT, 'core', 'kt-core', 'src', 'videotools.rs'), 'utf8'); const py = fs.readFileSync(path.join(ROOT, 'scripts', 'denopack.py'), 'utf8');
  const fromRs = [...rs.matchAll(/\("(\w+)", "(\w+)"\) => Some\("(deno-[^"]+)"\)/g)].map((m) => `${m[1]}-${m[2]}=${m[3]}`).sort();
  const fromPy = [...py.matchAll(/'(\w+-\w+)': '(deno-[^']+)'/g)].map((m) => `${m[1]}=${m[2]}`).sort();
  ok(`deno pack: the release script's table is kt-core's (${fromRs.length} systems)`, fromRs.length === 5 && fromRs.join() === fromPy.join(), { fromRs, fromPy });
}
(async () => {
  await partOne();
  await partTwo();
  await partThree();
  console.log(fails ? `${fails} FAILED` : 'videotauri: all passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
