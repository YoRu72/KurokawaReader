// node tests/themedefault.cjs: «Expressive 3», the main theme again (0.21).
//  1. the move back (theme/themes.ts migrateMain), every stored-settings shape: fresh, moved to Frost by itself, Frost
//     chosen (marked, or told by what was touched around it), another theme, the reader's own, before themes, corrupted;
//  2. its palettes: text on its surfaces ≥ 4.5:1 (body), outlines and icons ≥ 3:1, the colour roles on their containers,
//     the snackbar on the inverse surface — dark and light; no colour in the yellow/amber band; base.css says the same
//     values as themes.ts;
//  3. in the app: the default per light/dark/system; the move once, its snackbar, «Use Frost» undoing it, ✕ dismissing
//     it, nothing shown again; a chosen Frost untouched; corrupted settings start clean; the gallery shows Expressive 3
//     first with «Default», and Reset goes back to it.
// Only loopback, made-up data, no fixed waits beyond a short settle.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || !extra ? '' : `  — ${extra}`)); if (!c) fails++; };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-themedefault-'));
esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'theme', 'themes.ts')], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'themes.js'), logLevel: 'silent' });
const T = require(path.join(tmp, 'themes.js'));

(async () => {
  /* 1. the move back, table-tested */
  ok('the main theme is Expressive 3 (id classic), first in the gallery', T.DEFAULT_THEME === 'classic' && T.THEMES[0].id === 'classic' && T.themeById(undefined).id === 'classic' && T.themeById('gone').id === 'classic');
  const TABLE = [
    ['fresh install (nothing stored)', null, false, { theme: 'classic', moved: false, chosen: false }],
    ['moved to Frost by 0.17 and never touched', { theme: 'frost', uiMode: 'dark', darkTone: 'default', accent: 'graphite', glassBlur: 'auto' }, false, { theme: 'classic', moved: true, chosen: false, prevTheme: 'frost' }],
    ['moved to Frost by 0.17 with its own colours kept', { theme: 'frost', darkTone: 'grey', accent: 'teal', themeKeepColours: true }, false, { theme: 'classic', moved: true, chosen: false, prevKeep: true }],
    ['a 0.17+ fresh install on Frost (only the defaults stored)', { theme: 'frost', glassBlur: 'auto', addons: ['player'] }, false, { theme: 'classic', moved: true }],
    ['chose Frost (marked, from 0.21)', { theme: 'frost', themeChosen: true }, false, { theme: 'frost', moved: false, chosen: true }],
    ['Frost with the blur chosen', { theme: 'frost', glassBlur: 'full' }, false, { theme: 'frost', moved: false, chosen: true }],
    ['Frost with the glass sidebar set', { theme: 'frost', glassRail: false }, false, { theme: 'frost', moved: false, chosen: true }],
    ['Frost with the battery choice set', { theme: 'frost', glassBattery: true }, false, { theme: 'frost', moved: false, chosen: true }],
    ['Frost after another theme\'s colours were taken (accentPrev)', { theme: 'frost', accentPrev: 'teal' }, false, { theme: 'frost', moved: false, chosen: true }],
    ['Frost with themes of one\'s own saved', { theme: 'frost' }, true, { theme: 'frost', moved: false, chosen: true }],
    ['chose another theme (Aurora)', { theme: 'aurora', accent: 'theme' }, false, { theme: 'aurora', moved: false, chosen: true }],
    ['a downloaded theme (Frosted Glass)', { theme: 'frosted-glass' }, false, { theme: 'frosted-glass', moved: false, chosen: true }],
    ['a theme of one\'s own in use', { theme: 'my-abc123' }, true, { theme: 'my-abc123', moved: false, chosen: true }],
    ['chose Classic (now Expressive 3)', { theme: 'classic' }, false, { theme: 'classic', moved: false }],
    ['settings from before themes (no theme)', { uiMode: 'dark', darkTone: 'grey', accent: 'rose' }, false, { theme: 'classic', moved: false, chosen: false }],
    ['corrupted: not an object', 'garbage', false, { theme: 'classic', moved: false, chosen: false }],
    ['corrupted: an empty theme name', { theme: '' }, false, { theme: 'classic', moved: false, chosen: false }],
  ];
  for (const [name, stored, mine, want] of TABLE) {
    const m = T.migrateMain(stored, mine);
    const good = m.theme === want.theme && (want.moved === undefined || m.moved === want.moved) && (want.chosen === undefined || m.chosen === want.chosen)
      && (want.prevTheme === undefined || m.prev?.theme === want.prevTheme) && (want.prevKeep === undefined || m.prev?.themeKeepColours === want.prevKeep) && (!m.moved || !!m.prev);
    ok(`move back: ${name} → ${want.theme}${want.moved ? ' (snackbar)' : ''}`, good, JSON.stringify(m));
  }

  /* 2. the palettes */
  const L = { ...T.E3_LIGHT.surfaces }; const D = T.E3_DARK.surfaces; const TL = T.E3_LIGHT.text; const TD = T.APP_TEXT.dark;
  const RL = T.E3_LIGHT.roles; const RD = { ...T.GRAPHITE.dark, secondaryContainer: T.E3_DARK.secondaryContainer };
  const c = (a, b) => T.contrast(T.parseColor(a), T.parseColor(b));
  const rows = []; const need = (mode, what, fg, bg, min) => rows.push({ mode, what, fg, bg, min, ratio: c(fg, bg) });
  for (const [mode, S, X, R, inv] of [['dark', D, TD, RD, T.E3_DARK.inverse], ['light', L, TL, RL, T.E3_LIGHT.inverse]]) {
    for (const k of ['ground', 'low', 'mid', 'high']) { need(mode, `on-surface on ${k}`, X.on, S[k], 4.5); need(mode, `on-surface-variant on ${k}`, X.variant, S[k], 4.5); need(mode, `outline (icons, large) on ${k}`, X.outline, S[k], 3); }
    for (const k of ['ground', 'low', 'mid']) need(mode, `on-surface-dim on ${k}`, X.dim, S[k], 4.5);
    need(mode, 'on-surface on highest (selection bar)', X.on, S.highest, 4.5);
    need(mode, 'primary (icons, bars) on ground', R.primary, S.ground, 3); need(mode, 'primary (icons, bars) on card', R.primary, S.low, 3);
    need(mode, 'on-primary on primary', R.onPrimary, R.primary, 4.5);
    need(mode, 'on-primary-container on its container', R.onPrimaryContainer, R.primaryContainer, 4.5);
    need(mode, 'on-secondary-container on its container (selected chip, nav)', R.onSecondaryContainer, R.secondaryContainer, 4.5);
    need(mode, 'on-tertiary-container on its container', R.onTertiaryContainer, R.tertiaryContainer, 4.5);
    need(mode, 'snackbar text on the inverse surface', inv.on, inv.surface, 4.5); need(mode, 'snackbar action on the inverse surface', inv.primary, inv.surface, 4.5);
  }
  need('light', 'tertiary (done bars) on card', T.E3_LIGHT.tertiary, L.low, 3);
  const low = rows.filter((r) => r.ratio < r.min);
  ok(`contrast: ${rows.length} key text/surface pairs of Expressive 3 dark and light meet 4.5:1 (body) / 3:1 (large, icons) (lowest ${Math.min(...rows.map((r) => r.ratio / r.min)).toFixed(2)}× its bar)`, !low.length, low.map((r) => `${r.mode} ${r.what} ${r.ratio.toFixed(2)}`).join('; '));
  if (process.env.KT_TABLE) for (const r of rows) console.log(`  ${r.mode.padEnd(5)} ${r.ratio.toFixed(2).padStart(5)}  ${r.what}`);
  // The yellow/amber band: hue 30–70°, saturation > 20 %, not near black or white.
  const hsl = (col) => { const [r, g, b] = T.parseColor(col).map((x, i) => (i < 3 ? x / 255 : x)); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
    const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)); let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: (h * 60 + 360) % 360, s, l }; };
  const yellow = (col) => { const x = hsl(col); return x.h >= 30 && x.h <= 70 && x.s > 0.2 && x.l > 0.08 && x.l < 0.95; };
  const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'styles', 'base.css'), 'utf8');
  const block = css.slice(css.indexOf("/* «Expressive 3» — the main theme"), css.indexOf('/* ---------- base ---------- */'));
  const all = [...Object.values(L), ...Object.values(TL), ...Object.values(RL), T.E3_LIGHT.tertiary, ...Object.values(T.E3_LIGHT.inverse), ...Object.values(D), ...Object.values(TD), ...Object.values(RD), ...Object.values(T.E3_DARK.inverse), ...(block.match(/#[0-9a-f]{6}\b/gi) || [])];
  const yel = all.filter(yellow);
  ok(`no colour of Expressive 3 (${all.length} checked, its stylesheet block too) in the yellow/amber band`, block.length > 200 && !yel.length, yel.join(', '));
  // A selected chip or place told from the others: in the dark a step lighter (≥ 1.15:1 over the chips' tone), in the
  // light by its indigo (saturation ≥ 30 points over the chips' neutral).
  ok('a selected chip is told from the others at a glance (dark by tone, light by hue)', c(RD.secondaryContainer, D.high) >= 1.15 && hsl(RL.secondaryContainer).s - hsl(L.high).s >= 0.3, `${c(RD.secondaryContainer, D.high).toFixed(2)} / ${(hsl(RL.secondaryContainer).s - hsl(L.high).s).toFixed(2)}`);
  const inCss = (v) => block.toLowerCase().includes(v.toLowerCase());
  const missing = [...Object.values(L), ...Object.values(TL), ...Object.values(RL), T.E3_LIGHT.tertiary, ...Object.values(T.E3_LIGHT.inverse), T.E3_DARK.secondaryContainer, T.E3_DARK.inverse.primary].filter((v) => !inCss(v));
  ok('base.css carries the same values as themes.ts (previews, tests and the app agree)', !missing.length, missing.join(', '));

  /* 3. in the app */
  const web = serve().listen(0, '127.0.0.1'); await new Promise((r) => web.once('listening', r)); const URL0 = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  // `seed`: { settings (string or object; null = nothing), flags (localStorage keys) }; once per context.
  const page = async (seed, scheme = 'dark', o = { w: 360, h: 780 }) => {
    const ctx = await br.newContext({ viewport: { width: o.w, height: o.h }, colorScheme: scheme, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.route(/raw\.githubusercontent\.com|api\.github\.com/, (r) => r.fulfill({ status: 404, body: '' }));
    await p.addInitScript((s) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('kr.lang', 'en');
      if (s.settings !== null) localStorage.setItem('kt.settings', typeof s.settings === 'string' ? s.settings : JSON.stringify(s.settings)); for (const [k, v] of Object.entries(s.flags || {})) localStorage.setItem(k, v); }, seed);
    return { p, ctx };
  };
  const look = (p) => p.evaluate(() => ({ theme: document.documentElement.dataset.theme, ui: document.documentElement.dataset.ui, bg: getComputedStyle(document.body).backgroundColor, meta: document.querySelector('meta[name="theme-color"]')?.getAttribute('content'), s: (() => { try { return JSON.parse(localStorage.getItem('kt.settings') || '{}'); } catch { return { corrupted: true }; } })(), note: localStorage.getItem('kt.mainThemeNote'), main: localStorage.getItem('kt.mainTheme') }));
  const start = async (p, hash = '') => { await p.goto(URL0 + hash); await p.waitForSelector('#app .view'); await p.waitForFunction(() => document.documentElement.dataset.theme !== undefined); };

  // The default per light / dark / system.
  for (const [ui, scheme, wantBg, wantUi] of [['light', 'dark', 'rgb(238, 240, 246)', 'light'], ['system', 'light', 'rgb(238, 240, 246)', 'light'], ['system', 'dark', 'rgb(18, 19, 20)', 'dark'], ['dark', 'light', 'rgb(18, 19, 20)', 'dark']]) {
    const { p, ctx } = await page({ settings: { uiMode: ui } }, scheme); await start(p);
    const r = await look(p);
    ok(`default with «${ui}» (system ${scheme}): Expressive 3 ${wantUi}`, r.theme === 'classic' && r.ui === wantUi && r.bg === wantBg && r.meta === (wantUi === 'light' ? '#eef0f6' : '#121314'), JSON.stringify(r)); await ctx.close();
  }
  { const { p, ctx } = await page({ settings: null }); await start(p); const r = await look(p);
    ok('a fresh install: Expressive 3 dark, the flag set, no snackbar', r.theme === 'classic' && r.ui === 'dark' && r.main === '1' && !r.note && !(await p.$('.main-note')), JSON.stringify(r)); await ctx.close(); }

  // Moved to Frost by itself: back to Expressive 3 once, the snackbar, «Use Frost».
  const AUTO = { settings: { theme: 'frost', uiMode: 'dark', darkTone: 'default', accent: 'graphite', glassBlur: 'auto', addons: ['player'] }, flags: { 'kt.themeMigrated': '1' } };
  {
    const { p, ctx } = await page(AUTO); await start(p);
    const r0 = await look(p);
    ok('moved to Frost by itself: Expressive 3 again, saved', r0.theme === 'classic' && r0.s.theme === 'classic' && r0.main === '1', JSON.stringify(r0));
    await p.waitForSelector('.main-note', { timeout: 5000 });
    const txt = await p.$eval('.main-note', (e) => e.textContent);
    ok('the snackbar says so, with «Use Frost» and a close button', /main theme is Expressive 3 again/.test(txt) && /Frost is still in Appearance/.test(txt) && /Use Frost/.test(txt) && !!(await p.$('.main-note .toast-x')));
    const box = await p.$eval('.main-note', (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, w: innerWidth }; });
    ok('…inside the screen at 360 px', box.l >= 0 && box.r <= box.w, JSON.stringify(box));
    ok('…shown once: its note already forgotten', (await look(p)).note === null);
    await p.click('.main-note .toast-act'); await p.waitForFunction(() => document.documentElement.dataset.theme === 'frost');
    const r1 = await look(p);
    ok('«Use Frost» puts Frost back, recorded as chosen', r1.theme === 'frost' && r1.s.theme === 'frost' && r1.s.themeChosen === true && !(await p.$('.main-note')), JSON.stringify(r1));
    await p.reload(); await p.waitForSelector('#app .view'); await p.waitForTimeout(1200);
    const r2 = await look(p);
    ok('…and after a restart: still Frost, no snackbar again', r2.theme === 'frost' && !(await p.$('.main-note')), JSON.stringify(r2));
    await ctx.close();
  }
  {
    const { p, ctx } = await page({ ...AUTO, settings: { ...AUTO.settings, darkTone: 'grey', accent: 'teal', themeKeepColours: true } }); await start(p);
    await p.waitForSelector('.main-note', { timeout: 5000 }); await p.click('.main-note .toast-x'); await p.waitForFunction(() => !document.querySelector('.main-note'));
    const r = await look(p);
    ok('✕ dismisses it: Expressive 3 stays, the colours chosen before still there (grey, teal)', r.theme === 'classic' && r.bg === 'rgb(28, 27, 31)' && r.s.accent === 'teal', JSON.stringify(r));
    await p.reload(); await p.waitForSelector('#app .view'); await p.waitForTimeout(1200);
    ok('…not shown again after a restart', !(await p.$('.main-note')) && (await look(p)).theme === 'classic');
    await ctx.close();
  }
  {
    const { p, ctx } = await page({ settings: { theme: 'frost', themeChosen: true }, flags: { 'kt.themeMigrated': '1' } }); await start(p); await p.waitForTimeout(1200);
    const r = await look(p); ok('Frost chosen by hand: kept, no snackbar', r.theme === 'frost' && !(await p.$('.main-note')), JSON.stringify(r)); await ctx.close();
  }
  {
    const { p, ctx } = await page({ settings: { theme: 'aurora', accent: 'theme' }, flags: { 'kt.themeMigrated': '1' } }); await start(p); await p.waitForTimeout(1200);
    const r = await look(p); ok('another theme chosen: kept and marked as chosen, no snackbar', r.theme === 'aurora' && r.s.themeChosen === true && !(await p.$('.main-note')), JSON.stringify(r)); await ctx.close();
  }
  {
    const n = errors.length; const { p, ctx } = await page({ settings: '{"theme": "frost", oops' }); await start(p); await p.waitForTimeout(800);
    const r = await look(p); ok('corrupted settings: the app starts clean on Expressive 3, no error, no snackbar', r.theme === 'classic' && errors.length === n && !(await p.$('.main-note')), JSON.stringify(r)); await ctx.close();
  }
  // The gallery: Expressive 3 first, «Default»; Reset goes back to it; light/dark/system explained.
  {
    const { p, ctx } = await page({ settings: { theme: 'aurora', themeChosen: true, uiMode: 'light' }, flags: { 'kt.themeMigrated': '1', 'kt.mainTheme': '1' } }, 'light'); await start(p, '#/settings/appearance');
    await p.waitForSelector('#appearance .tg-card[data-theme]');
    const g = await p.evaluate(() => ({ first: document.querySelector('#appearance .tg-card[data-theme]').dataset.theme, tag: document.querySelector('#appearance .tg-card[data-theme="classic"] .tg-tag')?.textContent, tags: document.querySelectorAll('#appearance .tg-tag').length, hint: document.querySelector('#appearance').textContent.includes('System follows your device') }));
    ok('the gallery: Expressive 3 first, the only one tagged «Default»; the light/dark line explained', g.first === 'classic' && g.tag === 'Default' && g.tags === 1 && g.hint, JSON.stringify(g));
    await p.locator('#appearance .row', { hasText: 'Reset' }).locator('button').click(); await p.waitForFunction(() => document.documentElement.dataset.theme === 'classic');
    const r = await look(p); ok('Reset: Expressive 3, the choice-marker cleared', r.theme === 'classic' && r.s.theme === 'classic' && !r.s.themeChosen, JSON.stringify(r));
    await ctx.close();
  }
  ok('no page errors', !errors.length, errors.slice(0, 3).join(' | '));
  await br.close(); web.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
