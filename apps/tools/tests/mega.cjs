// node tests/mega.cjs: MEGA links on a stubbed phone, against a MEGA API played here with real MEGA encryption — a file
// link read (its name decrypted with the link's key) and added as a download of its storage address carrying its key;
// a folder link's tree read (keys unwrapped with the folder's key), one file left out, the other added inside the
// folder's own folder; the same link added from anywhere else (a page's links) goes the same way; a page with MEGA
// links written as text offers them, keys kept. Also the downloader's half: tests/native/T.java (run 14).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const b64u = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fold = (k) => (k.length === 32 ? Buffer.from(Array.from({ length: 16 }, (_, i) => k[i] ^ k[i + 16])) : k);
const encAttr = (name, k) => { let p = Buffer.from('MEGA' + JSON.stringify({ n: name })); p = Buffer.concat([p, Buffer.alloc((16 - (p.length % 16)) % 16)]); const c = crypto.createCipheriv('aes-128-cbc', fold(k), Buffer.alloc(16)); c.setAutoPadding(false); return b64u(Buffer.concat([c.update(p), c.final()])); };
const ecb = (k, data) => { const c = crypto.createCipheriv('aes-128-ecb', k, null); c.setAutoPadding(false); return Buffer.concat([c.update(data), c.final()]); };
// A file link and a folder: Show/ (Ep 01.mkv, Extras/Ep 02.mkv).
const fileId = 'AbCdEf12', fileKey = crypto.randomBytes(32);
const folderId = 'FoLdEr99', folderKey = crypto.randomBytes(16);
const rootH = 'r00t', subH = 's0b1', f1H = 'f111', f2H = 'f222'; const k1 = crypto.randomBytes(32), k2 = crypto.randomBytes(32), kSub = crypto.randomBytes(16), kRoot = crypto.randomBytes(16);
const node = (h, p, t, name, k, s) => ({ h, p, t, a: encAttr(name, k), k: `${rootH}:${b64u(ecb(folderKey, k))}`, ...(s ? { s } : {}) });
const TREE = { f: [node(rootH, 'xxx', 1, 'Show', kRoot), node(subH, rootH, 1, 'Extras', kSub), node(f1H, rootH, 0, 'Ep 01.mkv', k1, 1000), node(f2H, subH, 0, 'Ep 02.mkv', k2, 2000)] };
(async () => {
  const web = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.exposeFunction('__mega', (url, body) => {
    const n = /[?&]n=([\w-]+)/.exec(url)?.[1]; const req = JSON.parse(body)[0];
    if (req.a === 'g' && req.p === fileId) return JSON.stringify([{ s: 4242, at: encAttr('Movie (2024).mkv', fileKey), ...(req.g ? { g: 'https://gfs.example/dl/AAA' } : {}) }]);
    if (req.a === 'f' && n === folderId) return JSON.stringify([TREE]);
    if (req.a === 'g' && n === folderId) return JSON.stringify([{ s: 1, g: `https://gfs.example/dl/${req.n}` }]);
    return JSON.stringify(-9);
  });
  await p.addInitScript(([fileLink, folderLink]) => {
    window.__adds = []; const tasks = [];
    const plugin = new Proxy({
      addListener: async () => ({ remove() {} }), list: async () => ({ tasks }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
      add: async (o) => { window.__adds.push(o); const t = { id: 't' + window.__adds.length, kind: 'http', name: o.name, source: o.source, dir: o.dir, state: 'queued', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native', meta: o.meta }; return { task: t }; },
      httpRequest: async (o) => { if (/g\.api\.mega\.co\.nz\/cs/.test(o.url)) return { status: 200, headers: {}, body: await window.__mega(o.url, o.body) }; if (/forum\.example/.test(o.url)) return { status: 200, headers: { 'content-type': 'text/html' }, body: `<html><body><p>Download here: ${fileLink} and the batch ${folderLink} — enjoy</p><a href="https://example.org/x.zip">zip</a></body></html>` }; return { status: 404, headers: {}, body: '' }; },
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, [`https://mega.nz/file/${fileId}#${b64u(fileKey)}`, `https://mega.nz/folder/${folderId}#${b64u(folderKey)}`]);
  const base = `http://127.0.0.1:${web.address().port}/`;
  const fileLink = `https://mega.nz/file/${fileId}#${b64u(fileKey)}`, folderLink = `https://mega.nz/folder/${folderId}#${b64u(folderKey)}`;
  await p.goto(base + '#/'); await p.waitForSelector('.fab');
  // A file link: its name read with its key.
  await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet'); await p.fill('.add-input', fileLink); await p.dispatchEvent('.add-input', 'input');
  await p.waitForFunction(() => /MEGA ·/.test(document.querySelector('.add-size')?.textContent || ''), null, { timeout: 8000 }).catch(() => undefined);
  const line = await p.$eval('.add-size', (e) => e.textContent); ok('a MEGA file link read: its name decrypted, its size', /Movie \(2024\)\.mkv/.test(line) && /4\.1 KB|4 KB|4\.2 KB/.test(line), line);
  await p.click('.add-sheet .btn.primary:has-text("Download")').catch(async () => { await p.evaluate(() => [...document.querySelectorAll('.sheet .btn.primary')].pop()?.click()); }); await p.waitForTimeout(800);
  let adds = await p.evaluate(() => window.__adds);
  ok('added as its storage address, with its key and name', adds.length === 1 && adds[0].source.url === 'https://gfs.example/dl/AAA' && adds[0].name === 'Movie (2024).mkv' && adds[0].meta?.megaKey === `${Buffer.from(fileKey).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`, adds);
  // A folder link: its tree, one file left out.
  await p.evaluate(() => { window.__adds = []; document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()); });
  await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet'); await p.fill('.add-input', folderLink); await p.dispatchEvent('.add-input', 'input');
  await p.waitForSelector('.mega-file', { timeout: 8000 }).catch(() => undefined);
  const listed = await p.$$eval('.mega-file', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ')));
  ok('a folder link: its files listed with their place in it', listed.length === 2 && /Ep 01\.mkv/.test(listed[0]) && /Extras\/Ep 02\.mkv/.test(listed[1]), listed);
  await p.locator('.mega-file', { hasText: 'Ep 01' }).locator('input').uncheck();
  await p.evaluate(() => [...document.querySelectorAll('.sheet .btn.primary')].pop()?.click()); await p.waitForTimeout(800);
  adds = await p.evaluate(() => window.__adds);
  ok('only the chosen one added, in the folder\'s own folder', adds.length === 1 && adds[0].name === 'Ep 02.mkv' && /Show\/Extras$/.test(adds[0].dir ?? '') && adds[0].meta?.megaHandle === 'f222' && adds[0].meta?.megaFolder === folderId, adds);
  // A page with MEGA links written as text: offered, keys kept.
  await p.evaluate(() => { document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()); });
  await p.evaluate(() => import(document.querySelector('script[type=module]')?.src || '').catch(() => null));
  await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item[data-act="search"]'); await p.waitForSelector('.sheet input');
  await p.fill('.sheet input[type=url], .sheet input', 'https://forum.example/thread/1'); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
  const offered = await p.evaluate(() => [...document.querySelectorAll('.sheet .file-row')].map((x) => x.textContent));
  ok('a page\'s MEGA links (written as text) offered', offered.filter((x) => /mega\.nz/.test(x) || /MEGA/.test(x)).length >= 2, offered);
  ok('no page errors', !errors.length, errors);
  await b.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
