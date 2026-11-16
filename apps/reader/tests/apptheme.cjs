// node tests/apptheme.cjs: the shared theme files (src/theme/themes.ts, custom.ts, gallery.ts, editor.ts — the same
// bytes as Kurokawa Tools') read what differs from src/theme/app.ts, the Reader's own; this proves the Reader's side
// stayed as it was when Tools' main theme and moving backgrounds came (Tools 0.21):
//  1. the Reader's choices: Frost the default theme, Classic its name and the last card (downloaded styles before it),
//     no pencil and no «Default» tag on it, no main-theme move (no migrateMain), Classic's colours the app's own in
//     light and dark, no moving backgrounds;
//  2. a saved or imported style whose background is Tools' 'drift' or 'flow' is accepted and drawn as its still
//     stand-in (the mesh of its three colours): no data-anim, no --th-anim-*, nothing animated;
//  3. in the Reader, every kind of stored settings (none, Classic, a glass style, a style of one's own, settings from
//     before styles, corrupted): the interface style stays what was stored (Classic when nothing was), nothing is
//     written back, no snackbar, no moving background; on a computer the style editor offers no moving background and
//     Appearance has no such row. With KR_OLD_DIST (a build from before), each case looks the same in both builds
//     (but the moving one, which a build from before refused).
// Only loopback and made-up data.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.join(__dirname, '..', 'dist');
const OLD = process.env.KR_OLD_DIST ? path.resolve(process.env.KR_OLD_DIST) : null;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
let fails = 0; const ok = (n, c, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || !extra ? '' : `  — ${typeof extra === 'string' ? extra : JSON.stringify(extra).slice(0, 600)}`)); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-apptheme-'));
const bundle = (name) => { esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'theme', `${name}.ts`)], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, `${name}.js`), logLevel: 'silent' }); return require(path.join(tmp, `${name}.js`)); };
const J = (x) => JSON.parse(JSON.stringify(x));
const hex = (c) => { const n = parseInt(c.slice(1, 7), 16); return `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`; };

// A style of one's own whose background is Tools' moving 'drift' (dark) and 'flow' (light).
const COLS = ['#2b3540', '#3a3e45', '#2e3237'];
const MOVING = { v: 1, id: 'my-moving1', name: 'Moving', base: 'frost', radius: 1, accent: 'app', at: 1,
  dark: { surfaces: { ground: '#0a0b0d', lowest: '#070809', low: '#111316', mid: '#15171b', high: '#1c1f24', highest: '#24282e' }, text: { on: '#e2e4e8', variant: '#b4b8bf', dim: '#8f949c', outline: '#7d828a', outlineVariant: '#2c3036' }, roles: null, tint: '#111316', strength: 0.66, blur: 28, sat: 1.35, edge: 0.07, sheen: 0.05, shadow: 0.7, bg: { kind: 'drift', colors: COLS, solid: '#0a0b0d', veil: 0.2, picBlur: 0 } },
  light: { surfaces: { ground: '#ebebe9', lowest: '#fbfbfa', low: '#f5f5f3', mid: '#efefed', high: '#e6e6e3', highest: '#dddddb' }, text: { on: '#1a1c1e', variant: '#43474e', dim: '#5b5f66', outline: '#6b6f76', outlineVariant: '#c4c7cc' }, roles: null, tint: '#fbfbfa', strength: 0.6, blur: 24, sat: 1.2, edge: 0.5, sheen: 0.6, shadow: 0.4, bg: { kind: 'flow', colors: ['#d8e3ee', '#dfe2e6', '#e6e8ec'], solid: '#ebebe9', veil: 0.2, picBlur: 0 } } };

