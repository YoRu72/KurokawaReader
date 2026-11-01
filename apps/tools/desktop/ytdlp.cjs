// yt-dlp on the desktop: the binary fetched from its GitHub releases into the app's data folder and checked
// against SHA2-256SUMS (refreshed when a day old and a site fails), `-J` for what a page offers, and video jobs
// run with progress — shown beside the other downloads as tasks of kind «video».
'use strict';
const { app, net } = require('electron'); const fs = require('node:fs'); const path = require('node:path'); const { spawn, execFile } = require('node:child_process'); const crypto = require('node:crypto');
const Ffmpeg = require('./ffmpeg.cjs');

const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
const binDir = () => path.join(app.getPath('userData'), 'bin');
const binPath = () => path.join(binDir(), process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const stampPath = () => path.join(binDir(), 'yt-dlp.stamp.json');
let fetching = null;

async function fetchBinary(onProgress) {
  if (fetching) return fetching;
  fetching = (async () => {
    fs.mkdirSync(binDir(), { recursive: true });
    const sums = await (await net.fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS')).text();
    const want = sums.split('\n').map((l) => l.trim().split(/\s+/)).find((p) => p[1] === ASSET)?.[0];
    const res = await net.fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`); if (!res.ok || !res.body) throw new Error('yt-dlp: HTTP ' + res.status);
    const total = Number(res.headers.get('content-length') || 0); const tmp = binPath() + '.part'; const out = fs.createWriteStream(tmp); const hash = crypto.createHash('sha256'); let got = 0;
    const reader = res.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; out.write(Buffer.from(value)); hash.update(value); got += value.length; onProgress?.({ got, total }); }
    await new Promise((r) => out.end(r));
    if (want && hash.digest('hex') !== want) { fs.rmSync(tmp, { force: true }); throw new Error('yt-dlp: checksum mismatch'); }
    fs.renameSync(tmp, binPath()); if (process.platform !== 'win32') fs.chmodSync(binPath(), 0o755);
    fs.writeFileSync(stampPath(), JSON.stringify({ at: Date.now(), url: res.url }));
    return binPath();
  })().finally(() => { fetching = null; });
  return fetching;
}
function haveBinary() { return fs.existsSync(binPath()); }
function version() { return new Promise((res) => execFile(binPath(), ['--version'], { timeout: 10000 }, (e, out) => res(e ? null : String(out).trim()))); }
async function ensure(onProgress) { if (!haveBinary()) await fetchBinary(onProgress); return binPath(); }
/** The newest release's tag (yt-dlp prints the same string for --version). */
async function latestTag() { const r = await net.fetch('https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest', { headers: { accept: 'application/vnd.github+json' } }); if (!r.ok) throw new Error('HTTP ' + r.status); return String((await r.json()).tag_name || '').trim(); }
/** Brings the binary to the newest release when it is behind; `force` checks even if checked within the day. */
async function update(force = false) {
  if (!haveBinary()) { await fetchBinary(); return { version: await version(), updated: true }; }
  let st = {}; try { st = JSON.parse(fs.readFileSync(stampPath(), 'utf8')); } catch { /* none */ }
  if (!force && st.checked && Date.now() - st.checked < 86400000) return { version: await version(), updated: false };
  const [have, tag] = await Promise.all([version(), latestTag()]);
  let updated = false; if (tag && have !== tag) { await fetchBinary(); updated = true; }
  try { const cur = JSON.parse(fs.readFileSync(stampPath(), 'utf8')); fs.writeFileSync(stampPath(), JSON.stringify({ ...cur, checked: Date.now() })); } catch { /* ignore */ }
  return { version: await version(), latest: tag, updated };
}
async function maybeUpdate() { try { if (haveBinary()) await update(false); } catch { /* offline: next time */ } }
const common = () => { const ff = Ffmpeg.binary(); return ['--no-warnings', '--no-playlist-reverse', ...(fs.existsSync(ff) ? ['--ffmpeg-location', ff] : [])]; };

/** What a page offers: title, thumbnail, duration, formats; a playlist's entries (flat). */
async function info(url, opts = {}) {
  await ensure();
  const args = ['-J', '--no-warnings', ...(opts.playlist ? ['--flat-playlist'] : ['--no-playlist']), ...(opts.cookiesFromBrowser ? ['--cookies-from-browser', opts.cookiesFromBrowser] : []), url];
  const out = await new Promise((res, rej) => execFile(binPath(), args, { maxBuffer: 64 << 20, timeout: 90000 }, (e, so, se) => (e ? rej(new Error(String(se || e.message).trim().split('\n').pop())) : res(so))));
  const j = JSON.parse(out);
  return normalise(j);
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

/** Video jobs: each a task like the others, run by yt-dlp with its progress read from the progress template. */
class VideoJobs {
  constructor(send) { this.send = send; this.tasks = new Map(); this.procs = new Map(); this.statePath = path.join(app.getPath('userData'), 'video-jobs.json'); this.load(); }
  load() { try { for (const t of JSON.parse(fs.readFileSync(this.statePath, 'utf8'))) { if (t.state === 'downloading' || t.state === 'queued') t.state = 'paused'; this.tasks.set(t.id, t); } } catch { /* none */ } }
  save() { try { fs.writeFileSync(this.statePath, JSON.stringify([...this.tasks.values()])); } catch { /* ignore */ } }
  list() { return [...this.tasks.values()]; }
  emit() { this.send(); }
  async add(o) {
    const id = 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const t = { id, kind: 'video', name: o.title || o.url, source: { url: o.url }, dir: o.dir, state: 'queued', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), meta: { ...(o.meta || {}), kind: 'video', site: o.site, quality: o.label, format: o.format, audioOnly: !!o.audioOnly, container: o.container, headers: o.headers, outName: o.outName, subs: o.subs, embedThumb: o.embedThumb, embedMeta: o.embedMeta, sponsorblock: o.sponsorblock, playlistIndex: o.playlistIndex, cookiesFromBrowser: o.cookies || o.cookiesFromBrowser, chapters: o.chapters, template: o.template, section: o.section }, engine: 'native' };
    this.tasks.set(id, t); this.save(); this.emit(); if (!o.paused) void this.start(id); return t;
  }
  async start(id) {
    const t = this.tasks.get(id); if (!t || this.procs.has(id)) return;
    t.state = 'downloading'; t.error = undefined; this.emit();
    try { await ensure(); } catch (e) { t.state = 'failed'; t.error = String(e.message); this.emit(); this.save(); return; }
    const m = t.meta || {}; const safe = (x) => String(x).replace(/[\\/:*?"<>|\x00-\x1f]+/g, ' ').trim().slice(0, 180); const tpl = m.template && !/[\\/]|\.\./.test(m.template) ? m.template : '%(title)s [%(id)s]';
    const outTpl = m.outName ? path.join(t.dir, `${safe(m.outName)}.%(ext)s`) : m.template ? path.join(t.dir, `${m.playlistIndex ? `${String(m.playlistIndex).padStart(2, '0')} - ` : ''}${tpl}.%(ext)s`) : path.join(t.dir, m.playlistIndex ? `${String(m.playlistIndex).padStart(2, '0')} - %(title)s [%(id)s].%(ext)s` : '%(title)s [%(id)s].%(ext)s');
    const args = [...common(), '--newline', '--no-playlist', '--continue', '--no-mtime', '--progress-template', 'download:KT|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s|%(info.filename)s', '-o', outTpl];
    if (m.audioOnly) args.push('-f', m.format || 'bestaudio/best', '-x', ...(m.container ? ['--audio-format', m.container] : [])); else args.push('-f', m.format ? `${m.format}/best` : 'bestvideo+bestaudio/best', ...(m.container ? ['--merge-output-format', m.container] : ['--merge-output-format', 'mp4']));
    if (m.subs) args.push('--write-subs', '--sub-langs', m.subs, '--embed-subs'); if (m.embedThumb) args.push('--embed-thumbnail'); if (m.embedMeta !== false) args.push('--embed-metadata'); if (m.sponsorblock) args.push('--sponsorblock-remove', 'sponsor');
    if (m.cookiesFromBrowser) args.push('--cookies-from-browser', m.cookiesFromBrowser);
    if (m.chapters) args.push('--embed-chapters');
    if (m.section && /^[\d:.]+-[\d:.]+$/.test(m.section)) args.push('--download-sections', `*${m.section}`);
    for (const [k, v] of Object.entries(m.headers || {})) if (k && v) args.push('--add-header', `${k}:${v}`);
    args.push(t.source.url);
    const p = spawn(binPath(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); this.procs.set(id, p); let err = ''; let buf = ''; let last = 0;
    p.stdout.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop() || ''; for (const l of lines) { if (l.startsWith('KT|')) { const [, done, total, est, speed, eta, file] = l.split('|'); t.done = Number(done) || 0; t.total = Number(total) || Number(est) || 0; t.downSpeed = Number(speed) || 0; t.eta = Number(eta) || undefined; if (file && file !== 'NA') { const base = path.basename(file).replace(/\.f\d+\.(\w+)$/, '.$1').replace(/\.part$/, ''); t.files = [{ index: 0, path: base, size: t.total, done: t.done, priority: 1 }]; t.name = base.replace(/\.[^.]+$/, '') || t.name; } } else if (/\[(Merger|ExtractAudio|EmbedSubtitle|Metadata|ffmpeg)\]/.test(l)) { t.detail = l.replace(/^\[\w+\]\s*/, '').slice(0, 120); if (/Merging into "(.+)"/.test(l)) { const f = /Merging into "(.+)"/.exec(l)[1]; t.files = [{ index: 0, path: path.basename(f), size: t.total, done: t.total, priority: 1 }]; t.name = path.basename(f).replace(/\.[^.]+$/, ''); } } const now = Date.now(); if (now - last > 300) { last = now; this.emit(); } } });
    p.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-10000); });
    p.on('close', (code) => { this.procs.delete(id); const tt = this.tasks.get(id); if (!tt) return; if (tt.state === 'paused' || tt.state === 'removed') { /* asked */ } else if (code === 0) { tt.state = 'done'; tt.done = tt.total || tt.done; tt.doneAt = Date.now(); tt.downSpeed = 0; } else { tt.state = 'failed'; tt.error = (err.trim().split('\n').filter((l) => /ERROR/.test(l)).pop() || err.trim().split('\n').pop() || `yt-dlp ${code}`).replace(/^ERROR:\s*/, '').slice(0, 300); } this.save(); this.emit(); });
  }
  pause(id) { const t = this.tasks.get(id); if (!t) return; t.state = 'paused'; t.downSpeed = 0; const p = this.procs.get(id); if (p) p.kill(); this.save(); this.emit(); }
  resume(id) { const t = this.tasks.get(id); if (!t) return; void this.start(id); }
  remove(id, deleteFiles) { const t = this.tasks.get(id); if (!t) return; t.state = 'removed'; const p = this.procs.get(id); if (p) p.kill(); this.tasks.delete(id); if (deleteFiles && t.dir) { try { for (const f of fs.readdirSync(t.dir)) if (t.files[0] && f.startsWith(t.files[0].path.replace(/\.[^.]+$/, ''))) fs.rmSync(path.join(t.dir, f), { force: true }); } catch { /* ignore */ } } this.save(); this.emit(); }
  fileOf(id) { const t = this.tasks.get(id); return t && t.files[0] ? path.join(t.dir, t.files[0].path) : t?.dir; }
  stop() { for (const p of this.procs.values()) p.kill(); }
}
const VIDEO_HOSTS = /(^|\.)(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com|instagram\.com|facebook\.com|fb\.watch|x\.com|twitter\.com|reddit\.com|bilibili\.com|nicovideo\.jp|soundcloud\.com|bandcamp\.com|ok\.ru|vk\.com|rumble\.com|odysee\.com|streamable\.com|imgur\.com|pinterest\.com|threads\.net|9gag\.com|crunchyroll\.com|iwara\.tv|nhk\.or\.jp|abema\.tv)$/i;
module.exports = { ensure, haveBinary, version, update, info, normalise, VideoJobs, maybeUpdate, VIDEO_HOSTS, binPath };
