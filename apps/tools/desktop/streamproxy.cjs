// A small server on 127.0.0.1 for online sources (Seanime's streaming extensions): the page's <video> cannot send
// the headers such a source wants (a referer, a cookie), so it reads this instead. A file is passed through with
// its ranges (seeking works); an HLS playlist, which this Chromium cannot play by itself, is remuxed by the
// bundled ffmpeg into fragmented MP4 as it comes (nothing re-encoded).
const http = require('node:http');
const { spawn } = require('node:child_process');
const { net } = require('electron');
const Ffmpeg = require('./ffmpeg.cjs');
const Transcode = require('./transcode.cjs');
const Relay = require('./relay.cjs');
// (The relay follows redirects itself, one hop at a time, so the page's cookie never reaches another host: Electron's
// net.request tells each redirect; net.fetch would hide it.)
Relay.setFetch(manualFetch);
function manualFetch(u, o) {
  const { Readable } = require('node:stream');
  return new Promise((res, rej) => {
    const rq = net.request({ url: u, method: o.method || 'GET', redirect: 'manual' });
    for (const [k, v] of Object.entries(o.headers || {})) { try { rq.setHeader(k, v); } catch { /* not settable */ } }
    const wrap = (status, hd, body) => ({ status, url: u, headers: { get: (k) => { const v = hd[k.toLowerCase()]; return Array.isArray(v) ? v.join(', ') : v ?? null; } }, body, text: async () => { if (!body) return ''; const chunks = []; const rd = body.getReader(); for (;;) { const x = await rd.read(); if (x.done) break; chunks.push(Buffer.from(x.value)); } return Buffer.concat(chunks).toString('utf8'); } });
    rq.on('redirect', (code, _m, to) => { try { rq.abort(); } catch { /* */ } res(wrap(code, { location: to }, null)); });
    rq.on('response', (r) => res(wrap(r.statusCode, r.headers, Readable.toWeb(r))));
    rq.on('error', rej); rq.end();
  });
}
/** /p addresses are signed (HMAC over the source and its headers, with an expiry), as /f is by its token: no other
 *  program on this computer can use the server as a proxy, nor change where a signed one goes. */
const PSECRET = require('node:crypto').randomBytes(32);
const psign = (u, h, e) => require('node:crypto').createHmac('sha256', PSECRET).update(`${u}\n${h}\n${e}`).digest('hex').slice(0, 32);
const psigned = (u, h, e, t) => { if (!(Number(e) > Date.now())) return false; const want = Buffer.from(psign(u, h, e)); const got = Buffer.from(String(t || '')); return got.length === want.length && require('node:crypto').timingSafeEqual(got, want); };
/** CORS only for the app's own page (app://), never «*». */
const appOrigin = (req) => { const o = req.headers.origin; return o && /^app:\/\/kurokawa$/.test(o) ? { 'access-control-allow-origin': o, vary: 'origin' } : {}; };

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
async function url(u, headers) { if (!/^https?:\/\//i.test(String(u))) throw new Error('refused: not http(s)'); await start(); const h = JSON.stringify(headers || {}); const e = String(Date.now() + 12 * 3600e3); return `http://127.0.0.1:${port}/p?u=${encodeURIComponent(u)}&h=${encodeURIComponent(h)}&e=${e}&t=${psign(u, h, e)}`; }

async function serve(req, out) {
  const q = new URL(req.url, 'http://x'); if (q.pathname.startsWith('/r/')) { if (!(await Relay.handle(req, out, `http://127.0.0.1:${port}`))) { out.writeHead(404); out.end(); } return; } if (q.pathname === '/f') { localFile(q, req, out); return; } if (q.pathname === '/audio') { audio(q, req, out); return; } if (q.pathname === '/video') { await Transcode.serve(q, req, out); return; } if (q.pathname !== '/p') { out.writeHead(404); out.end(); return; }
  const u = q.searchParams.get('u') || ''; const hs = q.searchParams.get('h') || '{}';
  if (!psigned(u, hs, q.searchParams.get('e'), q.searchParams.get('t')) || !/^https?:\/\//i.test(u)) { out.writeHead(403); out.end(); return; }
  let h = {}; try { h = JSON.parse(hs); } catch { /* none */ }
  const headers = { 'user-agent': UA, ...Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), String(v)])) };
  const isPlaylist = (type, href) => /mpegurl/i.test(type || '') || /\.m3u8(\?|$)/i.test(href);
  if (isPlaylist('', u)) { remux(u, headers, req, out); return; }
  if (req.headers.range) headers.range = req.headers.range;
  const r = await net.fetch(u, { headers, method: req.method === 'HEAD' ? 'HEAD' : 'GET' });
  const type = r.headers.get('content-type') || '';
  if (isPlaylist(type, r.url)) { try { await r.body?.cancel(); } catch { /* fine */ } remux(r.url, headers, req, out); return; }
  const pass = { ...appOrigin(req) };
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
  out.writeHead(200, { 'content-type': 'video/mp4', ...appOrigin(req), 'cache-control': 'no-store' });
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
/** Another app's player (relay.cjs): a session of its own, with its token; closed when that playback ends. */
async function relayOpen(o) { await start(); return Relay.open(o || {}, `http://127.0.0.1:${port}`); }
function relayClose(o) { return { closed: Relay.close(String(o && o.token || '')) }; }
function relayStatus(o) { return Relay.status(String(o && o.token || '')); }
function stop() { Relay.closeAll(); try { server?.close(); } catch { /* fine */ } server = null; }
module.exports = { url, stop, audioBase, videoBase, fileUrl, relayOpen, relayClose, relayStatus };