(async () => {
  /* 1. the Reader's choices */
  const A = bundle('app'); const T = bundle('themes'); const C = bundle('custom'); const P = bundle('packs');
  ok('src/theme/app.ts: Frost the default, Classic named «Classic» and last, no pencil, no tag, no moving backgrounds, radius from 20',
    JSON.stringify(A.APP_THEME) === JSON.stringify({ defaultTheme: 'frost', mainNameKey: 'themeClassic', mainFirst: false, mainCopyable: false, mainTag: false, animBg: false, radiusLg: 20 }), A.APP_THEME);
  ok('no main-theme move in the Reader: app.ts exports nothing but its config, themes.ts no migrateMain', JSON.stringify(Object.keys(A)) === '["APP_THEME"]' && T.migrateMain === undefined && T.E3_LIGHT === undefined);
  ok('the default theme is Frost; an unknown id falls back to it', T.DEFAULT_THEME === 'frost' && T.themeById(undefined).id === 'frost' && T.themeById('gone').id === 'frost');
  const cl = T.THEMES[T.THEMES.length - 1];
  ok('Classic closes the list, under its own name', cl.id === 'classic' && cl.classic && cl.nameKey === 'themeClassic' && T.THEMES[0].id === 'frost');
  T.registerTheme({ id: 'pk-test', name: 'Pack', dark: T.themeById('frost').dark });
  ok('a downloaded theme goes before Classic', T.THEMES[T.THEMES.length - 2].id === 'pk-test' && T.THEMES[T.THEMES.length - 1].id === 'classic');
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const rl = T.resolve({ theme: 'classic', mode: 'light', darkTone: 'default', useThemeColours: true }); const rd = T.resolve({ theme: 'classic', mode: 'dark', darkTone: 'grey', useThemeColours: true });
  ok('Classic in light and dark: the app\'s own surfaces and text, no tokens, no roles', rl.tokens === null && same(rl.surfaces, T.APP_SURFACES.light) && same(rl.text, T.APP_TEXT.light) && rl.roles === null
    && rd.tokens === null && same(rd.surfaces, T.APP_SURFACES.grey) && same(rd.text, T.APP_TEXT.dark));
  const pv = (m) => T.previewOf(cl, m, 'default').vars;
  ok('Classic\'s gallery card is drawn with the default accent (graphite), light and dark', ['light', 'dark'].every((m) => Object.values(T.GRAPHITE[m]).every((c) => Object.values(pv(m)).includes(c))));
  const noR = J(T.themeById('frost')); delete noR.radius; noR.id = 'no-radius'; T.upsertTheme(noR);
  ok('a copy of a theme without its own radius keeps the scale 1 (from 20)', C.fromBase(T.themeById('no-radius'), 'default', 'x').radius === 1);

  /* 2. a moving background brought into the Reader: its still stand-in */
  const s = C.sanitise(J(MOVING)); const def = C.toDef(s);
  ok('a style whose background is \'drift\' / \'flow\' is accepted (the kinds kept, so it goes back to Tools as it came)', s.dark.bg.kind === 'drift' && s.light.bg.kind === 'flow');
  ok('…and drawn still: no moving background in its tokens, the mesh of its three colours instead', ['dark', 'light'].every((m) => def[m].anim === undefined && def[m].animColors === undefined && /^radial-gradient\(90% 48%/.test(def[m].bg))
    && COLS.every((c) => def.dark.bg.includes(`rgb(${hex(c).replace(/, /g, ' ')}`) || def.dark.bg.includes(hex(c))), def.dark.bg);
  const imported = await C.importTheme(await P.buildPack({ format: 1, id: 'x', name: 'x', version: '1', tokens: { kurokawaMyTheme: 1, theme: J(MOVING) } }, []));
  const idef = C.toDef(imported.my ?? imported);
  ok('an imported .ktheme with drift/flow loads, and as its still stand-in', idef.dark.anim === undefined && idef.light.anim === undefined && /radial-gradient/.test(idef.dark.bg));

  /* 3. in the Reader */
  const serve = (dist) => { const w = http.createServer((req, res) => { let f = path.join(dist, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }); w.listen(0, '127.0.0.1'); return new Promise((r) => w.once('listening', () => r(w))); };
  const br = await chromium.launch(); const errors = [];
  const CASES = [
    ['a fresh install (nothing stored)', null, null],
    ['Classic chosen, dark', JSON.stringify({ uiStyle: 'classic', theme: 'dark' }), null],
    ['a glass style chosen', JSON.stringify({ uiStyle: 'frosted-glass', theme: 'grey', glassBlur: 'full' }), null],
    ['Frost stored (as Tools\' 0.17 gave it)', JSON.stringify({ uiStyle: 'frost', theme: 'grey' }), null],
    ['a style of one\'s own with a moving background', JSON.stringify({ uiStyle: MOVING.id, theme: 'dark' }), JSON.stringify([MOVING])],
    ['settings from before styles (light)', JSON.stringify({ theme: 'light', fontSize: 18 }), null],
    ['corrupted settings', '{"uiStyle": "clas', null],
  ];
  const look = async (dist, visual, mine, pc) => {
    const w = await serve(dist); const port = w.address().port;
    const ctx = await br.newContext({ viewport: pc ? { width: 1280, height: 800 } : { width: 380, height: 800 }, isMobile: !pc, hasTouch: !pc, locale: 'en', serviceWorkers: 'block', reducedMotion: 'no-preference' });
    await ctx.route(/raw\.githubusercontent\.com|github\.com/, (r) => r.fulfill({ status: 404, body: '' }));
    await ctx.addInitScript(([v, m]) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); if (v !== null) localStorage.setItem('kr.visual', v); if (m !== null) localStorage.setItem('kr.myStyles', m); }, [visual, mine]);
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.library-view'); await p.waitForTimeout(1500);
    const snap = await p.evaluate(() => { const h = document.documentElement; const cs = getComputedStyle(h); let vis = null; try { vis = JSON.parse(localStorage.getItem('kr.visual') || 'null'); } catch { vis = 'unreadable'; }
      return { uiStyle: vis && typeof vis === 'object' ? vis.uiStyle : vis, chosen: vis && typeof vis === 'object' && 'themeChosen' in vis, theme: h.dataset.theme ?? null, glass: h.dataset.glass ?? null, anim: h.dataset.anim ?? null,
        animVar: cs.getPropertyValue('--th-anim-a').trim(), bg: cs.getPropertyValue('--th-bg').trim().slice(0, 120), animHost: !!document.querySelector('#kt-animbg'), toast: !!document.querySelector('.toast, .main-note, .undo-snack') }; });
    return { snap, p, ctx, w };
  };
  for (const [name, visual, mine] of CASES) {
    const { snap, ctx, w } = await look(DIST, visual, mine, false); await ctx.close(); w.close();
    const want = name.startsWith('a glass') ? 'frosted-glass' : name.startsWith('Frost') ? 'frost' : name.includes('own') ? MOVING.id : 'classic';
    const stored = (() => { try { return visual ? JSON.parse(visual).uiStyle ?? 'classic' : 'classic'; } catch { return 'classic'; } })();
    // (Corrupted settings are left as they are — unreadable, so Classic shows — exactly as before.)
    ok(`${name}: the interface style stays ${want}, nothing marked, no snackbar, nothing moving`, (snap.uiStyle === 'unreadable' ? 'classic' : snap.uiStyle ?? 'classic') === stored && stored === want && !snap.chosen && !snap.toast && snap.anim === null && !snap.animVar && !snap.animHost
      && (want === 'classic' ? snap.glass === null : true), snap);
    if (name.includes('own')) ok(`${name}: drawn as its still stand-in (the mesh of its three colours)`, snap.theme === MOVING.id && /radial-gradient/.test(snap.bg) && snap.anim === null, snap);
    // (The one case a build from before cannot draw: 'drift'/'flow' did not exist, so it refused that style and showed
    //  Classic; now it is shown, still. Every other case must look the same.)
    if (OLD && !name.includes('own')) { const o = await look(OLD, visual, mine, false); await o.ctx.close(); o.w.close(); ok(`${name}: the same as the build before (KR_OLD_DIST)`, JSON.stringify(o.snap) === JSON.stringify(snap), { before: o.snap, now: snap }); }
  }
  // On a computer: the gallery, the editor and Appearance offer no moving background; Classic has no pencil, no tag.
  {
    const { p, ctx, w } = await look(DIST, JSON.stringify({ uiStyle: 'paper-ink', theme: 'dark' }), JSON.stringify([MOVING]), true);
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.tg-card[data-theme="paper-ink"] .tg-edit', { state: 'attached' });
    await p.evaluate(() => { const card = document.querySelector('.tg-grid').closest('.card'); card.classList.remove('collapsed'); document.querySelector(`[data-sec="${card.id}"]`)?.click(); });
    const cards = await p.evaluate(() => [...document.querySelectorAll('.tg-grid .tg-card')].map((c) => ({ id: c.dataset.theme, edit: !!c.querySelector('.tg-edit'), tag: !!c.querySelector('.tg-tag') })));
    const ids = cards.map((c) => c.id); const cls = cards.find((c) => c.id === 'classic');
    ok('the gallery: Classic after the built-in styles, no pencil, no «Default» tag; no tag anywhere', cls && !cls.edit && !cls.tag && ids.indexOf('classic') > ids.indexOf('frosted-glass-dark') && !cards.some((c) => c.tag), cards);
    const text = await p.evaluate(() => document.querySelector('.settings-view').innerText);
    ok('Appearance has no moving-background row', !/Animated background|Frost drift|Expressive flow|Expressive 3/.test(text));
    await p.click('.tg-card[data-theme="paper-ink"] .tg-edit'); await p.waitForSelector('.te-panel');
    const chips = await p.evaluate(() => [...document.querySelectorAll('.te-panel .te-chips[role="radiogroup"] .chip')].map((b) => b.textContent));
    ok('the style editor on a computer: background kinds without a moving one', chips.length >= 4 && chips.length <= 5 && !chips.some((c) => /drift|flow|animBg/i.test(c)) && !(await p.$('.te-panel .te-note')), chips);
    await ctx.close(); w.close();
  }
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await br.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
