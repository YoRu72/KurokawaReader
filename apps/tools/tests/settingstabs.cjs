// Settings' bar of tabs (the default layout): All, The app, then each installed add-on that has something to set
// — its cards, and its sources' options on its own page —; «One list» in General takes the bar away.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const errors = []; const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const p = await br.newPage({ viewport: { width: 400, height: 860 } }); p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: MIME[path.extname(f)] || 'text/plain' }); });
  await p.addInitScript(() => { localStorage.setItem('kr.lang', 'en'); if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ addons: ['anime', 'tv', 'subtitles', 'subs-subdl', 'torrent-search', 'torrent-search-tpb'], subLangs: ['en'] })); });
  await p.goto(`http://127.0.0.1:${port}/#/settings`); await p.waitForSelector('.settings-tabs .chip'); await p.waitForTimeout(800);
  const tabs = await p.$$eval('.settings-tabs .chip', (c) => c.map((x) => x.textContent.trim())); console.log('tabs:', tabs.join(' | '));
  check('All, The app, then the add-ons with settings', tabs[0] === 'All settings' && tabs[1] === 'The app' && tabs.some((x) => /Anime/.test(x)) && tabs.some((x) => /TV/.test(x)) && tabs.some((x) => /Subtitles/.test(x)));
  const allIds = await p.$$eval('.settings-view section.card', (c) => c.map((x) => x.id)); check('All shows every card', allIds.includes('general') && allIds.includes('anime') && allIds.includes('tv'));
  await p.locator('.settings-tabs .chip', { hasText: 'Anime' }).click(); await p.waitForTimeout(200);
  let ids = await p.$$eval('.settings-view section.card', (c) => c.map((x) => x.id)); console.log('anime tab:', ids.join(' '));
  check('the Anime tab: its cards only, open', ids.includes('anime') && ids.includes('anilist') && ids.includes('episodes') && !ids.includes('general') && !ids.includes('tv') && !(await p.$('section.card.collapsed')));
  await p.locator('.settings-tabs .chip', { hasText: 'Subtitles' }).click(); await p.waitForTimeout(200);
  ids = await p.$$eval('.settings-view section.card', (c) => c.map((x) => x.id)); console.log('subtitles tab:', ids.join(' '));
  const srcText = await p.$eval('#src-subtitles', (e) => e.innerText).catch(() => '');
  check('the Subtitles tab: languages and its sources\' options', ids.includes('sublangs') && /SubDL/i.test(srcText) && !!(await p.$('#src-subtitles input')));
  const tsTab = tabs.find((x) => /torrent/i.test(x));
  if (tsTab) { await p.locator('.settings-tabs .chip', { hasText: tsTab }).click(); await p.waitForTimeout(200); check('a sources-only add-on gets a page of its options', !!(await p.$('[id^="src-"] input'))); }
  await p.locator('.settings-tabs .chip', { hasText: 'The app' }).click(); await p.waitForTimeout(200);
  ids = await p.$$eval('.settings-view section.card', (c) => c.map((x) => x.id)); console.log('app tab:', ids.join(' '));
  check('The app: general and the rest, no add-on cards', ids.includes('general') && ids.includes('updates') && !ids.includes('anime') && !ids.includes('sublangs'));
  // One list instead.
  await p.click('#general h3').catch(() => undefined); await p.waitForTimeout(100);
  await p.locator('#general .row', { hasText: 'Settings layout' }).locator('button').click(); await p.locator('.sheet .dest-row, .sheet label, .sheet button', { hasText: 'One list' }).first().click(); await p.waitForTimeout(300);
  check('One list: no bar, every card', await p.$eval('.settings-tabs', (e) => e.hidden) && (await p.$$('.settings-view section.card')).length >= allIds.length);
  check('the choice kept', await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).settingsLayout === 'list'));
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
