// node tests/pdftools/ui.cjs <a.pdf> <b.pdf> <picture.png> <outdir> [lang]: drive the PDF tools in the built app —
// merge two PDFs, organise pages (extract / delete / reorder + turn), pictures → PDF, pages → pictures — saving
// every result and a screenshot of each sheet.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [a, b, pic, out, lang = 'en'] = process.argv.slice(2).map((x, i) => (i < 4 ? path.resolve(x) : x));
fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5199, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 900, height: 1000 }, acceptDownloads: true }); const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('console', (m) => { if (m.type() === 'error') console.log('console', m.text().slice(0, 300)); });
  page.on('dialog', (d) => { console.log('dialog:', d.message()); void d.accept(process.env.PW || ''); });
  await page.goto('http://localhost:5199/'); await page.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, lang); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [a, b]); await page.waitForFunction(() => document.querySelectorAll('.book-card').length >= 2, null, { timeout: 60000 }); await page.waitForTimeout(500);
  const save = async (name) => { const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120000 }), page.click('.sheet:last-of-type .convert-result button:nth-child(2)')]); const f = path.join(out, name); await dl.saveAs(f); console.log('saved', name, fs.statSync(f).size); };
  const openTools = async () => { await page.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((s) => s.remove())); await page.click('.library-tools .tool-btn[data-icon="file"]'); await page.waitForSelector('.sheet .convert-target'); };
  const tool = async (i) => { await page.click(`.sheet .convert-targets .convert-target:nth-child(${i})`); };
  const waitResult = async () => { await page.waitForSelector('.sheet:last-of-type .convert-result:not([hidden]) button', { timeout: 120000 }); };
  // Merge: both library PDFs, the second cut to its first page.
  await openTools(); await page.screenshot({ path: path.join(out, 'tools.png') });
  await tool(5); await page.waitForSelector('.sheet.stacked .tool-bar');
  await page.click('.sheet.stacked .tool-bar button:first-child'); await page.waitForSelector('.sheet.stacked input[type=checkbox]');
  for (const c of await page.$$('.sheet:last-of-type input[type=checkbox]')) await c.check();
  await page.click('.sheet:last-of-type .sheet-actions button'); await page.waitForFunction(() => document.querySelectorAll('.sheet:last-of-type .tool-row').length >= 2);
  await page.fill('.sheet:last-of-type .tool-row:nth-child(2) .tool-range', '1');
  await page.waitForTimeout(800); await page.screenshot({ path: path.join(out, 'merge.png') });
  await page.click('.sheet:last-of-type .sheet-actions .btn.primary'); await waitResult(); await save('merged.pdf');
  // Organise: the first PDF, pages 1 and 3 selected; extract, delete, and reorder (last page first, turned).
  await openTools(); await tool(6); await page.waitForSelector('.sheet:last-of-type .dest-row'); await page.click('.sheet:last-of-type .dest-row:first-child');
  await page.waitForSelector('.sheet:last-of-type .page-tile'); await page.waitForTimeout(1500);
  await page.fill('.sheet:last-of-type .organize-range', '1, 3'); await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(out, 'organize.png') });
  await page.click('.sheet:last-of-type .sheet-actions .btn.primary'); await waitResult(); await save('extract.pdf');
  await page.click('.sheet:last-of-type .sheet-actions button:nth-child(2)'); await waitResult(); await save('deleted.pdf');
  const tiles = await page.$$('.sheet:last-of-type .page-tile');
  // The last page turned, then moved to the front by typing its new place.
  const last = tiles[tiles.length - 1]; await (await last.$('.icon-btn')).click();
  await (await last.$('.page-pos')).click(); await page.fill('.page-pos-input', '1'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  await page.click('.sheet:last-of-type .sheet-actions button:nth-child(1)'); await waitResult(); await save('reordered.pdf');
  // Pictures → PDF.
  await openTools(); await tool(3); await page.waitForSelector('.sheet:last-of-type .tool-bar');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.click('.sheet:last-of-type .tool-bar button')]); await chooser.setFiles([pic, pic]);
  await page.waitForSelector('.sheet:last-of-type .tool-row'); await page.waitForTimeout(500); await page.screenshot({ path: path.join(out, 'images.png') });
  await page.click('.sheet:last-of-type .sheet-actions .btn.primary'); await waitResult(); await save('pictures.pdf');
  // Pages → pictures (pages 1-2 of the first PDF).
  await openTools(); await tool(9); await page.waitForSelector('.sheet:last-of-type .dest-row'); await page.click('.sheet:last-of-type .dest-row:first-child');
  await page.waitForSelector('.sheet:last-of-type .tool-range'); await page.fill('.sheet:last-of-type .tool-range', '1-2');
  await page.click('.sheet:last-of-type .sheet-actions .btn.primary'); await waitResult(); await save('pages.zip');
  // A password on the file (AES-256): the protected copy opens with it and refuses without.
  await openTools(); await tool(8); await page.waitForSelector('.sheet:last-of-type .dest-row'); await page.click('.sheet:last-of-type .dest-row:first-child');
  await page.waitForSelector('.sheet:last-of-type input[type=password]'); await page.fill('.sheet:last-of-type input[type=password]', 'pw1'); await page.screenshot({ path: path.join(out, 'protect.png') });
  await page.click('.sheet:last-of-type .sheet-actions .btn.primary'); await waitResult(); await save('protected.pdf');
  { const { execFileSync } = require('child_process'); const enc = execFileSync('qpdf', ['--password=pw1', '--show-encryption', path.join(out, 'protected.pdf')]).toString(); let refused = false; try { refused = /Incorrect password/.test(execFileSync('qpdf', ['--show-encryption', path.join(out, 'protected.pdf')], { stdio: 'pipe' }).toString()); } catch { refused = true; }
    console.log(/R = 6/.test(enc) && /user password/.test(enc) && refused ? 'ok protected: AES-256, opens with the password, refused without' : 'FAIL protected: ' + JSON.stringify(enc.slice(0, 300)) + ' refused=' + refused); }
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
