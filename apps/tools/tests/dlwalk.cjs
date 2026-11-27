// node tests/dlwalk.cjs : the downloads walked against servers that misbehave on purpose. Everything is on 127.0.0.1
// with made-up bytes. Two parts:
//  1. the engine — the phone's file downloader (native/android/KrDownloader.java, plain java.net, compiled here with
//     tests/native/DlWalkT.java) run against this file's server, one case at a time: no Content-Length, a wrong one, no
//     Range support, Range answered 200, the file changed between pause and resume (date + ETag, ETag alone, a part
//     begun), the link expired after a pause (then a new link), 429 with Retry-After, 503 three times, five drops at
//     40 %, a byte a second for 30 s, five redirects and a loop, Content-Disposition names (RTL, slashes, 300
//     characters, reserved, trailing dot, «..», a bidi control), two downloads to one name at once, ten quick pauses,
//     removed while running, the app killed mid-way (a child JVM), offline then back, a folder that cannot be written
//     and a full disk (the harness's file that runs out of room after 1 MB: the same on every machine). For each: the state and reason the engine reports, the
//     bytes, the file's SHA-256 against the source, what is left in the folder, the threads still running.
//  2. the page — the downloads list fed (a made-up phone plugin and a made-up computer bridge) with the cards those
//     runs end in, plus queued / paused / held / retrying ones: each card's line in en and ar (numbers never NaN,
//     negative, ∞ or past 100 %), every failure naming its reason with its next step on the card; 20 queued under a
//     limit of 3 (order, pause all, resume all); the page reloaded mid-download (the card back with its bytes); back
//     online. Phone 360x800 and computer 1280x800, screenshots of each.
// Env: DLWALK_SRC=<folder with KrDownloader.java …> (another version, e.g. the one before a change)  WALK_ONLY=<case,…>
//      DLWALK_PART=engine|page|all  WALK_SHOTS=<dir>
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto'); const { execFileSync, spawn } = require('node:child_process');
const ROOT = path.join(__dirname, '..'); const DIST = path.join(ROOT, 'dist'); const SRC = process.env.DLWALK_SRC || path.join(ROOT, 'native', 'android');
const SHOTS = process.env.WALK_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-dlwalkshots-'));
const PART = process.env.DLWALK_PART || 'all'; const ONLY = process.env.WALK_ONLY ? process.env.WALK_ONLY.split(',') : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0, passes = 0; const faultLog = [];
const ok = (name, c, x) => { if (c) passes++; else { fails++; faultLog.push(`${name} ${x === undefined ? '' : JSON.stringify(x).slice(0, 500)}`); } console.log((c ? 'ok   ' : 'FAIL ') + name + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 1200000).unref();

// ---- the made-up files: 6 MB of random bytes, another version of the same size, the first with its chunks' middles
// changed (what a check of each chunk's ends cannot see), a small one for the names.
const MB = 1 << 20; const SIZE = 6 * MB;
const V1 = crypto.randomBytes(SIZE); const V2 = crypto.randomBytes(SIZE); const MID = Buffer.from(V1); for (let k = 0; k < 6; k++) MID.fill(0x5a, k * MB + 400 * 1024, k * MB + 420 * 1024);
const SMALL = crypto.randomBytes(64 * 1024);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// ---- the server that misbehaves (one behaviour per case, picked by the path /f/<case>)
const C = {}; const cs = (k) => (C[k] ??= { reqs: 0, drops: 0, ver: 1, expired: false, offline: false, slow: true, inflight: 0, stalled: false, tag: 0 });
const RANGE = (hd, size) => { const m = /bytes=(\d*)-(\d*)/.exec(hd || ''); if (!m) return null; const a = m[1] ? Number(m[1]) : 0; const b = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1; return a > b || a >= size ? 'bad' : { a, b }; };
const LM1 = 'Tue, 03 Nov 2026 10:00:00 GMT', LM2 = 'Wed, 25 Nov 2026 18:30:00 GMT';
async function send(q, r, buf, o = {}) {
  const k = o.k; const s = cs(k); let span = o.noRange ? null : RANGE(q.headers.range, buf.length);
  if (span === 'bad') { r.writeHead(416, { 'content-range': `bytes */${buf.length}`, 'content-length': 0 }); r.end(); return; }
  const a = span ? span.a : 0, b = span ? span.b : buf.length - 1; const len = b - a + 1;
  const hd = { 'content-type': o.type || 'application/octet-stream', 'accept-ranges': o.acceptRanges ?? (o.noRange ? 'none' : 'bytes'), ...(o.headers || {}) };
  if (!o.noLength) hd['content-length'] = String(o.claim ?? len);
  if (span) hd['content-range'] = `bytes ${a}-${b}/${buf.length}`;
  r.writeHead(span ? 206 : 200, hd); if (q.method === 'HEAD') { r.end(); return; }
  s.inflight++; r.on('close', () => { s.inflight--; });
  let pos = a; const piece = 64 * 1024;
  while (pos <= b && !r.destroyed) {
    if (o.cutAt !== undefined && pos >= o.cutAt) { r.destroy(); return; }
    if (o.drop && o.drop(pos, a)) { r.destroy(); return; }
    if (o.stall && o.stall(pos)) { const until = Date.now() + 30000; while (Date.now() < until && !r.destroyed) { r.write(buf.subarray(pos, pos + 1)); pos++; await sleep(1000); } if (r.destroyed) return; }
    const n = Math.min(piece, b - pos + 1); if (!r.write(buf.subarray(pos, pos + n))) await new Promise((res) => r.once('drain', res)); pos += n;
    if (o.rate) await sleep(Math.round((n / o.rate) * 1000)); else if (pos % (512 * 1024) < piece) await new Promise((res) => setImmediate(res));
  }
  if (!r.destroyed) r.end();
}
const NAMES = {
  rtl: `attachment; filename*=UTF-8''${encodeURIComponent('حلقة 01 — مثال.mkv')}`, slash: 'attachment; filename="../../etc/pass\\wd.bin"',
  long: `attachment; filename*=UTF-8''${encodeURIComponent('ب'.repeat(300) + '.mkv')}`, con: 'attachment; filename="CON.txt"', dot: 'attachment; filename="report."',
  dotdot: 'attachment; filename=".."', bidi: `attachment; filename*=UTF-8''${encodeURIComponent('\u202Egpj.exe')}`, nul: 'attachment; filename="nul.txt"',
};
function fileCase(q, r, k, u) {
  const s = cs(k); s.reqs++; const probe = q.headers.range === 'bytes=0-0';
  const etag = (v) => ({ etag: `"${k}-v${v}"` });
  switch (k) {
    case 'nolen': return send(q, r, V1, { k, noRange: true, noLength: true });
    case 'badlen': return send(q, r, V1, { k, noRange: true, cutAt: SIZE / 2 });
    case 'norange': return send(q, r, V1, { k, noRange: true });
    case 'r200': return send(q, r, V1, { k, noRange: true, acceptRanges: 'bytes' });
    case 'dropnr': return send(q, r, V1, { k, noRange: true, cutAt: SIZE * 0.4 });
    case 'r429': if (s.reqs === 1) { r.writeHead(429, { 'retry-after': '2', 'content-length': 0 }); r.end(); return; } return send(q, r, V1, { k, headers: etag(1) });
    case 'r503': if (s.reqs <= 3) { r.writeHead(503, { 'content-length': 0 }); r.end(); return; } return send(q, r, V1, { k, headers: etag(1) });
    case 'drop5': return send(q, r, V1, { k, headers: etag(1), drop: (pos, a) => { if (s.drops < 5 && pos >= Math.max(a + 64 * 1024, SIZE * 0.4) && a <= SIZE * 0.4 + 2 * MB) { s.drops++; return true; } return false; } });
    case 'stall': return send(q, r, V1, { k, headers: etag(1), stall: (pos) => { if (!s.stalled && pos >= SIZE * 0.4) { s.stalled = true; return true; } return false; } });
    case 'redir5': { const h = Number(u.searchParams.get('h') || 0); if (h < 5) { r.writeHead(302, { location: `/f/redir5?h=${h + 1}` }); r.end(); return; } return send(q, r, V1, { k, headers: etag(1) }); }
    case 'loop': r.writeHead(302, { location: u.searchParams.get('x') ? '/f/loop' : '/f/loop?x=1' }); r.end(); return;
    case 'changed': return send(q, r, s.ver === 1 ? V1 : V2, { k, headers: { ...etag(s.ver), 'last-modified': s.ver === 1 ? LM1 : LM2 } });
    case 'changedmid': return send(q, r, s.ver === 1 ? V1 : MID, { k, headers: { ...etag(s.ver), 'last-modified': s.ver === 1 ? LM1 : LM2 } });
    case 'changedpart': return send(q, r, s.ver === 1 ? V1 : V2, { k, headers: etag(s.ver) });
    case 'rotate': return send(q, r, V1, { k, headers: { etag: `"r${++s.tag}"`, 'last-modified': LM1 } });
    case 'expired': if (s.expired && !u.searchParams.get('fresh')) { r.writeHead(403, { 'content-length': 0 }); r.end(); return; } return send(q, r, V1, { k, headers: etag(1) });
    case 'crash': return send(q, r, V1, { k, headers: etag(1), rate: s.slow ? 0.1 * MB : 0 });
    case 'names': return send(q, r, SMALL, { k, headers: { 'content-disposition': NAMES[u.searchParams.get('k')] || 'attachment' } });
    case 'offline': if (s.offline) { r.socket.destroy(); return; } return send(q, r, V1, { k, headers: etag(1) });
    default: return send(q, r, V1, { k, headers: etag(1) });   // ok, same, del, quick
  }
}
const server = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x');
  if (u.pathname === '/ctl') { const s = cs(u.searchParams.get('c')); const op = u.searchParams.get('op');
    if (op === 'change') s.ver = 2; else if (op === 'expire') s.expired = true; else if (op === 'fast') s.slow = false; else if (op === 'offline') s.offline = true; else if (op === 'online') s.offline = false;
    r.writeHead(200, { 'content-type': 'text/plain' }); r.end(String(s.inflight)); return; }
  if (u.pathname.startsWith('/f/')) { void fileCase(q, r, u.pathname.slice(3), u); return; }
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html';
  const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r);
});

