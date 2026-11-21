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
  ['settings', async (p) => { await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { state: 'attached' }); await p.evaluate(() => document.querySelectorAll('.settings-body .card.collapsed').forEach((c) => c.classList.remove('collapsed'))); }, 'phone'],
  ...Array.from({ length: SETTING_COUNT }, (_, i) => ['settings-' + i, settingsSec(i), 'pc']),
  ['read-epub', openBook(/alice/i, '.reader-flow .kr-content')],
  ['read-epub-bars', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await wake(p); }],
  ['read-epub-bottom', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await wake(p); await p.evaluate(() => { const s = document.querySelector('.reader-view .reader, .reader-view [class*=scroll]'); document.querySelectorAll('.reader-view *').forEach((e) => { if (e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; }); }); await p.waitForTimeout(600); }],
  ['read-options', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await command('options')(p); await p.waitForSelector('.panel.open, .sheet', { timeout: 8000 }); }],
  ['read-contents', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await command('toc')(p); await p.waitForSelector('.panel.open, .sheet', { timeout: 8000 }); }],
  ['read-search', async (p) => { await openBook(/alice/i, '.reader-flow .kr-content')(p); await command('search')(p); await p.waitForSelector('.panel.open, .sheet, .search-bar, input[type=search]', { timeout: 8000 }); }],
  ['read-pdf', openBook(/pages/i, '.pdf-bar, .pdf-view, .pdf-pages')],
  ['read-notice', async (p) => { await openBook(/nihongo/, '.reader-flow .kr-content')(p); await waitNotice(p); await p.waitForTimeout(400); }, 'both', { notice: true }],
  ['read-notice-bottom', async (p) => { await openBook(/nihongo/, '.reader-flow .kr-content')(p); await waitNotice(p); await p.evaluate(() => { document.querySelectorAll('.reader-view *').forEach((e) => { if (e.scrollHeight > e.clientHeight + 200 && /(auto|scroll)/.test(getComputedStyle(e).overflowY)) e.scrollTop = e.scrollHeight; }); }); await p.waitForTimeout(700); }, 'both', { notice: true }],
];

// kind|view|selector-ish key -> reason. A key is `${kind} ${view} ${what}` prefix-matched (view without the device).
const ALLOW = [
  ['colour settings', 'reading-theme previews (sepia, candlelight, manuscript) and the highlight colour palette show the colours they stand for'],
  ['colour read-options', 'the same theme previews and highlight palette, inside the options panel'],
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
    if (['BUTTON', 'LABEL', 'SPAN', 'A', 'H1', 'H2', 'H3', 'SMALL', 'DIV'].includes(e.tagName) && !e.children.length && (e.textContent || '').trim() && /(hidden|clip)/.test(cs.overflowX) && e.scrollWidth > e.clientWidth + 2 && cs.textOverflow !== 'ellipsis') add('clipped', e, `${e.scrollWidth}>${e.clientWidth}`);
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
    if (errors.length) { console.log(`ERR   ${lang} ${dev}: page errors ${errors.slice(0, 3).join(' | ')}`); fails++; }
    await ctx.close(); // (one page closed before the next opens: the machine is short of memory)
  }
  console.log(fails ? `${fails} FAULTS ${JSON.stringify(summary)} (allowed ${allowedN} ${JSON.stringify(allowedBy)})` : `all passed (allowed ${allowedN} ${JSON.stringify(allowedBy)})`);
  await b.close(); server.close(); fs.rmSync(TMP, { recursive: true, force: true }); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
