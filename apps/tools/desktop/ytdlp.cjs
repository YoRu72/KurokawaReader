// yt-dlp on the desktop: the binary fetched from its GitHub releases into the app's data folder and checked
// against SHA2-256SUMS (refreshed when a day old and a site fails), `-J` for what a page offers, and video jobs
// run with progress — shown beside the other downloads as tasks of kind «video».
'use strict';
const { app, net } = require('electron'); const fs = require('node:fs'); const path = require('node:path'); const { spawn, execFile } = require('node:child_process'); const crypto = require('node:crypto');
const Ffmpeg = require('./ffmpeg.cjs');

const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const binDir = () => path.join(app.getPath('userData'), 'bin');
const managedPath = () => path.join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
/** A binary of the reader's own choosing (Settings → Video → path), when it exists; else the managed one. */
let customPath = ''; function setCustomPath(p) { customPath = p && fs.existsSync(p) ? p : ''; verCache = null; return !!customPath; }
const binPath = () => customPath || managedPath();
const isManaged = () => !customPath;
/** Releases older than this are not run: a forced update instead (sites change; an old yt-dlp fails everywhere). */
const MIN_VERSION = '2025.01.01';
const olderThan = (a, b) => String(a || '').replace(/[^\d.]/g, '') < String(b || '').replace(/[^\d.]/g, '');
/** The last three binaries kept beside the current one (yt-dlp.<version>.old) for a rollback when a release breaks a site. */
const olds = () => { try { return fs.readdirSync(binDir()).filter((n) => /\.old$/.test(n)).map((n) => ({ name: n, version: n.replace(/^yt-dlp(\.exe)?\./, '').replace(/\.old$/, ''), at: fs.statSync(path.join(binDir(), n)).mtimeMs })).sort((a, b) => b.at - a.at); } catch { return []; } };
async function keepOld() { if (!fs.existsSync(managedPath())) return; const v = (await versionOf(managedPath())) || String(Date.now()); const to = path.join(binDir(), `${path.basename(managedPath())}.${v}.old`); try { fs.copyFileSync(managedPath(), to); } catch { /* none */ } for (const o of olds().slice(3)) fs.rmSync(path.join(binDir(), o.name), { force: true }); }
async function rollback() { const o = olds()[0]; if (!o) throw new Error('nothing to roll back to'); fs.copyFileSync(path.join(binDir(), o.name), managedPath()); if (process.platform !== 'win32') fs.chmodSync(managedPath(), 0o755); fs.rmSync(path.join(binDir(), o.name), { force: true }); verCache = null; try { const cur = JSON.parse(fs.readFileSync(stampPath(), 'utf8')); fs.writeFileSync(stampPath(), JSON.stringify({ ...cur, checked: Date.now(), pinned: o.version })); } catch { /* none */ } return o.version; }
const stampPath = () => path.join(binDir(), 'yt-dlp.stamp.json');
let fetching = null;

