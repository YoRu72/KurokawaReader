// UI hunt (ported from apps/tools/tests/uihunt.cjs): opens every main Reader view (library, sources, catalog, notes, a book's page,
// every settings section, statistics, the reading screen with its bars, the options / contents / search sheets, the reading-dictionary
// notice) at phone 412x915 and PC 1280x800, in English and Arabic, offline, and looks for the small layout faults the owner finds by
// hand: page overflow, clipped text, a hint glued to its label, controls touching, small touch targets, unequal buttons in a row,
// native checkboxes / spinners, banned colours (yellow / amber / gold / orange), Eastern digits, LTR-pinned titles in RTL, a notice
// lying over the reading controls, phone-only wording on a computer and computer-only hints on a phone.
// Run: NODE_PATH=$(npm root -g) node tests/uihunt.cjs [en|ar] [--only <view>] [--list]   (KR_SHOTS=<dir>: a picture per view)
// A fault left on purpose goes in ALLOW below with its reason. Made-up books only (no real sites, no network).
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const args = process.argv.slice(2); const LANGS = args.includes('ar') ? ['ar'] : args.includes('en') ? ['en'] : ['en', 'ar'];
const oi = args.indexOf('--only'); const ONLY = oi >= 0 ? args[oi + 1] : '';
const di = args.indexOf('--dev'); const DEV = di >= 0 ? args[di + 1] : '';
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.epub': 'application/epub+zip', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f)); });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-uihunt-')); const SHOTS = process.env.KR_SHOTS; if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

// The books (made here): a Japanese text (the reading-dictionary notice), a PDF, and the two sample epubs the build ships.
const JA = ['第一話　帰り道', ...Array.from({ length: 40 }, (_, i) => `港町の灯台守は毎日同じ道を歩く。${i + 1}番目の朝、海が静かに光っていた。`)].join('\n\n');
fs.writeFileSync(path.join(TMP, 'nihongo.txt'), JA);
async function makePdf(file, pages) {
  const { PDFDocument, StandardFonts } = require(path.resolve(__dirname, '../node_modules/pdf-lib')); const d = await PDFDocument.create(); const font = await d.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) { const pg = d.addPage([432, 648]); pg.drawText(`Page ${i}`, { x: 40, y: 600, size: 18, font }); }
  fs.writeFileSync(file, await d.save());
}

