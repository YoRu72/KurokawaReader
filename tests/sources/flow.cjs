// The sources, end to end against tests/sources/server.cjs: the hub; archive.org browsed (shelf, search, tag,
// filter), a book's page and a file fetched into the library; Shamela's categories, a category's list, a
// book's page with its contents, reading it online (pages arriving as scrolled), fetching it whole, the
// catalogue of titles and a title search; a work in parts fetched merged and as a series; the format marks;
// the whole library as a shelf; a page split at the chapters starting on it; the back button returning to
// the view a book was opened from. node tests/sources/flow.cjs <dir with alice-in-wonderland.epub>
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const DIST = path.resolve(__dirname, '../../dist'); const BOOKS = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
(async () => {
  await new Promise((r) => server.listen(5402, r));
  const mock = spawn('node', [path.join(__dirname, 'server.cjs'), '5401', BOOKS], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 600));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en' }); const page = await ctx.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(String(e))); page.on('console', (m) => { if (m.type() === 'error' && !/favicon|404/.test(m.text())) errors.push(m.text()); });
  const ok = (name, cond) => console.log((cond ? 'ok  ' : 'FAIL'), name);
  const base = 'http://localhost:5402/';
  try {
    await page.goto(base); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.shamela.base', 'http://localhost:5401'); localStorage.setItem('kr.archive.base', 'http://localhost:5401'); }); await page.reload(); await page.waitForSelector('.library-view');
    // The hub, from the settings.
    await page.goto(base + '#/settings'); await page.waitForSelector('.settings-view, .view');
    // (A couple of sections opened on the way down, so the Sources button sits below the first screen.)
    for (const name of ['Appearance', 'Reader']) await page.click(`section.card h3:has-text("${name}")`).catch(() => undefined);
    await page.click('section.card h3:has-text("Sources")'); await page.waitForTimeout(300);
    await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => /Sources: Internet Archive/.test(x.textContent || '')); b.scrollIntoView({ block: 'center' }); }); await page.waitForTimeout(300);
    ok('the settings scrolled to the Sources section', await page.evaluate(() => document.querySelector('.settings-body').scrollTop > 200));
    await page.click('button:has-text("Sources: Internet Archive")'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    ok('hub lists both sources', (await page.$$('.source-card')).length === 2);
    // Back from the sources: the settings as they were left — the Sources section open, scrolled where it was.
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForSelector('.settings-body', { timeout: 15000 }); await page.waitForTimeout(600);
    const settingsBack = await page.evaluate(() => { const card = [...document.querySelectorAll('section.card')].find((c) => /Sources/.test(c.querySelector('h3')?.textContent || '')); const r = card?.querySelector('button')?.getBoundingClientRect(); return { hash: location.hash, open: card && !card.classList.contains('collapsed'), visible: !!r && r.top >= 0 && r.bottom <= window.innerHeight }; });
    ok('back from the sources: the settings, the Sources section still open and in view', settingsBack.hash === '#/settings' && settingsBack.open && settingsBack.visible);
    if (!(settingsBack.hash === '#/settings' && settingsBack.open && settingsBack.visible)) console.log('  settings:', JSON.stringify(settingsBack));
    await page.click('button:has-text("Sources: Internet Archive")'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(__dirname, 'hub.png') });
    // archive.org: the default shelf.
    await page.click('.source-card >> nth=0 >> .source-head'); await page.waitForSelector('.src-grid .src-card', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('archive shelf shows books (lending-only left out)', (await page.$$('.src-grid .src-card')).length === 4);
    ok('tags offered from results', (await page.$$('.src-tags .chip')).length >= 1);
    // The format marks: EPUB where it is, "EPUB (not available)" in red where it is not, the other formats after.
    const marks = await page.evaluate(() => [...document.querySelectorAll('.src-card')].map((c) => [...c.querySelectorAll('.src-fmt')].map((m) => (m.classList.contains('missing') ? '-' : '+') + m.textContent).join(' ')));
    ok('cards mark the formats (EPUB present or not available, in red)', marks.length === 4 && marks.filter((m) => /^\+EPUB \+PDF$/.test(m)).length === 1 && marks.filter((m) => /^-EPUB \(not available\) \+PDF$/.test(m)).length === 2 && marks.includes('+EPUB'));
    if (marks.length !== 4) console.log('  marks:', JSON.stringify(marks));
    await page.screenshot({ path: path.join(__dirname, 'archive.png') });
    // A tag narrows.
    await page.click('.src-tags .chip:has-text("Fantasy")'); await page.waitForTimeout(800);
    ok('tag narrows to two', (await page.$$('.src-grid .src-card')).length === 2);
    // Search.
    await page.fill('.src-search', 'Adab'); await page.press('.src-search', 'Enter'); await page.waitForTimeout(800);
    ok('search finds the Arabic book', await page.evaluate(() => /مقامات/.test(document.querySelector('.src-grid')?.textContent || '')));
    // The book: files, fetch.
    await page.click('.src-grid .src-card'); await page.waitForSelector('.src-files .src-file', { timeout: 15000 });
    ok('details show an EPUB file', await page.evaluate(() => /EPUB/.test(document.querySelector('.src-files')?.textContent || '')));
    await page.click('.src-files .src-file'); await page.waitForSelector('.src-files .btn.primary', { timeout: 60000 });
    ok('file fetched into the library', true);
    // A work in three volumes: the parts together, with their real sizes; the derivatives left out.
    await page.goto(base + '#/sources/archive/book/history-parts-test'); await page.waitForSelector('.src-parts', { timeout: 15000 }); await page.waitForTimeout(300);
    const partsHead = await page.$eval('.src-parts-head', (e) => e.textContent);
    ok('parts offered together with the real total size', /3 parts/.test(partsHead) && /\d KB/.test(partsHead) && (await page.$$('.src-parts')).length === 1 && !(await page.$('.src-actions > .src-files > .src-file')));
    if (!/3 parts/.test(partsHead) || !/\d KB/.test(partsHead)) console.log('  parts head:', partsHead);
    ok('book page marks EPUB not available, PDF present', await page.evaluate(() => { const m = [...document.querySelectorAll('.src-actions .src-fmt')].map((x) => x.className.replace('src-fmt ', '') + ':' + x.textContent); return m.join(' ') === 'missing:EPUB (not available) ok:PDF'; }));
    await page.click('.src-parts-toggle'); await page.waitForTimeout(200);
    ok('each part on its own, with its size', (await page.$$('.src-part-list .src-file:visible')).length === 3 && /KB/.test(await page.$eval('.src-part-list .src-file small', (e) => e.textContent)));
    await page.screenshot({ path: path.join(__dirname, 'archive-parts.png') });
    await page.click('.src-parts button:has-text("separate books")'); await page.waitForSelector('.src-parts .btn.primary', { timeout: 60000 });
    ok('fetched as separate books', /separate books/.test(await page.$eval('.src-parts .btn.primary', (e) => e.textContent)));
    await page.click('.src-parts button:has-text("merged")'); await page.waitForFunction(() => document.querySelectorAll('.src-parts .btn.primary').length === 2, null, { timeout: 60000 });
    await page.click('.src-parts .btn.primary:has-text("merged")'); await page.waitForSelector('.pdf-page canvas', { timeout: 60000 }); await page.waitForTimeout(500);
    ok('merged into one PDF of every volume\'s pages', (await page.$$('.pdf-page')).length === 6);
    await page.goto(base + '#/'); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
    const titles = await page.$$eval('.book-card', (cards) => cards.map((c) => c.textContent));
    ok('the library holds the EPUB, the three volumes and the merged book', titles.length === 5 && titles.filter((x) => /History of Everything/.test(x)).length === 4);
    if (titles.length !== 5) console.log('  titles:', JSON.stringify(titles));
    // Shamela: categories as shelves.
    await page.goto(base + '#/sources/shamela'); await page.waitForSelector('.src-shelves .chip', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('shamela categories as shelves', (await page.$$('.src-shelves .chip')).length >= 3);
    // "All": the whole library, category after category.
    await page.waitForSelector('.src-grid .src-card', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('the All shelf shows the books of every category', (await page.$$('.src-grid .src-card')).length >= 4 && (await page.$eval('.src-shelves .chip', (e) => e.classList.contains('on'))));
    await page.click('.src-shelves .chip >> nth=1'); await page.waitForFunction(() => document.querySelectorAll('.src-grid .src-card').length === 2 && document.querySelectorAll('.src-shelves .chip')[1].classList.contains('on'), null, { timeout: 15000 });
    ok('a category lists its books', (await page.$$('.src-grid .src-card')).length === 2);
    await page.screenshot({ path: path.join(__dirname, 'shamela.png') });
    // A book's page: contents, read online.
    await page.click('.src-grid .src-card >> nth=1'); await page.waitForSelector('.src-chapters li', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('book page shows the contents', (await page.$$('.src-chapters li')).length >= 5);
    ok('book page shows pages and card', await page.evaluate(() => /pages/.test(document.querySelector('.src-chips')?.textContent || '') && /الناشر/.test(document.querySelector('.src-meta')?.textContent || '')));
    await page.screenshot({ path: path.join(__dirname, 'shamela-book.png') });
    await page.click('.src-files .btn.primary'); await page.waitForSelector('.reader-scroll .kr-shamela', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.kr-shamela .kr-page:not(.pending)').length >= 2 && !!document.querySelector('.kr-shamela .kr-page[data-page="1"]:not(.pending) .kr-page-body'), null, { timeout: 20000 });
    const shown = await page.evaluate(() => ({ pages: document.querySelectorAll('.kr-shamela .kr-page').length, loaded: document.querySelectorAll('.kr-shamela .kr-page:not(.pending)').length, first: document.querySelector('.kr-shamela .kr-page[data-page="1"]:not(.pending) .kr-page-body')?.textContent?.slice(0, 40) }));
    ok('reads online: pages arrive as scrolled', shown.pages >= 92 && shown.loaded >= 2 && /بِسم الله|بَيَان/.test(shown.first || ''));
    if (!(shown.pages >= 92 && shown.loaded >= 2)) console.log('  shown:', JSON.stringify(shown));
    await page.screenshot({ path: path.join(__dirname, 'shamela-read.png') });
    // Scroll on: more pages load.
    // Reading on — the next chapters, one after another (the reader shows a chapter at a time), or scrolled to
    // the first page not here yet when it shows the whole book: the pages come as they are reached.
    const loadedNow = await page.evaluate(() => document.querySelectorAll('.kr-shamela .kr-page:not(.pending)').length);
    let more = false;
    for (let i = 0; i < 6 && !more; i++) {
      const moved = await page.evaluate(() => { const next = document.querySelector('.cn-btn.primary'); if (next) { next.click(); return 'chapter'; } const sc = document.querySelector('.reader-scroll'); const p = document.querySelector('.kr-shamela .kr-page.pending'); if (p && p.getClientRects().length) { sc.scrollTop = p.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop - 200; return 'scroll'; } return ''; });
      if (!moved) break;
      more = await page.waitForFunction((n) => document.querySelectorAll('.kr-shamela .kr-page:not(.pending)').length > n, loadedNow, { timeout: 4000 }).then(() => true, () => false);
    }
    ok('more pages as the book is read on', more);
    // The library shows it as online; back to the source page and fetch whole.
    await page.goto(base + '#/'); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
    ok('library badge: online book', !!(await page.$('.book-card .badge.online')));
    await page.goto(base + '#/sources/shamela/book/6388'); await page.waitForSelector('.src-files', { timeout: 15000 }); await page.waitForTimeout(500);
    await page.click('.src-files button:has-text("Fetch")'); await page.waitForFunction(() => /reads offline/.test(document.querySelector('.src-files')?.textContent || ''), null, { timeout: 120000 });
    ok('fetched whole for offline', true);
    await page.goto(base + '#/'); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
    ok('library badge gone once offline', !(await page.$('.book-card .badge.online')));
    // The catalogue of titles, and a title search without a sign-in.
    await page.goto(base + '#/sources'); await page.waitForSelector('.source-status button', { timeout: 15000 });
    await page.click('.source-status button:has-text("Fetch")'); await page.waitForFunction(() => /titles, fetched/.test(document.querySelector('.source-status')?.textContent || ''), null, { timeout: 60000 });
    ok('catalogue fetched', true);
    await page.goto(base + '#/sources/shamela?q=' + encodeURIComponent('الفقه')); await page.waitForSelector('.src-grid .src-card', { timeout: 15000 });
    ok('title search over the catalogue', (await page.$$('.src-grid .src-card')).length >= 1);
    // Text search asks for the sign-in.
    await page.evaluate(() => localStorage.setItem('kr.src.shamela.filters', JSON.stringify({ mode: 'texts' })));
    await page.goto(base + '#/sources/shamela?q=' + encodeURIComponent('الذكر') + '&v=1'); await page.waitForTimeout(1200);
    ok('text search on the site, no account: hits with the page and a snippet', (await page.$$('.src-grid .src-card')).length >= 3 && /ص 5/.test(await page.$eval('.src-grid .src-card', (e) => e.textContent)) && /نتيجة/.test(await page.$eval('.title', (e) => e.textContent)));
    await page.evaluate(() => { document.querySelector('.src-body').scrollTop = 99999; window.scrollTo(0, 99999); }); await page.waitForTimeout(1200);
    ok('every page of hits (the short pages ask for the next)', (await page.$$('.src-grid .src-card')).length === 4);
    // Chapter titles need وصلة الشاملة: a sign-in note, not an error.
    await page.evaluate(() => localStorage.setItem('kr.src.shamela.filters', JSON.stringify({ mode: 'chapters' })));
    await page.goto(base + '#/sources/shamela?q=الإيمان&v=2'); await page.waitForTimeout(1500);
    ok('chapter-title search asks to sign in', await page.evaluate(() => /sign in/i.test(document.querySelector('.src-status')?.textContent || '')));
    // Searching inside a book, on the site.
    await page.goto(base + '#/sources/shamela/book/6388'); await page.waitForSelector('.src-book-search input', { timeout: 15000 }); await page.waitForTimeout(400);
    await page.fill('.src-book-search input', 'الإيمان'); await page.press('.src-book-search input', 'Enter'); await page.waitForTimeout(1500);
    ok('in-book search on the site finds the pages', (await page.$$('.src-hits .src-hit')).length === 2 && /mark/.test(await page.$eval('.src-hits', (e) => e.innerHTML)));
    // A page two chapters start on is cut at their titles, each piece in its chapter.
    await page.goto(base + '#/sources/shamela/book/23635'); await page.waitForSelector('.src-files .btn.primary', { timeout: 15000 }); await page.waitForTimeout(300);
    await page.click('.src-files .btn.primary'); await page.waitForSelector('.reader-scroll .kr-shamela', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.kr-shamela .kr-page[data-page="3"]:not(.pending) .kr-page-body').length >= 3, null, { timeout: 20000 });
    const split = await page.evaluate(() => [...document.querySelectorAll('.kr-shamela .kr-page[data-page="3"]')].map((p) => ({ part: p.dataset.part, hidden: p.hidden, head: (p.previousElementSibling?.matches('h3') ? p.previousElementSibling.textContent : '') , text: p.querySelector('.kr-page-body')?.textContent?.slice(0, 14) })));
    ok('a page with two chapters starting on it is cut at their titles', split.length === 3 && split.every((p) => !p.hidden) && /^بقية الكلام/.test(split[0].text) && split[1].head === 'تفسير البسملة' && /^تفسير البسملة/.test(split[1].text) && split[2].head === 'نعم الله تعالى التي لا تحصى' && /^نعم الله/.test(split[2].text));
    if (split.length !== 3) console.log('  split:', JSON.stringify(split));
    ok('the page mark once, on the first piece', (await page.$$('.kr-shamela .kr-page[data-page="3"] .kr-page-mark')).length === 1);
    // The contents reach the pieces: the entry of the second chapter on the page jumps to its own piece.
    ok('contents entries point at the chapter pieces', await page.evaluate(() => { const h3 = [...document.querySelectorAll('.kr-shamela h3')].find((x) => x.textContent === 'نعم الله تعالى التي لا تحصى'); return !!h3 && !!h3.id && h3.nextElementSibling?.dataset.part === '2'; }));
    // Back: the reader returns to the book's page, the page to the shelf, the shelf to the hub — not the library.
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForTimeout(600);
    ok('back from the reader: the book\'s page', (await page.evaluate(() => location.hash)) === '#/sources/shamela/book/23635');
    // (A fresh start on the shelf, as when the app opens on it.)
    await page.goto(base + '#/sources/shamela'); await page.reload(); await page.waitForSelector('.src-grid .src-card', { timeout: 15000 }); await page.waitForTimeout(300);
    await page.click('.src-grid .src-card'); await page.waitForSelector('.src-files .btn.primary', { timeout: 15000 }); await page.waitForTimeout(300);
    const bookHash = await page.evaluate(() => location.hash);
    await page.click('.src-files .btn.primary'); await page.waitForSelector('.reader-scroll .kr-shamela', { timeout: 20000 }); await page.waitForTimeout(500);
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForTimeout(600);
    ok('shelf → book → reader → back: the book', (await page.evaluate(() => location.hash)) === bookHash && !!(await page.$('.src-files .btn.primary')));
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForTimeout(600);
    ok('… → back: the shelf, as it was', (await page.evaluate(() => location.hash)) === '#/sources/shamela' && (await page.$$('.src-grid .src-card')).length >= 4);
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForTimeout(600);
    ok('… → back: the hub', (await page.evaluate(() => location.hash)) === '#/sources' && !!(await page.$('.sources-hub')));
    // The same for a book of the library (the EPUB fetched above opens on its page): library → page → reader → back → page → back → library.
    await page.goto(base + '#/'); await page.reload(); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
    await page.click('.book-card:has-text("مقامات")'); await page.waitForSelector('.fab.book-resume', { timeout: 15000 }); await page.waitForTimeout(300);
    const epubPage = await page.evaluate(() => location.hash);
    await page.click('.fab.book-resume'); await page.waitForSelector('.reader-scroll, .reader-view', { timeout: 20000 }); await page.waitForTimeout(1500);
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForTimeout(600);
    ok('EPUB: back from the reader is the book\'s page', (await page.evaluate(() => location.hash)) === epubPage && /^#\/book\//.test(epubPage) && !!(await page.$('.fab.book-resume')));
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForTimeout(600);
    ok('EPUB: back from the page is the library', ['#/', '', '#'].includes(await page.evaluate(() => location.hash)) && !!(await page.$('.library-view')));
    // A web folder, added by its address from the + sheet: its listing read (Apache's table), browsed, searched, fetched from.
    await page.goto(base + '#/sources'); await page.reload(); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    await page.click('.topbar-actions button[aria-label="Add a repository"], .topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]');
    await page.fill('.sheet input[type=url]', 'http://localhost:5401/library'); await page.press('.sheet input[type=url]', 'Enter');
    await page.waitForSelector('.folder-card', { timeout: 20000 }); await page.waitForTimeout(400);
    ok('a web folder added by its address (sent to its slash, read as a listing)', /library/.test(await page.$eval('.folder-card b', (e) => e.textContent)) && /localhost:5401\/library/.test(await page.$eval('.folder-card small', (e) => e.textContent)));
    await page.click('.folder-card .source-head'); await page.waitForSelector('.src-grid .src-card', { timeout: 15000 }); await page.waitForTimeout(400);
    const dirId = (await page.evaluate(() => location.hash)).replace(/^#\/sources\//, '').replace(/[?].*$/, '');
    const plain = (x) => (x || '').replace(/[⁦-⁩]/g, '').trim();
    // The root (Apache's table): the folder's own books as a series' card and its rows, the subfolders as cards.
    const root = await page.evaluate(() => ({ head: document.querySelector('.series-head h2')?.textContent, chips: [...document.querySelectorAll('.series-head .src-chip')].map((c) => c.textContent), folders: [...document.querySelectorAll('.src-card.folder .src-title')].map((e) => e.textContent), rows: [...document.querySelectorAll('.vol-row')].map((r) => `${r.querySelector('.vol-title')?.textContent}|${r.querySelector('.vol-sub')?.textContent}`) }));
    ok('the root: its two books as a series with their rows, its two folders as cards (pictures and archives left out)', root.head === 'library' && root.chips[0] === '2 volumes' && root.folders.join() === 'Alpha Series,Beta' && root.rows.length === 2 && /^readme\|.*1\.5 KB/.test(plain(root.rows[0])) && /^sample\|.*1\.2 MB/.test(plain(root.rows[1])));
    if (root.rows.length !== 2 || root.head !== 'library') console.log('  root:', JSON.stringify(root));
    await page.screenshot({ path: path.join(__dirname, 'folder.png') });
    // Into a subfolder (nginx's <pre> listing): a series' page, every volume with its size, its cover and contents read from the file by range.
    await page.click('.src-card.folder >> nth=0'); await page.waitForFunction(() => /Alpha Series/.test(document.querySelector('.topbar .title')?.textContent || ''), null, { timeout: 15000 });
    await page.waitForFunction(() => document.querySelectorAll('.vol-row .vol-cover img').length === 2 && document.querySelectorAll('.vol-row .vol-toc').length === 2, null, { timeout: 30000 });
    const sub = await page.evaluate(() => ({ head: document.querySelector('.series-head h2')?.textContent, cover: (document.querySelector('.series-head .series-cover img')?.getAttribute('src') || '').slice(0, 15), rows: [...document.querySelectorAll('.vol-row')].map((r) => ({ title: r.querySelector('.vol-title')?.textContent, sub: r.querySelector('.vol-sub')?.textContent, cover: (r.querySelector('.vol-cover img')?.getAttribute('src') || '').slice(0, 15), toc: r.querySelectorAll('.vol-toc-list li').length, more: r.querySelector('.vol-toc-more')?.textContent, meta: r.querySelector('.vol-meta')?.textContent })) }));
    ok('a subfolder: the series card, its volumes in order with their sizes (the zip left out)', sub.head === 'Alpha Series' && sub.rows.length === 2 && sub.rows[0].title === 'Alpha 1' && /200 KB/.test(plain(sub.rows[0].sub)) && sub.rows[1].title === 'Alpha 2' && /311 KB/.test(plain(sub.rows[1].sub)));
    ok('every volume\'s cover and contents, read from the file without fetching it', sub.rows.every((r) => r.cover === 'data:image/jpeg' && r.toc >= 3) && /Show all/.test(sub.rows[0].more || '') && /Lewis Carroll/.test(sub.rows[0].meta || '') && sub.cover === 'data:image/jpeg');
    if (!sub.rows.every((r) => r.cover === 'data:image/jpeg' && r.toc >= 3)) console.log('  sub:', JSON.stringify(sub));
    const got = await (await fetch('http://localhost:5401/__otl/ranges')).json();
    ok('… by ranges of the files (never a whole volume)', got.some((r) => /^alice-in-wonderland\.epub \d+-\d+$/.test(r)) && got.every((r) => { const [a, b] = r.split(' ')[1].split('-').map(Number); return b - a < 1024 * 1024; }));
    await page.screenshot({ path: path.join(__dirname, 'folder-series.png') });
    // Back: the root folder, then the hub.
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForTimeout(600);
    ok('back from a subfolder: the folder above', (await page.evaluate(() => location.hash)) === `#/sources/${dirId}` && (await page.$$('.src-card.folder')).length === 2);
    // A search walks the folders (the Python <ul> one and the JSON one too): names matched with their folder's.
    await page.goto(base + `#/sources/${dirId}?q=` + encodeURIComponent('alpha 2')); await page.waitForSelector('.vol-row', { timeout: 20000 }); await page.waitForTimeout(400);
    ok('a search finds a volume by its folder and name', (await page.$$('.vol-row')).length === 1 && (await page.$$('.src-card')).length === 0 && /Alpha 2/.test(await page.$eval('.vol-row .vol-title', (e) => e.textContent)) && /Alpha Series/.test(await page.$eval('.vol-row .vol-sub', (e) => e.textContent)) && /1 found/.test(await page.$eval('.topbar .title', (e) => e.textContent)));
    await page.goto(base + `#/sources/${dirId}?q=deep`); await page.waitForSelector('.vol-row', { timeout: 20000 }); await page.waitForTimeout(400);
    ok('… down to a JSON listing: the folder and the file named so', (await page.$$('.src-card.folder')).length === 1 && (await page.$$('.vol-row')).length === 1 && /^deep$/.test(await page.$eval('.vol-row .vol-title', (e) => e.textContent)) && /Beta \/ Deep · 5\.9 KB/.test(plain(await page.$eval('.vol-row .vol-sub', (e) => e.textContent))));
    // A file's page (from its cover): the PDF's first page as its cover, read by range; the file with its size.
    await page.click('.vol-row .vol-cover'); await page.waitForSelector('.src-files .src-file', { timeout: 30000 }); await page.waitForTimeout(300);
    ok('a file\'s page: its kind marked, its size, its folder, its first page as the cover', await page.evaluate(() => /ok:PDF/.test([...document.querySelectorAll('.src-actions .src-fmt')].map((x) => x.className.replace('src-fmt ', '') + ':' + x.textContent).join(' ')) && /5\.9 KB/.test(document.querySelector('.src-files .src-file')?.textContent || '') && /deep\.pdf/.test(document.querySelector('.src-meta')?.textContent || '') && /^data:image\/jpeg/.test(document.querySelector('.src-cover img')?.getAttribute('src') || '')));
    await page.click('.src-files .src-file'); await page.waitForSelector('.src-files .btn.primary', { timeout: 60000 });
    await page.reload(); await page.waitForSelector('.src-files', { timeout: 30000 }); await page.waitForTimeout(800);
    ok('… once fetched, its page opens it from the library', /In your library/.test(await page.$eval('.src-files', (e) => e.textContent)));
    // The series' button: every volume not yet in the library, into a folder of the library named after it.
    await page.goto(base + `#/sources/${dirId}?shelf=Alpha%2520Series`); await page.waitForSelector('.series-head button', { timeout: 15000 }); await page.waitForTimeout(300);
    ok('the series offers all its volumes', /Download all 2 volumes/.test(await page.$eval('.series-head button', (e) => e.textContent)));
    await page.click('.series-head button'); await page.waitForFunction(() => /All in the library/.test(document.querySelector('.series-head button')?.textContent || ''), null, { timeout: 60000 });
    ok('… fetched: every row opens its book now', (await page.$$('.vol-row .vol-actions .btn.primary')).length === 2);
    await page.goto(base + '#/'); await page.reload(); await page.waitForSelector('.book-card'); await page.waitForTimeout(400);
    const lib = await page.$$eval('.book-card .bt', (es) => es.map((e) => e.textContent));
    const chips = await page.$$eval('.folder-chips .chip', (es) => es.map((e) => e.textContent));
    ok('the library holds the PDF (by its own title); the volumes are in a folder named after the series', lib.includes('Sample Report') && chips.some((c) => /Alpha Series/.test(c)));
    if (!chips.some((c) => /Alpha Series/.test(c)) || !lib.includes('Sample Report')) console.log('  library:', JSON.stringify({ lib, chips }));
    await page.click('.folder-chips .chip:has-text("Alpha Series")'); await page.waitForTimeout(500);
    ok('… the folder holds the two volumes', (await page.$$('.book-card')).length === 2);
    // The folder's address given a second time is refused as already added.
    await page.goto(base + '#/sources'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    await page.click('.topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]');
    await page.fill('.sheet input[type=url]', 'http://localhost:5401/library/'); await page.press('.sheet input[type=url]', 'Enter'); await page.waitForTimeout(1500);
    ok('the same folder again is refused', /already/i.test(await page.$eval('.sheet .hint', (e) => e.textContent)) && (await page.$$('.folder-card')).length === 1);
    // The hidden word: "OTL" in the + sheet adds server.elscione.com's folder (an h5ai server, here the mock).
    await ctx.route('https://server.elscione.com/**', async (route) => {
      const req = route.request(); const u = new URL(req.url());
      if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
      return route.fulfill({ response: await route.fetch({ url: 'http://localhost:5401' + u.pathname + u.search }) });
    });
    await page.keyboard.press('Escape'); await page.goto(base + '#/sources'); await page.reload(); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    ok('nothing hints at the word', !/OTL|elscione/i.test(await page.evaluate(() => document.body.textContent)));
    await page.click('.topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]');
    ok('… not in the add sheet either', !/OTL|elscione/i.test(await page.$eval('.sheet', (e) => e.textContent)));
    await page.fill('.sheet input[type=url]', 'OTL'); await page.press('.sheet input[type=url]', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.folder-card').length === 2, null, { timeout: 20000 }); await page.waitForTimeout(300);
    const otl = await page.$$eval('.folder-card', (cs) => cs.map((c) => `${c.querySelector('b')?.textContent}|${c.querySelector('small')?.textContent}`));
    ok('"OTL" adds the Officially Translated Light Novels folder', otl.some((x) => x === 'Officially Translated Light Novels|server.elscione.com/Officially Translated Light Novels'));
    await page.click('.folder-card:has-text("Officially Translated") .source-head'); await page.waitForSelector('.src-card.folder', { timeout: 20000 });
    await page.waitForFunction(() => document.querySelectorAll('.src-card.folder .src-cover.has-img img').length === 3 && document.querySelectorAll('.src-card.folder .src-badge').length === 3, null, { timeout: 40000 });
    const series = await page.$$eval('.src-card.folder', (cs) => cs.map((c) => `${c.querySelector('.src-title')?.textContent}|${c.querySelector('.src-badge')?.textContent}`));
    ok('its series as a shelf of covers — each its first volume\'s (or its own picture) — with how many volumes', series.join() === 'Alpha Saga|4 volumes,Beta Tales|1 volume,Gamma Chronicles|2 volumes');
    if (series.join() !== 'Alpha Saga|4 volumes,Beta Tales|1 volume,Gamma Chronicles|2 volumes') console.log('  series:', JSON.stringify(series));
    const posted = await (await fetch('http://localhost:5401/__otl/posts')).json();
    ok('a folder h5ai draws by script is listed through h5ai\'s API', posted.some((b) => /"action":"get"/.test(b) && /Gamma%20Chronicles/.test(b)));
    await page.screenshot({ path: path.join(__dirname, 'otl.png') });
    await page.click('.src-card.folder:has-text("Alpha Saga")'); await page.waitForSelector('.series-head', { timeout: 20000 });
    // (Covers come as their rows come near: scrolled down the page, as a reader would.)
    await page.waitForFunction(() => { const b = document.querySelector('.sources-view .src-body'); if (b) b.scrollTop += 300; return document.querySelectorAll('.vol-row .vol-cover img').length === 4; }, null, { timeout: 60000, polling: 400 });
    await page.evaluate(() => { document.querySelector('.sources-view .src-body').scrollTop = 0; });
    const saga = await page.$$eval('.vol-row', (rs) => rs.map((r) => `${r.querySelector('.vol-title')?.textContent}|${r.querySelector('.vol-kind')?.textContent}`));
    ok('a series\' page: the volumes in reading order (1, 2, 10, then the side story), every one with its cover', saga.join() === 'Alpha Saga Vol. 1|EPUB,Alpha Saga Vol. 2|EPUB,Alpha Saga Vol. 10|EPUB,Alpha Saga - Side Story|PDF');
    if (saga.length !== 4) console.log('  saga:', JSON.stringify(saga));
    ok('… with a button for all of them', /Download all 4 volumes/.test(await page.$eval('.series-head button', (e) => e.textContent)) && /4 volumes/.test(await page.$eval('.series-head .src-chips', (e) => e.textContent)));
    await page.screenshot({ path: path.join(__dirname, 'otl-series.png') });
    // One volume by its own button.
    await page.click('.vol-row >> nth=1 >> .vol-actions button'); await page.waitForSelector('.vol-row >> nth=1 >> .vol-actions .btn.primary', { timeout: 60000 });
    ok('one volume by its own button; the series\' button counts the rest', /Download all 3 volumes/.test(await page.$eval('.series-head button', (e) => e.textContent)));
    // Back from a volume — its page, or the reader — is the series where it was left, not the main page.
    const seriesHash = await page.evaluate(() => location.hash);
    const placeOf = () => page.evaluate(() => { const body = document.querySelector('.sources-view .src-body'); const r = document.querySelectorAll('.vol-row')[2]?.getBoundingClientRect(); return { hash: location.hash, top: body?.scrollTop ?? -1, rowTop: r ? Math.round(r.top) : -1, rows: document.querySelectorAll('.vol-row').length }; });
    await page.evaluate(() => { const body = document.querySelector('.sources-view .src-body'); const row = document.querySelectorAll('.vol-row')[2]; body.scrollTop = row.offsetTop - body.offsetTop - 80; }); await page.waitForTimeout(400);
    const before = await placeOf();
    await page.click('.vol-row >> nth=2 >> .vol-cover'); await page.waitForSelector('.src-files .src-file, .src-files .btn', { timeout: 30000 }); await page.waitForTimeout(300);
    ok('a volume\'s page from its cover', /\/book\/f%3AAlpha%2520Saga%2FAlpha%2520Saga%2520Vol\.%252010\.epub$/.test(await page.evaluate(() => location.hash)) || /book\/f/.test(await page.evaluate(() => location.hash)));
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForSelector('.vol-row', { timeout: 15000 }); await page.waitForTimeout(500);
    const after = await placeOf();
    ok('back from a volume\'s page: the series, scrolled where it was', after.hash === seriesHash && after.rows === 4 && before.top > 100 && Math.abs(after.top - before.top) <= 4 && Math.abs(after.rowTop - before.rowTop) <= 4);
    if (!(after.hash === seriesHash && Math.abs(after.top - before.top) <= 4)) console.log('  place:', JSON.stringify({ before, after, seriesHash }));
    // The volume fetched above, read and left: back on the series again.
    await page.evaluate(() => { const body = document.querySelector('.sources-view .src-body'); const row = document.querySelectorAll('.vol-row')[1]; body.scrollTop = row.offsetTop - body.offsetTop - 40; }); await page.waitForTimeout(400);
    const before2 = await placeOf();
    await page.click('.vol-row >> nth=1 >> .vol-actions .btn.primary'); await page.waitForSelector('.reader-view, .reader-scroll', { timeout: 30000 }); await page.waitForTimeout(1500);
    ok('a volume opens in the reader', /^#\/read\//.test(await page.evaluate(() => location.hash)));
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForSelector('.vol-row', { timeout: 15000 }); await page.waitForTimeout(500);
    const after2 = await placeOf();
    ok('back from the reader: the series, scrolled where it was (not the library)', after2.hash === seriesHash && Math.abs(after2.top - before2.top) <= 4);
    if (!(after2.hash === seriesHash && Math.abs(after2.top - before2.top) <= 4)) console.log('  place2:', JSON.stringify({ before2, after2, seriesHash }));
    // And on: the shelf of series, then the hub.
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForSelector('.src-card.folder', { timeout: 15000 }); await page.waitForTimeout(400);
    ok('… back: the shelf of series', (await page.$$('.src-card.folder .src-cover.has-img img')).length === 3 && !(await page.$('.series-head')));
    await page.evaluate(() => document.querySelector('.view .topbar button[data-icon="back"]').click()); await page.waitForSelector('.sources-hub', { timeout: 15000 });
    ok('… back: the sources', (await page.evaluate(() => location.hash)) === '#/sources');
    await page.goto(base + '#/sources'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    await page.click('.topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]');
    await page.fill('.sheet input[type=url]', 'otl'); await page.press('.sheet input[type=url]', 'Enter'); await page.waitForTimeout(1200);
    ok('"otl" again: already added', /already/i.test(await page.$eval('.sheet .hint', (e) => e.textContent)) && (await page.$$('.folder-card')).length === 2);
  } finally { console.log('errors', errors); await browser.close(); server.close(); mock.kill(); }
})();
