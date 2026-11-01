// The app's browser, the phone's side stubbed: «Grab» hands a page's links (and media its player loaded) to the
// grabber, which offers them by kind to pick from and adds the picked ones with the page's address and identity;
// a file the page downloads opens the Add sheet with its name; + → Browse opens the browser.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__calls = []; const L = {}; window.__emit = (ev, d) => (L[ev] || []).forEach((f) => f(d));
    const plugin = new Proxy({ addListener: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return { remove() {} }; }, list: async () => ({ tasks: [] }),
      add: async (o) => { window.__calls.push(['add', o]); return { task: { id: 'n' + window.__calls.length, kind: 'http', name: 'x', state: 'queued', files: [], done: 0, total: 0, downSpeed: 0, upSpeed: 0, addedAt: Date.now(), source: o.source } }; } },
      { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async (a) => { window.__calls.push([k, a]); return {}; }) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${web.address().port}/`); await p.waitForTimeout(900);
  const page = 'https://pawchive.example/post/1';
  await p.evaluate((page) => window.__emit('browser', { kind: 'links', url: page, title: 'A post', ua: 'Mozilla/5.0 test', links: [
    { href: 'https://file.example/data/c0/aa.jpeg?f=Picture%201.jpeg', text: '' }, { href: 'https://file.example/data/1f/bb.mp4?f=%E3%83%AD%E3%83%B3%E3%82%B0.mp4', text: 'Download' }, { href: 'https://pawchive.example/user/2', text: 'Artist' }, { href: 'https://cdn.example/v/master.m3u8', text: '', kind: 'media' }] }), page);
  await p.waitForSelector('.grab-row'); await p.waitForTimeout(200);
  const chips = (await p.$eval('.sheet .chip-row.wrap:not(.grab-projects)', (e) => e.innerText)).replace(/\s+/g, ' '); const rows = await p.$$eval('.grab-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  console.log('chips:', chips); console.log('rows:', rows.join(' | '));
  await p.screenshot({ path: path.join(__dirname, `shot-browser-${lang}.png`) });
  await p.locator('.sheet .chip-row.wrap:not(.grab-projects) .chip').first().click(); await p.waitForTimeout(100);
  const allRows = await p.$$eval('.grab-row', (r) => r.length);
  await p.locator('.grab-row input').first().check(); await p.click('.sheet .btn.primary'); await p.waitForTimeout(500);
  const adds = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'add').map((c) => c[1]));
  console.log('all rows', allRows, 'adds', JSON.stringify(adds.map((a) => [a.source.url, a.source.headers])));
  await p.evaluate(() => window.__emit('browser', { kind: 'download', url: 'https://file.example/data/zz.zip?f=Pack.zip', name: 'Pack.zip', referer: 'https://pawchive.example/post/1', ua: 'Mozilla/5.0 test' }));
  await p.waitForSelector('.sheet textarea'); await p.waitForTimeout(300);
  const addSheet = await p.evaluate(() => [document.querySelector('.sheet textarea').value, document.querySelector('.sheet input[type=text]')?.value]);
  console.log('add sheet:', addSheet);
  await p.keyboard.press('Escape'); await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); await p.waitForTimeout(200);
  await p.click('.fab'); await p.waitForSelector('.fab-item'); await p.locator('.fab-item').last().click(); await p.waitForSelector('.sheet .search-input');
  await p.fill('.sheet .search-input', 'pawchive.example'); await p.press('.sheet .search-input', 'Enter'); await p.waitForTimeout(300);
  console.log('sheet title:', await p.$eval('.sheet', (e) => e.innerText.slice(0, 60)).catch(() => 'none'));
  const browse = await p.evaluate(() => window.__calls.find((c) => c[0] === 'browse'));
  console.log('browse:', JSON.stringify(browse));
  const pass = /2/.test(chips) && rows.length >= 2 && allRows === 4 && adds.length >= 1 && adds.every((a) => a.source.headers && a.source.headers.Referer === page) && addSheet[0].includes('Pack.zip') && addSheet[1] === 'Pack.zip' && browse && browse[1].url === 'https://pawchive.example';
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
