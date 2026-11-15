// node tests/filename.cjs [en|ar]: a file's name in the card's title, the card's name and the list row (360 px) — judged by where
// things are drawn (element rects), not by the DOM only: in a right-to-left name the Arabic words on the right and ONE unbroken
// left-to-right run on the left («1688.pdf», «v3.ass», «- 02 (BD).mkv»); a left-to-right name untouched; the copied text the exact
// name; a long name cut between the words and the run (the run whole). Also the Arabic size line: each amount one run, no «?».
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; };
const STUB = () => { window.__tasks = JSON.parse(sessionStorage.getItem('kt.test.tasks') || '[]');
  const plugin = new Proxy({ addListener: () => ({ remove() {} }), list: async () => ({ tasks: window.__tasks }) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] }; };
const LONG = 'اسم طويل جدا لملف يستمر في الكلام عن موضوع واحد بلا انقطاع ولا توقف '.repeat(3) + '1688.pdf';
// [name, expected: 'ltr' (untouched) | 'plain-rtl' (no run) | the text of the left-to-right run, base direction]
const NAMES = [
  ['ثلاث رسائل، 1688.pdf', '1688.pdf'], ['كتاب 2024.epub', '2024.epub'], ['مقدمة v3.ass', 'v3.ass'], ['اسم.pdf', '.pdf'], ['اسم عربي - 02 (BD).mkv', '- 02 (BD).mkv'],
  ['أرشيف.tar.gz', '.tar.gz'], ['ملف١٢٣.pdf', '١٢٣.pdf'], ['مستند', 'plain-rtl'], ['.hidden', 'ltr'], ['Report final.pdf', 'ltr'], ['report تقرير.pdf', 'ltr'], ['v1.2 [1080p].mkv', 'ltr'],
  ['日本語のファイル.mkv', 'ltr'], ['1688 ثلاث.pdf', '.pdf'], [LONG, '1688.pdf'] ];
