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
    // (GitHub answers 5xx and times out now and then: up to six tries with a growing pause, each taking up where the
    // last stopped when the server honours a Range; a 4xx is final.)
    let done = 0, total = 0, last = 0, lastErr = null; fs.rmSync(tmp, { force: true });
    for (let attempt = 0; attempt < 6; attempt++) {
      if (ctl.signal.aborted) throw new Error('cancelled');
      if (attempt > 0) await new Promise((ok) => setTimeout(ok, Math.min(20000, 1500 * 2 ** (attempt - 1))));
      let out = null;
      try {
        const resume = done > 0;
        const r = await net.fetch(url, { signal: ctl.signal, headers: resume ? { Range: 'bytes=' + done + '-' } : {} });
        let append = resume;
        if (resume && r.status === 200) { done = 0; append = false; fs.rmSync(tmp, { force: true }); }
        else if (r.status !== 200 && r.status !== 206) throw new Error('HTTP ' + r.status);
        if (!append || !total) { const len = Number(r.headers.get('content-length') || 0); total = len > 0 ? len + (append ? done : 0) : 0; }
        out = fs.createWriteStream(tmp, { flags: append ? 'a' : 'w' });
        const reader = r.body.getReader();
        for (;;) { const { done: end, value } = await reader.read(); if (end) break; const b = Buffer.from(value); done += b.length; if (!out.write(b)) await new Promise((ok) => out.once('drain', ok)); const now = Date.now(); if (now - last > 250) { last = now; onProgress({ name, done, total }); } }
        await new Promise((ok, no) => out.end((e) => (e ? no(e) : ok()))); out = null;
        if (total && done < total) throw new Error('cut short');
        lastErr = null; break;
      } catch (e) {
        if (out) { try { await new Promise((ok) => out.end(ok)); } catch { /* closed */ } }
        if (ctl.signal.aborted) throw new Error('cancelled');
        lastErr = e; if (/^HTTP 4\d\d$/.test(String(e.message))) throw e;
      }
    }
    if (lastErr) throw lastErr;
    onProgress({ name, done, total });
    const hash = crypto.createHash('sha256'); await new Promise((ok, no) => fs.createReadStream(tmp).on('data', (b) => hash.update(b)).on('error', no).on('end', ok));
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
