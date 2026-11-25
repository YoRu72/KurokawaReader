// The search over the extensions of every repository added (0.67): hidden with no repository; two made-up repositories seeded
// (nothing is fetched): by name, by folded name (case, marks), by language (code and name), by repository name; the same extension
// of two repositories shown twice, labelled; the four states with their actions; the chips; «/» finds the field on a computer;
// 3,000 entries across 5 repositories filtered under 30 ms (the pure function, bundled and run in node).
// node tests/extsearch.cjs [en|ar]      (KR_SHOTS=<dir>: pictures)
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const LANG = process.argv.includes('ar') ? 'ar' : 'en'; const SHOTS = process.env.KR_SHOTS; const DIST = path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const APP = 'http://localhost:5434/';
const mk = (id, name, lang, version, extra = {}) => ({ id, name, lang, site: 'https://x.test/', version, url: `https://code.test/${id}.js`, kind: 'lnreader', runnable: true, itemType: 'novel', ...extra });
const repoA = { key: 'ra', url: 'https://a.test/i.json', given: 'https://a.test/i.json', name: 'Lantern Repo', kind: 'lnreader', addedAt: 1, fetchedAt: 1, items: [mk('p1', 'Café Chronicles', 'en', '1.0.0'), mk('p2', 'Zeta Tales', 'ar', '2.0.0'), mk('p3', 'Shared Stories', 'en', '1.0.0'), mk('p4', 'Old Engine', 'en', '1.0.0', { runnable: false, note: 'dartExtension' })] };
const repoB = { key: 'rb', url: 'https://b.test/i.json', given: 'https://b.test/i.json', name: 'Harbour Index', kind: 'lnreader', addedAt: 2, fetchedAt: 1, items: [mk('q1', 'Shared Stories', 'en', '1.1.0'), mk('q2', 'ストーリー', 'ja', '1.0.0')] };
(async () => {
  let fails = 0; const ok = (n, c) => { console.log(c ? 'ok  ' : 'FAIL', n); if (!c) fails++; };
  // Speed: the pure function, 3,000 entries over 5 repositories.
  {
    const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-es-')), 'es.cjs');
    require('esbuild').buildSync({ entryPoints: [path.join(__dirname, '../src/sources/extsearch.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
    const { buildExtIndex, searchExts } = require(out); const langs = ['en', 'ar', 'ja', 'ko', 'zh', 'fr'];
    const repos = Array.from({ length: 5 }, (_, r) => ({ key: 'r' + r, name: 'Repo ' + r, kind: 'lnreader', items: Array.from({ length: 600 }, (_, i) => mk('x' + i, `Name ${i} ${['Alpha', 'Beta', 'Gamma', 'Delta'][i % 4]} Café`, langs[i % 6], '1.0.0')) }));
    const ix = buildExtIndex(repos, { 'r0:x1': '0.9.0', 'r1:x2': '1.0.0' }, (c) => c, (l) => l.toUpperCase(), (a, b) => a > b);
    let worst = 0; let n = 0; for (const q of ['', 'a', 'cafe', 'gamma 12', 'repo 3', 'zzz', 'ar']) { for (let k = 0; k < 5; k++) { const t0 = performance.now(); n = searchExts(ix, q, {}).length; worst = Math.max(worst, performance.now() - t0); } }
    console.log(`  3,000 entries: worst of 35 runs ${worst.toFixed(1)} ms (last result ${n})`);
    ok(`3,000 extensions across 5 repositories filter under 30 ms (${worst.toFixed(1)} ms)`, ix.length === 3000 && worst < 30);
    ok('folding: "cafe" finds "Café", "name 2 gamma" the gap-loosened name', searchExts(ix, 'cafe').length === 3000 && searchExts(ix, 'name 2 gamma').length >= 1);
  }
  await new Promise((r) => server.listen(5434, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: LANG, colorScheme: 'dark', serviceWorkers: 'block' }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e)));
  let net = 0; await page.route('**/*', (r) => { const u = r.request().url(); if (u.startsWith(APP) || /^(data|blob):/.test(u)) return r.continue(); if (/code\.test/.test(u)) return r.fulfill({ status: 200, headers: { 'content-type': 'text/javascript', 'access-control-allow-origin': '*' }, body: 'exports.default = { id: "x", name: "X", version: "1", popularNovels: async () => [] };' }); if (!/\/repo\/themes\//.test(u)) net++; return r.abort(); });
  const seed = (repos, installed) => page.evaluate(([repos, installed]) => new Promise((res) => { localStorage.setItem('kr.ext.installed', JSON.stringify(installed)); const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); tx.objectStore('meta').put(repos, 'sources:repos'); tx.oncomplete = () => res(1); }; }), [repos, installed]);
  const rows = () => page.$$eval('.ext-hit', (r) => r.map((x) => ({ name: x.querySelector('b').textContent, text: x.querySelector('.ext-text').textContent, state: x.dataset.state })));
  const type = async (q) => { await page.fill('.ext-search-field', q); await page.waitForTimeout(450); };
  const hubReload = async () => { await page.goto(APP + '#/sources'); await page.reload(); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(700); };
  try {
    await page.goto(APP); await page.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, LANG); await page.reload(); await page.waitForSelector('.library-view');
    await seed([], {}); await hubReload();
    ok('no repository: no search field on the page', !(await page.$('.ext-search')));
    await seed([repoA, repoB], { 'ra:p1': '1.0.0', 'ra:p3': '0.9.0' }); await hubReload();
    ok('repositories added: the field shows above them', !!(await page.$('.ext-search-field')) && (await page.$$('.repo-section')).length === 2);
    await type('shared');
    let r = await rows(); ok('by name: the same extension of two repositories shows twice, each labelled with its repository', r.length === 2 && r.some((x) => /Lantern Repo/.test(x.text)) && r.some((x) => /Harbour Index/.test(x.text)));
    ok('… states: one with an update available, one not installed', r.some((x) => x.state === 'update') && r.some((x) => x.state === 'not'));
    await type('CAFE'); r = await rows(); ok('folded name (case, marks): "CAFE" finds "Café Chronicles", state installed', r.length === 1 && r[0].state === 'installed');
    await type('ar'); r = await rows(); ok('by language: "ar" finds the Arabic one', r.some((x) => /Zeta/.test(x.name)));
    await type('harbour'); r = await rows(); ok('by repository name', r.length === 2 && r.every((x) => /Harbour/.test(x.text)));
    await type('ストーリー'); r = await rows(); ok('non-Latin names', r.length === 1);
    await type('old'); r = await rows(); ok('«cannot run here» state, no action button on its row', r.length === 1 && r[0].state === 'cannot' && !(await page.$('.ext-hit.cannot .btn')));
    await type('nothing-like-this'); ok('empty state says nothing is there', !!(await page.$('.ext-search .empty')) && (await page.$$('.ext-hit')).length === 0);
    await type(''); ok('cleared: the repositories are back', !(await page.$('.ext-hit')) && (await page.$eval('.repos-tree', (e) => !e.hidden)));
    // chips
    const chips = await page.$$eval('.ext-filters .chip', (c) => c.map((x) => x.dataset.chip));
    ok('chips: Installed, Updates and the languages (more than one)', chips.includes('installed') && chips.includes('updates') && chips.filter((c) => c.startsWith('lang:')).length === 3);
    await page.click('.ext-filters [data-chip="updates"]'); await page.waitForTimeout(200); r = await rows(); ok('«Updates» chip: only the one to update', r.length === 1 && r[0].state === 'update');
    await page.click('.ext-filters [data-chip="updates"]'); await page.click('.ext-filters [data-chip="installed"]'); await page.waitForTimeout(200); r = await rows(); ok('«Installed» chip: installed and to update', r.length === 2);
    const own = await page.evaluate(() => { const i = document.querySelector('.ext-search-field'); const c = document.querySelector('.ext-search .src-search-row .icon-btn'); const a = i.getBoundingClientRect(), b = c.getBoundingClientRect(); return { type: i.type, attr: i.hasAttribute('data-own-clear'), rule: [...document.styleSheets].some((ss) => { try { return [...ss.cssRules].some((r) => /data-own-clear[^{]*::-webkit-search-cancel-button/.test(r.selectorText || '') && r.style.display === 'none'); } catch { return false; } }), appearance: getComputedStyle(i).appearance, inside: b.width > 0 && b.left >= a.left - 1 && b.right <= a.right + 1 && b.top >= a.top - 1 && b.bottom <= a.bottom + 1 }; });
    ok('one clear control: the browser\'s own is off and ours sits inside the field\'s box', own.type === 'search' && own.attr && own.rule && own.appearance === 'none' && own.inside); if (!(own.type === 'search' && own.attr && own.rule && own.appearance === 'none' && own.inside)) console.log(own);
    await page.click('.ext-search .src-search-row .icon-btn'); await page.waitForTimeout(200); ok('clear (×) empties the field and the filters', !(await page.$('.ext-hit')));
    // actions
    await type('shared'); const before = net;
    await page.click('.ext-hit.not .btn'); await page.waitForTimeout(900);
    r = await rows(); ok('«add» installs it: both rows now installed or to update', r.filter((x) => x.state === 'installed').length === 1 && r.filter((x) => x.state === 'update').length === 1);
    await page.click('.ext-hit.update .btn'); await page.waitForTimeout(900); r = await rows(); ok('«update» brings it up to date', r.every((x) => x.state === 'installed'));
    ok('searching itself made no request', before === 0 && net === 0);
    await page.click('.ext-hit .icon-btn[data-icon="more"]'); await page.waitForSelector('.sheet .dest-row.danger'); ok('the row\'s menu offers removal', true); await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    // many results: batches
    await type(''); await page.click('.ext-filters [data-chip^="lang:"]'); await page.waitForTimeout(200);
    if (SHOTS) { await type(LANG === 'ar' ? 'ا' : 'a'); await page.evaluate(() => window.scrollTo(0, 0)); await page.waitForTimeout(700); await page.screenshot({ path: path.join(SHOTS, `S4c-extsearch-${LANG}.png`) }); }
    // PC (a pointer that is not touch): «/» and Ctrl+F reach the field; a long list renders in batches.
    const pcx = await browser.newContext({ ...devices['Desktop Chrome'], locale: LANG, colorScheme: 'dark', serviceWorkers: 'block' }); const pc = await pcx.newPage();
    await pc.route('**/*', (r) => { const u = r.request().url(); return u.startsWith(APP) ? r.continue() : r.abort(); });
    await pc.goto(APP); await pc.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, LANG); await pc.reload(); await pc.waitForSelector('.library-view');
    const big = { ...repoA, key: 'rc', name: 'Big Repo', items: Array.from({ length: 3000 }, (_, i) => mk('b' + i, 'Bulk ' + i, 'en', '1.0.0')) };
    await pc.evaluate(([repos]) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); tx.objectStore('meta').put(repos, 'sources:repos'); tx.oncomplete = () => res(1); }; }), [[repoA, repoB, big]]);
    await pc.goto(APP + '#/sources'); await pc.reload(); await pc.waitForSelector('.ext-search-field'); await pc.waitForTimeout(700);
    await pc.keyboard.press('/'); ok('on a computer «/» focuses the field', await pc.evaluate(() => document.activeElement?.classList.contains('ext-search-field')));
    await pc.evaluate(() => document.activeElement.blur()); await pc.keyboard.press('Control+f'); ok('… and Ctrl+F too', await pc.evaluate(() => document.activeElement?.classList.contains('ext-search-field')));
    await pc.fill('.ext-search-field', 'bulk'); await pc.waitForTimeout(500);
    const n = (await pc.$$('.ext-hit')).length; ok(`a long list (3,000) renders in batches, not all at once (${n} rows)`, n >= 40 && n <= 80);
    await pc.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('sources:repos'); tx.oncomplete = () => res(1); }; })); await pcx.close();
  } catch (e) { ok('ran to the end: ' + String(e.message).split('\n')[0], false); }
  ok('no page errors', !errors.length); if (errors.length) console.log(errors.slice(0, 3));
  await page.evaluate(() => new Promise((res) => { localStorage.removeItem('kr.ext.installed'); const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); tx.objectStore('meta').delete('sources:repos'); tx.oncomplete = () => res(1); }; })).catch(() => undefined);
  console.log(fails ? `${fails} failed` : 'all passed'); await browser.close(); server.close(); process.exit(fails ? 1 : 0);
})();