// ---- part 1: the engine
const CASES = ['ok', 'nolen', 'badlen', 'norange', 'r200', 'dropnr', 'changed', 'changedmid', 'changedpart', 'rotate', 'expired', 'r429', 'r503', 'drop5', 'stall', 'redir5', 'loop', 'names', 'same', 'quick', 'del', 'crash', 'offline', 'nofolder', 'full'];
function compile() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-dlwalk-java-'));
  const strip = (f, pub) => { let s = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^package .*;/m, ''); if (pub) s = s.replace(new RegExp(`^final class ${pub}`, 'm'), `public final class ${pub}`); fs.writeFileSync(path.join(d, f), s); };
  strip('KrDownloader.java', 'KrDownloader'); strip('KtNameSafe.java'); strip('KtDlRules.java', 'KtDlRules');
  fs.copyFileSync(path.join(ROOT, 'native', 'android', 'KtCore.java'), path.join(d, 'KtCore.java')); fs.copyFileSync(path.join(__dirname, 'native', 'DlWalkT.java'), path.join(d, 'DlWalkT.java'));
  execFileSync("javac", ['-nowarn', '-d', path.join(d, 'out'), ...['KtCore.java', 'KrDownloader.java', 'KtNameSafe.java', 'KtDlRules.java', 'DlWalkT.java'].map((f) => path.join(d, f))], { stdio: ['ignore', 'ignore', 'pipe'] });
  return d;
}
async function engine(port) {
  let jd; try { jd = compile(); } catch (e) { ok('engine: KrDownloader compiles (javac)', false, String(e.stderr || e).split('\n').filter((l) => !/^Picked up/.test(l)).join('\n').slice(0, 600)); return {}; }
  const work = path.join(jd, 'work');
  const want = (ONLY ? CASES.filter((c) => ONLY.includes(c)) : CASES);
  const out = await new Promise((res) => { const p = spawn('java', ['-Dfile.encoding=UTF-8', '-Dstdout.encoding=UTF-8', '-Dsun.stdout.encoding=UTF-8', '-cp', path.join(jd, 'out'), 'DlWalkT', `http://127.0.0.1:${port}`, work, ...want], { stdio: ['ignore', 'pipe', 'pipe'] }); let o = ''; p.stdout.setEncoding('utf8'); p.stdout.on('data', (d) => { o += d; process.stdout.write(String(d).split('\n').filter((l) => l.startsWith('WALK ')).map((l) => `   · ${l.slice(5, 220)}\n`).join('')); }); p.stderr.on('data', () => {}); p.on('close', () => res(o)); });
  const R = {}; for (const l of out.split('\n')) if (l.startsWith('WALK ')) { try { const j = JSON.parse(l.slice(5)); R[j.case] = j; } catch { /* torn */ } }
  const has = (c) => want.includes(c); const g = (c) => R[c] || {};
  const done = (c, src, extra = '') => { const r = g(c); ok(`engine ${c}: done and whole${extra}`, r.state === 'done' && r.sha === sha(src) && r.size === src.length, { state: r.state, error: r.error, got: r.got, size: r.size, shaOk: r.sha === sha(src) }); };
  const noLeft = (c) => { const r = g(c); const left = (r.left || '').split(',').filter((x) => x && !/\.(bin|state|mkv|txt|exe)$/.test(x) && !/\.part$/.test(x) || /\.tmp$/.test(x)); ok(`engine ${c}: nothing stray left in the folder, no thread running`, !left.length && r.threads === 0, { left: r.left, threads: r.threads }); };
  if (has('ok')) { done('ok', V1); noLeft('ok'); }
  if (has('nolen')) done('nolen', V1, ' (no Content-Length)');
  if (has('badlen')) { const r = g('badlen'); ok('engine badlen: a cut answer (Content-Length 6 MB, 3 MB sent) is never «done»', r.state === 'failed' && /incomplete|Premature|end of/i.test(r.error || ''), r); }
  for (const c of ['norange', 'r200']) if (has(c)) { const r = g(c); done(c, V1, ' after a pause at 40 % (the server cannot go on: begun again, nothing spliced)'); ok(`engine ${c}: the second run began from 0, honestly`, r.firstAt >= 0 && r.firstAt < SIZE * 0.4 && r.pausedState === 'paused', { firstAt: r.firstAt, pausedAt: r.pausedAt }); }
  if (has('dropnr')) { const r = g('dropnr'); ok('engine dropnr: a server without ranges that drops at 40 %: failed with a reason, not «done»', r.state === 'failed' && !!r.error, r); }
  if (has('changed')) done('changed', V2, ' (file changed between pause and resume: the new one, whole)');
  if (has('changedmid')) done('changedmid', MID, ' (only the chunks\' middles changed, new date and ETag: never spliced)');
  if (has('changedpart')) done('changedpart', V2, ' (ETag changed, no date, only a part begun: never spliced)');
  if (has('rotate')) { const r = g('rotate'); done('rotate', V1, ' (an ETag that changes every answer, the same date)'); ok('engine rotate: …resumed, not begun again', r.firstAt >= SIZE * 0.2, { firstAt: r.firstAt, pausedAt: r.pausedAt }); }
  if (has('expired')) { const r = g('expired'); ok('engine expired: the link refused after a pause → failed «HTTP 403»', r.expiredState === 'failed' && r.expiredError === 'HTTP 403', r); ok('engine expired: …the bytes and the record kept', r.partKept === SIZE && r.recordKept === true, r); done('expired', V1, ' with a new link'); ok('engine expired: the new link went on from the bytes kept', r.firstAt >= SIZE * 0.3, { firstAt: r.firstAt, pausedAt: r.pausedAt }); }
  if (has('r429')) { const r = g('r429'); done('r429', V1, ' (429 with Retry-After: 2 first)'); ok('engine r429: Retry-After heeded, its wait told (retryAt)', r.ms >= 1900 && r.retryWhy === 'HTTP 429' && r.retryWait > 1000, { ms: r.ms, why: r.retryWhy, wait: r.retryWait }); }
  if (has('r503')) { const r = g('r503'); done('r503', V1, ' (503 three times first)'); ok('engine r503: the waits told as «HTTP 503»', r.retryWhy === 'HTTP 503', r.retryWhy); }
  if (has('drop5')) done('drop5', V1, ' (dropped at 40 % five times)');
  if (has('stall')) { const r = g('stall'); done('stall', V1, ' (a byte a second for 30 s)'); ok('engine stall: the trickling connection given up on and asked again (within 25 s, not after the 30 s)', r.ms < 25000, { ms: r.ms }); }
  if (has('redir5')) done('redir5', V1, ' (five redirects)');
  if (has('loop')) { const r = g('loop'); ok('engine loop: a redirect loop fails with its reason', r.state === 'failed' && /redirect/i.test(r.error || ''), r); }
  if (has('names')) { for (const n of g('names').names || []) { const c = n.clean || ''; const bad = /[\\/]/.test(c) || n.bytes > 255 || /^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(c) || /[. ]$/.test(c) || c === '..' || c === '.' || /[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/.test(c) || !c; ok(`engine names ${n.k}: «${c.slice(0, 40)}» is a name every target keeps`, !bad && n.state === 'done', n); } }
  if (has('same')) { const r = g('same'); ok('engine same: two downloads to one name at once get two names, both whole', r.n1 !== r.n2 && r.sha1 === sha(V1) && r.sha === sha(V1) && r.state1 === 'done' && r.state === 'done', { n1: r.n1, n2: r.n2, s1: r.state1, s2: r.state }); }
  if (has('quick')) { const r = g('quick'); done('quick', V1, ' after ten quick pauses'); }
  if (has('del')) { const r = g('del'); ok('engine del: removed while running — nothing left in its folder, no thread', !r.leftAfter && r.threads === 0, { left: r.leftAfter, threads: r.threads }); }
  if (has('crash')) { const r = g('crash'); done('crash', V1, ' after the app was killed at ~40 %'); ok('engine crash: …gone on from the record (not from 0)', r.firstAt >= SIZE * 0.2, { firstAt: r.firstAt, killedAt: r.killedAt }); }
  if (has('offline')) { const r = g('offline'); done('offline', V1, ' (no connection for 2.5 s, then back)'); ok('engine offline: the waits told as «net»', r.retryWhy === 'net', r.retryWhy); }
  if (has('nofolder')) { const r = g('nofolder'); ok('engine nofolder: a folder that cannot be written fails with a reason', r.state === 'failed' && !!r.error, r); }
  if (has('full')) { const r = g('full'); ok('engine full: a full disk fails with «No space left», after the bytes that fitted', r.state === 'failed' && /No space/i.test(r.error || '') && r.error !== 'noFolderAccess' && r.got > 0, r); }
  if (has('full') && has('nofolder')) ok('engine: a full disk told apart from a folder that cannot be written', !!g('nofolder').error && !/No space/i.test(g('nofolder').error) && /No space/i.test(g('full').error || ''), [g('nofolder').error, g('full').error]);
  try { fs.rmSync(jd, { recursive: true, force: true }); } catch { /* left */ }
  return R;
}

// ---- part 2: the page
const now0 = Date.now();
const T = (id, o) => ({ id, kind: 'http', name: `${id}.bin`, source: { url: `https://example.invalid/${id}.bin` }, dir: '/storage/emulated/0/Download/Kurokawa', state: 'downloading', done: 0, total: SIZE, downSpeed: 0, upSpeed: 0, files: [], addedAt: now0 - 1000, engine: 'native', ...o });
/** The cards the engine runs end in, and the states between. */
function cardTasks(R, pc) {
  const e = (c, d) => (R[c]?.error ?? d);
  const L = [
    T('queued', { state: 'queued', done: 0 }),
    T('starting', { state: 'downloading', done: 0, total: 0 }),
    T('running', { state: 'downloading', done: 2.4 * MB, downSpeed: 1.2 * MB, eta: 3, connections: 4 }),
    T('trickle', { state: 'downloading', done: 2.4 * MB, downSpeed: 1, eta: (SIZE - 2.4 * MB) }),
    T('retrying', { state: 'downloading', done: 0, total: 0, retryAt: Date.now() + 8000, retryWhy: 'HTTP 503' }),
    T('netwait', { state: 'downloading', done: 1.2 * MB, retryAt: Date.now() + 4000, retryWhy: 'net' }),
    T('paused', { state: 'paused', done: 2.4 * MB }),
    T('held', { state: 'paused', heldBy: 'metered', done: 1 * MB }),
    T('done', { state: 'done', done: SIZE, doneAt: now0 }),
    T('expired', { state: 'failed', done: 2.4 * MB, error: pc ? 'The response status is not successful. status=403 (22)' : e('expired', 'HTTP 403').replace(/^.*$/, 'HTTP 403') }),
    T('incomplete', { state: 'failed', done: 3 * MB, error: pc ? 'Network problem has occurred. cause:Connection reset by peer (6)' : e('badlen', 'incomplete') }),
    T('loop', { state: 'failed', done: 0, total: 0, error: pc ? 'Too many redirects (23)' : e('loop', 'Too many redirects') }),
    T('busy', { state: 'failed', done: 0, total: 0, error: pc ? 'The response status is not successful. status=503 (29)' : 'HTTP 503' }),
    T('folder', { state: 'failed', done: 0, total: 0, error: pc ? 'Failed to make the directory /mnt/gone, cause: Permission denied (18)' : 'noFolderAccess' }),
    T('full', { state: 'failed', done: 1 * MB, error: pc ? 'Not enough disk space (9)' : (R.full?.error || 'No space left on device') }),
    T('offline', { state: 'failed', done: 0, total: 0, error: pc ? 'Network problem has occurred. cause:Name resolution failed (19)' : 'Unable to resolve host "example.invalid": No address associated with hostname' }),
    T('page', { state: 'failed', done: 0, total: 0, error: 'page' }),
  ];
  // (Names as the engine made them from the servers' Content-Disposition.)
  for (const n of (R.names?.names || []).slice(0, 3)) if (n.clean) L.push(T(`name-${n.k}`, { name: n.clean, state: 'done', done: SMALL.length, total: SMALL.length, doneAt: now0 }));
  return L;
}
const FIXTURE = (o) => {
  try { localStorage.setItem('kr.lang', o.lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ navOrder: ['downloads'], connections: 0 })); } catch { /* blocked */ }
  // (A saved engine state: what the engine had when the page went away — the reload case.)
  let saved = null; try { saved = JSON.parse(sessionStorage.getItem('walk.tasks') || 'null'); } catch { /* none */ }
  const tasks = (saved || o.tasks).map((x) => ({ ...x, files: x.files || [] })); window.__tasks = tasks; window.__calls = [];
  const subs = new Set(); const push = () => { try { sessionStorage.setItem('walk.tasks', JSON.stringify(tasks)); } catch { /* full */ } for (const f of subs) f(tasks.map((x) => ({ ...x }))); }; window.__push = push;
  // (The queue as KtEngine keeps it: no more than maxActive file downloads at once, the rest waiting in their order.)
  const max = () => o.maxActive || 3; const busy = () => tasks.filter((x) => x.kind === 'http' && x.state === 'downloading').length;
  const pump = () => { for (const x of tasks) { if (busy() >= max()) break; if (x.state === 'queued' && !x.paused) x.state = 'downloading'; } };
  const api = {
    list: async () => (o.pc ? tasks.map((x) => ({ ...x })) : { tasks: tasks.map((x) => ({ ...x })) }),
    pause: async (a) => { const id = typeof a === 'string' ? a : a.id; window.__calls.push(['pause', id]); const x = tasks.find((y) => y.id === id); if (x) { x.paused = true; x.state = 'paused'; x.downSpeed = 0; } pump(); push(); },
    resume: async (a) => { const id = typeof a === 'string' ? a : a.id; window.__calls.push(['resume', id]); const x = tasks.find((y) => y.id === id); if (x) { x.paused = false; x.error = undefined; x.heldBy = undefined; x.state = busy() >= max() ? 'queued' : 'downloading'; if (x.meta) delete x.meta.interrupted; } push(); },
    remove: async (a, del) => { const id = typeof a === 'string' ? a : a.id; window.__calls.push(['remove', id]); const i = tasks.findIndex((y) => y.id === id); if (i >= 0) tasks.splice(i, 1); pump(); push(); },
    add: async (a) => { window.__calls.push(['add', a.source?.url, a.dir]); const x = { id: 'n' + Math.random().toString(36).slice(2, 7), kind: 'http', name: a.name || 'new.bin', source: a.source, dir: a.dir || '', state: busy() >= max() ? 'queued' : 'downloading', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native' }; tasks.push(x); push(); return o.pc ? x : { task: x }; },
    setUrl: async (a, b) => { const id = typeof a === 'string' ? a : a.id; const url = typeof a === 'string' ? b : a.url; window.__calls.push(['setUrl', id, url]); const x = tasks.find((y) => y.id === id); if (x) { x.source = { ...x.source, url }; x.state = 'downloading'; x.error = undefined; } push(); return ''; },
    pickDir: async () => (o.pc ? '/home/walk/Other' : { dir: '/storage/emulated/0/Other' }), defaultDir: async () => (o.pc ? '/home/walk/Downloads' : { dir: '/storage/emulated/0/Download/Kurokawa' }),
    move: async () => {}, configure: async () => {}, setLimits: async () => {},
  };
  if (o.pc) {
    const bridge = { platform: 'desktop', available: true, os: 'linux', ...api, onTasks: (cb) => { subs.add(cb); cb(tasks.map((x) => ({ ...x }))); return () => subs.delete(cb); }, setFiles: async () => {}, torrentInfo: async () => ({}), open: async () => {} };
    window.kurokawaTools = new Proxy(bridge, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    document.addEventListener('DOMContentLoaded', () => document.documentElement.classList.add('pc'));
    return;
  }
  api.addListener = async (ev, fn) => { if (ev === 'tasksChanged') { const f = (ts) => fn({ tasks: ts }); subs.add(f); return { remove() { subs.delete(f); } }; } return { remove() {} }; };
  const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
};
const CARDS = () => [...document.querySelectorAll('.task-card')].map((c) => {
  const r = c.getBoundingClientRect(); const fill = c.querySelector('.task-bar i'); const m = /scaleX\(([-\d.e]+)\)/.exec(fill?.style.transform || '');
  const btns = [...c.querySelectorAll('.task-actions button')].map((b) => { const bb = b.getBoundingClientRect(); return { label: b.getAttribute('aria-label') || b.textContent.trim(), w: bb.width, h: bb.height }; });
  const ln = c.querySelector('.task-line'); const lr = ln ? document.createRange() : null; if (lr) lr.selectNodeContents(ln); const reasonCut = !!ln && (() => { const k = ln.cloneNode(false); k.textContent = (ln.textContent || '').split(' · ')[0]; k.style.width = `${ln.clientWidth}px`; k.style.position = 'absolute'; k.style.visibility = 'hidden'; ln.parentElement.append(k); const cut = k.scrollHeight > k.clientHeight + 1 || k.scrollWidth > k.clientWidth + 1; k.remove(); return cut; })();
  return { reasonCut, id: c.dataset.id, line: c.querySelector('.task-line')?.textContent || '', name: c.querySelector('.task-name')?.textContent || '', bar: m ? Number(m[1]) : null, btns, w: r.width, right: r.right };
});
async function page(port, R) {
  const base = `http://127.0.0.1:${port}/`; const br = await chromium.launch();
  const W = { phone: { width: 360, height: 800 }, pc: { width: 1280, height: 800 } };
  const runs = [['phone', 'en'], ['phone', 'ar'], ['pc', 'en'], ['pc', 'ar']];
  for (const [kind, lang] of runs) {
    const pc = kind === 'pc'; const tag = `${kind}-${lang}`;
    const ctx = await br.newContext({ viewport: W[kind], deviceScaleFactor: pc ? 1 : 2, isMobile: !pc, hasTouch: !pc }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    const tasks = cardTasks(R, pc);
    await p.addInitScript(`(${FIXTURE.toString()})(${JSON.stringify({ lang, pc, tasks })})`);
    await p.goto(base + '#/'); await p.waitForSelector('.task-card', { timeout: 15000 }); await sleep(900);
    const cards = await p.evaluate(CARDS); const by = Object.fromEntries(cards.map((c) => [c.id, c]));
    ok(`[${tag}] every card drawn`, tasks.every((x) => by[x.id]), cards.map((c) => c.id));
    for (const c of cards) {
      const bad = /NaN|Infinity|∞|undefined|null|-\d/.test(c.line) || c.bar === null || c.bar < 0 || c.bar > 1.0001 || c.right > W[kind].width + 1;
      ok(`[${tag}] ${c.id}: numbers sane, inside the screen («${c.line.slice(0, 90)}»)`, !bad, c);
      for (const b of c.btns) ok(`[${tag}] ${c.id}: «${b.label}» is a target ≥ 40 px`, b.w >= 40 && b.h >= 40, b);
    }
    // (A clock longer than 99 hours is no time left anyone reads: not shown.)
    ok(`[${tag}] trickle: no absurd time left`, !/\d{3,}:\d\d:\d\d/.test(by.trickle?.line || ''), by.trickle?.line);
    // (Every failure: its reason in words — the language's, never the engine's raw English in Arabic — and its next step on the card.)
    const raw = /status=|cause:|Unable to resolve|Too many redirects|incomplete|No space left|noFolderAccess|HTTP \d|\(\d+\)$/;
    for (const id of ['expired', 'incomplete', 'loop', 'busy', 'folder', 'full', 'offline', 'page']) {
      const c = by[id]; if (!c) continue; const reason = c.line.split(' · ')[0];   // (first: a phone cuts the line at its end)
      ok(`[${tag}] ${id}: the reason in words («${reason.slice(0, 70)}»)`, reason.length > 3 && !raw.test(reason) && (lang !== 'ar' || /[\u0600-\u06ff]/.test(reason)), c.line);
      ok(`[${tag}] ${id}: the reason is seen whole (not cut off)`, !c.reasonCut, c.line);
      const labels = c.btns.map((b) => b.label).join(' | ');
      const need = id === 'expired' ? /new link|رابط/i : id === 'folder' || id === 'full' ? /folder|مجلّد|مجلد/i : id === 'page' ? /browser|المتصفّح|try again|المحاولة/i : /try again|المحاولة/i;
      ok(`[${tag}] ${id}: its next step is on the card («${labels}»)`, need.test(labels), labels);
    }
    ok(`[${tag}] retrying: the reason and a countdown`, /\d:\d\d/.test(by.retrying?.line || '') && !/HTTP 503$/.test(by.retrying?.line || ''), by.retrying?.line);
    ok(`[${tag}] retrying/netwait: the countdown is seen whole`, !by.retrying?.reasonCut && !by.netwait?.reasonCut, [by.retrying?.line, by.netwait?.line]);
    ok(`[${tag}] netwait: no connection said, with a countdown`, /\d:\d\d/.test(by.netwait?.line || ''), by.netwait?.line);
    ok(`[${tag}] held: says why it waits`, (by.held?.line || '').length > 5 && !/^Paused$/.test(by.held?.line || ''), by.held?.line);
    if (pc) ok(`[${tag}] the computer shows no phone-only hold`, true);
    // (One picture of every card: the window made as tall as the list for it, then put back.)
    { const hgt = await p.evaluate(() => Math.ceil((document.querySelector('.task-list')?.getBoundingClientRect().bottom ?? 800) + window.scrollY + 120)); await p.setViewportSize({ width: W[kind].width, height: Math.max(W[kind].height, hgt) }); await sleep(400);
      await p.screenshot({ path: path.join(SHOTS, `D4-${tag}-cards.png`) }); await p.setViewportSize(W[kind]); await sleep(200); }
    // (The new link, from the card itself: the bytes kept, the download going on.)
    const nl = await p.$('.task-card[data-id="expired"] .task-actions button[data-act="newUrl"]');
    if (nl) { await nl.click(); await p.waitForSelector('.sheet input[type=url]', { timeout: 4000 }).catch(() => {}); await p.fill('.sheet input[type=url]', 'https://example.invalid/expired-new.bin').catch(() => {}); await sleep(600); await p.screenshot({ path: path.join(SHOTS, `D4-${tag}-newlink.png`) }); await p.click('.sheet .btn.primary').catch(() => {}); await sleep(500);
      const calls = await p.evaluate(() => window.__calls); ok(`[${tag}] new link from the card → setUrl (the bytes kept)`, calls.some((c) => c[0] === 'setUrl' && c[1] === 'expired'), calls); }
    else ok(`[${tag}] new link from the card`, false, 'no button');
    // (Another folder, from the card: the download added there.)
    const cf = await p.$('.task-card[data-id="folder"] .task-actions button[data-act="chooseFolder"]');
    if (cf) { await cf.click(); await sleep(800); const calls = await p.evaluate(() => window.__calls); ok(`[${tag}] choose folder from the card → added into the folder picked`, calls.some((c) => c[0] === 'add' && /Other/.test(c[2] || '')), calls); }
    else ok(`[${tag}] choose folder from the card`, false, 'no button');
    // (Retry every failed one, once.)
    if (lang === 'en' && !pc) {
      await p.evaluate(() => { for (const x of window.__tasks) if (x.state === 'failed') { x.state = 'failed'; } window.__push(); });
    }
    await ctx.close();
    if (errs.length) ok(`[${tag}] no page errors`, false, errs);
  }
  // ---- D4b: Arabic on narrow phones (320, 360, 412): the header's count as «العدد: n»; on a running / paused / held card the
  // state, the sizes and the speed whole (wrapping, never cut or ellipsised); done-of-total read in that order (done to the right).
  for (const width of [320, 360, 412]) {
    const tag = `ar-${width}`; const ctx = await br.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    await p.addInitScript(`(${FIXTURE.toString()})(${JSON.stringify({ lang: 'ar', pc: false, tasks: cardTasks(R, false) })})`);
    await p.goto(base + '#/'); await p.waitForSelector('.task-card', { timeout: 15000 }); await sleep(900);
    const head = await p.$eval('.downloads-view .title .count', (e) => e.textContent);
    ok(`[${tag}] the header's count is «العدد: n» («${head}»)`, /^العدد: [0-9]+$/.test(head), head);
    const seen = await p.evaluate(() => [...document.querySelectorAll('.task-card')].map((c) => {
      const ln = c.querySelector('.task-line'); const box = ln.getBoundingClientRect();
      const parts = [...ln.querySelectorAll('.lp')].map((s) => { const rs = [...s.getClientRects()]; return { text: s.textContent, cut: !rs.length || rs.some((q) => q.bottom > box.bottom + 1 || q.top < box.top - 1 || q.right > box.right + 1 || q.left < box.left - 1) }; });
      // (Where «2.4» and «6.0» stand on screen, for the reading order.)
      const pos = (needle) => { const w = document.createTreeWalker(ln, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { const i = n.data.indexOf(needle); if (i >= 0) { const r = document.createRange(); r.setStart(n, i); r.setEnd(n, i + needle.length); return r.getBoundingClientRect().left; } } return null; };
      return { id: c.dataset.id, line: ln.textContent, parts, ellipsis: getComputedStyle(ln).textOverflow, at24: pos('2.4'), at60: pos('6.0') };
    }));
    for (const id of ['running', 'trickle', 'held', 'paused', 'queued', 'netwait']) {
      const c = seen.find((x) => x.id === id); if (!c) { ok(`[${tag}] ${id} drawn`, false); continue; }
      const cut = c.parts.slice(0, 3).filter((q) => q.cut);
      ok(`[${tag}] ${id}: state, sizes and speed seen whole («${c.line.slice(0, 80)}»)`, !cut.length && c.ellipsis !== 'ellipsis', { cut, line: c.line });
    }
    for (const id of ['running', 'paused']) {
      const c = seen.find((x) => x.id === id); const logical = c ? c.line.indexOf('2.4') < c.line.indexOf('6.0') : false;
      ok(`[${tag}] ${id}: «2.4 MB من 6.0 MB» — done first in reading order (right of the total on screen)`, !!c && logical && c.at24 > c.at60, c && { line: c.line, at24: c.at24, at60: c.at60 });
    }
    if (width === 360) { const hgt = await p.evaluate(() => Math.ceil((document.querySelector('.task-list')?.getBoundingClientRect().bottom ?? 800) + window.scrollY + 120)); await p.setViewportSize({ width, height: Math.max(800, hgt) }); await sleep(400); await p.screenshot({ path: path.join(SHOTS, 'D4b-cards-ar.png') }); }
    if (errs.length) ok(`[${tag}] no page errors`, false, errs);
    await ctx.close();
  }
  // ---- D4b: no Arabic downloads string puts a counted noun after a count: «… · العدد: {n}» / «label: {n}» instead.
  {
    const ar = fs.readFileSync(path.join(ROOT, 'src', 'i18n', 'ar.ts'), 'utf8'); const keys = new Set();
    for (const f of ['views/downloads.ts', 'views/downloadsOptions.ts', 'downloads/errors.ts', 'downloads/live.ts', 'downloads/extras.ts']) for (const m of fs.readFileSync(path.join(ROOT, 'src', f), 'utf8').matchAll(/\bt\('([A-Za-z0-9_]+)'/g)) keys.add(m[1]);
    const bad = [];
    for (const k of keys) { const m = new RegExp(`\\b${k}: (?:"([^"]*)"|'([^']*)')`).exec(ar); const v = m ? (m[1] ?? m[2]) : ''; if (/\{(n|all|added|skipped|peers|seeds|a|q|count)\}\s*(?!من[\s]|\/|·|$)[ء-ي]/.test(v)) bad.push(`${k}: ${v}`); }
    ok(`[strings] Arabic downloads strings: no «{n} + noun» (${keys.size} keys read)`, !bad.length, bad);
    // (…and no count handed to them as «3 عناصر»: countItems is a number with its noun.)
    const withNoun = ['views/downloads.ts', 'views/downloadsOptions.ts', 'downloads/extras.ts'].filter((f) => /\bcountItems\(/.test(fs.readFileSync(path.join(ROOT, 'src', f), 'utf8')));
    ok('[strings] the downloads view hands no «number + noun» count (countItems) to its strings', !withNoun.length, withNoun);
  }
  // ---- 20 queued with a limit of 3; pause all; resume all; a reload mid-download; back online (phone, en)
  {
    const ctx = await br.newContext({ viewport: W.phone, deviceScaleFactor: 2, isMobile: true, hasTouch: true }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.abort());
    const q = Array.from({ length: 20 }, (_, i) => T(`q${String(i + 1).padStart(2, '0')}`, { state: i < 3 ? 'downloading' : 'queued', done: i < 3 ? MB : 0, downSpeed: i < 3 ? 300 * 1024 : 0, addedAt: now0 + i }));
    await p.addInitScript(`(${FIXTURE.toString()})(${JSON.stringify({ lang: 'en', pc: false, tasks: q, maxActive: 3 })})`);
    await p.goto(base + '#/'); await p.waitForSelector('.task-card', { timeout: 15000 }); await sleep(700);
    const sb = async () => p.$eval('.dl-status', (e) => e.textContent);
    ok('[queue] 3 running · 17 waiting, said in the status bar', /3\D+17/.test(await sb()), await sb());
    const order = await p.evaluate(() => window.__tasks.filter((x) => x.state === 'downloading').map((x) => x.id));
    ok('[queue] the first three in order are the ones running', order.join() === 'q01,q02,q03', order);
    const menu = async (label) => { await p.click('.topbar-actions button[aria-label="More"]'); await p.waitForSelector('.sheet .dest-row'); await p.locator('.sheet .dest-row', { hasText: label }).first().click(); await sleep(600); };
    await menu('Pause all');
    ok('[queue] pause all: every one paused, none running or waiting', await p.evaluate(() => window.__tasks.every((x) => x.state === 'paused')), await p.evaluate(() => window.__tasks.map((x) => x.state).join()));
    await menu('Resume all');
    const after = await p.evaluate(() => ({ run: window.__tasks.filter((x) => x.state === 'downloading').map((x) => x.id), wait: window.__tasks.filter((x) => x.state === 'queued').length }));
    ok('[queue] resume all: 3 running again — the first three, in order — and 17 waiting (fair: the order kept)', after.run.join() === 'q01,q02,q03' && after.wait === 17, after);
    // (Reloaded mid-download: the engine's saved state — interrupted, its bytes — comes back as it was.)
    await p.evaluate(() => { const x = window.__tasks[0]; x.state = 'paused'; x.done = 2.4 * 1048576; x.meta = { interrupted: true }; window.__push(); });
    await p.reload(); await p.waitForSelector('.task-card', { timeout: 15000 }); await sleep(800);
    const c1 = (await p.evaluate(CARDS)).find((c) => c.id === 'q01');
    ok('[reload] the card back paused with its bytes (2.4 MB of 6 MB)', !!c1 && /Paused/.test(c1.line) && /2\.4 MB/.test(c1.line) && Math.abs(c1.bar - 0.4) < 0.01, c1);
    ok('[reload] the interrupted one offered back (recovery note)', await p.$eval('.recovery-note', (e) => !e.hidden && /Resume/.test(e.textContent)).catch(() => false));
    // (Back online: those that failed for want of a connection go on by themselves.)
    await p.evaluate(() => { for (const x of window.__tasks.slice(3, 6)) { x.state = 'failed'; x.error = 'Unable to resolve host "example.invalid": No address associated with hostname'; } window.__tasks[6].state = 'failed'; window.__tasks[6].error = 'HTTP 404'; window.__push(); });
    await ctx.setOffline(true); await sleep(300); await ctx.setOffline(false); await sleep(1200);
    const back = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'resume').map((c) => c[1]));
    ok('[online] back online: the three that failed offline resumed by themselves, the 404 not', ['q04', 'q05', 'q06'].every((id) => back.includes(id)) && !back.includes('q07'), back);
    await p.screenshot({ path: path.join(SHOTS, 'D4-queue-en.png') });
    if (errs.length) ok('[queue] no page errors', false, errs);
    await ctx.close();
  }
  await br.close();
}

(async () => {
  server.listen(0, '127.0.0.1'); await new Promise((r) => server.once('listening', r)); const port = server.address().port;
  const t0 = Date.now(); let R = {};
  if (PART !== 'page') R = await engine(port);
  if (PART !== 'engine') { if (!fs.existsSync(path.join(DIST, 'index.html'))) ok('page: dist built', false); else await page(port, R); }
  server.close(); server.closeAllConnections?.();
  console.log(`\nshots: ${SHOTS}`);
  if (faultLog.length) { console.log('\nFAULTS:'); for (const f of faultLog) console.log('  ' + f); }
  console.log(`dlwalk: ${passes} ok, ${fails} failed, ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exit(fails ? 1 : 0);
})();
