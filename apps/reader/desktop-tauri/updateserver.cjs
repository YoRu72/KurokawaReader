// A fake GitHub release on this computer, for the workflow's «update over the installed app» step (stage R6b): the
// files in <dir> (the newer build's KurokawaReader-<v>-windows-x64-setup.exe and its KurokawaReader-<v>-SHA256SUMS.txt)
// served with Range, and GET /releases answering as GitHub's API does (tag v<v>, the assets' names, sizes and
// addresses on this server). The first request for a setup file is cut off halfway — the app's updater must resume
// it. The port is written to <portfile>. The app reads this feed only because KR_UPDATE_FEED points at it and it is
// on this computer (updatelogic.rs is_loopback).
//   node updateserver.cjs <dir> <portfile>
'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2] || '.');
const portFile = process.argv[3];
const cut = new Set();
const log = (m) => { console.log(m); try { fs.appendFileSync(path.join(dir, 'server.log'), m + '\n'); } catch { /* none */ } };

const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/releases') {
    const files = fs.readdirSync(dir).filter((f) => /^KurokawaReader-.+-(windows-x64-setup\.exe|SHA256SUMS\.txt)$/.test(f));
    const versions = [...new Set(files.map((f) => /^KurokawaReader-(.+?)-(windows|SHA256SUMS)/.exec(f)[1]))];
    const body = versions.map((v) => ({
      tag_name: `v${v}`, html_url: `${base}/tag/v${v}`, draft: false, prerelease: false, body: "## What's new\n- CI's update",
      assets: files.filter((f) => f.startsWith(`KurokawaReader-${v}-`)).map((f) => ({ name: f, size: fs.statSync(path.join(dir, f)).size, browser_download_url: `${base}/dl/${f}` })),
    }));
    log(`GET /releases → ${JSON.stringify(body.map((r) => [r.tag_name, r.assets.map((a) => a.name)]))}`);
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); return;
  }
  const m = /^\/dl\/([^/]+)$/.exec(url); const f = m && path.join(dir, m[1]);
  if (!f || !fs.existsSync(f)) { log(`GET ${url} → 404`); res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size;
  const r = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
  const start = r ? Number(r[1]) : 0; const end = r && r[2] ? Number(r[2]) : size - 1;
  if (r && start >= size) { log(`GET ${m[1]} range ${start}- → 416`); res.writeHead(416, { 'content-range': `bytes */${size}` }); res.end(); return; }
  res.writeHead(r ? 206 : 200, { 'content-type': 'application/octet-stream', 'content-length': end - start + 1, 'accept-ranges': 'bytes', ...(r ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}) });
  const breakIt = /-setup\.exe$/.test(m[1]) && !cut.has(m[1]);
  log(`GET ${m[1]} ${r ? `range ${start}-${end}` : 'whole'} (${size} B)${breakIt ? ' — cut off halfway' : ''}`);
  if (breakIt) {
    cut.add(m[1]);
    const half = Math.floor((end - start + 1) / 2);
    fs.createReadStream(f, { start, end: start + half - 1 }).on('end', () => setTimeout(() => req.socket.destroy(), 100)).pipe(res, { end: false });
    return;
  }
  fs.createReadStream(f, { start, end }).pipe(res);
});
server.listen(0, '127.0.0.1', () => { const p = server.address().port; if (portFile) fs.writeFileSync(portFile, String(p)); log(`serving ${dir} on 127.0.0.1:${p}`); });
