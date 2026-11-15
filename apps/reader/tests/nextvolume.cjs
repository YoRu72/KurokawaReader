// node tests/nextvolume.cjs: Back after «Next volume» (src/views/reader.ts goNextVolume / askVolumeBack), on an imitated
// Android phone (Capacitor's Back imitated as the shell calls it) and on a computer (Esc):
//  1. at the end of volume 1 «Next volume: …» opens volume 2 — in its place: the way back does not grow;
//  2. the phone's Back from volume 2 shows the sheet (Back to the previous volume / Main page / Stay here) and stays;
//     Back again closes the sheet (stays); the top bar's arrow shows it too; «Back to the previous volume» opens volume
//     1 at the place it was left (its end); Back from it then goes to the library — no sheet, no bounce to volume 2;
//  3. chained: 1 → 2 → 3, «Main page» from volume 3 goes to the library, and Back there leaves the app (nothing
//     beneath: no loop of volumes); the previous volume of 3 is 2, not 1;
//  4. a computer: Esc from a volume opened by «Next volume» shows the sheet; «Stay here» stays;
//  5. a volume opened from the library (not by «Next volume») leaves at the first Back, no sheet.
// Screenshot (deviceScaleFactor 2) of the sheet in KR_SHOTS when given.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SHOTS = process.env.KR_SHOTS ? path.resolve(process.env.KR_SHOTS) : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-nextvolume-'));
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

async function makeEpub(file, n) {
  const JSZip = require(path.resolve(__dirname, '../node_modules/jszip')); const z = new JSZip();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  z.file('OEBPS/c1.xhtml', `<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xml:lang="en"><head><title>t</title></head><body><h1>Volume ${n}</h1>${Array.from({ length: 30 }, (_, i) => `<p>[V${n}-P${i}] The keeper climbed the stairs of the old tower at dusk and lit the lamp.</p>`).join('')}</body></html>`);
  z.file('OEBPS/nav.xhtml', '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Contents</title></head><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav></body></html>');
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="utf-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-nv-${n}</dc:identifier><dc:title>Lantern Tales Vol. ${n}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  fs.writeFileSync(file, await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
}
const CAP = () => {
  window.__cap = {};
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: {
    App: { addListener: (ev, fn) => { window.__cap[ev] = fn; return Promise.resolve({ remove() {} }); }, getLaunchUrl: async () => null, minimizeApp: async () => { window.__minimized = true; } },
    Kurokawa: { setVolumeKeys: async () => undefined, setEdgeGuard: async () => ({ ok: true }) },
  } };
};

