// A test server for the downloader. /file redirects to /store/file, a random file served in ranges with every
// connection held to RATE bytes a second (a far server, or a per-connection limit). Other ways a server
// answers: /flaky (each answer cut off part-way, without an error), /noranges (Range ignored: 200 and the
// whole file), /unknown (206 with the size unknown: "bytes 0-0/*"), /empty (a file of no bytes: 416 for
// a range). Prints the file's SHA-256 and the port, then serves until killed.
const http = require('http'); const crypto = require('crypto');
const SIZE = Number(process.env.SIZE || 12 * 1024 * 1024), RATE = Number(process.env.RATE || 500 * 1024);
const data = crypto.randomBytes(SIZE);
let cut = 0;
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/file') { res.writeHead(302, { Location: '/store/file?sig=1' }); res.end(); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (u === '/empty') { if (m) { res.writeHead(416, { 'Content-Range': 'bytes */0' }); res.end(); } else { res.writeHead(200, { 'Content-Length': 0 }); res.end(); } return; }
  const body = u === '/noranges' || !m ? null : m;
  let from = 0, to = SIZE - 1, code = 200;
  if (body) { from = +m[1]; to = m[2] ? Math.min(+m[2], SIZE - 1) : SIZE - 1; code = 206; }
  const headers = { 'Accept-Ranges': u === '/noranges' ? 'none' : 'bytes' };
  if (code === 206) headers['Content-Range'] = u === '/unknown' ? `bytes ${from}-${to}/*` : `bytes ${from}-${to}/${SIZE}`;
  // (An answer cut off part-way: its length left out, so the end looks like the whole of it.)
  const flaky = u === "/flaky" && to - from > 256 * 1024 && cut++ % 2 === 0;
  if (!flaky) headers['Content-Length'] = to - from + 1;
  res.writeHead(code, headers);
  const end = flaky ? from + Math.floor((to - from) / 3) : to;
  let pos = from; const step = Math.max(1024, Math.round(RATE / 20));
  const tick = () => { if (pos > end) { res.end(); return; } const e = Math.min(end + 1, pos + step); res.write(data.subarray(pos, e)); pos = e; setTimeout(tick, 50); };
  tick();
});
server.listen(0, () => { console.log(crypto.createHash('sha256').update(data).digest('hex'), server.address().port); });
