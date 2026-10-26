// node tests/pdftext/search.cjs <file.pdf> <query> [shot.png]: open a PDF in the built reader, search it, and print
// each hit's page and excerpt (what the search panel lists).
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../../dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const [pdf, query, shot] = [path.resolve(process.argv[2]), process.argv[3], process.argv[4]];
(async () => {
  await new Promise((r) => server.listen(5193, r));
  const browser = await chromium.launch(); const page = await (await browser.newContext({ viewport: { width: 1100, height: 1000 } })).newPage();
  page.on('pageerror', (e) => console.log('pageerror', e.message)); page.on('dialog', (d) => void d.accept(process.env.PW || ''));
  await page.goto('http://localhost:5193/'); await page.evaluate(() => { localStorage.setItem('kr.lang', 'ar'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
  await page.setInputFiles('input[type=file]', [pdf]); await page.waitForSelector('.book-card', { timeout: 60000 });
  await page.click('.book-card'); await page.waitForSelector('.pdf-page canvas', { timeout: 60000 });
  if (process.env.WAIT) await page.waitForTimeout(+process.env.WAIT);
  await page.keyboard.press('Control+f').catch(() => {}); await page.waitForTimeout(300);
  if (!(await page.$('input[type=search]'))) { const btns = await page.$$('.reader-view button[aria-label]'); for (const b of btns) { const l = await b.getAttribute('aria-label'); if (/بحث|Search/.test(l)) { await b.click(); break; } } }
  await page.waitForSelector('input[type=search]'); const cdp = process.env.PROF ? await page.context().newCDPSession(page) : null;
  if (cdp) { await cdp.send('Profiler.enable'); await cdp.send('Profiler.setSamplingInterval', { interval: 500 }); await cdp.send('Profiler.start'); }
  const t0 = Date.now(); await page.fill('input[type=search]', query);
  // (Done when the panel's status says how many results there are; checked twice a second, cheaply.)
  await page.waitForFunction(() => { const st = [...document.querySelectorAll('.panel div[style]')].find((d) => /النتائج|لا نتائج|result/i.test(d.textContent ?? '')); return !!st && !/…/.test(st.textContent ?? ''); }, null, { timeout: 600000, polling: 500 }).catch(() => {});
  console.log('search ms', Date.now() - t0, '|', await page.evaluate(() => document.querySelector('.panel')?.querySelector('div[style]')?.textContent));
  if (cdp) {
    const { profile } = await cdp.send('Profiler.stop'); const dt = {}; const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    for (let i = 0; i < profile.samples.length; i++) { const n = byId.get(profile.samples[i]); const k = `${n.callFrame.functionName || '(anon)'} ${path.basename(n.callFrame.url)}:${n.callFrame.lineNumber}`; dt[k] = (dt[k] || 0) + (profile.timeDeltas[i] || 0); }
    for (const [k, v] of Object.entries(dt).sort((a, b) => b[1] - a[1]).slice(0, 22)) console.log((v / 1000).toFixed(0).padStart(7), 'ms', k);
  }
  await page.waitForTimeout(500);
  if (process.env.DBG) await page.screenshot({ path: process.env.DBG });
  for (const t of await page.$$eval('li.hit', (els) => els.slice(0, 12).map((e) => e.innerText.replace(/\s*\n\s*/g, ' | ')))) console.log(t);
  if (shot) { await page.click('li.hit button'); await page.waitForTimeout(1500); await page.screenshot({ path: shot }); }
  await browser.close(); server.close();
})().catch((e) => { console.error(e); process.exit(1); });