const SETTING_COUNT = 26; // the sections of Settings, counted by position (s-0 ...); one that is not on this device is skipped
const lib = (hash) => async (p) => { await p.evaluate((h) => { location.hash = h; }, hash); };
// kind of book -> a function opening it on the reading screen (the id from the library's own store)
const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
const idOf = async (p, re) => (await allBooks(p)).find((b) => re.test(b.title) || re.test(b.fileName || ''))?.id;
const openBook = (re, ready) => async (p) => { const id = await idOf(p, re); if (!id) throw new Error('no book ' + re); await p.evaluate((id) => { location.hash = '#/'; setTimeout(() => { location.hash = `#/read/${id}`; }, 150); }, id); await p.waitForSelector(ready, { timeout: 30000 }); await p.waitForTimeout(1100); };
const command = (c) => async (p) => { await p.evaluate((c) => document.dispatchEvent(new CustomEvent('kr:command', { detail: c })), c); await p.waitForTimeout(700); };
const waitNotice = async (p) => { await p.evaluate(() => document.querySelector('.panel.open .panel-head .icon-btn')?.click()); await p.waitForTimeout(500); await p.evaluate(() => document.querySelector('.reader-view')?.classList.remove('immersive')); try { await p.waitForSelector('.kr-notice', { timeout: 10000 }); } catch (e) { const st = await p.evaluate(() => ({ panel: [...document.querySelectorAll('.panel.open')].length, sheet: document.querySelectorAll('.sheet').length, hash: location.hash, dict: !!document.querySelector('.reader-flow ruby'), visual: localStorage.getItem('kr.visual') })); throw new Error('no notice: ' + JSON.stringify(st)); } };
const aiSeed = async (p) => { await p.evaluate(() => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'custom', aiBaseUrl: 'https://ai.test/v1', aiKey: 'k', aiModel: 'm', aiTarget: 'ar', aiTask: 'translate', aiPrefetch: false }); localStorage.setItem('kr.visual', JSON.stringify(v)); }); await p.reload(); await p.waitForSelector('.library-view', { timeout: 15000 }); await p.waitForTimeout(400); };
const wake = async (p) => { await p.evaluate(() => { document.querySelector('.reader-view')?.classList.remove('immersive'); }); await p.waitForTimeout(300); };
const settingsSec = (i) => async (p) => {
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { state: 'attached', timeout: 15000 });
  const has = await p.evaluate((i) => !!document.getElementById('s-' + i), i); if (!has) throw new Error('SKIP');
  await p.evaluate((i) => { const nav = document.querySelector(`.settings-nav [data-sec="s-${i}"]`); if (document.documentElement.classList.contains('pc')) nav?.click(); else document.getElementById('s-' + i).classList.remove('collapsed'); }, i);
};
const VIEWS = [
  ['library', async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view .book-card', { timeout: 15000 }); }],
  ['stats', async (p) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.click('.library-view [title="Reading statistics"], .library-view [aria-label="Reading statistics"], .library-view button:has(svg) >> nth=0').catch(() => {}); await p.evaluate(() => { [...document.querySelectorAll('.library-view .icon-btn, .library-view button')].find((b) => /chart|stat|إحصاء|إحصائ/i.test((b.title || '') + (b.getAttribute('aria-label') || '')))?.click(); }); await p.waitForSelector('.sheet, .stats-view, .panel.open', { timeout: 8000 }); }],
  ['sources', lib('#/sources')], ['catalog', lib('#/catalog')], ['notes', lib('#/notes')],
  ['book', async (p) => { const id = await idOf(p, /nihongo/); await p.evaluate((id) => { location.hash = '#/book/' + id; }, id); await p.waitForSelector('.book-view, .book-page, .view', { timeout: 10000 }); }],
  // The book's «Edit title and author» sheet (src/ui/booknames.ts): with another title to show the rows and the keep switch.
  ['book-edit-names', async (p) => { const id = await idOf(p, /nihongo/); await p.evaluate((id) => { location.hash = '#/book/' + id; }, id); await p.waitForSelector('.book-hero h1', { timeout: 10000 }); await p.waitForTimeout(300); await p.evaluate(() => [...document.querySelectorAll('.book-tile')].find((x) => x.querySelector('svg') && /^(Edit|تعديل)/.test(x.textContent.trim())).click()); await p.waitForSelector('.names-shown'); await p.fill('.names-add', 'Another title'); await p.keyboard.press('Enter'); await p.fill('.names-shown', 'A new shown title'); await p.waitForTimeout(250); }],
  // The AniList review sheet (src/ui/alreview.ts): a made-up linked account and a book matched to a made-up AniList entry (stored locally; the
  // sheet's one request to AniList is answered «not found» by the route below — nothing leaves the page). Leftover sheets closed first.
  ['book-alreview', async (p) => {
    await p.route('https://graphql.anilist.co/**', (r) => r.fulfill({ status: 404, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ errors: [{ message: 'Not Found.', status: 404 }], data: { Review: null } }) }));
    await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((x) => x.remove()));
    const id = await idOf(p, /nihongo/);
    await p.evaluate(async (id) => {
      localStorage.setItem('kr.anilist.token', 'FAKE'); localStorage.setItem('kr.anilist.user', JSON.stringify({ id: 7, name: 'Reader', scoreFormat: 'POINT_10' }));
      const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); v.anilistEnabled = true; localStorage.setItem('kr.visual', JSON.stringify(v));
      await new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const st = r.result.transaction('books', 'readwrite'); const os = st.objectStore('books'); const g = os.get(id); g.onsuccess = () => { const b = g.result; b.track = { service: 'anilist', media: { id: 99, title: 'Made-up novel', url: 'https://anilist.co/manga/99' }, entry: { status: 'CURRENT', progress: 1, score: 8 }, updatedAt: 1 }; b.highlights = [{ id: 'h1', text: 'A made-up line.', color: 'blue', createdAt: 1 }]; os.put(b); }; st.oncomplete = () => res(); }; });
    }, id);
    await p.reload(); await p.waitForTimeout(800);
    await p.evaluate((id) => { location.hash = '#/book/' + id; }, id); await p.waitForSelector('.book-hero h1', { timeout: 10000 }); await p.waitForTimeout(400);
    await p.waitForSelector('.book-tile[data-al-review]', { timeout: 10000 }); await p.click('.book-tile[data-al-review]');
    await p.waitForSelector('.alr-sheet .alr-body'); await p.fill('.alr-summary', 'A made-up summary line'); await p.fill('.alr-body', 'A made-up review text. '.repeat(30)); await p.waitForTimeout(400);
  }],
  ['settings', async (p) => { await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { state: 'attached' }); await p.evaluate(() => document.querySelectorAll('.settings-body .card.collapsed').forEach((c) => c.classList.remove('collapsed'))); }, 'phone'],
  ...Array.from({ length: SETTING_COUNT }, (_, i) => ['settings-' + i, settingsSec(i), 'pc']),
  ['read-epub', openBook(/alice/i, '.reader-flow .kr-content')],
  ['read-epub-bars', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await wake(p); }],
  ['read-epub-bottom', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await wake(p); await p.evaluate(() => { const s = document.querySelector('.reader-view .reader, .reader-view [class*=scroll]'); document.querySelectorAll('.reader-view *').forEach((e) => { if (e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; }); }); await p.waitForTimeout(600); }],
  ['read-options', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await command('options')(p); await p.waitForSelector('.panel.open, .sheet', { timeout: 8000 }); }],
  ['read-contents', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await command('toc')(p); await p.waitForSelector('.panel.open, .sheet', { timeout: 8000 }); }],
  ['read-search', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await command('search')(p); await p.waitForSelector('.panel.open, .sheet, .search-bar, input[type=search]', { timeout: 8000 }); }],
  // The AI sheet's four tabs (src/ui/aisheet.ts), from the reader's Glossary command.
  ...['translation', 'glossary', 'names', 'saved'].map((k) => ['read-ai-' + k, async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await command('glossary')(p); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 8000 }); await p.click(`.ai-tab[data-tab="${k}"]`); await p.waitForSelector(`.ai-panel[data-tab="${k}"]:not([hidden]) > *`, { timeout: 8000 }); await p.waitForTimeout(500); }]),
  // «Text as image» (src/ui/textcard.ts): a paragraph picked, the card's title and author fields, the sheet scrolled to its end.
  ['read-text-card', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p);
    // (A sheet left over from the view before — the AI sheet on a computer — keeps the selection bar away: closed first.)
    for (let i = 0; i < 6 && await p.evaluate(() => !!document.querySelector('.sheet, .panel.open')); i++) { await p.keyboard.press('Escape'); await p.waitForTimeout(300); }
    // (The words of the first chapter on the screen — the others are drawn only when reached.)
    await p.evaluate(() => { const e = [...document.querySelectorAll('.kr-content > section')].find((x) => x.getClientRects().length && x.textContent.trim().length > 40); if (!e) throw new Error('no chapter on screen'); const r = document.createRange(); r.selectNodeContents(e); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }); await p.waitForTimeout(500); await p.evaluate(() => document.dispatchEvent(new Event('selectionchange'))); await p.waitForTimeout(500);
    await p.evaluate(() => { const b = [...document.querySelectorAll('.sel-toolbar button')].find((x) => /Text as image|صوِّر النص/.test(x.textContent)); if (!b) throw new Error('no Text as image button'); b.click(); }); await p.waitForSelector('.snap-sheet .snap-preview', { timeout: 8000 }).catch(async () => { throw new Error('no card: ' + await p.evaluate(() => [...document.querySelectorAll('.sheet,.toast')].map((x) => x.className + ':' + x.textContent.slice(0, 60)).join(' | '))); }); await p.waitForSelector('.snap-sheet .textpic-author', { timeout: 3000, state: 'attached' }); if (!(await p.isVisible('.snap-sheet .textpic-author'))) { await p.evaluate(() => document.querySelector('.snap-sheet .sheet-actions button').click()); await p.waitForSelector('.snap-sheet .textpic-author', { timeout: 8000 }); } await p.waitForTimeout(600);
    await p.evaluate(() => { const b = document.querySelector('.snap-sheet .sheet-body'); b.scrollTop = b.scrollHeight; }); await p.waitForTimeout(300); }],
  // A glossary name's card in the text (src/ui/glosscard.ts): a made-up glossary for «Alice» (every book), the name clicked where it is marked.
  ['read-gloss-card', async (p) => {
    await p.evaluate(() => { localStorage.setItem('kr.glossary', JSON.stringify([{ id: 'g1', from: 'Alice', to: 'أليس', lang: 'ar', kind: 'person', alts: ['أليسة'], note: 'A made-up note' }, { id: 'g2', from: 'Alice', to: 'アリス', lang: 'ja', kind: 'person' }])); });
    await p.reload(); await p.waitForSelector('.library-view', { timeout: 15000 });
    await openBook(/alice/i, '.reader-flow .kr-content')(p);
    await p.waitForFunction(() => (CSS.highlights?.get('kr-gloss')?.size ?? 0) > 0, null, { timeout: 15000 });
    const at = await p.evaluate(async () => { const first = [...CSS.highlights.get('kr-gloss')][0]; first.startContainer.parentElement.scrollIntoView({ block: 'center' }); await new Promise((r) => setTimeout(r, 400)); const sr = document.querySelector('.reader-scroll').getBoundingClientRect(); for (const r of CSS.highlights.get('kr-gloss')) { const q = r.getClientRects()[0]; if (q && q.top > sr.top + 40 && q.bottom < sr.bottom - 300) return { x: q.left + q.width / 2, y: q.top + q.height / 2 }; } return null; });
    if (!at) throw new Error('no name on the screen ' + JSON.stringify(await p.evaluate(() => { const sr = document.querySelector('.reader-scroll').getBoundingClientRect(); return { n: CSS.highlights.get('kr-gloss').size, sr: [sr.top, sr.bottom], rects: [...CSS.highlights.get('kr-gloss')].slice(0, 5).map((r) => { const q = r.getClientRects()[0]; return q && [Math.round(q.top), Math.round(q.bottom)]; }) }; }))); await p.mouse.click(at.x, at.y); await p.waitForSelector('.gloss-card', { timeout: 6000 }); await p.waitForTimeout(500); }],
  // The Kurokawa Installer's sheet (src/updates.ts), Android faked (no native part): the update sheet's button, the sheet read at rest.
  ['installer-sheet', async (p) => {
    await p.route('https://api.github.com/**', (r) => r.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify([{ tag_name: 'v0.99.0', name: 'v0.99.0', body: '- A made-up change', html_url: 'https://example.invalid/r', published_at: '2026-11-20T10:00:00Z', prerelease: false, draft: false, assets: [{ name: 'KurokawaReader-0.99.0-universal.apk', size: 31457280, browser_download_url: 'https://example.invalid/a.apk', digest: '' }] }]) }));
    await p.evaluate(() => {
      const L = {}; const mock = { getPlatform: () => 'android', isNativePlatform: () => true, Plugins: { Filesystem: {}, Kurokawa: {
        deviceInfo: async () => ({ abis: ['arm64-v8a'] }), installerAvailable: async () => ({ canInstall: true }), canInstall: async () => ({ granted: true }), cachedFile: async () => ({}), downloadFile: async () => ({ path: '/x/a.apk', size: 1 }), cancelDownload: async () => undefined,
        addListener: async (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return { remove() {} }; }, installApk: async () => undefined,
        apkInfo: async () => ({ label: 'KurokawaReader', package: 'com.example.reader', version: '0.99.0', versionCode: 99, size: 31457280, sameApp: true, installed: true, installedVersion: '0.66.0', signerMatch: true, minSdk: 24 }),
        apkInstall: async () => ({ id: 'x' }) } } };
      window.__fakeAndroid = true; Object.defineProperty(window, 'Capacitor', { configurable: true, get: () => (window.__fakeAndroid ? mock : undefined) });
    });
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { state: 'attached' }); await p.evaluate(() => document.querySelectorAll('.settings-body .card.collapsed').forEach((c) => c.classList.remove('collapsed')));
    await p.evaluate(() => { const bt = [...document.querySelectorAll('.settings-body button')].find((x) => x.querySelector('svg') && /Check for updates|التحقّق|التحقق/i.test(x.textContent)); if (!bt) throw new Error('no check button'); bt.scrollIntoView(); bt.click(); });
    await p.waitForSelector('.update-sheet .upd-go', { timeout: 10000 }); await p.click('.update-sheet .upd-go'); await p.waitForSelector('.inst-go:not([disabled])', { timeout: 10000 });
    await p.evaluate(() => { window.__fakeAndroid = false; }); await p.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 5000 }).catch(() => undefined); }, 'phone'],
  // The AI translator's question and new settings rows (src/ui/gather.ts, src/ui/aisettings.ts, src/ui/glossarysheet.ts): the provider made up (nothing is sent).
  ['translate-question', async (p) => {
    await aiSeed(p); await openBook(/nihongo/, '.reader-flow .kr-content')(p); await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' }))); await p.waitForSelector('.gather-sheet .gather-go', { timeout: 10000 });
    await p.evaluate(() => document.querySelector('.tr-pill')?.remove()); // (the bar behind the sheet squeezes its buttons in Arabic — a fault of the bar's own, not of the question)
    await p.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 4000 }).catch(() => undefined); }],
  // The same question for a book whose former volume's glossary is in use (the long primary label), at 360 and 412 wide: the label stays
  // inside its button; when the two labels do not fit side by side the buttons stack at full width (src/ui/dom.ts stackWhenCramped).
  ...[360, 412].map((w) => ['translate-question-volume-' + w, async (p) => {
    await aiSeed(p); await openBook(/nihongo/, '.reader-flow .kr-content')(p); await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' }))); await p.waitForSelector('.gather-sheet .gather-go', { timeout: 10000 });
    await p.evaluate(() => document.querySelector('.tr-pill')?.remove());
    await p.evaluate(() => { const ar = document.documentElement.dir === 'rtl'; const s = document.querySelector('.gather-sheet'); s.querySelector('.gather-go').textContent = ar ? 'البحث في هذا المجلد عن أسماء جديدة' : 'Check this volume for new names'; const line = document.createElement('p'); line.className = 'gather-volume'; line.setAttribute('role', 'status'); line.textContent = ar ? 'يُستعمل مسرد «⁨Gate Story Vol. 1⁩»' : 'The glossary of Gate Story Vol. 1 is in use'; s.querySelector('.gather-why').after(line); });
    await p.setViewportSize({ width: w - 1, height: 915 }); await p.waitForTimeout(150); await p.setViewportSize({ width: w, height: 915 });
    await p.waitForFunction(() => document.getAnimations().length === 0, null, { timeout: 4000 }).catch(() => undefined); await p.waitForTimeout(300); }, 'phone']),
  // «Save the translation as EPUB» (src/ui/trepubsheet.ts): the sheet over a book with something kept that matches nothing now (the one line saying so);
  // its form with real saved translations is read in tests/translatedepub.cjs. Nothing is sent. (Phone only: it is a sheet.)
  ['translate-export', async (p) => {
    await aiSeed(p); await openBook(/nihongo/, '.reader-flow .kr-content')(p);
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 10000 });
    await p.click('.ai-tab[data-tab="saved"]'); await p.waitForSelector('.ai-epub', { timeout: 8000 });
    const id = await idOf(p, /nihongo/);
    await p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const tx = r.result.transaction('meta', 'readwrite'); tx.objectStore('meta').put({ x: 'y' }, 'tr:' + id); tx.oncomplete = () => res(1); }; }), id);
    await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => (e.__close ? e.__close() : e.remove())));
    await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 10000 });
    await p.click('.ai-tab[data-tab="saved"]'); await p.waitForSelector('.ai-epub:not([disabled])', { timeout: 8000 }); await p.click('.ai-epub'); await p.waitForSelector('.tre-sheet .tre-status:not([hidden]), .tre-sheet .tre-form:not([hidden])', { timeout: 20000 }); await p.waitForTimeout(500);
  }, 'phone'],
  ['ai-translation-auto', async (p) => {
    await aiSeed(p); await openBook(/nihongo/, '.reader-flow .kr-content')(p); await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .ai-tab', { timeout: 10000 });
    await p.click('.ai-sheet .ai-tab[data-tab="translation"]'); await p.waitForSelector('.tr-auto-book button', { timeout: 8000 }); await p.click('.tr-auto-start'); await p.locator('.tr-auto-book').scrollIntoViewIfNeeded(); await p.waitForTimeout(400); }],
  ['ai-glossary-options', async (p) => {
    await aiSeed(p); await openBook(/nihongo/, '.reader-flow .kr-content')(p); await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'glossary' }))); await p.waitForSelector('.ai-sheet .gloss-opts summary', { timeout: 10000 });
    await p.click('.ai-sheet .gloss-opts summary'); await p.waitForSelector('.gloss-gather-mode button', { timeout: 8000 }); await p.locator('.gloss-gather-mode').scrollIntoViewIfNeeded(); await p.waitForTimeout(400); }],
  ['read-pdf', openBook(/pages/i, '.pdf-bar, .pdf-view, .pdf-pages')],
  ['read-notice', async (p) => { await openBook(/nihongo/, '.reader-flow .kr-content')(p); await waitNotice(p); await p.waitForTimeout(400); }, 'both', { notice: true }],
  ['read-notice-bottom', async (p) => { await openBook(/nihongo/, '.reader-flow .kr-content')(p); await waitNotice(p); await p.evaluate(() => { document.querySelectorAll('.reader-view *').forEach((e) => { if (e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; }); }); await p.waitForTimeout(700); }, 'both', { notice: true }],
];

