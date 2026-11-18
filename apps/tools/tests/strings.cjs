// node tests/strings.cjs: the strings cut in two by the build (scripts/build.mjs splitStrings — the start fetches only
// those the first screen names, every other screen waits for the rest): no screen shows a key instead of its words.
// Each place of the app opened in English, Arabic and Japanese (the phone's size, the computer's for Settings), the
// Add sheet and the Settings search too; the page's text and its labels (title, aria-label, placeholder) read for any
// word (each text node apart: words of two elements side by side are not one) that is a key of src/i18n/en.ts written as keys are (camelCase or with _), and the start's own table checked to
// hold fewer strings than the whole.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const EN = fs.readFileSync(path.join(__dirname, '..', 'src/i18n/en.ts'), 'utf8');
// (Keys that cannot be plain words: a capital inside, a _ or a digit.)
const KEYS = new Set([...EN.matchAll(/(?:^|[\s,{])([A-Za-z_]\w*):\s*["'`]/g)].map((m) => m[1]).filter((k) => /[a-z][A-Z]|_|\d/.test(k)));
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; };
const ROUTES = ['#/', '#/settings', '#/settings/addons', '#/files', '#/videos', '#/courses', '#/anime', '#/anime?tab=search', '#/tv', '#/subs', '#/search', '#/screen', '#/battery', '#/task/none'];
(async () => {
  ok(`the key list read (${KEYS.size})`, KEYS.size > 1000);
  // (The start: app.js and what it imports statically — how many keys it carries.)
  const A = path.join(DIST, 'assets'); const closure = new Set(); const visit = (f) => { if (closure.has(f) || !fs.existsSync(path.join(A, f))) return; closure.add(f); const src = fs.readFileSync(path.join(A, f), 'utf8'); for (const m of src.matchAll(/(?:^|[;}\s])import(?:[^"'()]*?from)?\s*["'](\.\/[^"']+\.js)["']/g)) visit(m[1].slice(2)); }; visit('app.js');
  const startText = [...closure].map((f) => fs.readFileSync(path.join(A, f), 'utf8')).join('\n'); const inStart = [...KEYS].filter((k) => new RegExp(`["{,]${k}"?:`).test(startText)).length;
  ok(`the build cut the strings: ${inStart} of ${KEYS.size} keys at the start`, inStart > 50 && inStart < KEYS.size / 3, inStart);
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  for (const lang of ['en', 'ar', 'ja']) {
    for (const kind of ['phone', 'pc']) {
      const ctx = await br.newContext(kind === 'phone' ? { viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 800 } });
      await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
      const p = await ctx.newPage(); p.setDefaultTimeout(8000); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
      await p.addInitScript((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'player', 'anime', 'tv', 'subtitles', 'video', 'archives', 'screen'] })); }, lang);
      const seen = new Map();
      const scan = async (where) => {
        const words = await p.evaluate(() => { const out = []; const it = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = it.nextNode())) if (!n.parentElement?.closest('script,style')) out.push(n.data); for (const e of document.querySelectorAll('[title],[aria-label],[placeholder]')) out.push(e.getAttribute('title') || '', e.getAttribute('aria-label') || '', e.getAttribute('placeholder') || ''); return out.join(' ').match(/[A-Za-z_]\w*/g) || []; });
        for (const w of words) if (KEYS.has(w) && !seen.has(w)) seen.set(w, where);
      };
      await p.goto(base + '#/'); await p.waitForSelector('.downloads-view .task-list', { state: 'attached' });
      for (const r of ROUTES) { await p.evaluate((h) => { location.hash = h; }, r); await p.waitForTimeout(r === '#/' ? 300 : 700); await p.waitForFunction(() => !document.querySelector('#app > .view > .center > .spinner'), null, { timeout: 8000 }).catch(() => undefined); await scan(r); }
      // (The Add sheet, and the Settings search typed into.)
      await p.evaluate(() => { location.hash = '#/'; }); await p.waitForTimeout(300);
      const fab = await p.$('.downloads-view .fab, .rail-fab'); if (fab) { await fab.click(); await p.waitForTimeout(600); await scan('add menu'); await p.keyboard.press('Escape'); }
      await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-search'); await p.fill('.settings-search', 'a'); await p.waitForTimeout(300); await scan('settings search');
      ok(`${lang} ${kind}: no key shown instead of its words`, seen.size === 0, [...seen].slice(0, 12));
      ok(`${lang} ${kind}: no page errors`, !errs.length, errs.slice(0, 3));
      await ctx.close();
    }
  }
  await br.close(); web.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