(async () => {
  const web = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.json') ? 'application/json' : 'text/html' }); r.end(fs.readFileSync(f)); });
  await new Promise((res) => web.listen(0, '127.0.0.1', res)); const base = `http://127.0.0.1:${web.address().port}`; const b = await chromium.launch(); const errs = [];
  for (const L of ['en', 'ar']) {
    const ctx = await b.newContext({ viewport: { width: 360, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true }); const p = await ctx.newPage(); p.on('pageerror', (e) => errs.push(e.message));
    const now = Date.now(); const tasks = NAMES.map(([n], i) => ({ id: `t${i}`, kind: 'http', name: n, source: { url: 'https://h.example.test/x' }, dir: '/d', state: i % 2 ? 'failed' : 'downloading', done: 3.8e6, total: i % 3 ? 9e6 : -1, downSpeed: 2e5, upSpeed: 0, files: [], addedAt: now - i, engine: 'native', error: 'HTTP 404' }));
    await p.addInitScript(STUB); await p.addInitScript(([lg, ts]) => { localStorage.setItem('kr.lang', lg); localStorage.setItem('kt.settings', JSON.stringify({ downloadDir: '/d' })); sessionStorage.setItem('kt.test.tasks', JSON.stringify(ts)); }, [L, tasks]);
    // what is drawn for a name inside `sel` (a container): the run's and the words' rectangles
    const probe = (sel, name) => p.evaluate(([sel, name]) => { const el = document.querySelector(sel); if (!el) return { missing: true }; const nm = el.querySelector('.nm'); const r = (e) => { const b = e.getBoundingClientRect(); return { l: b.left, r: b.right, w: b.width }; };
      return { text: el.textContent, dir: el.dir, hasNm: !!nm, run: nm ? nm.querySelector('.nm-run').textContent : null, runR: nm ? r(nm.querySelector('.nm-run')) : null, stem: nm && nm.querySelector('.nm-stem') ? r(nm.querySelector('.nm-stem')) : null, cut: nm && nm.querySelector('.nm-stem') ? nm.querySelector('.nm-stem').scrollWidth > nm.querySelector('.nm-stem').clientWidth + 1 : false, box: r(el.closest('.kt-hero, .topbar, .task-card') || el.parentElement), self: r(el) }; }, [sel, name]);
    const judge = (where, [name, want], r, long) => {
      if (r.missing) { ok(`[${L}] ${where}: ${name.slice(0, 24)} present`, false); return; }
      ok(`[${L}] ${where}: «${name.slice(0, 22)}» the copied text is the exact name`, r.text === name, r.text);
      if (want === 'ltr') ok(`[${L}] ${where}:   left-to-right base, untouched`, r.dir === 'ltr' && !r.hasNm, r);
      else if (want === 'plain-rtl') ok(`[${L}] ${where}:   right-to-left, no run`, r.dir === 'rtl' && !r.hasNm, r);
      else {
        ok(`[${L}] ${where}:   one run «${want}»`, r.dir === 'rtl' && r.run === want, r);
        if (where === 'card name' && name === LONG) { /* (wraps over several lines: only the box is judged) */ } else if (r.stem) ok(`[${L}] ${where}:   drawn: the words on the right, the run on the left of them`, r.runR.r <= r.stem.l + 1.5 && r.stem.r >= r.self.r - 3, r);
        else ok(`[${L}] ${where}:   drawn: the run at the visual end (left) of the line`, r.runR.l <= r.self.l + 3 || r.runR.r <= r.self.r - 0, r);
        ok(`[${L}] ${where}:   the run whole inside the box`, r.runR.l >= r.box.l - 1 && r.runR.r <= r.box.r + 1, r);
        if (long) ok(`[${L}] ${where}:   a long name cut between its words and the run (ellipsis in the middle), the run whole`, r.cut === true, r);
      } };
    await p.goto(`${base}/#/`); await p.reload(); await p.waitForSelector('.task-card', { timeout: 15000 }); await p.waitForTimeout(600);
    for (let i = 0; i < NAMES.length; i++) judge('list row', NAMES[i], await probe(`.task-card[data-id="t${i}"] .task-name`, NAMES[i][0]), NAMES[i][0] === LONG);
    if (L === 'ar') { const line = await p.evaluate(() => [...document.querySelectorAll('.task-line')].map((e) => e.textContent)); ok('[ar] list line: each amount isolated (LRI…PDI), no «?»', line.some((x) => /⁦[^⁩]*MB⁩/.test(x)) && !line.some((x) => /\?/.test(x)), line.slice(0, 3)); await p.screenshot({ path: path.join(process.env.KT_SHOTS || require('node:os').tmpdir(), 'list-row-ar.png') }); }
    for (let i = 0; i < NAMES.length; i++) {
      await p.goto(`${base}/#/task/t${i}`); await p.reload(); await p.waitForSelector('.task-detail .kt-meter', { timeout: 15000 }); await p.waitForTimeout(250);
      judge('card name', NAMES[i], await probe('.kt-name', NAMES[i][0]), false); judge('card title', NAMES[i], await probe('.topbar .title > span:first-child', NAMES[i][0]), NAMES[i][0] === LONG);
      if (i === 0 || i === 1) { const of = await p.evaluate(() => ({ t: document.querySelector('.kt-of')?.textContent ?? null })); ok(`[${L}] size line of ${i === 1 ? 'a known-size task' : 'an unknown-size running one'}`, i === 1 ? /3\.6 MB/.test(of.t) && /8\.6 MB/.test(of.t) && /\u2066[^\u2069]*MB\u2069/.test(of.t) : of.t !== null && !/\?/.test(of.t) && !/ من | of /.test(of.t) && /\u2066[^\u2069]*MB\u2069/.test(of.t), of); }
    }
    await ctx.close();
  }
  ok('no page errors', errs.length === 0, errs); await b.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
