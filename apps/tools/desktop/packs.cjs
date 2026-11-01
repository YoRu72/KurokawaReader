// Packs on the desktop: ffmpeg, which used to ride inside every installer, fetched from this version's release the
// first time something needs it (Convert, Make smaller, clips, yt-dlp's merging, online HLS), checked against its
// SHA-256 and kept in the app's data folder.
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto'); const zlib = require('node:zlib');
const { app, net } = require('electron');

const exe = process.platform === 'win32' ? '.exe' : '';
const dir = (name) => path.join(app.getPath('userData'), 'packs', name);
const ffmpegPath = () => path.join(dir('ffmpeg'), 'ffmpeg' + exe);
const marker = (name) => path.join(dir(name), '.kurokawa-pack');
const jobs = new Map();

function installed(name) { try { return fs.existsSync(name === 'ffmpeg' ? ffmpegPath() : '') ? fs.readFileSync(marker(name), 'utf8').trim() : null; } catch { return null; } }
function status() {
  const v = installed('ffmpeg'); let size = 0; try { if (v) size = fs.statSync(ffmpegPath()).size; } catch { /* gone */ }
  return { ffmpeg: { version: v, size }, python: { version: null, size: 0 }, platform: process.platform, arch: process.arch };
}
/** Downloads the gzipped program, checks the download's SHA-256, unpacks it beside a marker. */
async function install({ name, url, sha256, version }, onProgress) {
  if (name !== 'ffmpeg') throw new Error('pack ' + name);
  const ctl = new AbortController(); jobs.set(name, ctl);
  const d = dir(name); fs.mkdirSync(d, { recursive: true });
  const tmp = path.join(d, 'download.gz');
  try {
    const r = await net.fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status);
    const total = Number(r.headers.get('content-length') || 0); const out = fs.createWriteStream(tmp); const hash = crypto.createHash('sha256'); let done = 0, last = 0;
    const reader = r.body.getReader();
    for (;;) { const { done: end, value } = await reader.read(); if (end) break; const b = Buffer.from(value); hash.update(b); done += b.length; if (!out.write(b)) await new Promise((ok) => out.once('drain', ok)); const now = Date.now(); if (now - last > 250) { last = now; onProgress({ name, done, total }); } }
    await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok())));
    onProgress({ name, done, total });
    if (sha256 && hash.digest('hex') !== String(sha256).toLowerCase()) throw new Error('checksum');
    const dest = ffmpegPath(); const part = dest + '.part';
    await new Promise((ok, no) => fs.createReadStream(tmp).pipe(zlib.createGunzip()).on('error', no).pipe(fs.createWriteStream(part, { mode: 0o755 })).on('error', no).on('finish', ok));
    fs.renameSync(part, dest); if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
    fs.writeFileSync(marker(name), String(version || '1'));
  } finally { jobs.delete(name); fs.rmSync(tmp, { force: true }); }
}
function cancel(name) { jobs.get(name)?.abort(); }
function remove(name) { fs.rmSync(dir(name), { recursive: true, force: true }); }
module.exports = { status, install, cancel, remove, ffmpegPath, installed };
