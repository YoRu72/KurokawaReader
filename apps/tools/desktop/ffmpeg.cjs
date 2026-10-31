// ffmpeg on the desktop: the static binary that ships with the app (ffmpeg-static, unpacked from asar), or one
// on the PATH; progress read from `-progress pipe:1`; jobs cancellable.
'use strict';
const { spawn, execFile } = require('node:child_process'); const path = require('node:path'); const fs = require('node:fs');
function binary() {
  try { const p = require('ffmpeg-static'); if (p && fs.existsSync(p.replace('app.asar', 'app.asar.unpacked'))) return p.replace('app.asar', 'app.asar.unpacked'); } catch { /* not bundled */ }
  return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}
function probeBinary() { const b = binary(); const p = b.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'); return fs.existsSync(p) ? p : (process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe'); }
const jobs = new Map();
function available() { return new Promise((res) => { execFile(binary(), ['-version'], { timeout: 8000 }, (err, out) => res(err ? { ok: false, why: String(err.message) } : { ok: true, path: binary(), version: String(out).split('\n')[0] })); }); }
/** Runs ffmpeg; `onProgress({time, size, speed})` from the key=value stream; resolves {code, log}. */
function run(id, args, onProgress) {
  return new Promise((resolve) => {
    const p = spawn(binary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); jobs.set(id, p); let log = ''; let buf = ''; const cur = {};
    p.stdout.on('data', (d) => { buf += d; const lines = buf.split(/\r?\n/); buf = lines.pop() || ''; for (const l of lines) { const i = l.indexOf('='); if (i < 0) continue; const k = l.slice(0, i), v = l.slice(i + 1).trim(); if (k === 'out_time_us' || k === 'out_time_ms') cur.time = Number(v) / 1e6; else if (k === 'total_size') cur.size = Number(v); else if (k === 'speed') cur.speed = parseFloat(v) || 0; else if (k === 'progress') onProgress({ ...cur, done: v === 'end' }); } });
    p.stderr.on('data', (d) => { log += d; if (log.length > 200000) log = log.slice(-100000); });
    p.on('error', (e) => { jobs.delete(id); resolve({ code: 127, log: String(e.message) }); });
    p.on('close', (code) => { jobs.delete(id); resolve({ code: code ?? 1, log }); });
  });
}
function cancel(id) { const p = jobs.get(id); if (p) { try { p.kill('SIGINT'); setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, 3000); } catch { /* gone */ } } }
/** ffprobe's JSON (streams and format) — through ffmpeg itself when ffprobe is not beside it. */
function probe(file) {
  return new Promise((res) => { execFile(probeBinary(), ['-v', 'error', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', file], { maxBuffer: 20 << 20 }, (err, out) => { if (!err) { try { return res(JSON.parse(out)); } catch { /* fall through */ } } res(null); }); });
}
module.exports = { available, run, cancel, probe, binary };