async function fetchBinary(onProgress) {
  if (fetching) return fetching;
  fetching = (async () => {
    fs.mkdirSync(binDir(), { recursive: true });
    const sums = await (await net.fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS', { signal: AbortSignal.timeout(20000) })).text();
    const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === ASSET)?.[0];
    const res = await net.fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`); if (!res.ok || !res.body) throw new Error('yt-dlp: HTTP ' + res.status);
    const total = Number(res.headers.get('content-length') || 0); const tmp = managedPath() + '.part'; const out = fs.createWriteStream(tmp); const hash = crypto.createHash('sha256'); let got = 0;
    const reader = res.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; out.write(Buffer.from(value)); hash.update(value); got += value.length; onProgress?.({ got, total }); }
    await new Promise((r) => out.end(r));
    if (want && hash.digest('hex') !== want) { fs.rmSync(tmp, { force: true }); throw new Error('yt-dlp: checksum mismatch'); }
    await keepOld(); fs.renameSync(tmp, managedPath()); if (process.platform !== 'win32') fs.chmodSync(managedPath(), 0o755); verCache = null;
    fs.writeFileSync(stampPath(), JSON.stringify({ at: Date.now(), url: res.url }));
    return binPath();
  })().finally(() => { fetching = null; });
  return fetching;
}
function haveBinary() { return fs.existsSync(binPath()); }
/** The version, asked of the binary once per file (keyed by its size and time): a start does not spawn yt-dlp again. */
let verCache = null;
function versionOf(bin) { return new Promise((res) => execFile(bin, ['--version'], { timeout: 10000 }, (e, out) => res(e ? null : String(out).trim()))); }
async function version() { const bin = binPath(); let key = ''; try { const st = fs.statSync(bin); key = `${bin}|${st.size}|${st.mtimeMs}`; } catch { return null; } if (verCache && verCache.key === key) return verCache.v; const v = await versionOf(bin); verCache = { key, v }; return v; }
async function ensure(onProgress) { if (!haveBinary()) await fetchBinary(onProgress); else if (isManaged()) { const v = await version(); if (v && olderThan(v, MIN_VERSION)) { try { await fetchBinary(onProgress); } catch { /* offline: the old one runs */ } } } return binPath(); }
/** The newest release's tag (yt-dlp prints the same string for --version). */
async function latestTag() { const r = await net.fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(15000) }); if (!r.ok) throw new Error('HTTP ' + r.status); return String((await r.json()).tag_name || '').trim(); }
/** Brings the binary to the newest release when it is behind; `force` checks even if checked within the day. */
async function update(force = false) {
  if (!haveBinary()) { await fetchBinary(); return { version: await version(), updated: true }; }
  let st = {}; try { st = JSON.parse(fs.readFileSync(stampPath(), 'utf8')); } catch { /* none */ }
  if (!force && st.checked && Date.now() - st.checked < 86400000) return { version: await version(), updated: false };
  const [have, tag] = await Promise.all([version(), latestTag()]);
  let updated = false; if (tag && have !== tag && (!st.pinned || olderThan(have, MIN_VERSION) || force)) { await fetchBinary(); updated = true; }
  try { const cur = JSON.parse(fs.readFileSync(stampPath(), 'utf8')); fs.writeFileSync(stampPath(), JSON.stringify({ ...cur, checked: Date.now() })); } catch { /* ignore */ }
  return { version: await version(), latest: tag, updated };
}
// (The one owner of the daily check on this build: main.cjs calls it after the window is up and every 6 h; never while a
// job runs — a job that fails with an extractor error asks for its own check, below.)
let busy = () => false; function setBusy(f) { busy = f; }
async function maybeUpdate() { try { if (haveBinary() && !busy()) await update(false); } catch { /* offline: next time */ } }
// (YouTube needs a JavaScript runtime since yt-dlp 2025.11 — without one it reads nothing. The app's own Node is it:
// Electron's program runs as plain Node with ELECTRON_RUN_AS_NODE, which yt-dlp's child inherits.)
// (Only for a yt-dlp that knows the option — one of the user's own may be older.)
let jsOk = true;
const JS_SINCE = '2025.11.12';
async function checkJs() { const v = await version(); jsOk = !v || !olderThan(v, JS_SINCE); }
const jsArgs = () => (jsOk ? ['--js-runtimes', `node:${process.execPath}`] : []);
const ENV = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
// (The page builds the argument list — src/downloads/videoArgs.ts —; this side only refuses what that builder never writes: a flag outside the list
// below, a value that is a flag, a file name pattern that leaves the download folder. The folder itself (-P), the ffmpeg location, the progress template
// and a sign-in are put beside it here, never taken from the page's list.)
const ALLOWED = new Set(['-f', '-S', '--merge-output-format', '--remux-video', '-x', '--audio-format', '--audio-quality', '--embed-thumbnail', '--convert-thumbnails', '--embed-metadata', '--parse-metadata', '--embed-chapters', '--split-chapters', '--write-subs', '--write-auto-subs', '--sub-langs', '--embed-subs', '--convert-subs', '--sub-format', '-k', '--write-thumbnail', '--write-info-json', '--no-clean-info-json', '--write-comments', '--sponsorblock-remove', '--sponsorblock-mark', '--download-sections', '--add-header', '--no-playlist', '--yes-playlist', '--playlist-items', '-o', '-N', '--http-chunk-size', '--retries', '--fragment-retries', '--throttled-rate', '--buffer-size']);
const ALONE = new Set(['-x', '-k', '--embed-thumbnail', '--embed-metadata', '--embed-chapters', '--split-chapters', '--write-subs', '--write-auto-subs', '--embed-subs', '--write-thumbnail', '--write-info-json', '--no-clean-info-json', '--write-comments', '--no-playlist', '--yes-playlist']);
function vetArgs(args) {
  if (!Array.isArray(args) || args.length > 200 || !args.every((a) => typeof a === 'string' && a.length <= 4000 && !a.includes('\0'))) return null;
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]; if (!a.startsWith('-') || !ALLOWED.has(a)) return null; out.push(a); if (ALONE.has(a)) continue;
    const v = args[++i]; if (v === undefined || v.startsWith('-')) return null;
    if (a === '-o') { const t = v.replace(/^(?:chapter|thumbnail|subtitle|infojson|description|pl_thumbnail|pl_infojson|pl_description|default):/, ''); if (/^[\\/~]|^[A-Za-z]:|\.\.|[$\x00]/.test(t)) return null; }
    out.push(v);
  }
  return out;
}
const common = () => { const ff = Ffmpeg.binary(); return ['--no-warnings', '--no-playlist-reverse', ...jsArgs(), ...(fs.existsSync(ff) ? ['--ffmpeg-location', ff] : [])]; };

/* ---------- a sign-in kept per site (the in-app browser's cookies of that site only), a read page reused ---------- */
// (kt-core videotools.rs cookie_site / netscape_file / with_shell_inputs / info_id are the same rules for the Tauri build.)
const cookieDir = () => path.join(app.getPath('userData'), 'video-cookies');
const infoDir = () => path.join(app.getPath('userData'), 'video-info');
const INFO_FRESH_MS = 5 * 60 * 1000;
function cookieSite(url) {
  let h; try { h = new URL(String(url)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  if (!h || /^[\d.]+$/.test(h) || h.startsWith('[')) return null;
  const l = h.split('.').filter(Boolean); if (l.length < 2) return null; const n = l.length;
  const keep = n >= 3 && l[n - 1].length === 2 && ['co', 'com', 'net', 'org', 'or', 'ac', 'gov', 'edu', 'ne', 'go'].includes(l[n - 2]) ? 3 : 2;
  const site = l.slice(n - keep).join('.');
  return site === 'youtu.be' || site === 'youtube-nocookie.com' ? 'youtube.com' : site === 'twitter.com' ? 'x.com' : site;
}
const cookieFileName = (site) => { const s = String(site || '').toLowerCase().replace(/[^a-z0-9.-]/g, ''); return !s || s.startsWith('.') || s.includes('..') || s.length > 100 ? null : `${s}.txt`; };
/** The kept sign-in of a link's site, when there is one. */
function cookieFileFor(url) { const n = cookieFileName(cookieSite(url)); if (!n) return null; const f = path.join(cookieDir(), n); return fs.existsSync(f) ? f : null; }
function netscapeFile(site, cookies) {
  let out = '# Netscape HTTP Cookie File\n# Kept by Kurokawa Tools for one site; delete it in Settings.\n\n'; const seen = new Set();
  for (const c of cookies) {
    const d = String(c.domain || '').toLowerCase(); const bare = d.replace(/^\./, ''); if (!bare || !(bare === site || bare.endsWith(`.${site}`))) continue;
    const bad = (x) => /[\t\r\n]/.test(String(x)); if (!c.name || bad(c.name) || bad(c.value) || bad(d) || bad(c.path || '')) continue;
    const key = `${d}|${c.path}|${c.name}`; if (seen.has(key)) continue; seen.add(key);
    const sub = d.startsWith('.') || c.hostOnly === false;
    out += `${c.httpOnly ? '#HttpOnly_' : ''}${sub && !d.startsWith('.') ? `.${d}` : d}\t${sub ? 'TRUE' : 'FALSE'}\t${c.path || '/'}\t${c.secure ? 'TRUE' : 'FALSE'}\t${Math.max(0, Math.floor(Number(c.expirationDate) || 0))}\t${c.name}\t${c.value}\n`;
  }
  return out;
}
const countOf = (text) => text.split('\n').filter((l) => l.trim() && (!l.startsWith('#') || l.startsWith('#HttpOnly_'))).length;
/** The in-app browser's cookies of `url`'s site written to the app's own file for it (only this user may read it); never logged. → { site, count } */
async function saveCookies(url, cookies) {
  const site = cookieSite(url); const name = cookieFileName(site); if (!name) throw new Error('not a site');
  const text = netscapeFile(site, cookies); const count = countOf(text); if (!count) return { site, count: 0 };
  fs.mkdirSync(cookieDir(), { recursive: true, mode: 0o700 }); const f = path.join(cookieDir(), name); const tmp = `${f}.part`;
  fs.writeFileSync(tmp, text, { mode: 0o600 }); fs.renameSync(tmp, f); try { fs.chmodSync(f, 0o600); } catch { /* Windows: the user's own folder */ }
  return { site, count };
}
function listCookies() { try { return fs.readdirSync(cookieDir()).filter((n) => /\.txt$/.test(n)).map((n) => { const f = path.join(cookieDir(), n); let count = 0; try { count = countOf(fs.readFileSync(f, 'utf8')); } catch { /* unreadable */ } return { site: n.replace(/\.txt$/, ''), count, at: fs.statSync(f).mtimeMs }; }); } catch { return []; } }
/** A kept sign-in removed: overwritten first, then deleted. */
function removeCookies(site) { const n = cookieFileName(site); if (!n) return false; const f = path.join(cookieDir(), n); if (!fs.existsSync(f)) return false; try { fs.writeFileSync(f, Buffer.alloc(fs.statSync(f).size)); } catch { /* gone */ } fs.rmSync(f, { force: true }); return true; }
/** The shell's own inputs added to a list whose last argument is the address (kt-core with_shell_inputs). */
function withShellInputs(args, cookieFile, infoFile) {
  const a = []; const last = args.length - 1;
  for (let i = 0; i < last; i++) { if (cookieFile && args[i] === '--cookies-from-browser' && i + 1 < last) { i++; continue; } a.push(args[i]); }
  if (cookieFile) a.push('--cookies', cookieFile);
  if (infoFile) a.push('--load-info-json', infoFile); else if (last >= 0) a.push(args[last]);
  return a;
}
/** FNV-1a 64 of what was asked: the name a read page is kept under (16 hex digits). */
function infoId(url, playlist, cookies) { let h = 0xcbf29ce484222325n; for (const b of Buffer.from(`${playlist ? 'p' : 'v'}|${cookies || ''}|${url}`)) { h ^= BigInt(b); h = (h * 0x100000001b3n) & 0xffffffffffffffffn; } return h.toString(16).padStart(16, '0'); }
const infoIdOk = (id) => typeof id === 'string' && /^[0-9a-f]{16}$/.test(id);
/** A page read moments ago, by the id this shell gave it: its file when still fresh (signed media addresses expire). */
function freshInfo(id) { if (!infoIdOk(id)) return null; const f = path.join(infoDir(), `${id}.json`); try { return Date.now() - fs.statSync(f).mtimeMs < INFO_FRESH_MS ? f : null; } catch { return null; } }
function tidyInfo() { try { for (const n of fs.readdirSync(infoDir())) { const f = path.join(infoDir(), n); if (Date.now() - fs.statSync(f).mtimeMs > INFO_FRESH_MS * 2) fs.rmSync(f, { force: true }); } } catch { /* none */ } }

/** What a page offers: title, thumbnail, duration, formats; a playlist's entries (flat). One video's answer is kept a
 *  few minutes (its id handed back), so the download that follows reads it instead of asking the site again. */
async function info(url, opts = {}) {
  await ensure();
  await checkJs();
  // (-J reads the page once and prints everything; a playlist only flat — its entries, not each video —; one video never walks its list; a page that does not answer is let go of after 15 s a try, and a known extractor error is tried once more, not three times.)
  const ck = cookieFileFor(url);
  const base = ['-J', '--no-warnings', '--skip-download', '--socket-timeout', '15', '--extractor-retries', '1', ...jsArgs(), ...(opts.playlist ? ['--flat-playlist'] : ['--no-playlist']), ...(opts.cookiesFromBrowser ? ['--cookies-from-browser', String(opts.cookiesFromBrowser)] : []), String(url)];
  const args = withShellInputs(base, ck, null);
  const out = await new Promise((res, rej) => execFile(binPath(), args, { maxBuffer: 64 << 20, timeout: 90000, env: ENV }, (e, so, se) => (e ? rej(new Error(e.killed && !se ? 'ERROR: timed out' : String(se || e.message).trim().split('\n').pop())) : res(so))));
  const j = JSON.parse(out);
  const shaped = normalise(j);
  if (shaped.kind === 'video') { try { fs.mkdirSync(infoDir(), { recursive: true, mode: 0o700 }); const id = infoId(String(url), false, ck ? 'kept' : String(opts.cookiesFromBrowser || '')); fs.writeFileSync(path.join(infoDir(), `${id}.json`), out, { mode: 0o600 }); shaped.infoId = id; tidyInfo(); } catch { /* not kept: the download reads the page again */ } }
  return shaped;
}
function normalise(j) {
  if (j._type === 'playlist') return { kind: 'playlist', title: j.title, entries: (j.entries || []).filter(Boolean).map((e) => ({ url: e.url || e.webpage_url || e.original_url, title: e.title, duration: e.duration, id: e.id })), count: (j.entries || []).length, url: j.webpage_url };
  const fmts = (j.formats || []).filter((f) => f.url || f.manifest_url);
  const video = fmts.filter((f) => f.vcodec && f.vcodec !== 'none'); const audioOnly = fmts.filter((f) => (!f.vcodec || f.vcodec === 'none') && f.acodec && f.acodec !== 'none');
  const byHeight = new Map();
  for (const f of video) { const h = f.height || 0; const key = `${h}${f.dynamic_range && /HDR|HLG/i.test(f.dynamic_range) ? ' HDR' : ''}`; const prev = byHeight.get(key); const score = (f.fps || 0) * 1000 + (f.tbr || 0) + (f.acodec && f.acodec !== 'none' ? 1 : 0); if (!prev || score > prev.score) byHeight.set(key, { f, score }); }
  const bestAudio = [...audioOnly].sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const choices = [...byHeight.values()].map(({ f }) => f).sort((a, b) => (b.height || 0) - (a.height || 0)).map((f) => { const muxed = f.acodec && f.acodec !== 'none'; const size = (f.filesize || f.filesize_approx || 0) + (muxed || !bestAudio ? 0 : (bestAudio.filesize || bestAudio.filesize_approx || 0)); return { id: muxed ? f.format_id : `${f.format_id}+${bestAudio ? bestAudio.format_id : 'bestaudio'}`, kind: 'video', label: `${f.height ? `${f.height}p${f.fps && f.fps > 30 ? Math.round(f.fps) : ''}` : f.format_note || f.format_id}${f.dynamic_range && /HDR|HLG/i.test(f.dynamic_range) ? ' HDR' : ''}`, ext: f.ext, height: f.height, fps: f.fps, size: size || undefined, vcodec: f.vcodec, acodec: muxed ? f.acodec : bestAudio?.acodec, note: f.format_note }; });
  const audio = [...audioOnly].sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0)).slice(0, 4).map((f) => ({ id: f.format_id, kind: 'audio', label: `${Math.round(f.abr || f.tbr || 0)} kbps ${f.acodec || ''}`.trim(), ext: f.ext, size: f.filesize || f.filesize_approx || undefined, acodec: f.acodec }));
  return { kind: 'video', id: j.id, title: j.title, thumbnail: j.thumbnail, duration: j.duration, site: j.extractor_key, url: j.webpage_url || j.original_url, uploader: j.uploader || j.channel, choices, audio, subtitles: Object.keys(j.subtitles || {}), live: !!j.is_live, chapters: (j.chapters || []).length };
}

/** What one line of yt-dlp's output says, kept on the task: bytes over all the streams (video, then audio — the bar does not start again),
 *  speed and time left of the stream running, its pieces (fragment i of n), and the phase — video, audio, merging, converting, embedding, finishing.
 *  The page is told at most every 400 ms, and at once when the phase changes. */
function lineReader(t, m, emit) {
  let dests = 0, offset = 0, last = 0, streamTotal = 0; const fmt = String(m.audioFmt || '').toUpperCase(); const meta = () => (t.meta = t.meta || {});
  const phaseOf = (p) => { const x = meta(); if (x.phase === p) return false; x.phase = p; return true; };
  return (l) => {
    let force = false;
    if (l.startsWith('KT|')) {
      const [, done, total, est, speed, eta, fi, fc, ...rest] = l.split('|'); const file = rest.join('|'); const cur = Number(done) || 0; const tot = Number(total) || Number(est) || 0; streamTotal = tot || streamTotal;
      t.done = offset + cur; t.total = Math.max(Number(m.expect) || 0, offset + tot); t.downSpeed = Number(speed) || 0; t.eta = Number(eta) || undefined;
      const x = meta(); if (fc && fc !== 'NA' && Number(fc) > 1) { x.frag = Number(fi) || 0; x.frags = Number(fc); } else { delete x.frag; delete x.frags; }
      if (!x.phase || x.phase === 'info') force = phaseOf(m.audioOnly || dests > 1 ? 'audio' : 'video');
      if (file && file !== 'NA') { const base = path.basename(file).replace(/\.f\d+\.(\w+)$/, '.$1').replace(/\.part$/, ''); t.files = [{ index: 0, path: base, size: t.total, done: t.done, priority: 1 }]; t.name = base.replace(/\.[^.]+$/, '') || t.name; }
    } else if (/^\[download\] Destination:/.test(l)) { dests++; if (dests > 1) { offset += streamTotal; streamTotal = 0; } force = phaseOf(m.audioOnly || dests > 1 ? 'audio' : 'video'); }
    else if (/^\[(Merger)\]/.test(l)) { force = phaseOf('merge'); t.downSpeed = 0; t.eta = undefined; delete meta().frag; delete meta().frags; }
    else if (/^\[ExtractAudio\]/.test(l)) { force = phaseOf(`convert ${fmt}`.trim()); t.downSpeed = 0; t.eta = undefined; }
    else if (/^\[(EmbedThumbnail|Metadata|EmbedSubtitle|ThumbnailsConvertor|SubtitlesConvertor)\]/.test(l)) { force = phaseOf('embed'); t.downSpeed = 0; t.eta = undefined; }
    else if (/^\[(SponsorBlock|ModifyChapters|SplitChapters|VideoRemuxer|VideoConvertor|Fixup\w*)\]/.test(l)) { force = phaseOf('finish'); t.downSpeed = 0; t.eta = undefined; }
    else if (/^\[(info|youtube|generic)\]/.test(l) && !meta().phase) force = phaseOf('info');
    if (/\[(Merger|ExtractAudio|EmbedSubtitle|Metadata|ffmpeg)\]/.test(l)) { t.detail = l.replace(/^\[\w+\]\s*/, '').slice(0, 120); if (/Merging formats into "(.+)"/.test(l)) { const f = /Merging formats into "(.+)"/.exec(l)[1]; t.files = [{ index: 0, path: path.basename(f), size: t.total, done: t.total, priority: 1 }]; t.name = path.basename(f).replace(/\.[^.]+$/, ''); } }
    const now = Date.now(); if (force || now - last > 400) { last = now; emit(); }
  };
}

/** Video jobs: each a task like the others, run by yt-dlp with its progress read from the progress template. */
class VideoJobs {
  has(id) { return this.tasks.has(id); }
  constructor(send) { this.send = send; this.tasks = new Map(); this.procs = new Map(); this.active = new Set(); this.max = 3; this.statePath = path.join(app.getPath('userData'), 'video-jobs.json'); this.load(); }
  /** At most this many run at once (Settings → Downloads «Simultaneous video downloads»); the rest wait, oldest first. */
  setMax(n) { this.max = Math.max(1, Math.min(10, Math.floor(Number(n)) || 3)); this.pump(); }
  running() { return this.active.size; }
  /** The waiting ones started while there is room, in the order they were added. */
  pump() { for (const t of this.tasks.values()) { if (this.active.size >= this.max) break; if (t.state === 'queued' && !this.active.has(t.id)) void this.start(t.id); } }
  load() { try { for (const t of JSON.parse(fs.readFileSync(this.statePath, 'utf8'))) { if (t.state === 'downloading' || t.state === 'queued') t.state = 'paused'; this.tasks.set(t.id, t); } } catch { /* none */ } }
  save() { try { fs.writeFileSync(this.statePath, JSON.stringify([...this.tasks.values()])); } catch { /* ignore */ } }
  list() { return [...this.tasks.values()]; }
  emit() { this.send(); }
  async add(o) {
    const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const t = { id, kind: 'video', name: o.title || o.url, source: { url: o.url }, dir: o.dir, state: 'queued', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), meta: { ...(o.meta || {}), kind: 'video', site: o.site, quality: o.label, format: o.format, audioOnly: !!o.audioOnly, container: o.container, headers: o.headers, outName: o.outName, subs: o.subs, embedThumb: o.embedThumb, embedMeta: o.embedMeta, sponsorblock: o.sponsorblock, args: Array.isArray(o.args) ? o.args : undefined, expect: o.expect || undefined, audioFmt: o.audioFmt, playlistIndex: o.playlistIndex, cookiesFromBrowser: o.cookies || o.cookiesFromBrowser, chapters: o.chapters, template: o.template, section: o.section, infoId: infoIdOk(o.infoId) ? o.infoId : undefined }, engine: 'native' };
    this.tasks.set(id, t); this.save(); this.emit(); if (!o.paused) void this.start(id); return t;
  }
  async start(id) {
    const t = this.tasks.get(id); if (!t || this.procs.has(id) || this.active.has(id)) return;
    // (No room: it waits its turn — «queued», its place shown in the list — and starts when one ends.)
    if (this.active.size >= this.max) { t.state = 'queued'; t.downSpeed = 0; this.emit(); this.save(); return; }
    this.active.add(id); t.state = 'downloading'; t.error = undefined; this.emit();
    try { await ensure(); } catch (e) { this.active.delete(id); t.state = 'failed'; t.error = String(e.message); this.emit(); this.save(); this.pump(); return; }
    await checkJs();
    const m = t.meta || {}; const safe = (x) => String(x).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 180); const tpl = m.template && !/[\\/]|\.\./.test(m.template) ? m.template : '%(title)s [%(id)s]';
    const outTpl = m.outName ? path.join(t.dir, `${safe(m.outName)}.%(ext)s`) : m.template ? path.join(t.dir, `${m.playlistIndex ? `${String(m.playlistIndex).padStart(2, '0')} - ` : ''}${tpl}.%(ext)s`) : path.join(t.dir, m.playlistIndex ? `${String(m.playlistIndex).padStart(2, '0')} - %(title)s [%(id)s].%(ext)s` : '%(title)s [%(id)s].%(ext)s');
    // (A list the page built — src/downloads/videoArgs.ts — runs as it is, vetted, in the download folder (-P); a task from before it, or one the local API added, runs the older way below.)
    const vetted = Array.isArray(m.args) ? vetArgs(m.args) : null;
    if (Array.isArray(m.args) && !vetted) { this.active.delete(id); t.state = 'failed'; t.error = 'invalid options'; this.emit(); this.save(); this.pump(); return; }
    const args = [...common(), '--newline', ...(vetted ? [] : ['--no-playlist']), '--continue', '--no-mtime', '--progress-template', 'download:KT|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(progress.fragment_index)s|%(progress.fragment_count)s|%(info.filename)s', ...(vetted ? ['-P', t.dir, ...vetted] : ['-o', outTpl])];
    if (!vetted) {
    if (m.audioOnly) args.push('-f', m.format || 'bestaudio/best', '-x', ...(m.container ? ['--audio-format', m.container] : [])); else args.push('-f', m.format ? `${m.format}/best` : 'bestvideo+bestaudio/best', ...(m.container ? ['--merge-output-format', m.container] : ['--merge-output-format', 'mp4']));
    if (m.subs) { args.push('--write-subs', '--sub-langs', m.subs, '--embed-subs'); if (m.bilingual) args.push('--sub-format', 'srt/best', '--convert-subs', 'srt', '-k'); } if (m.embedThumb) args.push('--embed-thumbnail'); if (m.infoJson) args.push('--write-info-json', '--no-clean-info-json'); if (m.comments) args.push('--write-comments'); if (m.liveChat) args.push('--write-subs', '--sub-langs', (m.subs ? m.subs + ',' : '') + 'live_chat'); if (m.cover) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg', '-o', `thumbnail:${path.join(t.dir, `${m.outName ? safe(m.outName) : tpl}.%(ext)s`)}`); if (m.embedMeta !== false) args.push('--embed-metadata'); { const mode = m.sponsorMode || (m.sponsorblock ? 'remove' : 'off'); const cats = m.sponsorCats || 'sponsor'; if (mode === 'remove') args.push('--sponsorblock-remove', cats); else if (mode === 'mark') args.push('--sponsorblock-mark', cats, '--embed-chapters'); }
    }
    if (m.cookiesFromBrowser) args.push('--cookies-from-browser', m.cookiesFromBrowser);
    if (!vetted) {
    if (m.chapters) args.push('--embed-chapters');
    if (m.section) for (const sec of String(m.section).split(/\s*[,;]\s*/)) if (/^[\d:.]+-[\d:.]+$/.test(sec)) args.push('--download-sections', `*${sec}`);
    if (m.chapterMatch) args.push('--download-sections', String(m.chapterMatch));
    if (m.splitChapters) args.push('--split-chapters', '-o', `chapter:${path.join(t.dir, `${m.outName ? safe(m.outName) : tpl} - %(section_number)02d %(section_title)s.%(ext)s`)}`);
    for (const [k, v] of Object.entries(m.headers || {})) if (k && v) args.push('--add-header', `${k}:${v}`);
    }
    args.push(t.source.url);
    // (The shell's own inputs: the site's kept sign-in, and the page read moments ago for the chooser — the site not asked again.)
    const infoFile = m.noInfo ? null : freshInfo(m.infoId);
    const run = withShellInputs(args, cookieFileFor(t.source.url), infoFile);
    if (t.state !== 'downloading') { this.active.delete(id); this.pump(); return; }
    const p = spawn(binPath(), run, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env: ENV }); this.procs.set(id, p); let err = ''; let buf = '';
    const read = lineReader(t, m, () => this.emit());
    p.stdout.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop() || ''; for (const l of lines) read(l); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('close', (code) => { this.procs.delete(id); this.active.delete(id); const tt = this.tasks.get(id); if (!tt) { this.pump(); return; }
      if (code !== 0 && tt.state === 'downloading') {
        const line = err.trim().split('\n').filter((l) => /ERROR/.test(l)).pop() || '';
        // (The page read before could not be used — its addresses expired, or it was refused —: read again, once, at once.)
        if (infoFile && !m.noInfo) { m.noInfo = true; this.save(); void this.start(id); return; }
        // (A site that changed: most «it stopped working» is an old yt-dlp. Checked for a newer one once; when there was one, tried again once.)
        if (healable(line) && !m.healTried && isManaged()) { m.healTried = true; tt.detail = 'yt-dlp update'; this.emit(); void update(true).then((r) => { if (r && r.updated) { m.healed = r.version || true; this.save(); void this.start(id); } else { tt.state = 'failed'; tt.error = line.replace(/^ERROR:\s*/, '').slice(0, 300); this.save(); this.emit(); this.pump(); } }, () => { tt.state = 'failed'; tt.error = line.replace(/^ERROR:\s*/, '').slice(0, 300); this.save(); this.emit(); this.pump(); }); return; }
      }
      if (tt.state === 'paused' || tt.state === 'removed') { /* asked */ } else if (code === 0) { tt.state = 'done'; tt.done = tt.total || tt.done; tt.doneAt = Date.now(); tt.downSpeed = 0; if (m.bilingual && tt.files && tt.files[0]) { try { bilingual(path.join(tt.dir, tt.files[0].path || tt.files[0].name || ''), String(m.bilingual)); } catch (e) { /* the two files stay */ } } } else { tt.state = 'failed'; tt.error = (err.trim().split('\n').filter((l) => /ERROR/.test(l)).pop() || err.trim().split('\n').pop() || `yt-dlp ${code}`).replace(/^ERROR:\s*/, '').slice(0, 300); } this.save(); this.emit(); this.pump(); });
  }
  pause(id) { const t = this.tasks.get(id); if (!t) return; t.state = 'paused'; t.downSpeed = 0; const p = this.procs.get(id); if (p) p.kill(); else { this.active.delete(id); this.pump(); } this.save(); this.emit(); }
  resume(id) { const t = this.tasks.get(id); if (!t) return; void this.start(id); }
  remove(id, deleteFiles) { const t = this.tasks.get(id); if (!t) return; t.state = 'removed'; const p = this.procs.get(id); if (p) p.kill(); else { this.active.delete(id); } this.tasks.delete(id); this.pump(); if (deleteFiles && t.dir) { try { for (const f of fs.readdirSync(t.dir)) if (t.files[0] && f.startsWith(t.files[0].path.replace(/\.[^.]+$/, ''))) fs.rmSync(path.join(t.dir, f), { force: true }); } catch { /* ignore */ } } this.save(); this.emit(); }
  fileOf(id) { const t = this.tasks.get(id); return t && t.files[0] ? path.join(t.dir, t.files[0].path) : t?.dir; }
  stop() { for (const p of this.procs.values()) p.kill(); }
}
// (A copy of src/video/ytdlp.ts's list — tests/videohosts.cjs keeps the three equal.)
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|reddit\.com|bilibili\.com|bilibili\.tv|nicovideo\.jp|soundcloud\.com|bandcamp\.com|ok\.ru|vk\.com|vkvideo\.ru|rumble\.com|odysee\.com|streamable\.com|imgur\.com|pinterest\.com|threads\.net|9gag\.com|crunchyroll\.com|iwara\.tv|nhk\.or\.jp|abema\.tv|tver\.jp|kick\.com|archive\.org|ted\.com|bitchute\.com|mixcloud\.com|vlive\.tv|weibo\.com|douyin\.com|ixigua\.com|youku\.com|zhihu\.com|naver\.com|kakao\.com|aparat\.com|shahid\.mbc\.net)$/i;
/** kt-core videotools.rs healable: a failure a newer yt-dlp often mends. */
const healable = (line) => /unable to extract|failed to extract|failed to parse|nsig extraction failed|player response|please report this issue|update yt-dlp|yt-dlp -u|signature solving failed|n challenge solving failed/i.test(line);
module.exports = { vetArgs, ensure, haveBinary, version, update, info, normalise, VideoJobs, maybeUpdate, setBusy, VIDEO_HOSTS, binPath, rollback, olds, setCustomPath, isManaged, MIN_VERSION, cookieSite, cookieFileFor, saveCookies, listCookies, removeCookies, withShellInputs, infoId, freshInfo, healable };

/* ---------- a bilingual subtitle: two .srt files beside the video (yt-dlp's «stem.lang.srt») merged, cue by cue ---------- */
const TIMES = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
const ms = (t) => { const p = t.replace('.', ',').split(/[:,]/); return ((+p[0] * 60 + +p[1]) * 60 + +p[2]) * 1000 + +(p[3] || '0').padEnd(3, '0').slice(0, 3); };
const cues = (f) => { const out = []; for (const block of fs.readFileSync(f, 'utf8').replace(/\r/g, '').split(/\n\n+/)) { const lines = block.trim().split('\n'); for (let i = 0; i < lines.length; i++) { const m = TIMES.exec(lines[i]); if (m) { const text = lines.slice(i + 1).map((l) => l.replace(/<[^>]+>/g, '')).join('\n'); if (text) out.push([m[1], m[2], text]); break; } } } return out; };
function bilingual(out, pair) {
  const [la, lb] = pair.split(','); if (!la || !lb) return; const dir = path.dirname(out); const stem = path.basename(out).replace(/\.[^.]+$/, '');
  const find = (lang) => fs.readdirSync(dir).find((n) => n.startsWith(stem + '.') && n.endsWith('.srt') && (n === `${stem}.${lang}.srt` || new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.${lang}-[A-Za-z]+\\.srt$`).test(n)));
  const fa = find(la), fb = find(lb); if (!fa || !fb) return; const ca = cues(path.join(dir, fa)), cb = cues(path.join(dir, fb)); if (!ca.length || !cb.length) return;
  let n = 1; let text = '';
  for (const [s, e, t] of ca) { const s1 = ms(s), e1 = ms(e); const other = cb.filter(([s2, e2]) => { const ov = Math.min(e1, ms(e2)) - Math.max(s1, ms(s2)); return ov > 0 && ov * 2 >= Math.min(e1 - s1, ms(e2) - ms(s2)); }).map((c) => c[2].replace(/\n/g, ' ')).join(' '); text += `${n++}\n${s} --> ${e}\n${t}${other ? '\n' + other : ''}\n\n`; }
  fs.writeFileSync(path.join(dir, `${stem}.${la}-${lb}.srt`), text);
}
module.exports.bilingual = bilingual;
