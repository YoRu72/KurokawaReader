// The extension marketplace: the real Seanime Marketplace list and the Hayase repository (served from local
// copies), browsed in Settings → Anime; one Seanime source and one Hayase source installed and listed.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MP = process.env.MARKET_DIR;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: /\.mjs$/.test(f) ? 'text/plain' : (MIME[path.extname(f)] || 'application/octet-stream') }); });
  await p.route(/raw\.githubusercontent\.com\/Bas1874\/Seanime-Marketplace\/.*Main\.json/, (r) => r.fulfill({ contentType: 'text/plain', body: fs.readFileSync(path.join(MP, 'Bas1874_Seanime-Marketplace/Marketplace/Main.json')) }));
  await p.route(/raw\.githubusercontent\.com\/tanzim2000\/hayase-extension\/.*index\.json/, (r) => r.fulfill({ contentType: 'text/plain', body: fs.readFileSync(path.join(MP, 'tanzim2000_hayase-extension/index.json')) }));
  await p.route(/raw\.githubusercontent\.com\/Tanzim2000\/hayase-extension\/.*\/dist\/(.*)/, (r) => r.fulfill({ contentType: 'text/plain', body: fs.readFileSync(path.join(MP, 'tanzim2000_hayase-extension/dist', r.request().url().split('/dist/')[1])) }));
  await p.route(/raw\.githubusercontent\.com\/.*\/manifest\.json/, (r) => r.fulfill({ contentType: 'text/plain', body: JSON.stringify({ id: 'acg-rip-provider', name: 'ACG.RIP', version: '1.0.2', type: 'anime-torrent-provider', language: 'typescript', payloadURI: 'https://raw.githubusercontent.com/x/y/main/src/ACG.ts', userConfig: { fields: [{ type: 'text', name: 'domain', label: 'Domain', default: 'https://acg.rip' }] } }) }));
  await p.route(/raw\.githubusercontent\.com\/.*\.ts$/, (r) => r.fulfill({ contentType: 'text/plain', body: 'class Provider { getSettings() { return { canSmartSearch: false } } async search(o: any): Promise<any[]> { return [] } }' }));
  await p.route('https://graphql.anilist.co/**', (r) => r.fulfill({ json: { data: {} } }));
  await p.addInitScript((lang) => localStorage.setItem('kr.lang', lang), lang);
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForSelector('.addon-row');
  await p.click('.addon-row[data-id="anime"] .btn'); await p.waitForSelector('.toast');
  await p.goto(`http://127.0.0.1:${port}/#/settings/anime`); await p.reload(); await p.waitForSelector('#anime');
  await p.evaluate(() => document.querySelector('#anime').classList.remove('collapsed'));
  await p.click('#anime button:has-text("Browse extensions")'); await p.waitForTimeout(3000); console.log('sheet:', (await p.$eval('.market-sheet', (e) => e.innerText).catch((e) => 'no sheet ' + e.message)).slice(0, 300)); await p.waitForSelector('.market-list .addon-row', { timeout: 10000 });
  console.log('seanime sources:', await p.$$eval('.market-list .addon-row', (e) => e.length), '| first:', (await p.$$eval('.market-list .addon-row b', (e) => e.slice(0, 5).map((x) => x.textContent))).join(' | '));
  console.log('langs:', (await p.$$eval('.market-sheet .chip-row:nth-of-type(2) .chip', (e) => e.map((x) => x.textContent))).join(' '));
  await p.screenshot({ path: path.join(__dirname, `shot-market-${lang}.png`) });
  await p.click('.market-list .addon-row:has-text("ACG.RIP") .btn'); await p.waitForSelector('.toast:has-text("ACG")');
  await p.click('.market-sheet .chip:has-text("Hayase")'); await p.waitForSelector('.market-list .addon-row:has-text("SubsPlease")');
  console.log('hayase sources:', (await p.$$eval('.market-list .addon-row b', (e) => e.map((x) => x.textContent))).join(' | '));
  await p.click('.market-list .addon-row:has-text("SubsPlease") .btn'); await p.waitForTimeout(800);
  const ps = await p.evaluate(async () => { const r = indexedDB.open('kurokawa-tools'); return new Promise((res) => { r.onsuccess = () => res('ok'); r.onerror = () => res('no db'); }); });
  await p.click('.sheet .sheet-close, .sheet [aria-label="Close"]').catch(() => {});
  await p.waitForTimeout(500);
  console.log('provider list:', (await p.$$eval('#anime .addons-list .addon-row b', (e) => e.map((x) => x.textContent))).join(' | '));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : 'all passed');
  await br.close(); web.close(); process.exit(errors.length ? 1 : 0);
})();