async function session(phone, fn) {
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext(phone ? { viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: 'block', locale: 'en' } : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, serviceWorkers: 'block', locale: 'en' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  if (phone) await p.addInitScript(CAP);
  await p.goto(`http://127.0.0.1:${server.address().port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', bookPage: 'never', doubleBackExit: false })); });
  await p.reload(); await p.waitForSelector('.library-view');
  const files = []; for (const n of [1, 2, 3]) { const f = path.join(TMP, `v${n}.epub`); await makeEpub(f, n); files.push(f); }
  await p.setInputFiles('.library-view input[type=file]', files);
  let ids = {};
  for (let i = 0; i < 200 && Object.keys(ids).length < 3; i++) { await p.waitForTimeout(250); const all = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result.map((b) => ({ id: b.id, title: b.title }))); }; })); for (const b of all) { const m = /Vol\. (\d)/.exec(b.title); if (m) ids[m[1]] = b.id; } await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); }); }
  try { await fn(p, ids, errors); } finally { ok(`${phone ? 'phone' : 'computer'}: no page errors`, errors.length === 0, errors); await br.close(); }
}
const shown = (p) => p.evaluate(() => { const v = document.querySelector('.reader-view .reader-flow h1'); return v && v.offsetParent ? v.textContent : document.querySelector('.library-view') ? 'library' : '?'; });
const openVol = async (p, id) => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id); await p.waitForSelector('.reader-flow .kr-content p >> visible=true'); await p.waitForTimeout(900); };
const toEndAndNext = async (p) => {
  for (let i = 0; i < 12; i++) { await p.evaluate(() => { const s = document.querySelector('.reader-scroll'); s.scrollTop = s.scrollHeight; }); await p.waitForTimeout(250); if (await p.$('.next-volume')) break; }
  await p.waitForSelector('.next-volume', { timeout: 10000 }); await p.click('.next-volume'); await p.waitForTimeout(1200);
};
const sheetUp = (p) => p.evaluate(() => !!document.querySelector('.sheet.vol-back'));
const histLen = (p) => p.evaluate(() => history.length);
const androidBack = async (p) => { await p.evaluate(() => window.__cap.backButton({ canGoBack: true })); await p.waitForTimeout(700); };

(async () => {
  await new Promise((r) => server.listen(0, r));
  await session(true, async (p, ids) => {
    ok('three volumes imported', Object.keys(ids).length === 3, ids);
    await openVol(p, ids[1]);
    const h0 = await histLen(p);
    await toEndAndNext(p);
    ok('«Next volume» opens volume 2 in the place of volume 1 (the way back does not grow)', (await shown(p)) === 'Volume 2' && (await histLen(p)) === h0, { shown: await shown(p), h0, h1: await histLen(p) });
    await androidBack(p);
    ok('the phone\'s Back from volume 2: the sheet, still in volume 2', await sheetUp(p) && (await shown(p)) === 'Volume 2');
    const labels = await p.evaluate(() => [...document.querySelectorAll('.sheet.vol-back button')].map((b) => b.textContent.trim()));
    ok('the sheet: Back to the previous volume (its title), Main page, Stay here', labels.some((l) => /previous volume/.test(l) && /Vol\. 1/.test(l)) && labels.includes('Main page') && labels.includes('Stay here'), labels);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'next-volume-back-sheet.png') });
    await androidBack(p);
    ok('Back again closes the sheet and stays in volume 2', !(await sheetUp(p)) && (await shown(p)) === 'Volume 2');
    await p.click('.reader-view .topbar button[data-icon="back"]'); await p.waitForTimeout(500);
    ok('the top bar\'s arrow shows the sheet too', await sheetUp(p) && (await shown(p)) === 'Volume 2');
    await p.click('.sheet.vol-back .vol-back-prev'); await p.waitForSelector('.reader-flow .kr-content p >> visible=true'); await p.waitForTimeout(1500);
    const atEnd = await p.evaluate(() => { const s = document.querySelector('.reader-scroll'); return s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight); });
    ok('«Back to the previous volume»: volume 1, at the place it was left (its end)', (await shown(p)) === 'Volume 1' && atEnd > 0.8, { shown: await shown(p), atEnd });
    await androidBack(p);
    ok('Back from volume 1 then: the library — no sheet, no bounce to volume 2', (await shown(p)) === 'library' && !(await sheetUp(p)), await shown(p));
    // 3. chained
    await openVol(p, ids[1]); await toEndAndNext(p); await toEndAndNext(p);
    ok('chained: 1 → 2 → 3', (await shown(p)) === 'Volume 3');
    await androidBack(p);
    const prevTitle = await p.evaluate(() => document.querySelector('.sheet.vol-back .vol-back-prev')?.textContent ?? '');
    ok('the previous volume of 3 is 2', /Vol\. 2/.test(prevTitle), prevTitle);
    await p.click('.sheet.vol-back .vol-back-home'); await p.waitForTimeout(1200);
    ok('«Main page»: the library', (await shown(p)) === 'library');
    await androidBack(p);
    ok('Back on the library then: the app put away (nothing beneath — no loop of volumes)', await p.evaluate(() => !!window.__minimized) && (await shown(p)) === 'library');
    // 5. opened from the library: no sheet
    await openVol(p, ids[2]); await androidBack(p);
    ok('a volume opened from the library: the first Back leaves, no sheet', (await shown(p)) === 'library' && !(await sheetUp(p)));
  });
  await session(false, async (p, ids) => {
    await openVol(p, ids[1]); await toEndAndNext(p);
    await p.keyboard.press('Escape'); await p.waitForTimeout(500);
    ok('a computer: Esc from volume 2 shows the sheet', await sheetUp(p) && (await shown(p)) === 'Volume 2');
    await p.click('.sheet.vol-back .vol-back-stay'); await p.waitForTimeout(400);
    ok('«Stay here» stays', !(await sheetUp(p)) && (await shown(p)) === 'Volume 2');
    await p.keyboard.press('Alt+ArrowLeft'); await p.waitForTimeout(500);
    ok('a computer: Alt+← shows it too', await sheetUp(p));
    await p.keyboard.press('Escape'); await p.waitForTimeout(400);
    ok('Esc with the sheet up closes the sheet only', !(await sheetUp(p)) && (await shown(p)) === 'Volume 2');
  });
  server.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
