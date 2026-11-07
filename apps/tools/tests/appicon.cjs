// The app's icon of your choosing: a picture picked, cropped (moved, zoomed, shaped), used — on a computer handed to
// the window and shortcuts (and the original brought back), on Android pinned as a home-screen shortcut.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const zlib = require('node:zlib');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
// A 64×40 red PNG, made here.
const png = (() => { const w = 64, hh = 40; const raw = Buffer.alloc((w * 4 + 1) * hh); for (let y = 0; y < hh; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const o = y * (w * 4 + 1) + 1 + x * 4; raw[o] = 220; raw[o + 1] = 30; raw[o + 2] = 30; raw[o + 3] = 255; } }
  const crc = (b) => { let c, t = []; for (let n = 0; n < 256; n++) { c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } let x = 0xffffffff; for (const v of b) x = t[(x ^ v) & 255] ^ (x >>> 8); return (x ^ 0xffffffff) >>> 0; };
  const chunk = (ty, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(ty), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(hh, 4); ih[8] = 8; ih[9] = 6; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); })();
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const pick = async (p, clickSel) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.evaluate((s) => document.querySelector(s).click(), clickSel)]); await fc.setFiles({ name: 'me.png', mimeType: 'image/png', buffer: png }); await p.waitForSelector('.icon-crop canvas'); };
  const crop = async (p) => { const c = await p.$('.icon-crop canvas'); const b = await c.boundingBox(); await p.mouse.move(b.x + 140, b.y + 140); await p.mouse.down(); await p.mouse.move(b.x + 180, b.y + 150, { steps: 4 }); await p.mouse.up(); await p.click('.icon-crop .segmented button >> nth=0'); await p.click('.icon-crop .btn.primary'); };
  // A computer
  { const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); window.__icon = []; window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], on: () => () => {}, onTasks: () => () => {}, appIcon: async (o) => { if (o) { window.__icon.push(o.set ? o.set.slice(0, 22) : null); window.__cur = o.set; return true; } return window.__cur || null; } }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) }); });
    await p.goto(base + '#/settings'); await p.waitForSelector('.app-icon-row', { state: 'attached' });
    await pick(p, '.app-icon-row .btn.tonal'); await crop(p); await p.waitForTimeout(300);
    const set = await p.evaluate(() => ({ calls: window.__icon, src: document.querySelector('.app-icon-now').getAttribute('src').slice(0, 22) }));
    check('a computer: the cropped picture handed over as the app\'s icon, shown in Settings', set.calls[0] === 'data:image/png;base64,' && set.src === 'data:image/png;base64,', set);
    const inApp = () => p.evaluate(() => ({ logo: (document.querySelector('.rail-brand img')?.getAttribute('src') || '').slice(0, 22), fav: (document.querySelector('link[rel="icon"]')?.getAttribute('href') || '').slice(0, 22) }));
    let ia = await inApp(); check('a computer: the sidebar\'s logo and the window\'s icon are the new one', ia.logo === 'data:image/png;base64,' && ia.fav === 'data:image/png;base64,', ia);
    await p.reload(); await p.waitForSelector('.rail-brand img'); await p.waitForTimeout(300); ia = await inApp(); check('a computer: … and still after a restart', ia.logo === 'data:image/png;base64,' && ia.fav === 'data:image/png;base64,', ia);
    await p.goto(base + '#/settings'); await p.waitForSelector('.app-icon-row', { state: 'attached' }); await p.waitForTimeout(300);
    await p.evaluate(() => [...document.querySelectorAll('.app-icon-row button')].find((b) => /original/.test(b.textContent)).click()); await p.waitForTimeout(200);
    check('a computer: the original icon back', (await p.evaluate(() => window.__icon.at(-1))) === null);
    ia = await inApp(); check('a computer: the app\'s own logo back in the page', !ia.logo.startsWith('data:') && !ia.fav.startsWith('data:'), ia);
    await ctx.close(); }
  // Android
  { const ctx = await br.newContext({ viewport: { width: 412, height: 860 } }); const p = await ctx.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(() => { localStorage.setItem('kr.lang', 'en'); window.__pin = null; const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [] }), pinIcon: async (o) => { window.__pin = { png: o.png.slice(0, 22), label: o.label }; return { ok: true }; } }; const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }); window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] }; });
    await p.goto(base + '#/settings'); await p.waitForSelector('.app-icon-row', { state: 'attached' });
    await pick(p, '.app-icon-row .btn.tonal'); await crop(p); await p.waitForTimeout(300);
    const pin = await p.evaluate(() => window.__pin);
    check('Android: a home-screen shortcut asked for, with the cropped picture and the app\'s name', !!pin && pin.png === 'data:image/png;base64,' && /Kurokawa/.test(pin.label), pin);
    await ctx.close(); }
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
