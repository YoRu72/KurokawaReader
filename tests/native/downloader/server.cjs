// A test server for the downloader: GET /file redirects to /store/file, which serves a random file in ranges,
// each connection held to RATE bytes a second (as a far server or a per-connection limit would). Prints the
// file's SHA-256 and the port, then serves until killed.
const http = require('http'); const crypto = require('crypto');
const SIZE = Number(process.env.SIZE || 12 * 1024 * 1024), RATE = Number(process.env.RATE || 500 * 1024);
const data = crypto.randomBytes(SIZE);
const server = http.createServer((req, res) => {
  if (req.url === '/file') { res.writeHead(302, { Location: '/store/file?sig=1' }); res.end(); return; }
  if (!req.url.startsWith('/store/file')) { res.writeHead(404); res.end(); return; }
  let from = 0, to = SIZE - 1, code = 200; const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (m) { from = +m[1]; to = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1; code = 206; }
  res.writeHead(code, { 'Content-Length': to - from + 1, 'Accept-Ranges': 'bytes', ...(code === 206 ? { 'Content-Range': `bytes ${from}-${to}/${SIZE}` } : {}) });
  let pos = from; const step = Math.max(1024, Math.round(RATE / 20));
  const tick = () => { if (pos > to) { res.end(); return; } const end = Math.min(to + 1, pos + step); res.write(data.subarray(pos, end)); pos = end; setTimeout(tick, 50); };
  tick();
});
server.listen(0, () => { console.log(crypto.createHash('sha256').update(data).digest('hex'), server.address().port); });
