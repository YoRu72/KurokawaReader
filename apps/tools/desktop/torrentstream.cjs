// Watching while it downloads, on a computer: a small server on 127.0.0.1 that hands the player a file of a
// download aria2 is still getting. Each part is sent once its pieces are in (aria2's bitfield says so) — waited for
// otherwise —, with ranges, so the player starts at once and can seek; the download asked to fetch in order.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

let server = null; let port = 0; let engine = null;
const statusCache = new Map();   // gid → { at, st }
const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/webm', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg' };

async function status(gid) {
  const c = statusCache.get(gid); if (c && Date.now() - c.at < 400) return c.st;
  const st = await engine.rpc.call('tellStatus', gid, ['status', 'files', 'pieceLength', 'numPieces', 'bitfield', 'totalLength', 'completedLength', 'dir']);
  statusCache.set(gid, { at: Date.now(), st }); if (statusCache.size > 20) statusCache.delete(statusCache.keys().next().value);
  return st;
}
/** Whether pieces a..b (inclusive) are all in: aria2's bitfield, hex, the first piece in the highest bit. */
function have(bitfield, a, b) {
  if (!bitfield) return false;
  for (let i = a; i <= b; i++) { const nib = parseInt(bitfield[i >> 2] || '0', 16); if (!(nib & (8 >> (i & 3)))) return false; }
  return true;
}
/** Where a file starts in the download's bytes (a torrent's files one after another, the unselected ones too). */
function placeOf(st, index) {
  const files = st.files || []; let off = 0;
  for (let i = 0; i < files.length; i++) { const len = Number(files[i].length) || 0; if (Number(files[i].index) - 1 === index || (files[i].index === undefined && i === index)) return { off, len, path: files[i].path }; off += len; }
  return null;
}

function start(e) {
  engine = e;
  if (server) return Promise.resolve(port);
  return new Promise((res, rej) => {
    server = http.createServer((req, out) => void serve(req, out).catch((err) => { if (!out.headersSent) out.writeHead(502, { 'access-control-allow-origin': '*' }); out.end(String(err && err.message || err)); }));
    server.on('error', rej);
    server.listen(0, '127.0.0.1', () => { port = server.address().port; res(port); });
  });
}
/** The address the player reads, the download asked to fetch its pieces in order from then on. */
async function url(e, gid, index) {
  await start(e);
  try { await e.rpc.call('changeOption', gid, { 'stream-piece-selector': 'inorder', 'bt-prioritize-piece': 'head=16M,tail=4M' }); } catch { /* not changeable now: as it was */ }
  return `http://127.0.0.1:${port}/t/${encodeURIComponent(gid)}/${index}`;
}

async function serve(req, out) {
  const m = /^\/t\/([^/]+)\/(\d+)$/.exec(new URL(req.url, 'http://x').pathname);
  if (!m) { out.writeHead(404); out.end(); return; }
  const gid = decodeURIComponent(m[1]); const index = Number(m[2]);
  let st = await status(gid); let place = placeOf(st, index);
  if (!place || !place.len) { out.writeHead(404, { 'access-control-allow-origin': '*' }); out.end(); return; }
  const size = place.len; const pl = Number(st.pieceLength) || 1 << 20;
  let from = 0, to = size - 1;
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) { if (r[1]) from = Number(r[1]); if (r[2]) to = Math.min(size - 1, Number(r[2])); if (!r[1] && r[2]) { from = Math.max(0, size - Number(r[2])); to = size - 1; } }
  if (from >= size) { out.writeHead(416, { 'content-range': `bytes */${size}`, 'access-control-allow-origin': '*' }); out.end(); return; }
  out.writeHead(r ? 206 : 200, { 'content-type': TYPES[path.extname(place.path).toLowerCase()] || 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': String(to - from + 1), ...(r ? { 'content-range': `bytes ${from}-${to}/${size}` } : {}), 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') { out.end(); return; }
  let closed = false; req.on('close', () => { closed = true; });
  let fd = null; const CHUNK = 256 * 1024; let pos = from;
  try {
    while (pos <= to && !closed) {
      const n = Math.min(CHUNK, to - pos + 1);
      // (The part's pieces not in yet: waited for, the download fetching them in order.)
      for (;;) {
        if (closed) return;
        const done = st.status === 'complete' || (Number(st.completedLength) >= Number(st.totalLength) && Number(st.totalLength) > 0);
        if (done || have(st.bitfield, Math.floor((place.off + pos) / pl), Math.floor((place.off + pos + n - 1) / pl))) break;
        if (st.status === 'error' || st.status === 'removed') throw new Error('download stopped');
        await new Promise((ok) => setTimeout(ok, 400)); st = await status(gid); place = placeOf(st, index) || place;
      }
      if (fd === null) { if (!fs.existsSync(place.path)) { await new Promise((ok) => setTimeout(ok, 400)); continue; } fd = fs.openSync(place.path, 'r'); }
      const buf = Buffer.allocUnsafe(n); const got = fs.readSync(fd, buf, 0, n, pos); if (got <= 0) { await new Promise((ok) => setTimeout(ok, 300)); continue; }
      pos += got; if (!out.write(got === n ? buf : buf.subarray(0, got))) await new Promise((ok) => out.once('drain', ok));
    }
  } finally { if (fd !== null) try { fs.closeSync(fd); } catch { /* gone */ } out.end(); }
}
function stop() { try { server?.close(); } catch { /* fine */ } server = null; }
module.exports = { url, stop, have, placeOf };
