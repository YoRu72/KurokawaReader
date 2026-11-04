// Files shared over Wi-Fi (REX Player's web share): a small server on every interface, at an address with a
// random key, that a phone or another computer opens in its browser — a page listing the files, each downloadable
// with ranges — until it is stopped.
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

let server = null, key = '', files = [], sent = 0, hits = 0, port = 0;
const MIME = { mp4: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', pdf: 'application/pdf', zip: 'application/zip', apk: 'application/vnd.android.package-archive', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', txt: 'text/plain', srt: 'application/x-subrip', epub: 'application/epub+zip' };
const mimeOf = (n) => MIME[n.toLowerCase().split('.').pop()] || 'application/octet-stream';
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const human = (b) => { if (b < 1024) return `${b} B`; let v = b / 1024; const u = ['KB', 'MB', 'GB', 'TB']; let i = 0; while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; } return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${u[i]}`; };

/** The computer's address on its network (a private IPv4; Wi-Fi or Ethernet first). */
function lanIp() {
  let fallback = null;
  for (const [name, list] of Object.entries(os.networkInterfaces())) for (const a of list || []) {
    if (a.family !== 'IPv4' || a.internal) continue;
    if (/^(wl|en|eth|Wi-Fi|Ethernet)/i.test(name)) return a.address;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address) && !fallback) fallback = a.address;
  }
  return fallback;
}
function url() { const ip = lanIp(); return server && ip ? `http://${ip}:${port}/${key}/` : null; }

function start(paths, names) {
  stop();
  files = paths.map((p, i) => ({ path: p, name: (names && names[i]) || path.basename(p) })).filter((f) => { try { return fs.statSync(f.path).isFile(); } catch { return false; } });
  if (!files.length) throw new Error('no files');
  key = crypto.randomBytes(6).toString('hex'); sent = 0; hits = 0;
  server = http.createServer((req, res) => {
    const u = decodeURIComponent((req.url || '/').split('?')[0]);
    if (!u.startsWith(`/${key}/`)) { res.writeHead(404); res.end(); return; }
    hits++; const rest = u.slice(key.length + 2);
    if (!rest || rest === 'index.html') {
      const html = `<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'><title>Kurokawa Tools</title><style>body{font-family:system-ui,sans-serif;margin:0;background:#141218;color:#e6e0e9}h1{font-size:18px;padding:18px 20px;margin:0;background:#211f26}a{display:flex;justify-content:space-between;gap:12px;padding:14px 20px;color:#d0bcff;text-decoration:none;border-bottom:1px solid #2b2930}a:hover{background:#1d1b20}small{color:#cac4d0}p{padding:10px 20px;color:#cac4d0;font-size:13px}</style></head><body><h1>Kurokawa Tools</h1>${files.map((f, i) => `<a href='d/${i}/${encodeURIComponent(f.name)}' download><span>${esc(f.name)}</span><small>${human(fs.statSync(f.path).size)}</small></a>`).join('')}<p>${files.length} file(s)</p></body></html>`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return;
    }
    const m = /^d\/(\d+)\//.exec(rest); const f = m && files[Number(m[1])];
    if (!f) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(f.path).size; const rg = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    let a = 0, b = size - 1; if (rg) { if (rg[1]) a = Number(rg[1]); if (rg[2]) b = Math.min(Number(rg[2]), size - 1); if (!rg[1] && rg[2]) { a = Math.max(0, size - Number(rg[2])); b = size - 1; } }
    if (a > b) { res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
    res.writeHead(rg ? 206 : 200, { 'content-type': mimeOf(f.name), 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`, ...(rg ? { 'content-range': `bytes ${a}-${b}/${size}` } : {}) });
    if (req.method === 'HEAD') { res.end(); return; }
    const st = fs.createReadStream(f.path, { start: a, end: b }); st.on('data', (c) => { sent += c.length; }); st.pipe(res);
  });
  return new Promise((ok, bad) => { server.once('error', bad); server.listen(0, '0.0.0.0', () => { port = server.address().port; ok({ url: url(), files: files.length }); }); });
}
function stop() { if (server) { try { server.close(); } catch { /* gone */ } server = null; } }
function status() { return { running: !!server, url: url(), sent, hits }; }
module.exports = { start, stop, status, lanIp };
