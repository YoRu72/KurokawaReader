// Extension repositories end to end against tests/ext/server.cjs: a repo added from the "+" (and refused the
// second time), an LNReader plugin browsed (popular, latest, search, filters), a novel's page, reading it
// from the site (chapters arriving as scrolled), fetching it whole; a Mangayomi repo and extension (chapters
// listed newest-first on the site, read first-to-last here); the bell: a chapter added on the site found
// by the check, the mark on the book; a site behind a browser check named as such; a Shosetsu repo
// recognised and listed as not runnable. node tests/ext/flow.cjs
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const SITE = 'http://localhost:5403';
(async () => {
  await new Promise((r) => server.listen(5404, r));
  const mock = spawn('node', [path.join(__dirname, 'server.cjs'), '5403'], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en' }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404|503|ERR_|net::/.test(m.text())) errors.push(m.text()); });
  let fails = 0; const ok = (name, cond) => { console.log((cond ? 'ok  ' : 'FAIL'), name); if (!cond) fails++; };
  const base = 'http://localhost:5404/';
  const addRepo = async (url) => { await page.click('.sources-view .topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]'); await page.fill('.sheet input[type=url]', url); await page.click('.sheet .btn.primary'); await page.waitForTimeout(1500); };
  try {
    await page.goto(base); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.sources.autoCheck', 'off'); }); await page.reload(); await page.waitForSelector('.library-view');
    await page.goto(base + '#/sources'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    ok('hub shows no repo by default, only the +', !!(await page.$('.repos-empty')) && !(await page.$('.repo-section')) && !!(await page.$('.topbar-actions button[data-icon="plus"]')));
    // An LNReader repo, from its index.
    await addRepo(`${SITE}/repo/plugins.min.json`);
    // (A repository added opens its list, to pick extensions from it: both added here.)
    await page.waitForSelector('.ext-pick-list', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('the repo\'s list opens, with language chips for the two languages', (await page.$$('.ext-pick-row')).length === 2 && (await page.$$('.sheet .ext-langs .chip')).length === 3);
    for (const b of await page.$$('.ext-pick-row .btn.primary')) { await b.click(); await page.waitForTimeout(400); }
    ok('… both extensions added from it', (await page.$$('.ext-pick-row .btn.tonal')).length === 2);
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove())); await page.waitForTimeout(300);
    await page.evaluate(() => location.reload()); await page.waitForSelector('.repo-section', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('repo section appears with the extensions added as its children', (await page.$$('.repo-section .ext-card')).length === 2 && /LNReader/.test(await page.$eval('.repo-head', (e) => e.textContent)) && /2 of 2/.test(await page.$eval('.repo-head', (e) => e.textContent)));
    // The same repo again: refused.
    await addRepo(`${SITE}/repo/plugins.min.json`); await page.waitForTimeout(300);
    ok('the same repo is refused', /already/.test(await page.$eval('.sheet', (e) => e.textContent)) && (await page.$$('.repo-section')).length === 1);
    await page.click('.sheet .sheet-close, .sheet button:has-text("Close")').catch(() => page.keyboard.press('Escape')); await page.waitForTimeout(300);
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    // A Mangayomi repo, from its site address (the index found at the usual names) — and a Shosetsu one.
    await addRepo(`${SITE}/myrepo`); await page.waitForSelector('.ext-pick-list', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('Mangayomi repo recognised: its one runnable JS novel extension offered (the Dart one not)', (await page.$$('.ext-pick-row')).length === 1);
    for (const b of await page.$$('.ext-pick-row .btn.primary')) { await b.click(); await page.waitForTimeout(400); }
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove())); await page.evaluate(() => location.reload()); await page.waitForSelector('.repo-section', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('… added as the second repo\'s child', (await page.$$('.repo-section')).length === 2 && (await page.$$('.repo-section >> nth=1 >> .ext-card')).length === 1);
    await addRepo(`${SITE}/shosetsu/index.json`); await page.waitForTimeout(800);
    ok('Shosetsu repo recognised and not runnable', (await page.$$('.repo-section')).length === 3 && /Shosetsu/.test(await page.$eval('.repo-section >> nth=2 >> .repo-head', (e) => e.textContent)) && (await page.$$('.repo-section >> nth=2 >> .ext-card')).length === 0 && /cannot run|not run|run here/i.test(await page.$eval('.repo-section >> nth=2', (e) => e.textContent)));
    // One extension by the link to its code, no repository: a repo of its own, added at once.
    await page.click('.sources-view .topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet .add-kinds'); await page.click('.sheet .add-kinds button:nth-child(2)');
    await page.fill('.sheet input[type=url]', `${SITE}/repo/other.js`); await page.click('.sheet .btn.primary'); await page.waitForTimeout(1200);
    ok('an extension added by its own link stands as a repo of one, its card a child', (await page.$$('.repo-section')).length === 4 && /Other Site/.test(await page.$eval('.repo-section >> nth=3 >> .repo-head', (e) => e.textContent)) && (await page.$$('.repo-section >> nth=3 >> .ext-card')).length === 1 && /added by its link/.test(await page.$eval('.repo-section >> nth=3 >> .repo-head', (e) => e.textContent)));
    await page.click('.repo-section >> nth=3 >> .ext-card'); await page.waitForFunction(() => /Other Site/.test(document.querySelector('.topbar .title')?.textContent || ''), null, { timeout: 20000 }); await page.waitForTimeout(400);
    ok('… and it runs (its page opens)', /Other Site/.test(await page.$eval('.topbar .title', (e) => e.textContent)));
    await page.goto(base + '#/sources'); await page.waitForSelector('.repo-section'); await page.waitForTimeout(300);
    await page.$eval('.repo-section >> nth=3 >> .ext-card', (el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))); await page.waitForSelector('.sheet .dest-row.danger');
    page.once('dialog', (d) => d.accept()); await page.click('.sheet .dest-row.danger'); await page.waitForTimeout(600);
    ok('… removed from its menu, the repo of one with it', (await page.$$('.repo-section')).length === 3);
    await page.screenshot({ path: path.join(__dirname, 'hub.png') });
    // The LNReader plugin: popular, latest, search, filters.
    await page.click('.repo-section >> nth=0 >> .ext-card >> nth=0'); await page.waitForSelector('.src-grid .src-card', { timeout: 20000 }); await page.waitForTimeout(500);
    const popular = await page.$$eval('.src-grid .src-title', (els) => els.map((e) => e.textContent));
    ok('popular list, more pages loaded as scrolled', popular.length >= 3 && popular[0] === 'Alpha Ascension');
    ok('shelf chips popular/latest', (await page.$$('.src-shelves .chip')).length === 2);
    await page.click('.src-shelves .chip:has-text("Latest")'); await page.waitForTimeout(1200);
    ok('latest shelf reversed', (await page.$eval('.src-grid .src-title', (e) => e.textContent)) === 'Locked Legend');
    await page.fill('.src-search', 'beta'); await page.press('.src-search', 'Enter'); await page.waitForTimeout(1200);
    ok('search finds Beta', (await page.$$('.src-grid .src-card')).length === 1 && /Beta/.test(await page.$eval('.src-grid .src-title', (e) => e.textContent)));
    await page.click('.topbar-actions button[aria-label="Filters"]'); await page.waitForSelector('.sheet'); await page.waitForTimeout(200);
    ok('filter sheet shows the plugin filters', /Sort by/.test(await page.$eval('.sheet', (e) => e.textContent)) && /Genres/.test(await page.$eval('.sheet', (e) => e.textContent)));
    await page.click('.sheet .chip:has-text("Romance")'); await page.click('.sheet .btn.primary'); await page.waitForTimeout(1500);
    await page.evaluate(() => { location.hash = location.hash.replace(/\?.*$/, '').replace(/&v=.*$/, ''); }); await page.waitForTimeout(1200);
    ok('genre filter applied to the shelf', (await page.$$('.src-grid .src-card')).length === 1 && /Beta/.test(await page.$eval('.src-grid .src-title', (e) => e.textContent)));
    await page.screenshot({ path: path.join(__dirname, 'browse.png') });
    // Reset the filter, open Alpha.
    await page.evaluate(() => { for (const k of Object.keys(localStorage)) if (k.startsWith('kr.src.ext:')) localStorage.removeItem(k); });
    await page.goto(base + '#/sources'); await page.waitForSelector('.repo-section'); await page.click('.repo-section >> nth=0 >> .ext-card >> nth=0'); await page.waitForSelector('.src-grid .src-card', { timeout: 20000 }); await page.waitForTimeout(400);
    await page.click('.src-grid .src-card:has-text("Alpha")'); await page.waitForSelector('.src-details .src-chapters', { timeout: 20000 }); await page.waitForTimeout(300);
    const detail = await page.evaluate(() => ({ title: document.querySelector('.src-head h2').textContent, author: document.querySelector('.src-author-line')?.textContent, chapters: document.querySelectorAll('.novel-chapters li').length, tags: document.querySelectorAll('.src-tags .chip').length, first: document.querySelector('.novel-chapters li')?.textContent }));
    ok('novel page: title, author, 6 chapters, tags', detail.title === 'Alpha Ascension' && detail.author === 'A. Writer' && detail.chapters === 6 && detail.tags === 2 && /Chapter 1/.test(detail.first));
    await page.screenshot({ path: path.join(__dirname, 'novel.png') });
    // Read from the site.
    await page.click('.src-files .btn.primary'); await page.waitForSelector('.kr-webnovel', { timeout: 20000 }); await page.waitForTimeout(2500);
    const read = await page.evaluate(() => ({ chapters: document.querySelectorAll('.kr-webnovel .kr-novel-chapter').length, loaded: document.querySelectorAll('.kr-webnovel .kr-chap:not(.pending)').length, text: document.querySelector('.kr-webnovel .kr-chap:not(.pending)')?.textContent, ads: !!document.querySelector('.kr-webnovel .ads, .kr-webnovel script') }));
    ok('reading: chapters laid out, the first ones fetched, ads and scripts gone', read.chapters === 6 && read.loaded >= 2 && /Chapter 1 of Alpha/.test(read.text) && !read.ads);
    await page.screenshot({ path: path.join(__dirname, 'read.png') });
    // The book is in the library with the online mark.
    await page.goto(base + '#/'); await page.waitForSelector('.library-view'); await page.waitForTimeout(600);
    ok('library shows the novel as online', !!(await page.$('.book-card .badge.online, .card .badge.online, .badge.online')));
    // Fetch the whole novel.
    await page.goto(base + '#/sources'); await page.waitForSelector('.repo-section'); await page.click('.repo-section >> nth=0 >> .ext-card >> nth=0'); await page.waitForSelector('.src-grid .src-card', { timeout: 20000 }); await page.waitForTimeout(400);
    await page.click('.src-grid .src-card:has-text("Alpha")'); await page.waitForSelector('.src-files', { timeout: 20000 }); await page.waitForTimeout(300);
    ok('novel page knows the book is in the library', /In your library/.test(await page.$eval('.src-actions', (e) => e.textContent)));
    await page.click('.src-files .btn.tonal'); await page.waitForTimeout(4000);
    ok('whole novel fetched for offline', /reads offline/.test(await page.$eval('.src-actions', (e) => e.textContent)));
    // The novel saved as an EPUB file: the card, every chapter, the package naming it.
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.src-files button:has-text("Save as EPUB")')]);
    const JSZip = require(path.join(__dirname, '../../node_modules/jszip'));
    const z = await JSZip.loadAsync(fs.readFileSync(await dl.path()));
    const opf = await z.file('OEBPS/content.opf').async('string'); const xhtml = Object.keys(z.files).filter((n) => /^OEBPS\/ch\d+\.xhtml$/.test(n));
    ok('saved as an EPUB: the card and every chapter, the title and author in the package', dl.suggestedFilename() === 'Alpha Ascension.epub' && (await z.file('mimetype').async('string')) === 'application/epub+zip' && /<dc:title>Alpha Ascension<\/dc:title>/.test(opf) && /A\. Writer/.test(opf) && xhtml.length === 7 && /Chapter 1 of Alpha/.test(await z.file('OEBPS/ch2.xhtml').async('string')) && /<nav/.test(await z.file('OEBPS/nav.xhtml').async('string')));
    if (xhtml.length !== 7) console.log('  epub:', dl.suggestedFilename(), JSON.stringify(Object.keys(z.files)));
    // A chapter arrives on the site; the check finds it.
    await page.evaluate((site) => fetch(site + '/admin/add-chapter?slug=alpha').then((r) => r.json()), SITE);
    await page.goto(base + '#/sources'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    await page.click('.bell-btn'); await page.waitForSelector('.sheet'); await page.waitForTimeout(200);
    await page.click('.sheet button:has-text("Check now")'); await page.waitForTimeout(3500);
    const sheet = await page.$eval('.sheet', (e) => e.textContent);
    ok('check finds the new chapter', /New chapters/.test(sheet) && /Alpha Ascension/.test(sheet));
    ok('bell carries the count', (await page.$eval('.bell-btn .count', (e) => e.textContent).catch(() => '')) === '1');
    await page.screenshot({ path: path.join(__dirname, 'bell.png') });
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    await page.goto(base + '#/'); await page.waitForSelector('.library-view'); await page.waitForTimeout(600);
    ok('library marks the book with (!) and the count', (await page.$eval('.badge.alert', (e) => e.textContent).catch(() => '')) === '!1');
    await page.screenshot({ path: path.join(__dirname, 'library.png') });
    // Opening the book clears the mark and shows the new chapter.
    await page.click('.badge.alert'); await page.waitForSelector('.kr-webnovel', { timeout: 20000 }); await page.waitForTimeout(800);
    ok('the new chapter is in the book', (await page.$$('.kr-webnovel .kr-novel-chapter')).length === 7);
    await page.goto(base + '#/'); await page.waitForSelector('.library-view'); await page.waitForTimeout(600);
    ok('mark gone once opened', !(await page.$('.badge.alert')));
    // The Mangayomi extension.
    await page.goto(base + '#/sources'); await page.waitForSelector('.repo-section'); await page.click('.repo-section >> nth=1 >> .ext-card:not(.off)'); await page.waitForSelector('.src-grid .src-card', { timeout: 20000 }); await page.waitForTimeout(400);
    ok('Mangayomi extension browses popular', (await page.$$('.src-grid .src-card')).length >= 3);
    await page.click('.topbar-actions button[aria-label="Filters"]'); await page.waitForSelector('.sheet'); await page.waitForTimeout(200);
    ok('Mangayomi filters shown', /Status/.test(await page.$eval('.sheet', (e) => e.textContent)));
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    await page.click('.src-grid .src-card:has-text("Beta")'); await page.waitForSelector('.src-details .src-chapters', { timeout: 20000 }); await page.waitForTimeout(300);
    const my = await page.evaluate(() => ({ chapters: document.querySelectorAll('.novel-chapters li').length, first: document.querySelector('.novel-chapters li')?.textContent, status: document.querySelector('.src-chips')?.textContent }));
    ok('Mangayomi novel: chapters in reading order, status', my.chapters === 4 && /Chapter 1/.test(my.first) && /Completed/.test(my.status));
    // Chapters picked (a long press), the ones between added, fetched for offline: marked afterwards.
    await page.dispatchEvent('.novel-chapters li:nth-child(2) button', 'contextmenu'); await page.waitForTimeout(150);
    await page.dispatchEvent('.novel-chapters li:nth-child(4) button', 'contextmenu'); await page.waitForTimeout(150);
    const picked2 = (await page.$$('.novel-chapters button.on')).length;
    await page.click('.chapter-sel button[title="Select the chapters between"]'); await page.waitForTimeout(150);
    const picked3 = (await page.$$('.novel-chapters button.on')).length;
    await page.click('.chapter-sel .btn.primary'); await page.waitForTimeout(3000);
    const haveN = (await page.$$('.novel-chapters button.have')).length;
    ok('chapters picked by a long press, the ones between added, and fetched for offline', picked2 === 2 && picked3 === 3 && haveN === 3 && !(await page.$$('.chapter-sel:not([hidden])')).length);
    if (!(picked2 === 2 && picked3 === 3 && haveN === 3)) console.log('  picked:', picked2, picked3, haveN);
    // The offline copy of one of them let go: its mark gone, the others kept.
    await page.dispatchEvent('.novel-chapters li:nth-child(3) button', 'contextmenu'); await page.waitForTimeout(150);
    await page.click('.chapter-sel button[title="Remove the offline copies"]'); await page.waitForTimeout(1200);
    ok('the offline copy of a picked chapter removed, the others kept', (await page.$$('.novel-chapters button.have')).length === 2 && !(await page.$('.novel-chapters li:nth-child(3) button.have')));
    await page.click('.src-files .btn.primary'); await page.waitForSelector('.kr-webnovel', { timeout: 20000 }); await page.waitForTimeout(2500);
    ok('Mangayomi chapter text read', /Chapter 1 of Beta/.test(await page.$eval('.kr-webnovel .kr-chap:not(.pending)', (e) => e.textContent).catch(() => '')));
    // Extension settings sheet.
    await page.goto(base + '#/sources'); await page.waitForSelector('.repo-section'); await page.click('.repo-section >> nth=1 >> .ext-card:not(.off)'); await page.waitForSelector('.src-grid .src-card', { timeout: 20000 });
    await page.click('.topbar-actions button[aria-label="Extension settings"]'); await page.waitForSelector('.sheet'); await page.waitForTimeout(200);
    ok('extension settings list the site address', /Site address/.test(await page.$eval('.sheet', (e) => e.textContent)));
    await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
    // A site behind a browser check.
    await page.goto(base + '#/sources'); await page.waitForSelector('.repo-section'); await page.click('.repo-section >> nth=0 >> .ext-card >> nth=0'); await page.waitForSelector('.src-grid .src-card', { timeout: 20000 });
    await page.click('.src-shelves .chip:has-text("Latest")'); await page.waitForTimeout(1200);
    await page.click('.src-grid .src-card:has-text("Locked")'); await page.waitForTimeout(2500);
    ok('browser check named, with the way through', /make sure you’re a person/.test(await page.$eval('.src-details', (e) => e.textContent)) && /Confirm I’m human/.test(await page.$eval('.src-details .btn.primary', (e) => e.textContent)));
    // Removing a repo.
    await page.goto(base + '#/sources'); await page.waitForSelector('.repo-section');
    page.once('dialog', (d) => d.accept());
    await page.click('.repo-section >> nth=2 >> .repo-head button[data-icon="more"]'); await page.waitForSelector('.sheet'); await page.click('.sheet .btn.danger'); await page.waitForTimeout(600);
    ok('repo removed', (await page.$$('.repo-section')).length === 2);
  } finally { console.log(`\n${fails ? fails + ' failed' : 'all passed'}; errors`, errors); await browser.close(); server.close(); mock.kill(); }
})();
