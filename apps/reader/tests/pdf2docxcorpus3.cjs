// node tests/pdf2docxcorpus3.cjs: PDF -> Word over a second corpus — six KINDS of document (invoice, paper, Arabic page,
// slides, form, book), each made by the two or three programs most natural for it (tests/pdf2docx/corpus3: pdf/<kind>-<program>.pdf,
// truth/<kind>.json, sources and generator in src/ and make.sh). Scored per PDF and per measure, 0-1 each, by corpus3/score3.cjs
// (it reuses corpus2/score.cjs's reader and measures and adds what the new kinds need).
// Needs only the committed PDFs. With soffice on the PATH each .docx is also opened by LibreOffice (its page count is scored too).
// Pass/fail: no cell under its floor (floors.json: a score minus 0.02; `cells` for «Easy to edit», `exact` for «Exact look»), and
// in either result the PDF's own text layer is in the .docx word for word (text_layer_recall >= 0.99).
//   KR_CORPUS_WRITE_FLOORS=1  raise floors to this run's scores minus 0.02 (never lowers one)   KR_CORPUS_ONLY=id,id  a subset
//   KR_CORPUS_MODES=edit|exact|edit,exact   KR_CORPUS_DOCX=<dir>  score the .docx files already in <dir> (no browser)
//   KR_CORPUS_SAVE=<dir>  keep the converted .docx   KR_CORPUS_OUT=<dir>  where scores.json/.md go (default corpus3/out)   KR_NOSOFFICE=1
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { execSync } = require('child_process');
const { readDocx, pdfTextWords, wordRecall } = require('./pdf2docx/corpus2/score.cjs');
const { score3, pdfInfo3, ORDER } = require('./pdf2docx/corpus3/score3.cjs');
const ROOT = path.join(__dirname, 'pdf2docx/corpus3'); const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2dc3-'));
const haveSoffice = (() => { if (process.env.KR_NOSOFFICE) return false; try { execSync('soffice --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
const only = process.env.KR_CORPUS_ONLY ? process.env.KR_CORPUS_ONLY.split(',') : null; const outDir = path.resolve(process.env.KR_CORPUS_OUT || path.join(ROOT, 'out')); fs.mkdirSync(outDir, { recursive: true });
const saveDir = process.env.KR_CORPUS_SAVE ? path.resolve(process.env.KR_CORPUS_SAVE) : null; if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

async function convert(browser, file, mode) {
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => { void d.accept(''); });
  try {
    await page.goto('http://127.0.0.1:5214/'); await page.evaluate((m) => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.convert', JSON.stringify({ docxResult: m })); }, mode); await page.reload(); await page.waitForSelector('.library-view');
    await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
    const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
    if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
    await page.waitForSelector('.convert-target'); const t0 = Date.now(); await page.click('.convert-target:has-text("Word")');
    await page.waitForSelector('.convert-result:not([hidden]) button, .sheet .src:has-text("failed")', { timeout: 150000 }); const secs = (Date.now() - t0) / 1000;
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.convert-result button:has-text("Save")')]);
    const out = path.join(tmp, path.basename(file, '.pdf') + (mode === 'exact' ? '.exact' : '') + '.docx'); await dl.saveAs(out); return { out, secs, errs };
  } catch (e) { return { out: null, secs: 0, errs: errs.concat(String(e.message).slice(0, 160)) }; } finally { await ctx.close(); }
}
// LibreOffice's page count of the .docx (0 when it cannot open it).
const loPages = (docx) => { try { execSync(`cd "${tmp}" && rm -f "${path.basename(docx, '.docx')}.pdf" && soffice -env:UserInstallation=file://${tmp}/lo --headless --convert-to pdf "${docx}" >/dev/null 2>&1`, { timeout: 120000 }); const pdf = path.join(tmp, path.basename(docx, '.docx') + '.pdf'); return fs.existsSync(pdf) ? +/Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${pdf}"`).toString())[1] : 0; } catch { return 0; } };
const f2 = (x) => (x === null || x === undefined ? '  - ' : x.toFixed(2));

(async () => {
  const modes = (process.env.KR_CORPUS_MODES || 'edit,exact').split(','); const R = { edit: {}, exact: {} };
  const ids = fs.readdirSync(path.join(ROOT, 'pdf')).filter((f) => f.endsWith('.pdf')).map((f) => f.slice(0, -4)).sort().filter((id) => !only || only.includes(id));
  const pre = process.env.KR_CORPUS_DOCX ? path.resolve(process.env.KR_CORPUS_DOCX) : null; let browser = null;
  if (!pre) { await new Promise((r) => server.listen(5214, r)); browser = await chromium.launch(); }
  for (const id of ids) {
    const file = path.join(ROOT, 'pdf', id + '.pdf'); const kind = id.split('-')[0]; const truth = JSON.parse(fs.readFileSync(path.join(ROOT, 'truth', kind + '.json'), 'utf8'));
    // (A word mixing an Arabic letter with Latin ones is stock pdf.js's leftover of a positional glyph's name — «ةl», «نf» — not text.)
    const layer = await pdfTextWords(file).then((ws) => ws.filter((w) => !(/[\u0600-\u06ff]/.test(w) && /[a-z]/.test(w)))).catch(() => null); const info = await pdfInfo3(file).catch(() => ({ pages: 1 }));
    for (const mode of modes) {
      const tag = id + (mode === 'exact' ? '.exact' : ''); let docx, secs = 0, errs = [];
      if (pre) docx = path.join(pre, tag + '.docx'); else { const r = await convert(browser, file, mode); docx = r.out; secs = r.secs; errs = r.errs; }
      if (!docx || !fs.existsSync(docx)) { R[mode][id] = { scores: {}, secs, failed: true, errs }; console.log(id.padEnd(16), mode, 'CONVERSION FAILED', errs.join(' | ')); continue; }
      if (saveDir) fs.copyFileSync(docx, path.join(saveDir, tag + '.docx'));
      const D = await readDocx(fs.readFileSync(docx)); const S = await score3(D, truth, { id, kind, mode, pages: info.pages });
      const wr = layer && layer.length ? wordRecall(layer, D) : null; S.text_layer_recall = wr ? wr.recall : null;
      if (haveSoffice) { const n = loPages(docx); S.lo_opens = n > 0 ? 1 : 0; if (n) S.pages = n === info.pages ? 1 : Math.abs(n - info.pages) === 1 ? 0.5 : 0; }
      R[mode][id] = { scores: S, secs, secsPerPage: secs / (info.pages || 1), pages: info.pages, errs, missed: wr ? wr.miss.slice(0, 30) : [] };
      const v = Object.entries(S).filter(([k, x]) => k !== 'text_layer_recall' && x !== null && x !== undefined).map(([, x]) => x);
      console.log(id.padEnd(16), mode.padEnd(5), 'ok', secs.toFixed(1) + 's', (v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)).toFixed(2), wr ? 'layer ' + wr.recall.toFixed(3) + (wr.miss.length ? ' missing: ' + wr.miss.slice(0, 12).join(' ') : '') : '');
    }
  }
  if (browser) { await browser.close(); server.close(); }
  const floorsFile = path.join(ROOT, 'floors.json'); const F = fs.existsSync(floorsFile) ? JSON.parse(fs.readFileSync(floorsFile, 'utf8')) : { note: 'cells: floors of «Easy to edit»; exact: floors of «Exact look». Each a score minus 0.02 (never below 0); KR_CORPUS_WRITE_FLOORS=1 only raises them.', cells: {}, exact: {} };
  const md = ['# PDF to Word, corpus3 (kinds of document) scores', ''];
  for (const mode of modes) {
    const res = R[mode]; const measures = ORDER.filter((m) => Object.values(res).some((r) => r.scores[m] !== undefined && r.scores[m] !== null));
    const mean = (id) => { const v = measures.filter((m) => m !== 'text_layer_recall').map((m) => res[id].scores[m]).filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    md.push(`## ${mode === 'edit' ? 'Easy to edit (default)' : 'Exact look'}`, '', 'Measures 0-1 (higher is better); "-" = not applicable; the mean leaves out text_layer_recall (the guard).', '', '| pdf | mean | pages | s/page | ' + measures.join(' | ') + ' |', '|---|---|---|---|' + measures.map(() => '---').join('|') + '|');
    for (const id of Object.keys(res)) { const r = res[id]; md.push(`| ${id} | ${f2(mean(id))} | ${r.pages} | ${r.secsPerPage !== undefined ? r.secsPerPage.toFixed(2) : '-'} | ` + measures.map((m) => f2(r.scores[m]).trim()).join(' | ') + ' |'); }
    md.push('');
    console.log(`\n==== ${mode === 'edit' ? 'Easy to edit' : 'Exact look'}`);
    for (let i = 0; i < measures.length; i += 10) { const ms = measures.slice(i, i + 10); console.log('\n' + 'pdf'.padEnd(16) + ms.map((m) => m.slice(0, 9).padStart(10)).join('')); for (const id of Object.keys(res)) console.log(id.padEnd(16) + ms.map((m) => f2(res[id].scores[m]).padStart(10)).join('')); }
    console.log('\nmean per pdf: ' + Object.keys(res).map((id) => `${id} ${f2(mean(id)).trim()}`).join(', '));
    const tot = Object.values(res).reduce((a, r) => a + (r.secs || 0), 0), pg = Object.values(res).reduce((a, r) => a + (r.pages || 0), 0); console.log(`conversion time ${tot.toFixed(0)} s, ${(tot / Math.max(1, pg)).toFixed(2)} s/page (not judged)`);
    for (const id of Object.keys(res)) { const v = res[id].scores.text_layer_recall; if (v === null || v === undefined) continue; ok(`${mode}: ${id} keeps the PDF's text, word for word (${v.toFixed(3)} >= 0.99)`, v >= 0.99); if (v < 0.99) console.log('  missing:', res[id].missed.join(' ')); }
    const key = mode === 'edit' ? 'cells' : 'exact'; F[key] = F[key] || {};
    if (process.env.KR_CORPUS_WRITE_FLOORS) { for (const id of Object.keys(res)) { const c = F[key][id] = F[key][id] || {}; for (const m of measures) { const v = res[id].scores[m]; if (v === null || v === undefined || m === 'text_layer_recall') continue; const nf = Math.max(0, Math.round((v - 0.02) * 1000) / 1000); if (c[m] === undefined || nf > c[m]) c[m] = nf; } } }
    else {
      ok('floors.json exists', fs.existsSync(floorsFile)); let checked = 0; const under = [];
      for (const id of Object.keys(res)) for (const [m, fl] of Object.entries(F[key][id] || {})) { const v = res[id].scores[m]; if (v === undefined) continue; checked++; if (v === null || v < fl) under.push(`${id}/${m} ${v === null ? 'null' : v.toFixed(3)} < ${fl}`); }
      ok(`${mode}: every pdf x measure cell is at or above its floor (${checked} cells)`, under.length === 0); for (const u of under) console.log('  under:', u);
      for (const id of Object.keys(res)) ok(`${mode}: ${id} converted`, !res[id].failed);
    }
  }
  fs.writeFileSync(path.join(outDir, 'scores.md'), md.join('\n') + '\n'); fs.writeFileSync(path.join(outDir, 'scores.json'), JSON.stringify(R, null, 1)); console.log('tables saved under', outDir);
  if (process.env.KR_CORPUS_WRITE_FLOORS) { fs.writeFileSync(floorsFile, JSON.stringify(F, null, 1) + '\n'); console.log('floors raised in', floorsFile); }
  fs.rmSync(tmp, { recursive: true, force: true }); console.log(fails ? `\n${fails} FAILED` : '\nall ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