// kind|view|selector-ish key -> reason. A key is `${kind} ${view} ${what}` prefix-matched (view without the device).
const ALLOW = [
  ['colour installer-sheet', 'the settings page behind the sheet holds the reading-theme previews and the highlight palette (allowed on the settings view itself)'],
  ['colour settings', 'reading-theme previews (sepia, candlelight, manuscript) and the highlight colour palette show the colours they stand for'],
  ['colour read-options', 'the same theme previews and highlight palette, inside the options panel'],
  ['stick-out book-edit-names div.book-hero-bg', 'the same blurred backdrop, behind the sheet'],
  ['stick-out book-alreview div.book-hero-bg', 'the same blurred backdrop, behind the sheet'],
  ['stick-out book div.book-hero-bg', 'the blurred cover backdrop is bled past the edge on purpose and clipped by the page (no page overflow)'],
];
const allowedBy = {}; const allowed = (key) => { const a = ALLOW.find(([k]) => key.startsWith(k)); if (a) allowedBy[a[0]] = (allowedBy[a[0]] || 0) + 1; return !!a; };

/** Runs in the page: returns a list of { kind, what } faults. */
function hunt({ phone, rtl, lang }) {
  const out = []; const vw = document.documentElement.clientWidth;
  const desc = (e) => { let s = e.tagName.toLowerCase(); if (e.id) s += '#' + e.id; const c = [...e.classList].slice(0, 2).join('.'); if (c) s += '.' + c; const tx = (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 70); if (e.tagName === 'INPUT') s += `[${e.type}]<${e.parentElement ? e.parentElement.tagName.toLowerCase() + '.' + [...e.parentElement.classList].join('.') : ''}`; return s + (tx ? ` «${tx}»` : ''); };
  const vis = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; const cs = getComputedStyle(e); if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false; for (let a = e; a; a = a.parentElement) { if (a.hidden || getComputedStyle(a).display === 'none') return false; } return true; };
  const add = (kind, e, extra) => out.push({ kind, what: desc(e) + (extra ? ' ' + extra : '') });
  const root = document.documentElement;
  if (root.scrollWidth > root.clientWidth + 1 || document.body.scrollWidth > root.clientWidth + 1) out.push({ kind: 'overflow', what: `page ${Math.max(root.scrollWidth, document.body.scrollWidth)} > ${root.clientWidth}` });
  const all = [...document.body.querySelectorAll('*')].filter(vis);
  // Clipped on purpose (scrollers, sliders, marquees) is not a fault: look at the scroll ancestors.
  const inScroller = (e) => { for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const cs = getComputedStyle(a); if (/(auto|scroll)/.test(cs.overflowX) && a.scrollWidth > a.clientWidth + 1) return true; if (cs.overflowX === 'hidden' && a.getBoundingClientRect().width < e.getBoundingClientRect().width - 1) return false; } return false; };
  // The book's own text (what the author wrote) is not the app's interface: its digits, colours and clipping are not judged.
  const book = (e) => !!e.closest('.kr-content, .reader-flow, .pdf-pages, .pdf-page, canvas, .textLayer, .kr-page, .book-card .cover, .book-card .ba, .book-card .t, .gen');
  for (const e of all) {
    const r = e.getBoundingClientRect(); const cs = getComputedStyle(e); if (book(e)) continue;
    if (cs.position !== 'fixed' && !inScroller(e) && (r.right > vw + 2 || r.left < -2) && !e.closest('.scrim, .sheet-scrim, [aria-hidden=true], svg, .marquee, .panel:not(.open)')) add('stick-out', e, `${Math.round(r.left)}..${Math.round(r.right)} of ${vw}`);
    if (['BUTTON', 'LABEL', 'SPAN', 'A', 'H1', 'H2', 'H3', 'SMALL', 'DIV'].includes(e.tagName) && !e.children.length && (e.textContent || '').trim() && /(hidden|clip)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 2 && (cs.textOverflow !== 'ellipsis' || e.closest('.book-tile')) && !(e.closest('.book-tile') && cs.whiteSpace !== 'nowrap' && e.scrollWidth <= e.clientWidth + 2)) add('clipped', e, `${e.scrollWidth}>${e.clientWidth}`);
    // A label wider than its button (centred text spills out on both sides, so no overflow:hidden clipping shows it).
    if (e.tagName === 'BUTTON' && (e.textContent || '').trim() && !e.closest('svg, .scrim, [aria-hidden=true], .panel:not(.open)')) { const rg0 = document.createRange(); rg0.selectNodeContents(e); const q0 = rg0.getBoundingClientRect(); if (q0.width && (q0.right > r.right + 1.5 || q0.left < r.left - 1.5 || e.scrollWidth > e.clientWidth + 1)) add('label-leaves-button', e, `text ${Math.round(q0.left)}..${Math.round(q0.right)} in button ${Math.round(r.left)}..${Math.round(r.right)}`); }
    if (e.tagName === 'SPAN' && e.closest('.book-tile')) { const tr = e.closest('.book-tile').getBoundingClientRect(); const rg = document.createRange(); rg.selectNodeContents(e); const q = rg.getBoundingClientRect(); if (q.right > tr.right + 1 || q.left < tr.left - 1 || e.scrollWidth > e.clientWidth + 1 || cs.textOverflow === 'ellipsis') add('clipped', e, `tile label «${e.textContent}» cut or past its tile`); }
    for (const prop of ['color', 'backgroundColor', 'borderTopColor']) {
      const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?/.exec(cs[prop] || ''); if (!m) continue; if (m[4] !== undefined && +m[4] < 0.3) continue;
      const rr = +m[1] / 255, g = +m[2] / 255, b = +m[3] / 255; const mx = Math.max(rr, g, b), mn = Math.min(rr, g, b), d = mx - mn; if (!d) continue;
      let hh = mx === rr ? ((g - b) / d) % 6 : mx === g ? (b - rr) / d + 2 : (rr - g) / d + 4; hh = (hh * 60 + 360) % 360; const l = (mx + mn) / 2; const s = d / (1 - Math.abs(2 * l - 1));
      if (hh >= 25 && hh <= 65 && s > 0.4 && l > 0.12 && l < 0.92 && (prop !== 'borderTopColor' || parseFloat(cs.borderTopWidth) > 0)) add('colour', e, `${prop} ${cs[prop]}`);
    }
    if (e.tagName === 'INPUT' && e.type === 'checkbox' && cs.appearance !== 'none' && cs.webkitAppearance !== 'none' && !e.closest('.sr-only')) add('native-checkbox', e);
    if (e.tagName === 'INPUT' && e.type === 'number' && cs.appearance !== 'textfield' && cs.webkitAppearance !== 'textfield' && getComputedStyle(e, '::-webkit-inner-spin-button').webkitAppearance !== 'none') add('native-spinner', e);
    if (!e.children.length && /[٠-٩۰-۹]/.test(e.textContent || '') && !(e.closest('.segmented') && (e.textContent || '').trim() === '١٢٣')) add('eastern-digits', e);
    if (rtl && /^(H1|H2|H3)$/.test(e.tagName) && cs.direction === 'ltr' && /[؀-ۿ]/.test(e.textContent || '')) add('ltr-title-in-rtl', e);
  }
  // glued: a label-ish text directly followed by an inline small/span hint with no space
  for (const sm of all.filter((x) => (x.tagName === 'SMALL' || x.classList.contains('hint') || x.classList.contains('sub')) && x.parentElement && !book(x))) {
    const prev = sm.previousSibling; if (!prev) continue; if (getComputedStyle(sm).display !== 'inline') continue;
    const pt = prev.nodeType === 3 ? prev.textContent : prev.textContent || ''; if (!pt.trim()) continue; if (/\s$/.test(pt) && prev.nodeType === 3) continue;
    const pr = prev.nodeType === 1 ? getComputedStyle(prev).display : 'inline'; if (pr !== 'inline') continue;
    const a = document.createRange(); a.selectNodeContents(prev); const ar = a.getBoundingClientRect(); const sr = sm.getBoundingClientRect(); if (Math.abs(ar.bottom - sr.bottom) < 6 || (sr.top < ar.bottom - 2)) add('glued', sm, `after «${pt.trim().slice(0, 20)}»`);
  }
  // controls
  const ctl = all.filter((e) => /^(BUTTON|A|SELECT|INPUT|TEXTAREA)$/.test(e.tagName) && !book(e) && !(e.tagName === 'INPUT' && e.type === 'hidden') && !e.closest('svg') && !(e.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio') && getComputedStyle(e).opacity === '0'));
  if (phone) for (const e of ctl) { if (e.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio') && e.closest('label')) continue; if (e.tagName === 'A' && e.closest('p, small, li:not(.row)')) continue; const r = e.getBoundingClientRect(); if (r.height < 40 || r.width < 40) add('small-target', e, `${Math.round(r.width)}x${Math.round(r.height)}`); }
  const rows = new Map(); for (const e of ctl) { if (e.tagName === 'INPUT' && (e.type === 'checkbox' || e.type === 'radio')) continue; const p = e.parentElement; if (!p) continue; (rows.get(p) || rows.set(p, []).get(p)).push(e); }
  for (const [p, es] of rows) {
    const bs = es.map((e) => ({ e, r: e.getBoundingClientRect() }));
    for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) {
      const a = bs[i].r, b = bs[j].r; if (Math.abs(a.top - b.top) > 8 && Math.abs(a.bottom - b.bottom) > 8) continue;
      const gap = Math.max(b.left - a.right, a.left - b.right); const ov = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (p.closest('.segmented, .seg')) continue; const icons = bs[i].e.classList.contains('icon-btn') && bs[j].e.classList.contains('icon-btn'); if (ov > 4 && gap < (icons ? 1 : 4)) add('touching', bs[j].e, `in ${p.tagName.toLowerCase()}.${[...p.classList].join('.')} with ${desc(bs[i].e)} gap ${Math.round(gap)}`);
    }
    const btns = es.filter((e) => e.tagName === 'BUTTON' && e.textContent.trim() && !e.closest('.chips, .chip-row, .folder-chips, .settings-nav, [role=tablist], .seg, .segmented, .tabs'));
    if (btns.length >= 2 && btns.length === es.length && /actions|btns|row|buttons/.test(p.className + ' ')) {
      const rs = btns.map((e) => e.getBoundingClientRect()); const sameLine = rs.every((r) => Math.abs(r.top - rs[0].top) < 8);
      if (sameLine) { const w = rs.map((r) => Math.round(r.width)); if (Math.max(...w) - Math.min(...w) > 3) add('unequal-buttons', p, w.join('/')); }
    }
  }
  // A notice lies above the reading controls, never over them.
  for (const n of all.filter((x) => x.classList.contains('kr-notice'))) {
    const nr = n.getBoundingClientRect(); if (nr.top < 0 || nr.bottom > innerHeight + 1 || nr.left < -1 || nr.right > vw + 1) out.push({ kind: 'notice-off-screen', what: desc(n) });
    for (const c of all.filter((x) => !n.contains(x) && /^(BUTTON|A|INPUT)$/.test(x.tagName) && (!book(x) || x.closest('.chapter-nav, .page-arrow')) && x.closest('.reader-view, .chapter-nav, .float-toolbar, .read-status, .pdf-bar, .page-arrow, .selection-bar, .topbar'))) {
      const r = c.getBoundingClientRect(); const ox = Math.min(nr.right, r.right) - Math.max(nr.left, r.left), oy = Math.min(nr.bottom, r.bottom) - Math.max(nr.top, r.top);
      if (ox > 2 && oy > 2) add('notice-over-controls', c, `under the notice (${Math.round(ox)}x${Math.round(oy)})`);
    }
  }
  // Phone-only wording on a computer and computer-only hints on a phone (English interface only: the words are looked for as written).
  if (lang === 'en') {
    const txt = (e) => (e.textContent || '').trim();
    const leaves = all.filter((e) => !e.children.length && txt(e) && !book(e));
    const PHONE = /\b(volume keys?|swipe|haptic|vibrat\w*|screen edges?|navigation bar|status bar|system bars?|pinch|shake)\b/i, PC = /\b(Ctrl|Alt\+|Shift\+|keyboard shortcuts?|right-click|hover|mouse wheel|double-click|press [A-Z]\b|F11)\b/i;
    for (const e of leaves) { if (!phone && PHONE.test(txt(e))) add('phone-only-on-pc', e); if (phone && PC.test(txt(e)) && !e.closest('kbd')) add('pc-only-on-phone', e); }
  }
  return out;
}

(async () => {
  if (args.includes('--list')) { console.log(VIEWS.map((v) => v[0]).join(' ')); process.exit(0); }
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const pdf = path.join(TMP, 'pages.pdf'); await makePdf(pdf, 12);
  const files = [path.join(TMP, 'nihongo.txt'), pdf, ...['alice-in-wonderland.epub', 'maqamat-al-hariri.epub'].map((f) => path.join(DIST, 'samples', f)).filter((f) => fs.existsSync(f))];
  const b = await chromium.launch(); let fails = 0; let allowedN = 0; const summary = {};
  for (const lang of LANGS) for (const dev of ['phone', 'pc'].filter((d) => !DEV || d === DEV)) {
    const phone = dev === 'phone'; const CS = process.env.KR_DARK ? { colorScheme: 'dark' } : {};
    const ctx = await b.newContext(phone ? { ...devices['Pixel 7'], viewport: { width: 412, height: 915 }, locale: lang, serviceWorkers: 'block', ...CS } : { viewport: { width: 1280, height: 800 }, locale: lang, serviceWorkers: 'block', ...CS });
    await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), (r) => r.abort()); // offline: nothing leaves the machine
    const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ furigana: true })); }, lang); await p.reload(); await p.waitForSelector('.library-view', { timeout: 20000 }); await p.waitForTimeout(500);
    await p.setInputFiles('.library-view input[type=file]', files);
    for (let i = 0; i < 160; i++) { const n = (await allBooks(p)).length; if (n >= files.length) break; await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); await p.waitForTimeout(250); }
    for (const [name, act, only, opt] of VIEWS) {
      if (ONLY && name !== ONLY) continue; if (only === 'phone' && !phone) continue; if (only === 'pc' && phone) continue;
      try {
        await p.evaluate(() => { location.hash = '#/'; }); await p.keyboard.press('Escape'); await p.waitForTimeout(250);
        if (phone) await p.setViewportSize({ width: 412, height: 915 });
        await act(p); await p.waitForTimeout(350);
        const faults = await p.evaluate(hunt, { phone, rtl: lang === 'ar', lang });
        const seen = new Set();
        for (const f of faults) {
          const key = `${f.kind} ${name} ${f.what.replace(/ «.*$/, '')}`; const line = `${lang} ${dev} ${name}: ${f.kind}: ${f.what}`;
          if (seen.has(line)) continue; seen.add(line);
          if (allowed(`${f.kind} ${name} ${f.what.split(' ')[0]}`) || allowed(`${f.kind} ${name}`)) { allowedN++; continue; }
          console.log('FAULT ' + line); fails++; summary[f.kind] = (summary[f.kind] || 0) + 1;
        }
        if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `hunt-${name}-${dev}-${lang}.png`) });
      } catch (e) { if (e.message === 'SKIP') continue; console.log(`ERR   ${lang} ${dev} ${name}: ${String(e.message).split('\n')[0]}`); fails++; }
    }
    if (phone && (!ONLY || ONLY === 'narrowcards')) { // narrow cards: 2-5 columns at 360 / 390 / 412 px: the marks sit inside the cover and never overlap, the stars stay in the card, nothing is clipped
      try {
        await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const db = r.result; const tx = db.transaction('books', 'readwrite'); const st = tx.objectStore('books'); st.getAll().onsuccess = (e) => { for (const b of e.target.result) { b.done = true; b.rating = 5; b.title = 'Mushoku Tensei: Jobless Reincarnation ' + b.title; b.author = 'Rifujin na Magonote'; st.put(b); } }; tx.oncomplete = () => res(); }; }));
        await p.evaluate(() => { location.hash = '#/'; }); await p.reload(); await p.waitForSelector('.library-view .book-card', { timeout: 15000 }); await p.waitForTimeout(500);
        for (const w of [360, 390, 412]) for (const cols of [2, 3, 4, 5]) {
          await p.setViewportSize({ width: w, height: 915 }); await p.evaluate((c) => { document.documentElement.style.setProperty('--lib-cols', String(c)); }, cols); await p.waitForTimeout(250);
          const bad = await p.evaluate(() => {
            const out = []; const r = (e) => e.getBoundingClientRect();
            for (const card of document.querySelectorAll('.book-card')) {
              const cv = card.querySelector('.cover'); if (!cv) continue; const cr = r(cv), kr = r(card); const bs = [...cv.querySelectorAll('.badge')].filter((b) => getComputedStyle(b).display !== 'none');
              for (const b of bs) { const x = r(b); if (x.left < cr.left + 2 || x.right > cr.right - 2 || x.top < cr.top + 2) out.push(`badge outside the cover «${b.textContent || b.className}»`); if (b.scrollWidth > b.clientWidth + 1) out.push(`badge clipped «${b.textContent}»`); }
              for (let i = 0; i < bs.length; i++) for (let j = i + 1; j < bs.length; j++) { const a = r(bs[i]), c = r(bs[j]); if (a.left < c.right - 0.5 && c.left < a.right - 0.5 && a.top < c.bottom - 0.5 && c.top < a.bottom - 0.5) out.push(`badges overlap «${bs[i].textContent}» «${bs[j].textContent}»`); }
              const st = card.querySelector('.stars-badge'); if (st && (r(st).right > kr.right + 0.5 || st.scrollWidth > st.clientWidth + 1)) out.push('stars outside the card');
              const bt = card.querySelector('.book-meta .bt'); if (bt && r(bt).right > kr.right + 0.5) out.push('title outside the card');
            }
            return [...new Set(out)];
          });
          for (const m of bad) { console.log(`FAULT ${lang} phone narrowcards ${w}px x ${cols} columns: ${m}`); fails++; summary.narrowcards = (summary.narrowcards || 0) + 1; }
          if (SHOTS && w === 412 && (cols === 3 || cols === 4)) await p.screenshot({ path: path.join(SHOTS, `R6-library-${cols}col${lang === 'ar' ? '-ar' : ''}.png`) });
        }
        await p.evaluate(() => document.documentElement.style.removeProperty('--lib-cols')); await p.setViewportSize({ width: 412, height: 915 });
      } catch (e) { console.log(`ERR   ${lang} phone narrowcards: ${String(e.message).split('\n')[0]} | ${await p.evaluate(() => location.hash + ' ' + document.body.className + ' ' + document.body.innerText.slice(0, 120).replace(/\s+/g, ' ')).catch(() => '')}`); fails++; }
    }
    if (errors.length) { console.log(`ERR   ${lang} ${dev}: page errors ${errors.slice(0, 3).join(' | ')}`); fails++; }
    await ctx.close(); // (one page closed before the next opens: the machine is short of memory)
  }
  console.log(fails ? `${fails} FAULTS ${JSON.stringify(summary)} (allowed ${allowedN} ${JSON.stringify(allowedBy)})` : `all passed (allowed ${allowedN} ${JSON.stringify(allowedBy)})`);
  await b.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
