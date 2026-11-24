// Updates appear only when there is something to update (0.67): nothing followed -> no bell on Browse, no section for the
// followed works in Settings (not in its chips or its search either), no red mark, no background check (zero requests);
// the app's own «App updates» section stays throughout. One work followed (added from a source) -> the section shows live
// with «Check now» and the time of the last check; one update waiting -> the bell with its count, the sheet lists the news of
// every followed work, «Check the others» asks the rest (a second work's news arrives, badge 2); all seen -> the bell goes.
// Every request goes to the loopback mock site (tests/ext/server.cjs, made-up novels); anything else is refused and counted.
// node tests/sourcesupdates.cjs [en|ar]      (KR_SHOTS=<dir>: pictures)
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const LANG = process.argv.includes('ar') ? 'ar' : 'en'; const SHOTS = process.env.KR_SHOTS;
const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const SITE = 'http://localhost:5423'; const APP = 'http://localhost:5424/';
const T = { en: { upToDate: 'Up to date', appUpdates: 'App updates', checkNow: 'Check now' }, ar: { upToDate: 'كل شيء محدَّث', appUpdates: 'تحديثات التطبيق', checkNow: 'تحقق الآن' } }[LANG];
(async () => {
  await new Promise((r) => server.listen(5424, r));
  const mock = spawn('node', [path.join(__dirname, 'ext/server.cjs'), '5423'], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: LANG, colorScheme: 'dark', serviceWorkers: 'block' }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => { if (!/Service worker is disabled because the context is sandboxed/.test(String(e))) errors.push(String(e)); }); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|503|ERR_|net::|Failed to load resource/.test(m.text())) errors.push(m.text()); });
  let fails = 0; const ok = (name, cond) => { console.log((cond ? 'ok  ' : 'FAIL'), name); if (!cond) fails++; };
  // (Every request counted by where it goes; the app's own files pass, the mock site is counted, anything else is refused.)
  let siteRequests = 0; let foreign = 0; const foreignUrls = new Set(); let delayMs = 0;
  await page.route('**/*', (route) => { const u = route.request().url(); if (u.startsWith(APP)) return route.continue(); if (u.startsWith(SITE)) { siteRequests++; if (delayMs) return setTimeout(() => route.continue().catch(() => undefined), delayMs); return route.continue(); } if (/^(data|blob):/.test(u)) return route.continue(); if (/\/repo\/themes\/themes\./.test(u)) return route.abort(); /* the app's own theme list, not a source */ foreign++; foreignUrls.add(u.slice(0, 80)); return route.abort(); });
  const visible = (sel) => page.$eval(sel, (e) => !e.hidden && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0).catch(() => false);
  const idb = (fn) => page.evaluate(`new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const st = r.result.transaction('books', 'readwrite').objectStore('books'); const go = ${fn}; st.getAll().onsuccess = (e) => { const out = go(e.target.result, st); st.transaction.oncomplete = () => res(out); }; }; })`);
  const poke = () => page.evaluate(() => { const c = new BroadcastChannel('kr-db'); c.postMessage('books'); c.close(); });
  const settle = (ms = 400) => page.waitForTimeout(ms);
  const hub = async () => { await page.goto(APP + '#/sources'); await page.waitForSelector('.sources-hub'); await settle(500); };
  const settings = async () => { await page.goto(APP + '#/settings'); await page.waitForSelector('.settings-body .card', { state: 'attached' }); await settle(600); };
  const updCardShown = () => visible('.upd-card');
  const chipShown = () => page.evaluate(() => { const c = document.querySelector('.upd-card'); const b = c && document.querySelector(`.settings-nav [data-sec="${c.id}"]`); return !!b && !b.hidden && getComputedStyle(b).display !== 'none'; });
  const appCard = () => page.evaluate((w) => [...document.querySelectorAll('.settings-body > .card > h3')].some((h) => h.textContent.trim() === w && !h.closest('.card').hidden), T.appUpdates);
  try {
    await page.goto(APP); await page.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.removeItem('kr.sources.checkedAt'); }, LANG); await page.reload(); await page.waitForSelector('.library-view');

    // ---- A. nothing followed ----
    await hub();
    ok('nothing followed: no bell on Browse', !(await visible('.bell-btn')));
    await page.goto(APP + '#/'); await page.waitForSelector('.library-view'); await settle(4800);
    ok('… and no red mark on the Browse button', await page.$eval('.browse-btn .alert-mark', (e) => e.hidden));
    await settings();
    ok('nothing followed: no section for the followed works, no chip for it', !(await updCardShown()) && !(await chipShown()));
    await page.fill('.settings-search', LANG === 'ar' ? 'تحقق' : 'check'); await settle(300);
    ok('… nor among the search results', !(await updCardShown()));
    await page.fill('.settings-search', ''); await settle(200);
    ok('the app\'s own «App updates» section is there', await appCard());

    // A repository added by hand (made-up, on loopback); with a stale last check and nothing followed nothing is asked.
    await hub();
    await page.click('.sources-view .topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]'); await page.fill('.sheet input[type=url]', `${SITE}/repo/plugins.min.json`); await page.click('.sheet .btn.primary');
    await page.waitForSelector('.ext-pick-list', { timeout: 15000 }); await settle(300);
    for (const b of await page.$$('.ext-pick-row .btn.primary')) { await b.click(); await settle(400); }
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    await page.evaluate(() => { localStorage.setItem('kr.sources.checkedAt', '1'); localStorage.removeItem('kr.sources.autoCheck'); localStorage.setItem('kr.updates.every', '1'); });
    siteRequests = 0; await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); await settle(6500);
    ok('nothing followed: the background check asks nothing (zero requests)', siteRequests === 0);

    // ---- the section appears by itself when a work is followed, and goes when none is ----
    await settings();
    await idb(`(all, st) => { st.put({ id: 'seed-follow', title: 'Seed Novel', format: 'webnovel', fileName: 'seed.json', size: 1, addedAt: Date.now(), remote: { source: 'ext:seed:plug', id: '/n/seed', newChapters: 0 } }); }`);
    await poke(); await page.waitForSelector('.upd-card:not([hidden])', { timeout: 5000 }).catch(() => undefined); await settle(300);
    ok('the first work followed: the section shows live (no restart) and its chip with it', (await updCardShown()) && (await chipShown()));
    const cardText = await page.$eval('.upd-card', (e) => e.textContent);
    ok('… with «Check now», the existing options and the time of the last check', cardText.includes(T.checkNow) && (await page.$$('.upd-card input[type=checkbox]')).length >= 6 && !!(await page.$('.upd-card .upd-last')) && (await page.$eval('.upd-card .upd-last', (e) => e.textContent.trim())).length > 3);
    ok('… and the app\'s own section still there', await appCard());
    await page.evaluate(() => localStorage.setItem('kr.sources.checkedAt', String(Date.now() - 3 * 3600000))); await settings(); await page.waitForSelector('.upd-card:not([hidden])'); await idb(`(all, st) => 0`);
    await page.evaluate(() => { const c = document.querySelector('.upd-card'); c.classList.remove('collapsed'); c.scrollIntoView({ block: 'start' }); }); await settle(700);
    if (SHOTS) { await page.screenshot({ path: path.join(SHOTS, 'S4b-settings-updates.png') }); }
    const btn = page.locator('.upd-card button', { hasText: T.checkNow });
    delayMs = 900; await btn.click(); await settle(150);
    ok('«Check now» is off while a check runs', await page.$eval('.upd-card .btn', (e) => e.disabled).catch(() => false));
    await page.waitForFunction((w) => document.querySelector('.upd-card .upd-status')?.textContent.includes(w), T.upToDate, { timeout: 20000 }).catch(() => undefined);
    delayMs = 0;
    ok('… then says «Up to date», and the button is back', (await page.$eval('.upd-card .upd-status', (e) => e.textContent)).includes(T.upToDate) && !(await page.$eval('.upd-card .btn', (e) => e.disabled)));
    await idb(`(all, st) => { st.delete('seed-follow'); }`); await poke(); await settle(900);
    ok('the last work gone: the section goes with it', !(await updCardShown()) && !(await chipShown()) && (await appCard()));

    // ---- two works followed from the mock site, one update waiting ----
    const follow = async (title) => {
      await hub(); await page.click('.repo-section >> nth=0 >> .ext-card >> nth=0'); await page.waitForSelector('.src-grid .src-card', { timeout: 20000 }); await settle(400);
      await page.click(`.src-grid .src-card:has-text("${title}")`); await page.waitForSelector('.src-files', { timeout: 20000 }); await settle(300);
      await page.click('.src-files .btn.tonal'); await page.waitForFunction(() => /reads offline|offline/i.test(document.querySelector('.src-actions')?.textContent ?? '') || /غير متصل|دون اتصال/.test(document.querySelector('.src-actions')?.textContent ?? ''), null, { timeout: 30000 }).catch(() => undefined); await settle(1200);
    };
    await follow('Alpha'); await follow('Gamma');
    await settings();
    ok('two works followed: the section is shown', await updCardShown());
    siteRequests = 0; await page.evaluate(() => { localStorage.setItem('kr.sources.checkedAt', '1'); document.dispatchEvent(new Event('visibilitychange')); });
    await page.waitForFunction(() => true); for (let i = 0; i < 40 && !siteRequests; i++) await settle(250);
    ok('… and now the background check does ask (the same trigger as before)', siteRequests > 0);
    await settle(2500);
    await hub();
    ok('followed but nothing waiting: no bell', !(await visible('.bell-btn')));
    // One update waiting (made up on the first work), the other work's site gets a chapter the bell\'s check will find.
    await idb(`(all, st) => { const b = all.find((x) => /Alpha/.test(x.title)); b.remote.newChapters = 1; b.remote.checkedAt = Date.now(); st.put(b); }`);
    await page.evaluate((u) => fetch(u).then((r) => r.json()), `${SITE}/admin/add-chapter?slug=gamma`);
    await page.reload(); await page.waitForSelector('.sources-hub'); await settle(700);
    ok('one update waiting: the bell shows with the count 1', (await visible('.bell-btn')) && (await page.$eval('.bell-btn .count', (e) => e.textContent.trim()).catch(() => '')).replace(/[^0-9٠-٩]/g, '') !== '' && /^(1|١)$/.test(await page.$eval('.bell-btn .count', (e) => e.textContent.trim()).catch(() => '')));
    await page.goto(APP + '#/'); await page.waitForSelector('.library-view'); await settle(4800);
    ok('… and the red mark on the Browse button with it', !(await page.$eval('.browse-btn .alert-mark', (e) => e.hidden)));
    await hub(); await page.click('.bell-btn'); await page.waitForSelector('.updates-sheet .upd-row'); await settle(500);
    ok('the sheet lists the first work\'s news and says how many works are followed', (await page.$$eval('.updates-sheet .upd-row', (r) => r.map((x) => x.textContent))).some((x) => /Alpha/.test(x)) && /(2|٢)/.test(await page.$eval('.updates-sheet .upd-followed', (e) => e.textContent)));
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'S4b-bell-sheet.png') });
    siteRequests = 0;
    await page.click('.updates-sheet .upd-state .btn');
    await page.waitForFunction(() => document.querySelectorAll('.updates-sheet .upd-row .badge.new').length >= 2, null, { timeout: 30000 }).catch(() => undefined);
    ok('«Check the others» asks the rest: the second work\'s news arrives too', (await page.$$eval('.updates-sheet .upd-row', (r) => r.map((x) => x.textContent))).some((x) => /Gamma/.test(x)) && siteRequests > 0);
    await settle(400);
    ok('… and the bell\'s badge says 2', /^(2|٢)$/.test(await page.$eval('.bell-btn .count', (e) => e.textContent.trim()).catch(() => '')));
    // Everything seen -> the bell goes.
    await page.click('.updates-sheet .upd-head .btn.text'); await settle(900);
    ok('all seen: the bell goes', !(await visible('.bell-btn')));
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    await page.goto(APP + '#/'); await page.waitForSelector('.library-view'); await settle(4800);
    ok('… and the red mark with it', await page.$eval('.browse-btn .alert-mark', (e) => e.hidden));
    await settings();
    ok('the section of the followed works stays (they are still followed) and the app\'s own section too', (await updCardShown()) && (await appCard()));
    if (foreign) console.log('  requests refused (not the app, not the mock):', foreign, [...foreignUrls]);
    ok('no request went anywhere but the app and the mock site', foreign === 0);
  } catch (e) { ok('ran to the end: ' + String(e.message).split('\n')[0], false); }
  ok('no page errors', !errors.length); if (errors.length) console.log(errors.slice(0, 4));
  console.log(fails ? `${fails} failed` : 'all passed');
  await browser.close(); server.close(); mock.kill(); process.exit(fails ? 1 : 0);
})();
