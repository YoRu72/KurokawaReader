// gallery-dl on the computer: the standalone binary from its GitHub releases (checked against the release's
// SHA-256 when it publishes one), run with `-j` to list what a gallery page holds — every picture's address and
// its metadata — so the app's own engine downloads them with their names. Nothing is downloaded by gallery-dl itself.
const { app, net } = require('electron'); const fs = require('node:fs'); const path = require('node:path'); const { execFile } = require('node:child_process'); const crypto = require('node:crypto');
const ASSET = process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl.bin';
const binDir = () => path.join(app.getPath('userData'), 'bin');
const binPath = () => path.join(binDir(), process.platform === 'win32' ? 'gallery-dl.exe' : 'gallery-dl');
let fetching = null;
async function fetchBinary(onProgress) {
  if (fetching) return fetching;
  fetching = (async () => {
    fs.mkdirSync(binDir(), { recursive: true });
    const rel = await (await net.fetch('https://api.github.com/repos/mikf/gallery-dl/releases/latest', { headers: { accept: 'application/vnd.github+json' } })).json();
    const asset = (rel.assets || []).find((a) => a.name === ASSET); if (!asset) throw new Error('gallery-dl: no binary for this platform');
    const want = asset.digest && /^sha256:/.test(asset.digest) ? asset.digest.slice(7) : null;
    const res = await net.fetch(asset.browser_download_url); if (!res.ok || !res.body) throw new Error('gallery-dl: HTTP ' + res.status);
    const total = Number(res.headers.get('content-length') || asset.size || 0); const tmp = binPath() + '.part'; const out = fs.createWriteStream(tmp); const hash = crypto.createHash('sha256'); let got = 0;
    const reader = res.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; out.write(Buffer.from(value)); hash.update(value); got += value.length; onProgress?.({ got, total }); }
    await new Promise((r) => out.end(r));
    if (want && hash.digest('hex') !== want) { fs.rmSync(tmp, { force: true }); throw new Error('gallery-dl: checksum mismatch'); }
    fs.renameSync(tmp, binPath()); if (process.platform !== 'win32') fs.chmodSync(binPath(), 0o755);
    return binPath();
  })().finally(() => { fetching = null; });
  return fetching;
}
const haveBinary = () => fs.existsSync(binPath());
async function ensure(onProgress) { if (!haveBinary()) await fetchBinary(onProgress); return binPath(); }
function version() { return new Promise((res) => execFile(binPath(), ['--version'], { timeout: 10000 }, (e, out) => res(e ? null : String(out).trim()))); }
/** What a gallery page holds: {title, items: [{url, name, ext, width, height, id}]}; `cookies` a Netscape file path (optional), `range` like "1-100". */
function list(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-j', '--no-download', ...(opts.cookies ? ['--cookies', opts.cookies] : []), ...(opts.range ? ['--range', opts.range] : []), url];
    execFile(binPath(), args, { timeout: 120000, maxBuffer: 64 << 20, windowsHide: true }, (e, out, err) => {
      if (e && !out) { reject(new Error(String(err || e.message).split('\n').filter(Boolean).pop() || 'gallery-dl failed')); return; }
      let msgs = []; try { msgs = JSON.parse(String(out)); } catch { reject(new Error('gallery-dl: unreadable answer')); return; }
      const items = []; let title = '';
      for (const m of msgs) {
        if (!Array.isArray(m)) continue;
        if (m[0] === 2 && m[1] && typeof m[1] === 'object') { const d = m[1]; title = d.title || d.name || d.album?.title || d.user?.name || title; }
        if (m[0] === 3 && typeof m[1] === 'string') { const d = m[2] || {}; const ext = d.extension || (/\.([a-z0-9]{2,5})(?:\?|$)/i.exec(m[1]) || [])[1] || 'jpg'; const base = d.filename || d.id || (d.num ? String(d.num) : '') || String(items.length + 1); items.push({ url: m[1], name: `${String(base).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').slice(0, 120)}.${ext}`, ext, width: d.width, height: d.height, id: d.id, category: d.category, headers: d._http_headers || undefined }); }
      }
      resolve({ title, items });
    });
  });
}
module.exports = { ensure, haveBinary, version, list, binPath };
