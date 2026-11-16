// The relay for another program's player (src/player/external): a source that needs request headers (a referer, a
// cookie, a user agent) the player cannot send, and its subtitles, made plain addresses any player opens. It lives in
// the local stream server (streamproxy.cjs: loopback only, a port the system picks); each playback gets its own
// random token in the path, and everything under it stops answering — open requests cut — when the playback ends
// (relayClose), or after six idle hours. An HLS playlist is passed through rewritten (not remuxed): every segment,
// key, map and sub-playlist becomes an address of the same session, by number — no URL is ever taken from a request,
// so the relay is no open proxy. Only http(s) is fetched; redirects are followed here, one hop at a time, and the
// cookie, authorisation and any other header of the page's go only to the source's own origin (another host — a CDN
// named in the playlist, a redirect elsewhere — gets the user agent and the referer only). No CORS: players, not pages.
'use strict';
const crypto = require('node:crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36';
const IDLE_MS = 6 * 3600e3; const MAX_URLS = 200000; const HOPS = 6;
/** A playlist is read whole to be rewritten: at most this much, else 502; an address longer than MAX_URL is left out. */
const MAX_LIST = 16 << 20; const MAX_URL = 8192;
let sendFile = null;
/** The stream server's own file sender (ranges), for a session that plays a file on this computer. */
function setFileSender(f) { sendFile = f; }
let doFetch = (u, o) => fetch(u, o);
/** Electron's net.fetch (the app's proxy and certificates) in the app; Node's own in tests. */
function setFetch(f) { doFetch = f; }
const sessions = new Map();
const isHttp = (u) => { if (typeof u !== 'string' || u.length > MAX_URL || /[\r\n\0]/.test(u)) return false; try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:'; } catch { return false; } };
const originOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
/** Headers for one request: all of the page's to the source's origin; elsewhere only User-Agent and Referer. */
function headersFor(target, page, origin) {
  const h = { 'user-agent': UA }; const same = originOf(target) === origin;
  for (const [k, v] of Object.entries(page || {})) { const l = k.toLowerCase(); if (l === 'range' || l === 'host' || /[\r\n]/.test(String(v))) continue; if (same || l === 'user-agent' || l === 'referer') h[l] = String(v); }
  return h;
}

function open(o, base) {
  const url = String(o.url || ''); if (url && !isHttp(url)) throw new Error('refused: target');
  // (A file on this computer for another program's player: by this session's address, not the run's own token.)
  let file = '';
  if (o.file) { const fs = require('node:fs'); const path = require('node:path'); const f = String(o.file); let st = null; try { st = path.isAbsolute(f) ? fs.statSync(f) : null; } catch { st = null; } if (!st || !st.isFile()) throw new Error('refused: file'); file = path.resolve(f); }
  const subs = (Array.isArray(o.subs) ? o.subs : []).map((x) => ({ url: x && isHttp(x.url) ? String(x.url) : '', name: String(x && x.name || ''), headers: x && x.headers || {} }));
  const token = crypto.randomBytes(16).toString('hex');
  const s = { url, file, origin: originOf(url), headers: o.headers || {}, subs, urls: [], ids: new Map(), live: new Set(), at: Date.now(), reads: 0, timer: null };
  sessions.set(token, s); idle(token, s);
  const at = `${base}/r/${token}`; const nm = (n, d) => encodeURIComponent(String(n || d).replace(/[\\/]/g, '_')).slice(0, 120);
  return { token, url: url || file ? `${at}/v/${nm(o.name, 'video')}` : '', subs: subs.map((x, i) => (x.url ? `${at}/s/${i}/${nm(x.name, `sub${i}.srt`)}` : '')) };
}
function idle(token, s) { clearTimeout(s.timer); s.timer = setTimeout(() => close(token), IDLE_MS); s.timer.unref?.(); }
function close(token) { const s = sessions.get(String(token)); if (!s) return false; sessions.delete(String(token)); clearTimeout(s.timer); for (const r of s.live) { try { r.destroy(); } catch { /* gone */ } } return true; }
function closeAll() { for (const t of [...sessions.keys()]) close(t); }
/** Whether a session is open, when it was last read and how often (a player that handed the address to an instance
 *  already running still reads it after its own process ended). */
function status(token) { const s = sessions.get(String(token)); return s ? { open: true, lastRead: s.at, reads: s.reads, reading: s.live.size } : { open: false }; }
const count = () => sessions.size;

const isPlaylist = (type, href) => /mpegurl/i.test(type || '') || /\.m3u8(\?|#|$)/i.test(href || '');
function idOf(s, u) { let n = s.ids.get(u); if (n === undefined) { if (s.urls.length >= MAX_URLS) return null; n = s.urls.length; s.urls.push(u); s.ids.set(u, n); } return n; }
/** A playlist's addresses (lines and URI="…") turned into this session's numbered ones; anything not http(s) left out. */
function rewrite(text, from, s, at) {
  const to = (x) => { let a; try { a = new URL(x, from).toString(); } catch { return null; } if (!isHttp(a)) return null; const n = idOf(s, a); return n === null ? null : `${at}/u/${n}`; };
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim(); if (!t) { out.push(line); continue; }
    if (t.startsWith('#')) { out.push(line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${to(u) ?? ''}"`)); continue; }
    const r = to(t); if (r) out.push(r);
  }
  return out.join('\n');
}

/** Answers /r/<token>/…; false for any other path (the stream server's own routes). */
async function handle(req, out, base) {
  const m = /^\/r\/([0-9a-f]{32})\/(v|u|s)(?:\/([^?]*))?/.exec(req.url || ''); if (!m) return false;
  const s = sessions.get(m[1]);
  if (!s) { out.writeHead(403, { 'content-type': 'text/plain' }); out.end('closed'); return true; }
  s.at = Date.now(); s.reads++; idle(m[1], s); s.live.add(out); out.on('close', () => s.live.delete(out));
  const at = `${base}/r/${m[1]}`;
  if (m[2] === 's') {
    const sub = s.subs[Number(String(m[3] || '').split('/')[0])];
    if (!sub || !sub.url) { out.writeHead(404); out.end(); return true; }
    await pass(req, out, sub.url, { ...s.headers, ...sub.headers }, s, at, false); return true;
  }
  if (m[2] === 'v' && s.file) { if (!sendFile) { out.writeHead(500); out.end(); return true; } out.on('close', () => { s.at = Date.now(); }); sendFile(s.file, req, out); return true; }
  const u = m[2] === 'v' ? s.url : s.urls[Number(m[3])];
  if (!u) { out.writeHead(404); out.end(); return true; }
  await pass(req, out, u, s.headers, s, at, true); return true;
}
async function pass(req, out, u, page, s, at, mayList) {
  const range = req.headers.range && !isPlaylist('', u) ? req.headers.range : null;
  let target = u; let r;
  for (let hop = 0; ; hop++) {
    if (!isHttp(target) || hop > HOPS) { out.writeHead(502); out.end('refused'); return; }
    const headers = headersFor(target, page, s.origin); if (range) headers.range = range;
    r = await doFetch(target, { headers, method: req.method === 'HEAD' ? 'HEAD' : 'GET', redirect: 'manual' });
    const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : null;
    if (!loc) break;
    try { await r.body?.cancel(); } catch { /* fine */ }
    target = new URL(loc, target).toString();
  }
  const ctype = r.headers.get('content-type') || '';
  if (mayList && r.status < 400 && isPlaylist(ctype, target)) {
    const len = Number(r.headers.get('content-length') || 0);
    if (len > MAX_LIST) { try { await r.body?.cancel(); } catch { /* */ } out.writeHead(502); out.end('playlist too big'); return; }
    let text = '';
    if (req.method !== 'HEAD' && r.body) { const rd = r.body.getReader(); const parts = []; let n = 0; for (;;) { const x = await rd.read(); if (x.done) break; n += x.value.length; if (n > MAX_LIST) { try { await rd.cancel(); } catch { /* */ } out.writeHead(502); out.end('playlist too big'); return; } parts.push(Buffer.from(x.value)); } text = Buffer.concat(parts).toString('utf8'); }
    const body = Buffer.from(rewrite(text, target, s, at), 'utf8');
    out.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': body.length, 'cache-control': 'no-store' });
    out.end(req.method === 'HEAD' ? undefined : body); return;
  }
  const head = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) { const v = r.headers.get(k); if (v) head[k] = v; }
  out.writeHead(r.status, head);
  if (!r.body || req.method === 'HEAD') { out.end(); return; }
  const reader = r.body.getReader(); out.on('close', () => { void reader.cancel().catch(() => undefined); });
  for (;;) { let x; try { x = await reader.read(); } catch { break; } if (x.done) break; if (out.destroyed) break; if (!out.write(Buffer.from(x.value))) await new Promise((ok) => { out.once('drain', ok); out.once('close', ok); }); }
  out.end();
}
module.exports = { open, close, closeAll, handle, setFetch, setFileSender, count, status, rewrite, isPlaylist, headersFor, isHttp, MAX_LIST };
