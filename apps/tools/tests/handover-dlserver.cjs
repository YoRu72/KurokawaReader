// CI's download server for the hand-over (tauri-check.yml, Tools' stage P9): a loopback server that outlives the step
// that starts it, so a download the Electron build was fetching when it handed over can be finished by the Tauri build in
// the next step. Started detached by tests/handover-electron.cjs:
//   node tests/handover-dlserver.cjs <work folder>
// It writes <work>/dlserver.json { port, pid, size, sha256 } and serves
//   /slow.bin   SIZE bytes of a fixed pattern (byte i = (i·31 + 7) & 255), Range answered; 64 KiB every 40 ms while
//               <work>/slow.flag exists (the Electron step: still moving at the hand-over), at full speed once the Tauri
//               step has removed it;
//   /small.bin  3 MiB of the same pattern (the download the person paused).
// It ends by itself after 30 minutes, or when <work>/dlserver.stop appears. Loopback only; made-up bytes.
'use strict';
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const WORK = process.argv[2]; if (!WORK) { console.error('usage: node tests/handover-dlserver.cjs <work folder>'); process.exit(2); }
fs.mkdirSync(WORK, { recursive: true });
const SIZE = 64 * 1024 * 1024; const SMALL = 3 * 1024 * 1024;
const byteAt = (i) => (i * 31 + 7) & 255;
const piece = (from, n) => { const b = Buffer.allocUnsafe(n); for (let k = 0; k < n; k++) b[k] = byteAt(from + k); return b; };
const sha = (() => { const h = crypto.createHash('sha256'); for (let at = 0; at < SIZE; at += 1 << 20) h.update(piece(at, Math.min(1 << 20, SIZE - at))); return h.digest('hex'); })();
const FLAG = path.join(WORK, 'slow.flag'); const STOP = path.join(WORK, 'dlserver.stop');
const server = http.createServer((req, res) => {
  const slow = req.url.startsWith('/slow'); const total = slow ? SIZE : req.url.startsWith('/small') ? SMALL : 0;
  if (!total) { res.writeHead(404); res.end(); return; }
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const from = m ? Number(m[1]) : 0; const to = m && m[2] ? Math.min(total - 1, Number(m[2])) : total - 1;
  if (from > to) { res.writeHead(416, { 'content-range': `bytes */${total}` }); res.end(); return; }
  res.writeHead(m ? 206 : 200, { 'content-length': to - from + 1, 'accept-ranges': 'bytes', ...(m ? { 'content-range': `bytes ${from}-${to}/${total}` } : {}), 'content-type': 'application/octet-stream' });
  let at = from;
  const tick = () => {
    if (res.destroyed) return; if (at > to) { res.end(); return; }
    const throttled = slow && fs.existsSync(FLAG); const n = Math.min(throttled ? 64 * 1024 : 1 << 20, to - at + 1);
    const ok = res.write(piece(at, n)); at += n;
    if (throttled) setTimeout(tick, 40); else if (ok) setImmediate(tick); else res.once('drain', tick);
  };
  tick();
});
server.listen(0, '127.0.0.1', () => {
  fs.writeFileSync(path.join(WORK, 'dlserver.json'), JSON.stringify({ port: server.address().port, pid: process.pid, size: SIZE, sha256: sha }));
});
const end = () => { try { server.close(); } catch { /* gone */ } process.exit(0); };
setTimeout(end, 30 * 60 * 1000).unref();
setInterval(() => { if (fs.existsSync(STOP)) end(); }, 1000);
