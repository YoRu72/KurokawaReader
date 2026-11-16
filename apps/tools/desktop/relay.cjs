// The relay for another app's player (src/player/external): a source that needs request headers (a referer, a
// cookie, a user agent) the player cannot send, and the subtitles beside it, made plain addresses any player opens.
// It lives in the local stream server (streamproxy.cjs: loopback only, a port the system picks); each playback gets
// its own random token in the path, and everything under it stops answering — open requests cut — when the
// playback ends (relayClose), or after six idle hours. An HLS playlist is passed through rewritten (not remuxed):
// every segment, key, map and sub-playlist, relative or absolute, becomes an address of the same session, by
// number — no URL is ever taken from the request, so the relay is no open proxy.
'use strict';
const crypto = require('node:crypto'); const fs = require('node:fs'); const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const IDLE_MS = 6 * 3600e3; const MAX_URLS = 200000;
let doFetch = (u, o) => fetch(u, o);
/** Electron's net.fetch (the app's proxy and certificates) in the app; Node's own in tests. */
function setFetch(f) { doFetch = f; }
const sessions = new Map();

function open(o, base) {
  const token = crypto.randomBytes(16).toString('hex');
  const s = { url: String(o.url || ''), headers: o.headers || {}, subs: Array.isArray(o.subs) ? o.subs : [], urls: [], ids: new Map(), live: new Set(), at: Date.now(), timer: null };
  sessions.set(token, s); idle(token, s);
  const at = `${base}/r/${token}`; const nm = (n, d) => encodeURIComponent(String(n || d).replace(/[\\/]/g, '_')).slice(0, 120);
  return { token, url: s.url ? `${at}/v/${nm(o.name, 'video')}` : '', subs: s.subs.map((x, i) => `${at}/s/${i}/${nm(x.name || (x.path ? path.basename(x.path) : ''), `sub${i}.srt`)}`) };
}
function idle(token, s) { clearTimeout(s.timer); s.timer = setTimeout(() => close(token), IDLE_MS); s.timer.unref?.(); }
function close(token) { const s = sessions.get(String(token)); if (!s) return false; sessions.delete(String(token)); clearTimeout(s.timer); for (const r of s.live) { try { r.destroy(); } catch { /* gone */ } } return true; }
function closeAll() { for (const t of [...sessions.keys()]) close(t); }
const count = () => sessions.size;

const isPlaylist = (type, href) => /mpegurl/i.test(type || '') || /\.m3u8(\?|#|$)/i.test(href || '');
function idOf(s, u) { let n = s.ids.get(u); if (n === undefined) { if (s.urls.length >= MAX_URLS) return null; n = s.urls.length; s.urls.push(u); s.ids.set(u, n); } return n; }
/** A playlist's addresses (lines and URI="…") turned into this session's numbered ones. */
function rewrite(text, from, s, at) {
  const abs = (x) => { try { return new URL(x, from).toString(); } catch { return null; } };
  const to = (x) => { const a = abs(x); const n = a ? idOf(s, a) : null; return n === null ? x : `${at}/u/${n}`; };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim(); if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${to(u)}"`);
    return to(t);
  }).join('\n');
}

/** Answers /r/<token>/…; false for any other path (the stream server's own routes). */
async function handle(req, out, base) {
  const m = /^\/r\/([0-9a-f]{32})\/(v|u|s)(?:\/([^?]*))?/.exec(req.url || ''); if (!m) return false;
  const s = sessions.get(m[1]);
  if (!s) { out.writeHead(403, { 'content-type': 'text/plain' }); out.end('closed'); return true; }
  s.at = Date.now(); idle(m[1], s); s.live.add(out); out.on('close', () => s.live.delete(out));
  const at = `${base}/r/${m[1]}`;
  if (m[2] === 's') {
    const i = Number(String(m[3] || '').split('/')[0]); const sub = s.subs[i];
    if (!sub) { out.writeHead(404); out.end(); return true; }
    if (sub.path) { fs.readFile(sub.path, (e, b) => { if (e) { out.writeHead(404); out.end(); return; } out.writeHead(200, { 'content-type': type(sub.path), 'content-length': b.length, 'access-control-allow-origin': '*' }); out.end(req.method === 'HEAD' ? undefined : b); }); return true; }
    await pass(req, out, String(sub.url), { ...s.headers, ...(sub.headers || {}) }, s, at, false); return true;
  }
  const u = m[2] === 'v' ? s.url : s.urls[Number(m[3])];
  if (!u) { out.writeHead(404); out.end(); return true; }
  await pass(req, out, u, s.headers, s, at, true); return true;
}
const type = (p) => ({ '.ass': 'text/x-ssa; charset=utf-8', '.ssa': 'text/x-ssa; charset=utf-8', '.vtt': 'text/vtt; charset=utf-8', '.srt': 'application/x-subrip; charset=utf-8' })[path.extname(p).toLowerCase()] || 'text/plain; charset=utf-8';
async function pass(req, out, u, h, s, at, mayList) {
  const headers = { 'user-agent': UA, ...Object.fromEntries(Object.entries(h || {}).map(([k, v]) => [k.toLowerCase(), String(v)])) };
  delete headers.range; delete headers.host;
  if (req.headers.range && !isPlaylist('', u)) headers.range = req.headers.range;
  const r = await doFetch(u, { headers, method: req.method === 'HEAD' ? 'HEAD' : 'GET', redirect: 'follow' });
  const ctype = r.headers.get('content-type') || '';
  if (mayList && r.status < 400 && isPlaylist(ctype, r.url || u)) {
    const text = req.method === 'HEAD' ? '' : await r.text();
    const body = Buffer.from(rewrite(text, r.url || u, s, at), 'utf8');
    out.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
    out.end(req.method === 'HEAD' ? undefined : body); return;
  }
  const head = { 'access-control-allow-origin': '*' };
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) head[k] = v; }
  out.writeHead(r.status, head);
  if (!r.body || req.method === 'HEAD') { out.end(); return; }
  const reader = r.body.getReader(); out.on('close', () => { void reader.cancel().catch(() => undefined); });
  for (;;) { let x; try { x = await reader.read(); } catch { break; } if (x.done) break; if (out.destroyed) break; if (!out.write(Buffer.from(x.value))) await new Promise((ok) => { out.once('drain', ok); out.once('close', ok); }); }
  out.end();
}
module.exports = { open, close, closeAll, handle, setFetch, count, rewrite, isPlaylist };
