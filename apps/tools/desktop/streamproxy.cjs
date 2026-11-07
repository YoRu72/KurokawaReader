// A small server on 127.0.0.1 for online sources (Seanime's streaming extensions): the page's <video> cannot send
// the headers such a source wants (a referer, a cookie), so it reads this instead. A file is passed through with
// its ranges (seeking works); an HLS playlist, which this Chromium cannot play by itself, is remuxed by the
// bundled ffmpeg into fragmented MP4 as it comes (nothing re-encoded).
const http = require('node:http');
const { spawn } = require('node:child_process');
const { net } = require('electron');
const Ffmpeg = require('./ffmpeg.cjs');
const Transcode = require('./transcode.cjs');

let server = null; let port = 0;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';

function start() {
  if (server) return Promise.resolve(port);
  return new Promise((res, rej) => {
    server = http.createServer((req, out) => void serve(req, out).catch((e) => { if (!out.headersSent) { out.writeHead(502, { 'access-control-allow-origin': '*' }); } out.end(String(e && e.message || e)); }));
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; res(port); });
  });
}
async function url(u, headers) { await start(); return `http://127.0.0.1:${port}/p?u=${encodeURIComponent(u)}&h=${encodeURIComponent(JSON.stringify(headers || {}))}`; }

async function serve(req, out) {
  const q = new URL(req.url, 'http://x'); if (q.pathname === '/f') { localFile(q, req, out); return; } if (q.pathname === '/audio') { audio(q, req, out); return; } if (q.pathname === '/video') { await Transcode.serve(q, req, out); return; } if (q.pathname !== '/p') { out.writeHead(404); out.end(); return; }
  const u = q.searchParams.get('u'); let h = {}; try { h = JSON.parse(q.searchParams.get('h') || '{}'); } catch { /* none */ }
  const headers = { 'user-agent': UA, ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)])) };
  const isPlaylist = (type, href) => /mpegurl/i.test(type || '') || /\.m3u8(\?|$)/i.test(href);
  if (isPlaylist('', u)) { remux(u, headers, req, out); return; }
  if (req.headers.range) headers.range = req.headers.range;
  const r = await net.fetch(u, { headers, method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
  const type = r.headers.get('content-type') || '';
  if (isPlaylist(type, r.url)) { try { await r.body?.cancel(); } catch { /* fine */ } remux(r.url, headers, req, out); return; }
  const pass = { 'access-control-allow-origin': '*' };
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) pass[k] = v; }
  out.writeHead(r.status, pass);
  if (!r.body || req.method === 'HEAD') { out.end(); return; }
  const reader = r.body.getReader(); req.on('close', () => { void reader.cancel().catch(() => undefined); });
  for (;;) { const { done, value } = await reader.read(); if (done) break; if (!out.write(Buffer.from(value))) await new Promise((ok) => out.once('drain', ok)); }
  out.end();
}
/** An HLS stream copied into fragmented MP4 by ffmpeg, its headers handed to every request ffmpeg makes. */
function remux(u, headers, req, out) {
  const ua = headers['user-agent']; const rest = Object.entries(headers).filter(([k]) => k !== 'user-agent' && k !== 'range').map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-user_agent', ua, ...(rest ? ['-headers', rest] : []), '-i', u, '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy', '-bsf:a', 'aac_adtstoasc', '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1'];
  const p = spawn(Ffmpeg.binary(), args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); let err = '';
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  out.writeHead(200, { 'content-type': 'video/mp4', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') { p.kill(); out.end(); return; }
  p.stdout.pipe(out);
  req.on('close', () => { try { p.kill('SIGKILL'); } catch { /* gone */ } });
  p.on('close', (code) => { if (code && err) console.warn('streamproxy ffmpeg:', err.trim().split('\n').pop()); out.end(); });
}
/** One audio track of a video, from `ss` seconds, turned into AAC as it plays: for sound the player cannot decode
 *  (AC-3, E-AC-3, DTS, TrueHD), played beside the muted video. */
function audio(q, req, out) {
  const src = q.searchParams.get('src') || ''; const ss = String(Number(q.searchParams.get('ss')) || 0); const a = String(Number(q.searchParams.get('a')) || 0);
  out.writeHead(200, { 'content-type': 'audio/aac', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
  if (req.method === 'HEAD' || !src) { out.end(); return; }
  const p = spawn(Ffmpeg.binary(), ['-nostdin', '-hide_banner', '-loglevel', 'error', '-ss', ss, '-i', src, '-map', `0:a:${a}`, '-vn', '-sn', '-dn', '-ac', '2', '-c:a', 'aac', '-b:a', '192k', '-f', 'adts', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  p.stdout.pipe(out); req.on('close', () => { try { p.kill('SIGKILL'); } catch { /* gone */ } }); p.on('close', () => out.end());
}
async function audioBase() { await start(); return `http://127.0.0.1:${port}/audio`; }
async function videoBase() { await start(); return `http://127.0.0.1:${port}/video`; }

// A file on this computer for the page's player and readers: by this server (with ranges, so seeking works), since a
// page served from app:// may not read file:// media and a Windows path is no URL. Only with this run's token.
const TOKEN = require('node:crypto').randomBytes(16).toString('hex');
const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/x-matroska', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav', '.srt': 'text/plain; charset=utf-8', '.ass': 'text/plain; charset=utf-8', '.vtt': 'text/vtt', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };
function localFile(q, req, out) {
  const fs = require('node:fs'); const path = require('node:path');
  if (q.searchParams.get('t') !== TOKEN) { out.writeHead(403); out.end(); return; }
  const p = q.searchParams.get('p') || ''; let st; try { st = fs.statSync(p); } catch { out.writeHead(404, { 'access-control-allow-origin': '*' }); out.end(); return; }
  if (!st.isFile()) { out.writeHead(404, { 'access-control-allow-origin': '*' }); out.end(); return; }
  const size = st.size; let from = 0, to = size - 1; const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) { if (r[1]) from = Number(r[1]); if (r[2]) to = Math.min(size - 1, Number(r[2])); if (!r[1] && r[2]) { from = Math.max(0, size - Number(r[2])); to = size - 1; } }
  if (size && from >= size) { out.writeHead(416, { 'content-range': `bytes */${size}`, 'access-control-allow-origin': '*' }); out.end(); return; }
  out.writeHead(r ? 206 : 200, { 'content-type': TYPES[path.extname(p).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': String(size ? to - from + 1 : 0), ...(r ? { 'content-range': `bytes ${from}-${to}/${size}` } : {}), 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  if (req.method === 'HEAD' || !size) { out.end(); return; }
  const rs = fs.createReadStream(p, { start: from, end: to }); req.on('close', () => rs.destroy()); rs.on('error', () => out.destroy()); rs.pipe(out);
}
async function fileUrl(p) { await start(); return `http://127.0.0.1:${port}/f?t=${TOKEN}&p=${encodeURIComponent(p)}`; }
function stop() { try { server?.close(); } catch { /* fine */ } server = null; }
module.exports = { url, stop, audioBase, videoBase, fileUrl };
