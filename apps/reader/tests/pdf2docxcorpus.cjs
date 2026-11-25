// node tests/pdf2docxcorpus.cjs: PDF -> Word over a corpus of PDFs made by many programs (tests/pdf2docx/corpus2), scored per
// program and per measure against one made-up source document (corpus2/source.json), 0-1 each (see corpus2/score.cjs).
// Needs only the committed PDFs (no LibreOffice, Chrome, LaTeX... to run; the generators are in corpus2/make/). With soffice on the
// PATH each .docx is also opened by LibreOffice (a repair-free open: --convert-to pdf must succeed).
// Both results of PDF → Word are scored: «Easy to edit» (the default) against floors.json's `cells`, «Exact look» against its
// `exact` set (the scores of the converter before the easy-to-edit result existed, minus 0.02).
// Pass/fail: no cell may fall under its floor (a score minus 0.02), and in either result the PDF's own text layer must be
// in the .docx word for word (text_layer_recall >= 0.99: body, tables, text boxes, headers, footers, footnotes). Timing is
// printed but never judged.
//   KR_CORPUS_WRITE_FLOORS=1  raise floors to this run's scores minus 0.02 (never lowers one)   KR_CORPUS_ONLY=id,id  a subset
//   KR_CORPUS_MODES=edit|exact|edit,exact  which results (default both)
//   KR_CORPUS_DOCX=<dir>  score the .docx files already in <dir> (no browser)   KR_CORPUS_SAVE=<dir>  keep the converted .docx
//   KR_CORPUS_OUT=<dir>   where the JSON + Markdown tables go (default corpus2/out)   KR_DIST=<dir>  another build   KR_NOSOFFICE=1
//   Owner PDFs (corpus2/owner/*.pdf, optional name.truth.json) are converted and scored too; they never fail the test.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const { execSync } = require('child_process');
const { readDocx, scoreDocx, fold, sim, pdfTextWords, wordRecall, pdfGeometry, scoreGeometry, pdfFlow, scoreFlow } = require('./pdf2docx/corpus2/score.cjs');
const ROOT = path.join(__dirname, 'pdf2docx/corpus2'); const DIST = path.resolve(process.env.KR_DIST || path.join(__dirname, '../dist'));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.bcmap': 'application/octet-stream', '.pfb': 'application/octet-stream' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const FLOW = {}; let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'p2dc-')); const src = JSON.parse(fs.readFileSync(path.join(ROOT, 'source.json'), 'utf8')); const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const haveSoffice = (() => { if (process.env.KR_NOSOFFICE) return false; try { execSync('soffice --version', { stdio: 'ignore' }); return true; } catch { return false; } })();
const only = process.env.KR_CORPUS_ONLY ? process.env.KR_CORPUS_ONLY.split(',') : null; const outDir = path.resolve(process.env.KR_CORPUS_OUT || path.join(ROOT, 'out')); fs.mkdirSync(outDir, { recursive: true });
const saveDir = process.env.KR_CORPUS_SAVE ? path.resolve(process.env.KR_CORPUS_SAVE) : null; if (saveDir) fs.mkdirSync(saveDir, { recursive: true });

