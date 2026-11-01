// node tests/translator/run.cjs: the AI translator against a stand-in provider (an OpenAI-compatible endpoint
// answered here): italics come through, the Arabic paragraph is not sent, each batch carries the book, the chapter
// and the lines before; a reply of the wrong length is asked for again in halves; the next chapter is translated
// ahead; «show the original too» puts the translation under the dimmed original; names proposed for the glossary
// are added to it.
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execFileSync } = require('child_process');
const DIST = path.resolve(__dirname, '../../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.woff2': 'font/woff2', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const out = process.argv[2] || path.join(require('os').tmpdir(), 'kr-translator'); fs.mkdirSync(out, { recursive: true });
const book = path.join(out, 'gate.epub'); execFileSync('python3', [path.join(__dirname, 'make.py'), book]);
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const ctx = await b.newContext({ ...devices['Pixel 7'], locale: 'en' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const asked = []; let broke = false; let limited = 0; let daily = false; let slow = false;
  await p.route('https://ai.test/v1/chat/completions', async (r) => {
    // Gemini's «too many requests», the first time: the minute's limit (wait a second), then the answer.
    if (limited === 0 || daily) { limited++; const quotaId = daily ? 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' : 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier'; return r.fulfill({ status: 429, headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ error: { code: 429, message: 'You exceeded your current quota', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: '60' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '1s' }] } }) }); }
    if (slow) await new Promise((res) => setTimeout(res, 400));
    const body = JSON.parse(r.request().postData()); const system = body.messages[0].content; const user = body.messages[1].content; asked.push({ system, user });
    let content;
    if (/translation glossary/.test(system)) content = JSON.stringify([{ from: 'Lin Feng', to: 'لين فنغ', kind: 'person' }]);
    else { const items = JSON.parse(user); const tr = items.map((x) => `AR(${x})`); content = JSON.stringify(!broke && items.length > 1 ? (broke = true, tr.slice(1)) : tr); }
    await r.fulfill({ headers: { 'access-control-allow-origin': '*', 'content-type': 'application/json' }, body: JSON.stringify({ choices: [{ message: { content } }] }) });
  });
  await p.route('https://ai.test/**', (r) => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET' } }) : r.fallback());
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'custom', aiBaseUrl: 'https://ai.test/v1', aiKey: 'k', aiModel: 'm', aiTarget: 'ar', aiTask: 'translate' }); localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await p.reload(); await p.waitForSelector('.library-view');
  await p.setInputFiles('input[type=file]', [book]); await p.waitForSelector('.book-card', { timeout: 60000 }); await p.waitForTimeout(1200);
  const id = await p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result[0].id); }; }));
  await p.evaluate((i) => { location.hash = `#/read/${i}`; }, id); await p.waitForSelector('.kr-chapter', { timeout: 30000 }); await p.waitForTimeout(1500);
  // Open the translator (the toolbar's button, else the reader's command).
  const btn = await p.$('button[aria-label="AI chapter translation"]');
  if (btn) await btn.click({ force: true }); else await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'translate' })));
  await p.waitForSelector('.tr-pill', { timeout: 10000 });
  await p.waitForFunction(() => document.querySelectorAll('.kr-chapter .kr-translated').length >= 2, null, { timeout: 15000 });
  const first = await p.$eval('.kr-chapter p.kr-translated', (e) => e.innerHTML); console.log('first:', first);
  ok('italics come through the translation', /<i>old gate<\/i>/.test(first) && /^AR\(/.test(first.replace(/<[^>]+>/g, '')));
  ok('the Arabic paragraph is left as it is', await p.evaluate(() => { const ar = [...document.querySelectorAll('.kr-chapter p')].find((x) => /مرحبًا/.test(x.textContent)); return !!ar && !ar.classList.contains('kr-translated'); }));
  ok('never sent', !asked.some((a) => /مرحبًا/.test(a.user)));
  const firstAsk = asked.find((a) => /Lin Feng/.test(a.user)); console.log('system:', firstAsk?.system.split('\n').filter((l) => /Book|Chapter|tags/.test(l)).join(' | '));
  ok('the book and the chapter given as context, the tags explained', !!firstAsk && /Book: Gate Story/.test(firstAsk.system) && /Chapter:/.test(firstAsk.system) && /<i>/.test(firstAsk.system));
  ok('a reply of the wrong length asked for again in halves', broke && asked.filter((a) => !/glossary/.test(a.system)).length >= 3);
  await p.waitForFunction(() => true); await p.waitForTimeout(1500);
  ok('the next chapter translated ahead', asked.some((a) => /The road went on/.test(a.user)));
  // Both shown.
  await p.click('.tr-pill .tr-mode'); await p.waitForTimeout(300);
  const both = await p.$eval('.kr-chapter p.kr-translated', (e) => ({ orig: e.querySelector('.kr-tr-orig')?.textContent, line: e.querySelector('.kr-tr-line')?.textContent }));
  console.log('both:', JSON.stringify(both)); ok('the original dimmed above, the translation under it', /Lin Feng looked/.test(both.orig || '') && /^AR\(/.test(both.line || ''));
  await p.click('.tr-pill .tr-mode'); await p.waitForTimeout(200);
  ok('back to the translation alone', !(await p.$('.kr-chapter .kr-tr-orig')));
  // Names for the glossary.
  await p.click('.tr-pill button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Customise' }).click();
  await p.waitForSelector('.tr-options'); await p.locator('.tr-options button', { hasText: 'Find names' }).click();
  await p.waitForSelector('.tr-term'); await p.locator('.sheet button', { hasText: 'Add for this book' }).click(); await p.waitForTimeout(300);
  const gl = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.glossary') || '[]')); console.log('glossary:', JSON.stringify(gl));
  ok('a proposed name added to this book\'s glossary', gl.some((x) => x.from === 'Lin Feng' && x.to === 'لين فنغ' && x.book));
  ok('the minute\'s limit waited out, no error shown', limited === 1 && !(await p.$('.toast.error')));
  // The search across languages: the words found in the original, the translation under it; then in the translation.
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'search' }))); await p.waitForSelector('.search-langs:not([hidden])', { timeout: 8000 });
  const langs = await p.$$eval('.search-langs button', (e) => e.map((x) => x.textContent)); console.log('search in:', langs.join(' | '));
  ok('a book with translations: the search offers both languages', langs.length === 3 && /Both/.test(langs[0]) && /Original/.test(langs[1]));
  await p.fill('input[type=search]', 'old gate'); await p.waitForSelector('.pair-hit', { timeout: 8000 });
  const hit = await p.$eval('.pair-hit', (e) => ({ o: e.querySelector('.ctx.orig')?.textContent, t: e.querySelector('.ctx.trl')?.textContent, mark: e.querySelector('.ctx.orig mark')?.textContent })); console.log('hit:', JSON.stringify(hit));
  ok('found in the original, the translation under it', /Lin Feng looked/.test(hit.o) && /^AR\(/.test(hit.t) && hit.mark === 'old gate');
  await p.click('.search-langs button >> nth=2'); await p.fill('input[type=search]', 'AR(Then'); await p.waitForTimeout(700);
  const hits2 = await p.$$eval('.pair-hit .ctx.trl mark', (e) => e.map((x) => x.textContent)); console.log('in the translation:', hits2.join(' | '));
  ok('searched in the translation alone', hits2.length === 1 && hits2[0] === 'AR(Then');
  await p.fill('input[type=search]', 'old gate'); await p.waitForTimeout(700);
  ok('the original\'s words not found when only the translation is searched', (await p.$$('.pair-hit .ctx.orig mark')).length === 0);
  // The day's quota used up: said plainly, once, and nothing more asked.
  daily = true; const before = limited; await p.evaluate(() => document.querySelectorAll('.panel, .sheet, .sheet-scrim').forEach((e) => e.remove()));
  await p.click('.tr-pill button[aria-label="Translate the chapter again"]'); await p.waitForSelector('.toast', { timeout: 15000 });
  const tx = await p.$eval('.toast', (e) => e.textContent); console.log('daily:', tx, limited - before);
  ok('the day\'s quota: said plainly, not asked again and again', /free quota/.test(tx) && limited - before <= 3);
  // The bar fits the screen; turned off, every paragraph keeps the direction the book gave it.
  ok('the bar within the screen', await p.$eval('.tr-pill', (e) => e.getBoundingClientRect().right <= innerWidth + 1 && e.getBoundingClientRect().left >= -1));
  daily = false; slow = true;
  await p.click('.tr-pill button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Clear' }).click(); await p.waitForTimeout(300);
  await p.click('.tr-pill .tr-toggle'); await p.waitForTimeout(300);
  const dirs = await p.$$eval('.kr-chapter p', (e) => e.map((x) => x.getAttribute('dir'))); console.log('directions after:', dirs.join(','));
  ok('turned off: the paragraphs\' own directions back (none taken from the chapter)', dirs.every((d) => d === 'ltr' || d === 'rtl') && dirs.filter((d) => d === 'rtl').length === 1);
  // The whole book as a job: on in the background, its progress where jobs are shown.
  await p.click('.tr-pill button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Translate ahead' }).click();
  await p.locator('.sheet button', { hasText: 'Translate the whole book' }).click(); await p.keyboard.press('Escape');
  await p.waitForSelector('.job-chip', { timeout: 8000 }); const chip = await p.$eval('.job-chip', (e) => e.textContent); console.log('job:', chip);
  ok('the whole book goes on as a job, its progress shown', /Translating «Gate Story»/.test(chip) && /Paragraphs: \d/.test(chip));
  await p.waitForSelector('.job-chip', { state: 'detached', timeout: 20000 }); ok('the job ends by itself', true);
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
