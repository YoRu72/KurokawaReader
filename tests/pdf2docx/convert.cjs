// node conv.cjs <pdf> <outdir>: import a PDF in the app, convert to DOCX, save it, render it with LibreOffice, and put original and result side by side.
if (process.argv.length < 4) { console.log('usage: node tests/pdf2docx/convert.cjs <file.pdf> <outdir>   (PW=password, NOLO=1 to skip LibreOffice)'); process.exit(1); }
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { execSync } = require('child_process');
const DIST = path.resolve(__dirname, '../../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [pdf, out] = [path.resolve(process.argv[2]), path.resolve(process.argv[3])]; fs.mkdirSync(out, { recursive: true });
(async () => {
  await new Promise((r) => server.listen(5197, r));
  const browser = await chromium.launch(); const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true }); const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('dialog', (d) => { console.log('dialog:', d.message()); void d.accept(process.env.PW || ''); }); page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('console', m.text().includes('P2D') ? m.text() : m.text().slice(0, 300)); });
  if (!process.env.NOLO) await page.addInitScript((l) => { globalThis.krDebugP2D = true; if (l[2]) globalThis.krNoLow = true; if (l[0]) globalThis.krDebugLine = l[0]; if (l[1]) globalThis.krDebugCtx = +l[1]; }, [process.env.LINE || "", process.env.CTX || "", process.env.NOLOW || ""]); await page.goto('http://localhost:5197/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [pdf]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(500);
  const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sheet');
  await page.click('.sheet button:has-text("Convert")'); await page.waitForSelector('.convert-target');
  // PROF=file.json: a CPU profile of the page's main thread during the conversion, its hottest functions printed.
  if (process.env.TIMING) await page.evaluate(() => { globalThis.krTiming = {}; });
  const cdp = process.env.PROF ? await page.context().newCDPSession(page) : null;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 200 }); await cdp.send('Profiler.start'); }
  const t0 = Date.now();
  // TARGET picks another output (its label in the sheet: "Text", "EPUB", "PDF"…); the file is then only saved.
  const target = process.env.TARGET || 'Word';
  if (process.env.STAGES) console.log('stage: convert');
  await page.click(`.convert-target:has-text("${target}")`);
  await page.waitForSelector('.convert-result:not([hidden]) button, .sheet .src:has-text("failed")', { timeout: 1500000 });
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.click('.convert-result button:has-text("Save")')]);
  const docx = path.join(out, target === 'Word' ? 'out.docx' : `out.${path.extname(dl.suggestedFilename()).slice(1) || 'bin'}`); await dl.saveAs(docx);
  console.log('docx', fs.statSync(docx).size, 'B in', Date.now() - t0, 'ms');
  if (process.env.TIMING) console.log('timing', JSON.stringify(await page.evaluate(() => Object.fromEntries(Object.entries(globalThis.krTiming || {}).map(([k, v]) => [k, Math.round(v)])))));
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop'); fs.writeFileSync(process.env.PROF, JSON.stringify(profile));
    const dt = {}; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const k = `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`; dt[k] = (dt[k] || 0) + (profile.timeDeltas[i] || 0); }
    for (const [k, v] of Object.entries(dt).sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log((v / 1000).toFixed(0).padStart(7), 'ms', k);
  }
  await browser.close(); server.close();
  if (process.env.NOLO || target !== 'Word') return;
  execSync(`cd ${out} && rm -f out.pdf && soffice --headless --convert-to pdf out.docx >/dev/null 2>&1`);
  console.log('docx pages', execSync(`pdfinfo ${out}/out.pdf | grep Pages`).toString().trim(), 'pdf pages', execSync(`pdfinfo ${pdf} | grep Pages`).toString().trim());
  execSync(`cd ${out} && rm -f a-*.png b-*.png && pdftoppm -r 60 -png ${pdf} a && pdftoppm -r 60 -png out.pdf b`);
})();