async function convert(browser, file, mode) {
  // A context of its own each time: a fresh library holding this one book, as in a user's first conversion.
  const ctx = await browser.newContext({ viewport: { width: 900, height: 900 }, acceptDownloads: true }); const page = await ctx.newPage(); const errs = [];
  page.on('pageerror', (e) => errs.push(e.message)); page.on('dialog', (d) => { void d.accept(''); });
  try {
    await page.goto('http://127.0.0.1:5213/'); await page.evaluate((m) => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.convert', JSON.stringify({ docxResult: m })); }, mode); await page.reload(); await page.waitForSelector('.library-view');
    await page.setInputFiles('input[type=file]', [file]); await page.waitForSelector('.book-card', { timeout: 60000 }); await page.waitForTimeout(300);
    const card = await page.$('.book-card'); await card.dispatchEvent('contextmenu'); await page.waitForSelector('.sel-actions');
    if (!(await page.$('.sel-actions button:has-text("Convert")'))) { await page.click('.sel-actions button:has-text("More")'); await page.waitForSelector('.sheet'); await page.click('.sheet button:has-text("Convert")'); } else await page.click('.sel-actions button:has-text("Convert")');
    await page.waitForSelector('.convert-target'); const t0 = Date.now(); await page.click('.convert-target:has-text("Word")');
    await page.waitForSelector('.convert-result:not([hidden]) button, .sheet .src:has-text("failed")', { timeout: 150000 }); const secs = (Date.now() - t0) / 1000;
    const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), page.click('.convert-result button:has-text("Save")')]);
    const out = path.join(tmp, path.basename(file, '.pdf') + (mode === 'exact' ? '.exact' : '') + '.docx'); await dl.saveAs(out); return { out, secs, errs };
  } catch (e) { return { out: null, secs: 0, errs: errs.concat(String(e.message).slice(0, 160)) }; } finally { await ctx.close(); }
}
const opensInLO = (docx) => { try { execSync(`cd "${tmp}" && rm -f "${path.basename(docx, '.docx')}.pdf" && soffice -env:UserInstallation=file://${tmp}/lo --headless --convert-to pdf "${docx}" >/dev/null 2>&1`, { timeout: 120000 }); const pdf = docx.replace(/\.docx$/, '.pdf'); return fs.existsSync(pdf) && +/Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${pdf}"`).toString())[1] > 0 ? 1 : 0; } catch { return 0; } };

// Owner PDFs: scored on what needs no truth, plus what a truth file gives.
async function scoreOwner(D, truth, meta) {
  const S = {}; const body = D.paras.filter((p) => !p.table && p.text.trim());
  S.o_text_any = body.length ? 1 : 0; S.o_links_real = D.links.length ? 1 : 0; S.o_lists_real = body.some((p) => p.num) ? 1 : 0; S.o_headings = body.some((p) => p.heading && p.heading.level >= 1) ? 1 : 0;
  S.o_pagenum_pollution = 1 - Math.min(1, body.filter((p) => /^\s*(page\s*)?\d{1,3}(\s*(of|\/)\s*\d{1,3})?\s*$/i.test(p.text)).length / Math.max(1, meta.pages));
  const ar = D.paras.filter((p) => /[؀-ۿ]/.test(p.text)); S.o_bidi = ar.length ? ar.filter((p) => p.bidi).length / ar.length : null;
  if (truth) {
    if (truth.text) { const a = fold(body.map((p) => p.text).join(' ')), b = fold(truth.text); const { dist } = require('./pdf2docx/corpus2/score.cjs'); S.o_text_acc = Math.max(0, 1 - dist(a, b) / Math.max(a.length, b.length, 1)); }
    if (truth.headings) S.o_headings_rec = truth.headings.filter((h) => body.some((p) => p.heading && p.heading.level === h.level && sim(fold(p.text), fold(h.text)) >= 0.85)).length / truth.headings.length;
    if (truth.links) S.o_links_target = truth.links.filter((l) => D.links.some((x) => x.target === l.href)).length / truth.links.length;
    if (truth.listItems) S.o_lists_truth = truth.listItems.filter((it) => body.some((p) => p.num && sim(fold(p.text), fold(it.text)) >= 0.85)).length / truth.listItems.length;
    if (truth.footnotes) S.o_footnotes = truth.footnotes.filter((f) => D.footnotes.some((x) => sim(fold(x), fold(f)) >= 0.85)).length / truth.footnotes.length;
    if (truth.tableCells) { const cells = D.tables.flatMap((t) => t.rows.flatMap((r) => r.cells).map((c) => fold(c.text))); const exp = truth.tableCells.flat(); S.o_table_cells = exp.filter((e) => cells.some((c) => sim(c, fold(e)) >= 0.85)).length / exp.length; }
    if (truth.rtl) S.o_rtl = truth.rtl.filter((t) => body.concat(D.paras).some((p) => p.bidi && sim(fold(p.text), fold(t)) >= 0.7)).length / truth.rtl.length;
  }
  return S;
}

const f2 = (x) => (x === null || x === undefined ? '  - ' : x.toFixed(2));
function tables(results, measures) {
  const ids = Object.keys(results); const head = 'program'.padEnd(20) + measures.map((m) => m.slice(0, 9).padStart(10)).join('');
  const lines = [head]; for (const id of ids) lines.push(id.padEnd(20) + measures.map((m) => f2(results[id].scores[m]).padStart(10)).join('')); return lines.join('\n');
}
(async () => {
  const entries = []; const modes = (process.env.KR_CORPUS_MODES || 'edit,exact').split(','); const R = { edit: {}, exact: {} };
  for (const p of man.pdfs) if (!only || only.includes(p.id)) entries.push({ id: p.id, file: path.join(ROOT, p.file), meta: p, owner: false });
  const ownerDir = path.join(ROOT, 'owner'); const owner = fs.existsSync(ownerDir) ? fs.readdirSync(ownerDir).filter((f) => /\.pdf$/i.test(f)) : [];
  if (!only) for (const f of owner) entries.push({ id: 'owner:' + f.replace(/\.pdf$/i, ''), file: path.join(ownerDir, f), owner: true, meta: { pages: 1, features: {} } });
  let browser = null; const pre = process.env.KR_CORPUS_DOCX ? path.resolve(process.env.KR_CORPUS_DOCX) : null;
  if (!pre) { await new Promise((r) => server.listen(5213, r)); browser = await chromium.launch(); }
  for (const e of entries) {
    const layer = e.owner ? null : await pdfTextWords(e.file).catch(() => null); const geo = e.owner ? null : await pdfGeometry(e.file).catch(() => null); const flow0 = e.owner || !haveSoffice ? null : await pdfFlow(e.file, src).catch(() => null);
    for (const mode of modes) {
      if (e.owner && mode === 'exact') continue; const results = R[mode]; const tag = e.id.replace(/^owner:/, 'owner-') + (mode === 'exact' ? '.exact' : '');
      let docx, secs = 0, errs = [];
      if (pre) docx = path.join(pre, tag + '.docx'); else { const r = await convert(browser, e.file, mode); docx = r.out; secs = r.secs; errs = r.errs; }
      if (!docx || !fs.existsSync(docx)) { results[e.id] = { scores: {}, secs, failed: true, errs }; console.log(e.id.padEnd(20), mode, 'CONVERSION FAILED', errs.join(' | ')); continue; }
      if (saveDir) fs.copyFileSync(docx, path.join(saveDir, tag + '.docx'));
      if (e.owner) { const tf = e.file.replace(/\.pdf$/i, '.truth.json'); const D = await readDocx(fs.readFileSync(docx)); const pages = +(/Pages:\s+(\d+)/.exec(execSync(`pdfinfo "${e.file}" 2>/dev/null || true`).toString()) || [0, 1])[1] || 1; const S = await scoreOwner(D, fs.existsSync(tf) ? JSON.parse(fs.readFileSync(tf, 'utf8')) : null, { pages }); if (haveSoffice && !pre) S.lo_opens = opensInLO(docx); results[e.id] = { scores: S, secs, pages, owner: true }; continue; }
      const D = await readDocx(fs.readFileSync(docx)); const meta = { ...e.meta, scanned: e.id.startsWith('scan-') };
      const S = scoreDocx(D, src, e.meta.features, meta);
      // (Measures of the flowing result: «Easy to edit» only.)
      if (geo && mode === 'edit' && !meta.scanned) Object.assign(S, scoreGeometry(D, geo));
      const wr = layer && layer.length ? wordRecall(layer, D) : null; S.text_layer_recall = wr ? wr.recall : null;
      if (haveSoffice && !pre) S.lo_opens = opensInLO(docx);
      // (soffice only: the long paragraph's pitch and the page count as LibreOffice lays the flowing result out.)
      if (haveSoffice && !pre && mode === 'edit' && flow0 && !meta.scanned && S.lo_opens) { const lp = docx.replace(/\.docx$/, '.pdf'); const f1 = fs.existsSync(lp) ? await pdfFlow(lp, src).catch(() => null) : null; if (f1) Object.assign(S, scoreFlow(flow0, f1)); FLOW[e.id] = { src: flow0, lo: f1 }; }
      results[e.id] = { scores: S, secs, secsPerPage: secs / (e.meta.pages || 1), pages: e.meta.pages, docxBytes: fs.statSync(docx).size, errs, missed: wr ? wr.miss.slice(0, 30) : [] };
      console.log(e.id.padEnd(20), mode.padEnd(5), 'ok', secs.toFixed(1) + 's', (Object.values(S).filter((x) => x !== null && x !== undefined).reduce((a, b) => a + b, 0) / Math.max(1, Object.values(S).filter((x) => x !== null && x !== undefined).length)).toFixed(2), wr ? 'layer ' + wr.recall.toFixed(3) + (wr.miss.length ? ' missing: ' + wr.miss.slice(0, 12).join(' ') : '') : '');
    }
  }
  if (browser) { await browser.close(); server.close(); }
  if (Object.keys(FLOW).length) console.log('\npages, source vs LibreOffice (easy to edit); long paragraph pitch, source vs LibreOffice:\n' + Object.entries(FLOW).map(([id, f]) => `${id.padEnd(20)} ${f.src.pages} -> ${f.lo ? f.lo.pages : '?'}   ${f.src.pitch ? f.src.pitch.toFixed(2) : '-'} -> ${f.lo && f.lo.pitch ? f.lo.pitch.toFixed(2) : '-'}`).join('\n'));
  const order = ['text_lat_acc', 'text_lat_rec', 'text_ar_acc', 'text_ar_rec', 'ar_digits', 'text_ja_acc', 'text_ja_rec', 'text_zh_acc', 'text_zh_rec', 'text_layer_recall', 'para_f1', 'para_long_whole', 'hyphen_join', 'headings_rec', 'headings_level', 'headings_text', 'lists_real', 'lists_marker', 'table_cells', 'table_shape', 'table_merged', 'table_header', 'table_text_any', 'table_ar_cells', 'picture', 'caption', 'footnotes', 'links', 'hf_pollution', 'hf_present', 'columns_order', 'columns_set', 'emphasis_bold', 'emphasis_italic', 'mono', 'direction', 'ocr_recovered', 'decor_stray', 'list_geometry', 'runs_plain', 'pitch', 'pages', 'lo_opens'];
  const floorsFile = path.join(ROOT, 'floors.json'); const F = fs.existsSync(floorsFile) ? JSON.parse(fs.readFileSync(floorsFile, 'utf8')) : null;
  const md = ['# PDF to Word corpus scores', ''];
  const totals = {};
  for (const mode of modes) {
    const results = R[mode];
    const corpus = Object.fromEntries(Object.entries(results).filter(([id]) => !results[id].owner)); const ownerRes = Object.fromEntries(Object.entries(results).filter(([id]) => results[id].owner));
    const measures = order.filter((m) => Object.values(corpus).some((r) => r.scores[m] !== undefined && r.scores[m] !== null));
    const mean = (id) => { const v = measures.filter((m) => m !== 'text_layer_recall').map((m) => corpus[id].scores[m]).filter((x) => x !== null && x !== undefined); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    md.push(`## ${mode === 'edit' ? 'Easy to edit (default)' : 'Exact look'}`, '', `Measures 0-1 (higher is better); "-" = not applicable to that program's PDFs (feature absent or not scored); the mean leaves out text_layer_recall (the guard). ${Object.keys(corpus).length} PDFs; LibreOffice open check: ${haveSoffice ? 'run' : 'skipped (soffice not found)'}.`, '', '| program | mean | pages | s/page | ' + measures.join(' | ') + ' |', '|---|---|---|---|' + measures.map(() => '---').join('|') + '|');
    for (const id of Object.keys(corpus)) { const r = corpus[id]; md.push(`| ${id} | ${f2(mean(id))} | ${r.pages} | ${r.secsPerPage !== undefined ? r.secsPerPage.toFixed(2) : '-'} | ` + measures.map((m) => f2(r.scores[m]).trim()).join(' | ') + ' |'); }
    if (Object.keys(ownerRes).length) { md.push('', '### Owner PDFs', '', JSON.stringify(Object.fromEntries(Object.entries(ownerRes).map(([k, v]) => [k, v.scores])), null, 1)); }
    md.push('');
    console.log(`\n==== ${mode === 'edit' ? 'Easy to edit' : 'Exact look'}`); for (let i = 0; i < measures.length; i += 9) console.log('\n' + tables(corpus, measures.slice(i, i + 9)));
    console.log('\nmean per program: ' + Object.keys(corpus).map((id) => `${id} ${f2(mean(id)).trim()}`).join(', '));
    const totalSecs = Object.values(results).reduce((a, r) => a + (r.secs || 0), 0); totals[mode] = totalSecs; const pagesAll = Object.values(corpus).reduce((a, r) => a + (r.pages || 0), 0);
    console.log(`conversion time ${totalSecs.toFixed(0)} s for ${Object.keys(corpus).length} PDFs, ${(totalSecs / Math.max(1, pagesAll)).toFixed(2)} s/page (not judged)`);
    // ---- the guard: no word of the PDF's text layer lost
    for (const id of Object.keys(corpus)) { const v = corpus[id].scores.text_layer_recall; if (v === null || v === undefined) continue; ok(`${mode}: ${id} keeps the PDF's text, word for word (${v.toFixed(3)} >= 0.99)`, v >= 0.99); if (v < 0.99) console.log('  missing:', corpus[id].missed.join(' ')); }
    // ---- floors
    const key = mode === 'edit' ? 'cells' : 'exact';
    if (process.env.KR_CORPUS_WRITE_FLOORS) {
      const cells = (F && F[key]) || {}; for (const id of Object.keys(corpus)) { cells[id] = cells[id] || {}; for (const m of measures) { const v = corpus[id].scores[m]; if (v !== null && v !== undefined) { const nf = Math.max(0, Math.round((v - 0.02) * 1000) / 1000); if (cells[id][m] === undefined || nf > cells[id][m]) cells[id][m] = nf; } } }
      if (F) F[key] = cells;
    } else {
      ok('floors.json exists', !!F); if (F && F[key]) {
        const floors = F[key]; let checked = 0, under = [];
        for (const id of Object.keys(corpus)) for (const [m, fl] of Object.entries(floors[id] || {})) { const v = corpus[id].scores[m]; if (v === undefined) continue; /* a measure that did not run here (e.g. no soffice) */ checked++; if (v === null || v < fl) under.push(`${id}/${m} ${v === null ? 'null' : v.toFixed(3)} < ${fl}`); }
        ok(`${mode}: every program x measure cell is at or above its floor (${checked} cells)`, under.length === 0); for (const u of under) console.log('  under:', u);
        for (const id of Object.keys(corpus)) ok(`${mode}: ${id} converted`, !results[id].failed);
      }
    }
  }
  fs.writeFileSync(path.join(outDir, 'scores.md'), md.join('\n') + '\n'); fs.writeFileSync(path.join(outDir, 'scores.json'), JSON.stringify(R, null, 1)); console.log('tables saved under', outDir);
  if (process.env.KR_CORPUS_WRITE_FLOORS && F) { fs.writeFileSync(floorsFile, JSON.stringify(F, null, 1) + '\n'); console.log('floors raised in', floorsFile); }
  fs.rmSync(tmp, { recursive: true, force: true }); console.log(fails ? `\n${fails} FAILED` : '\nall ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('ERROR', e); process.exit(1); });
