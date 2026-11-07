// Watching a torrent on a computer: WebTorrent (Hayase's engine) while the player is open, because aria2 fetches
// a torrent's pieces in its own order and cannot jump to the place the player seeks to. The download aria2 has is
// paused and WebTorrent works in the same folder (aria2 writes no placeholders: --file-allocation=none), each
// read of the player asking for the pieces at its own place first. When the player is closed, WebTorrent lets the
// torrent go (its files stay) and aria2 takes it back, checking what is there (--check-integrity), so nothing
// fetched while watching is fetched again. A file aria2 has already finished is served from the disk as before.
'use strict';
const http = require('node:http');

let client = null; let loading = null; let server = null; let port = 0;
const live = new Map(); // key (infoHash) → { torrent, gid, files: Set<number>, readers: number, idleTimer }

/** WebTorrent itself (an ES module, loaded once); null when it is not installed with the app. */
async function lib() {
  if (!loading) loading = import('webtorrent').then((m) => m.default || m).catch((e) => { console.warn('webstream: WebTorrent unavailable:', e && e.message); return null; });
  return loading;
}
async function available() { return !!(await lib()); }
async function getClient(opts) {
  if (client) return client;
  const WebTorrent = await lib(); if (!WebTorrent) return null;
  client = new WebTorrent({ maxConns: 80, natUpnp: false, natPmp: false, ...(opts || {}) });
  client.on('error', (e) => console.warn('webstream:', e && e.message));
  return client;
}
function listen() {
  if (server) return Promise.resolve(port);
  return new Promise((res, rej) => {
    server = http.createServer((req, out) => { serve(req, out).catch((e) => { if (!out.headersSent) out.writeHead(502, { 'access-control-allow-origin': '*' }); out.end(String(e && e.message || e)); }); });
    server.on('error', rej); server.listen(0, '127.0.0.1', () => { port = server.address().port; res(port); });
  });
}

/**
 * The address the player reads for file `fileIndex` of a torrent: `source` is its .torrent (bytes) or a magnet,
 * `dir` the folder the torrent's files are in. `peers` (tests) are added at once. Resolves once WebTorrent has the
 * torrent's metadata.
 */
async function url({ key, source, dir, fileIndex, gid, peers, clientOpts }) {
  const c = await getClient(clientOpts); if (!c) throw new Error('webtorrent-unavailable');
  await listen();
  let w = live.get(key);
  if (!w) {
    const torrent = c.add(source, { path: dir, deselect: true, destroyStoreOnDestroy: false, strategy: 'sequential' });
    w = { torrent, gid, files: new Set(), readers: 0, idleTimer: 0 }; live.set(key, w);
    // (A .torrent's hash is known at once — before a listener could be set —, a magnet's a moment later.)
    if (peers?.length) { const addAll = () => { for (const p of peers) torrent.addPeer(p); }; if (torrent.infoHash) addAll(); else torrent.once('infoHash', addAll); }
    torrent.on('error', (e) => console.warn('webstream torrent:', e && e.message));
  }
  const t = w.torrent;
  if (!t.ready) await new Promise((ok, no) => { const tm = setTimeout(() => no(new Error('webstream: no metadata in 90 s')), 90000); t.once('ready', () => { clearTimeout(tm); ok(); }); t.once('error', (e) => { clearTimeout(tm); no(e); }); });
  const f = t.files[fileIndex]; if (!f) throw new Error('webstream: no such file');
  // (The file being watched: wanted as a whole, at a low priority — the player's reads come first.)
  if (!w.files.has(fileIndex)) { w.files.add(fileIndex); f.select(); }
  return `http://127.0.0.1:${port}/w/${encodeURIComponent(key)}/${fileIndex}`;
}

const TYPES = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mkv': 'video/webm', '.webm': 'video/webm', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.ts': 'video/mp2t', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.opus': 'audio/ogg', '.wav': 'audio/wav' };
async function serve(req, out) {
  const m = /^\/w\/([^/]+)\/(\d+)$/.exec(new URL(req.url, 'http://x').pathname);
  const w = m && live.get(decodeURIComponent(m[1])); const f = w && w.torrent.files[Number(m[2])];
  if (!f) { out.writeHead(404, { 'access-control-allow-origin': '*' }); out.end(); return; }
  const size = f.length; let from = 0, to = size - 1;
  const r = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
  if (r) { if (r[1]) from = Number(r[1]); if (r[2]) to = Math.min(size - 1, Number(r[2])); if (!r[1] && r[2]) { from = Math.max(0, size - Number(r[2])); to = size - 1; } }
  if (from >= size) { out.writeHead(416, { 'content-range': `bytes */${size}`, 'access-control-allow-origin': '*' }); out.end(); return; }
  const ext = (f.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
  out.writeHead(r ? 206 : 200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'accept-ranges': 'bytes', 'content-length': String(to - from + 1), ...(r ? { 'content-range': `bytes ${from}-${to}/${size}` } : {}), 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
  if (req.method === 'HEAD') { out.end(); return; }
  // (Each read asks for its own pieces first; a read the player drops — a seek — lets them go.)
  w.readers++; clearTimeout(w.idleTimer);
  const s = f.createReadStream({ start: from, end: to });
  const done = () => { w.readers = Math.max(0, w.readers - 1); try { s.destroy(); } catch { /* gone */ } };
  req.on('close', done); s.on('error', () => { done(); out.destroy(); });
  s.pipe(out);
}

/** Speed and peers of what is being watched (the player's waiting line). */
function stats(key) {
  const w = live.get(key); if (!w) return null; const t = w.torrent;
  return { down: t.downloadSpeed, up: t.uploadSpeed, peers: t.numPeers, progress: t.progress };
}
/** The torrent let go (its files kept), for aria2 to take back. */
function release(key) {
  const w = live.get(key); if (!w) return Promise.resolve(null); live.delete(key);
  return new Promise((ok) => { try { w.torrent.destroy({ destroyStore: false }, () => ok(w.gid)); } catch { ok(w.gid); } setTimeout(() => ok(w.gid), 5000); });
}
function watching(key) { return live.has(key); }
async function stopAll() { for (const k of [...live.keys()]) await release(k); try { server?.close(); } catch { /* fine */ } server = null; if (client) { const c = client; client = null; await new Promise((ok) => { try { c.destroy(() => ok()); } catch { ok(); } setTimeout(ok, 3000); }); } }
module.exports = { available, url, stats, release, watching, stopAll };
