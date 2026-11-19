// node tests/themes.cjs: the glass themes (src/theme/).
//  1. contrast: every theme's text on every glass layer, over its background's brightest and darkest parts, ≥ 4.5:1
//     (from the tokens), and the drawn background stays within the extremes the tokens declare;
//  2. each theme applies its tokens on every main screen, in English and Arabic, at phone and PC sizes;
//  3. the move to themes: a fresh install, untouched settings, chosen colours kept; Classic gives back the old
//     computed colours exactly;
//  4. blur Off leaves no backdrop-filter anywhere (a sheet open too); Reduced keeps it to the bars and sheets;
//  5. PC and phone each show only their own glass option;
//  6. (0.21) the twelve palette themes (theme/palettes.ts) are all there, in dark and light; every theme × mode: each
//     text role at 4.5:1 or more on every surface container (drawn on the glass) and each «on» colour on its role; no
//     colour of any theme in the yellow–orange hues; a palette theme in use at the start is fetched and applied.
// Only loopback, made-up data, no fixed waits.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || !extra ? '' : `  — ${extra}`)); if (!c) fails++; };

// The theme module itself, bundled for Node.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-themes-'));
// (With the palette themes, which add themselves to the list as they load, and the hue rule.)
esbuild.buildSync({ stdin: { contents: "export * from './themes'; export * from './palettes'; export { banned, allowedHex } from './hues';", resolveDir: path.join(__dirname, '..', 'src', 'theme'), loader: 'ts' }, bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, 'themes.js'), logLevel: 'silent' });
const T = require(path.join(tmp, 'themes.js'));

// What today's look computes to (captured from the build before themes): Classic must give it back exactly.
const OLD = {
  default: { body: 'rgb(18, 19, 20)', '.topbar': 'color(srgb 0.0705882 0.0745098 0.0784314 / 0.86)', '.bottom-nav': 'rgb(30, 32, 34)', '.chip': 'rgb(46, 50, 55)', '.fab': 'rgb(58, 62, 69)', '.dl-status': 'color(srgb 0.117647 0.12549 0.133333 / 0.88)', '.nav-item.active .nav-pill': 'rgb(46, 50, 55)', text: 'rgb(228, 228, 230)', topbarFilter: 'blur(18px) saturate(1.2)' },
};

(async () => {
  /* 1. contrast from the tokens */
  const tones = ['default', 'grey', 'black'];
  let worst = { ratio: 99 };
  for (const def of T.THEMES) for (const mode of T.modesOf(def)) for (const darkTone of def.followsAccent ? tones : ['default']) for (const keep of [false, true]) {
    const r = T.resolve({ theme: def.id, mode, darkTone, useThemeColours: true, keepColours: keep });
    for (const x of T.contrastReport(r)) { if (x.ratio < worst.ratio) worst = { ...x, theme: def.id, mode, darkTone }; }
  }
  ok(`text on glass ≥ 4.5:1 over each background's brightest and darkest parts, every theme and mode (lowest ${worst.ratio.toFixed(2)}: ${worst.theme} ${worst.mode} ${worst.text} on ${worst.layer})`, worst.ratio >= 4.5);
  /* 1a. comfortable to the eyes: near-neutral grounds and glass, a soft glass saturation, muted accents and never a
     yellow one (HSL; an alpha colour by its own RGB) */
  {
    const hsl = (c) => { const [r, g, b] = T.parseColor(c).map((x, i) => (i < 3 ? x / 255 : x)); const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
      const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1)); let h = 0; if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; return { h: (h * 60 + 360) % 360, s, l }; };
    const lits = (str) => (String(str).match(/#[0-9a-f]{6}\b|rgba?\([^)]*\)/gi) || []).filter((x) => !/var\(/.test(x));
    const bad = [];
    for (const def of T.THEMES) for (const mode of T.modesOf(def)) {
      const tok = mode === 'dark' ? def.dark : def.light; if (!tok || def.classic || def.palette) continue;
      const lim = mode === 'dark' ? 0.10 : 0.12; const tag = `${def.id} ${mode}`;
      const surf = tok.surfaces ?? (mode === 'dark' ? T.FROST_GRAPHITE : T.FROST_LIGHT);
      for (const [k, c] of Object.entries(surf)) if (hsl(c).s > lim) bad.push(`${tag} ${k} ${c} S ${(hsl(c).s * 100).toFixed(0)}%`);
      for (const k of ['pane', 'card', 'sheet']) if (typeof tok[k] === 'string' && hsl(tok[k]).s > lim) bad.push(`${tag} ${k} ${tok[k]}`);
      if (tok.sat > 1.05) bad.push(`${tag} --g-sat ${tok.sat}`);
      for (const c of lits(tok.bg)) if (hsl(c).s > 0.25) bad.push(`${tag} background ${c}`);
      for (const [k, c] of Object.entries(tok.roles ?? {})) { if (!lits(c).length) continue; const x = hsl(c);
        if (x.h >= 30 && x.h <= 70 && x.s > 0.2 && x.l > 0.08 && x.l < 0.95) bad.push(`${tag} ${k} ${c} is yellow`);
        if (k === 'primary' && x.s > 0.4) bad.push(`${tag} primary ${c} S ${(x.s * 100).toFixed(0)}%`); }
    }
    ok('comfortable to the eyes: grounds and glass ≤ 10 % (dark) / 12 % (light) saturation, glass saturation ≤ 1.05, the background a whisper of hue, accents muted, none yellow', !bad.length, bad.join('; '));
    ok('the calm rules bind every glass theme but the palette ones (whose colours are their identity: checked below)', T.THEMES.filter((x) => !x.palette && !x.classic).length >= 7);
    ok('a theme taken out of the app (ember) falls back to the default', T.themeById('ember').id === 'classic' && !T.THEMES.some((x) => x.id === 'ember'));
  }
  /* 6. (0.21) the palette themes; every surface; no yellow anywhere */
  {
    const WANT = ['resonance', 'neon-night', 'plum-dusk', 'glacier', 'aurora-lake', 'claret', 'argent', 'lilac-milk', 'abyss', 'slate-rain', 'sakura-night', 'nebula'];
    const missing = WANT.filter((id) => { const d = T.THEMES.find((x) => x.id === id); return !d || !d.dark || !d.light || !d.nameKey || !d.dark.roles || !d.light.roles; });
    ok(`the twelve palette themes are there, each in dark and light with its own colours (${WANT.length})`, !missing.length && ['classic', 'frost'].every((id) => T.THEMES.some((x) => x.id === id)), missing.join(', '));
    const P = T.parseColor; let worst = { r: 99 }; let n = 0;
    for (const def of T.THEMES) for (const mode of T.modesOf(def)) for (const darkTone of def.followsAccent ? ['default', 'grey', 'black'] : ['default']) {
      const r = T.resolve({ theme: def.id, mode, darkTone, useThemeColours: true }); const ground = P(r.surfaces.ground);
      const unders = r.tokens ? r.tokens.extremes.map((e) => T.over(r.card, T.over(P(e), ground))) : [ground];
      const note = (ratio, what) => { n++; if (ratio < worst.r) worst = { r: ratio, what: `${def.id} ${mode} ${darkTone} ${what}` }; };
      for (const u of unders) for (const k of ['lowest', 'low', 'mid', 'high', 'highest']) {
        const sf = r.tokens ? T.over([...P(r.surfaces[k]).slice(0, 3), r.tokens.fill], u) : P(r.surfaces[k]);
        for (const tx of ['on', 'variant', 'dim']) note(T.contrast(T.over(P(r.text[tx]), sf), sf), `${tx} on ${k}`);
      }
      if (r.roles) for (const [a, b] of [['onPrimary', 'primary'], ['onPrimaryContainer', 'primaryContainer'], ['onSecondaryContainer', 'secondaryContainer'], ['onTertiaryContainer', 'tertiaryContainer']]) {
        const bc = T.over(P(r.roles[b]), unders[0]); note(T.contrast(T.over(P(r.roles[a]), bc), bc), `${a} on ${b}`);
      }
    }
    ok(`every theme × mode (× dark tone): text ≥ 4.5:1 on every surface container, each «on» colour on its role (${n} pairs; lowest ${worst.r.toFixed(2)}: ${worst.what})`, worst.r >= 4.5);
    const lits = (str) => (String(str).match(/#[0-9a-f]{6}\b|rgba?\([^)]*\)/gi) || []);
    const yellow = [];
    for (const def of T.THEMES) for (const mode of ['dark', 'light']) { const tok = def[mode]; if (!tok) continue;
      for (const [k, v] of Object.entries(tok)) for (const c of typeof v === 'object' && v ? Object.values(v).flatMap(lits) : lits(v)) if (T.banned(P(c))) yellow.push(`${def.id} ${mode} ${k} ${c}`); }
    ok('no colour of any theme in the yellow–orange hues (20°–85°)', !yellow.length, yellow.slice(0, 6).join('; '));
    ok('a colour picked in that band is moved to the nearest allowed hue; others are kept', T.allowedHex('#e0b45c').moved && !T.banned(P(T.allowedHex('#e0b45c').hex)) && T.allowedHex('#ff9900').moved && !T.allowedHex('#22d3ee').moved && T.allowedHex('#22D3EE').hex === '#22d3ee' && !T.allowedHex('#8a8580').moved);
    ok('credits: Sakura Night and Plum Dusk carry their MIT notices', /Catppuccin/.test(T.themeById('sakura-night').notice || '') && /Ros/.test(T.themeById('plum-dusk').notice || ''));
  }
  ok('the blur follows the platform (phone Reduced, computer Full, WebKitGTK Reduced) and the system\'s wishes', T.resolveBlur('auto', { platform: 'android', phone: true, webkitGtk: false, reducedTransparency: false, reducedMotion: false, lowBattery: false }).blur === 'reduced'
    && T.resolveBlur('auto', { platform: 'desktop', phone: false, webkitGtk: false, deviceMemory: 16, reducedTransparency: false, reducedMotion: false, lowBattery: false }).blur === 'full'
    && T.resolveBlur('auto', { platform: 'desktop', phone: false, webkitGtk: true, reducedTransparency: false, reducedMotion: false, lowBattery: false }).blur === 'reduced'
    && T.resolveBlur('auto', { platform: 'desktop', phone: false, webkitGtk: false, deviceMemory: 4, reducedTransparency: false, reducedMotion: false, lowBattery: false }).why === 'memory'
    && T.resolveBlur('auto', { platform: 'android', phone: true, webkitGtk: false, reducedTransparency: true, reducedMotion: false, lowBattery: false }).blur === 'off'
    && T.resolveBlur('auto', { platform: 'android', phone: true, webkitGtk: false, reducedTransparency: false, reducedMotion: false, lowBattery: true }).blur === 'off'
    && T.resolveBlur('full', { platform: 'android', phone: true, webkitGtk: false, reducedTransparency: true, reducedMotion: false, lowBattery: false }).blur === 'full');
  ok('migration (0.17): fresh → the default (Expressive 3 since 0.21); untouched → the default; chosen colours → kept', T.migrateLook(null).theme === 'classic' && !T.migrateLook(null).keepColours && T.migrateLook({ uiMode: 'dark', darkTone: 'default', accent: 'graphite' }).keepColours === false && T.migrateLook({ darkTone: 'grey', accent: 'graphite' }).keepColours === true && T.migrateLook({ accent: 'teal' }).keepColours === true);

  const web = serve().listen(0, '127.0.0.1'); await new Promise((r) => web.once('listening', r)); const port = web.address().port; const URL0 = `http://127.0.0.1:${port}/`;
  const br = await chromium.launch(); const errors = [];
  const page = async (o, settings, lang = 'en') => {
    const ctx = await br.newContext({ viewport: { width: o.w, height: o.h }, deviceScaleFactor: o.dpr || 1, isMobile: !!o.mobile, hasTouch: !!o.mobile, locale: lang, reducedMotion: 'reduce', serviceWorkers: 'block', colorScheme: 'dark' }); // (A dark system: «system», the default mode since 0.21, shows these in dark as they were measured.)
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript(([s, l]) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('kr.lang', l); if (s !== null) localStorage.setItem('kt.settings', s); if (s && s.includes('"__migrated"')) { localStorage.setItem('kt.themeMigrated', '1'); localStorage.setItem('kt.mainTheme', '1'); } }, [settings === null ? null : JSON.stringify({ addons: ['player'], ...settings }), lang]);
    // (raw.githubusercontent.com — the theme list — is not reached: answered 404 here.)
    await p.route(/raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404, body: '' }));
    return { p, ctx };
  };
  const PHONE = { w: 360, h: 800, mobile: true }, PC = { w: 1280, h: 800 };
  const go = async (p, hash, sel) => { await p.goto(URL0 + hash); await p.waitForSelector(sel); await p.waitForFunction(() => document.documentElement.dataset.theme !== undefined); };

  /* 1b. the drawn background within the declared extremes */
  for (const id of (process.env.KT_ONLY ? [process.env.KT_ONLY] : ['frost', 'aurora', 'obsidian', 'washi', 'frosted-glass', 'neon-night', 'resonance'])) for (const mode of T.modesOf(T.themeById(id))) {
    const { p, ctx } = await page(PHONE, { theme: id, uiMode: mode, accent: T.themeById(id).followsAccent ? 'graphite' : 'theme', glassBlur: 'off', __migrated: 1 });
    await go(p, '', '.downloads-view');
    // (Everything over the background made invisible, and seen to be so, before the picture is taken.)
    await p.waitForFunction(() => { let st = document.getElementById('kt-bare'); if (!st) { st = document.createElement('style'); st.id = 'kt-bare'; st.textContent = 'body > * { opacity: 0 !important; }'; document.head.append(st); } return [...document.body.children].every((e) => getComputedStyle(e).opacity === '0'); });
    const shot = await p.screenshot({ type: 'png' });
    if (process.env.KT_SHOTS) fs.writeFileSync(path.join(process.env.KT_SHOTS, `bg-${id}-${mode}.png`), shot);
    const [lo, hi] = await p.evaluate(async (b64) => { const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode(); const c = document.createElement('canvas'); c.width = 60; c.height = 120; const g = c.getContext('2d'); g.filter = 'blur(2px)'; g.drawImage(img, 0, 0, 60, 120); const d = g.getImageData(4, 4, 52, 112).data; const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; let a = 1, z = 0; for (let i = 0; i < d.length; i += 4) { const L = 0.2126 * f(d[i]) + 0.7152 * f(d[i + 1]) + 0.0722 * f(d[i + 2]); a = Math.min(a, L); z = Math.max(z, L); } return [a, z]; }, shot.toString('base64'));
    const r = T.resolve({ theme: id, mode, darkTone: 'default', useThemeColours: true }); const ex = r.tokens.extremes.map((x) => T.luminance(T.over(T.parseColor(x), T.parseColor(r.surfaces.ground))));
    ok(`${id} ${mode}: the drawn background stays within its declared extremes`, hi <= Math.max(...ex) + 0.02 && lo >= Math.min(...ex) - 0.02, `drawn ${lo.toFixed(3)}–${hi.toFixed(3)}, declared ${Math.min(...ex).toFixed(3)}–${Math.max(...ex).toFixed(3)}`);
    await ctx.close();
  }

  /* 1c. the header's title on the start side in every theme (a narrow phone stacks the bar: buttons, then the title
     below — never the title after the buttons, on the far side), and the bar settled (the same layout twice) */
  {
    const bad = [];
    // (Of the palette themes, two: they share one shape; each is fetched at the start here, as when it is in use.)
    for (const lang of ['en', 'ar']) for (const def of T.THEMES.filter((x) => !x.custom && (!x.palette || ['neon-night', 'sakura-night'].includes(x.id)))) {
      const { p, ctx } = await page({ w: 360, h: 780, mobile: true, dpr: 2 }, { theme: def.id, glassBlur: 'full', __migrated: 1 }, lang);
      // (As on a phone: the native bridge there gives the bar all its buttons — the narrow case.)
      await p.addInitScript(() => { const L = {}; const plugin = new Proxy({ addListener: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return { remove() {} }; }, list: async () => ({ tasks: [] }) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] }; });
      await go(p, '', '.downloads-view > .topbar .title');
      // (The window resized by a pixel and back, as a phone turning or its keyboard does: the bar decides again.)
      await p.evaluate(() => document.fonts.ready); await p.setViewportSize({ width: 361, height: 780 }); await p.setViewportSize({ width: 360, height: 780 }); await p.waitForTimeout(250);
      const look = () => p.evaluate(() => { const tb = document.querySelector('.downloads-view > .topbar'); const t = tb.querySelector(':scope > .title').getBoundingClientRect(); const a = tb.querySelector(':scope > .topbar-actions').getBoundingClientRect();
        const rtl = document.documentElement.dir === 'rtl'; const below = t.top >= a.bottom - 1; return { cls: tb.className, start: below || (rtl ? t.right >= a.right : t.left <= a.left), wide: document.scrollingElement.scrollWidth > innerWidth + 1 }; });
      const one = await look(); await p.waitForTimeout(200); const two = await look();
      if (!one.start || one.wide || one.cls !== two.cls) bad.push(`${def.id} ${lang} ${JSON.stringify([one, two])}`);
      await ctx.close();
    }
    ok('the header\'s title on the start side in every theme (en, ar), the bar settled, nothing wider than the screen', !bad.length, bad.join('; '));
  }

  /* 2. tokens on every main screen */
  const SCREENS = [['', '.downloads-view'], ['#/search', '.view'], ['#/videos', '.view'], ['#/settings', '.settings-view']];
  for (const lang of ['en', 'ar']) for (const [size, o] of [['phone', PHONE], ['pc', PC]]) for (const id of ['frost', 'aurora', 'obsidian', 'classic', 'neon-night']) {
    const { p, ctx } = await page(o, { theme: id, accent: id === 'aurora' || id === 'neon-night' ? 'theme' : 'graphite', glassBlur: 'full', __migrated: 1 }, lang);
    let good = true; let why = '';
    for (const [hash, sel] of SCREENS) {
      await go(p, hash, sel);
      const st = await p.evaluate(() => { const h = document.documentElement; const cs = (q, k) => { const e = document.querySelector(q); return e ? getComputedStyle(e)[k] : null; }; const before = getComputedStyle(document.body, '::before'); return { theme: h.dataset.theme, glass: h.dataset.glass, dir: h.dir, bgImg: before.backgroundImage, bar: cs('.topbar', 'backdropFilter'), nav: cs('.bottom-nav', 'backdropFilter') ?? cs('.nav-rail', 'backdropFilter'), low: getComputedStyle(h).getPropertyValue('--md-surface-container-low').trim(), primary: getComputedStyle(h).getPropertyValue('--md-primary').trim() }; });
      const glassy = id !== 'classic';
      const fine = st.theme === id && (lang === 'ar' ? st.dir === 'rtl' : st.dir === 'ltr') && (glassy ? st.glass === 'full' && st.bgImg.includes('gradient') && (st.bar === null || /blur/.test(st.bar) || hash === '#/settings') && /blur/.test(st.nav || '') && /\/ 0?\.\d/.test(st.low) : st.glass === undefined && st.bgImg === 'none' && st.low === '#1a1b1d') && (id !== 'aurora' || st.primary === '#a1c0bc');
      if (!fine) { good = false; why = `${hash || '#/'} ${JSON.stringify(st)}`; }
    }
    ok(`${id} applies on every main screen (${lang}, ${size})`, good, why);
    await ctx.close();
  }

  /* 3. the move to themes, in the app (0.17's, then 0.21's: Expressive 3 the default again) */
  {
    const { p, ctx } = await page(PHONE, null); await go(p, '', '.downloads-view');
    const r = await p.evaluate(() => ({ s: JSON.parse(localStorage.getItem('kt.settings') || '{}'), flag: localStorage.getItem('kt.themeMigrated'), main: localStorage.getItem('kt.mainTheme'), theme: document.documentElement.dataset.theme }));
    ok('a fresh install gets Expressive 3 and both flags', r.theme === 'classic' && r.flag === '1' && r.main === '1', JSON.stringify(r)); await ctx.close();
  }
  {
    const { p, ctx } = await page(PHONE, { uiMode: 'dark', darkTone: 'default', accent: 'graphite' }); await go(p, '', '.downloads-view');
    const r = await p.evaluate(() => ({ s: JSON.parse(localStorage.getItem('kt.settings')), flag: localStorage.getItem('kt.themeMigrated'), note: localStorage.getItem('kt.mainThemeNote'), bg: getComputedStyle(document.body).backgroundColor }));
    ok('settings from before themes keep the look they had (Expressive 3), no snackbar owed', r.s.theme === 'classic' && r.flag === '1' && !r.note && r.bg === 'rgb(18, 19, 20)', JSON.stringify(r)); await ctx.close();
  }
  {
    const { p, ctx } = await page(PHONE, { uiMode: 'dark', darkTone: 'grey', accent: 'teal' }); await go(p, '', '.downloads-view');
    const r = await p.evaluate(() => { const c = getComputedStyle(document.documentElement); return { s: JSON.parse(localStorage.getItem('kt.settings')), bg: getComputedStyle(document.body).backgroundColor, primary: c.getPropertyValue('--md-primary').trim() }; });
    ok('chosen colours from before themes are kept (grey tone, teal accent) in Expressive 3', r.s.theme === 'classic' && r.bg === 'rgb(28, 27, 31)' && r.primary === '#86d6cf', JSON.stringify(r)); await ctx.close();
  }
  {
    const { p, ctx } = await page(PHONE, { theme: 'frost', __migrated: 1 }); await go(p, '#/settings/appearance', '.tg-card[data-theme="classic"]');
    await p.click('.tg-card[data-theme="classic"] .tg-pick'); await p.waitForFunction(() => document.documentElement.dataset.theme === 'classic');
    await go(p, '', '.downloads-view .dl-status');
    const got = await p.evaluate((keys) => { const o = {}; for (const q of keys) { const e = document.querySelector(q); o[q] = e ? getComputedStyle(e).backgroundColor : null; } o.text = getComputedStyle(document.body).color; o.topbarFilter = getComputedStyle(document.querySelector('.topbar')).backdropFilter; return o; }, Object.keys(OLD.default).filter((k) => k !== 'text' && k !== 'topbarFilter'));
    // (0.21: the one change on purpose — a chosen chip and the bottom bar's place a step lighter and cooler, told at a glance.)
    const SELECTED = { '.chip': 'rgb(58, 64, 75)', '.nav-item.active .nav-pill': 'rgb(58, 64, 75)' };
    const diff = Object.entries({ ...OLD.default, ...SELECTED }).filter(([k, v]) => got[k] !== v);
    ok('Expressive 3, in one tap, gives back the old default\'s computed colours exactly (its selected tone a step clearer)', diff.length === 0, JSON.stringify(diff.map(([k]) => [k, got[k]])));
    await ctx.close();
  }

  /* 4. blur off, and reduced */
  for (const [blur, size, o] of [['off', 'phone', PHONE], ['off', 'pc', PC], ['reduced', 'phone', PHONE]]) {
    const { p, ctx } = await page(o, { theme: 'frost', glassBlur: blur, __migrated: 1 });
    const seen = [];
    for (const [hash, sel] of SCREENS) {
      await go(p, hash, sel);
      if (!hash) { await p.click(o.mobile ? '.fab' : '.rail-fab'); await p.waitForSelector('.fab-menu'); }
      seen.push(...await p.evaluate(() => [...document.querySelectorAll('*')].map((e) => [e.className && String(e.className).slice(0, 40), getComputedStyle(e).backdropFilter, getComputedStyle(e, '::before').backdropFilter]).filter((x) => (x[1] && x[1] !== 'none') || (x[2] && x[2] !== 'none'))));
      if (!hash) await p.keyboard.press('Escape');
    }
    if (blur === 'off') ok(`blur Off: no backdrop-filter on any element (${size})`, seen.length === 0, JSON.stringify(seen.slice(0, 4)));
    else { const cards = seen.filter((x) => /\bcard\b/.test(x[0]) && !/task-card/.test(x[0])); ok('blur Reduced: bars and sheets only, never the cards', seen.length > 0 && cards.length === 0, JSON.stringify(cards.slice(0, 3))); }
    await ctx.close();
  }

  /* 5. PC and phone options */
  for (const [size, o] of [['phone', PHONE], ['pc', PC]]) {
    const { p, ctx } = await page(o, { theme: 'frost', __migrated: 1 });
    await go(p, '#/settings/appearance', '#appearance .tg-grid .tg-card');
    const r = await p.evaluate(() => { const txt = document.querySelector('#appearance').textContent; return { battery: /low battery/i.test(txt), rail: /Glass sidebar/.test(txt), blur: /Glass blur/.test(txt), cards: document.querySelectorAll('#appearance .tg-card[data-theme]').length }; });
    ok(`${size}: ${size === 'pc' ? 'the sidebar choice, not the battery one' : 'the battery choice, not the sidebar one'}; the blur choice and every theme`, r.blur && r.cards >= 8 && (size === 'pc' ? r.rail && !r.battery : r.battery && !r.rail), JSON.stringify(r));
    await ctx.close();
  }

  /* 6b. the accent swatches: none yellow, amber or olive offered; the custom one's wheel within the allowed hues */
  {
    const { p, ctx } = await page(PC, { theme: 'classic', __migrated: 1 }); await go(p, '#/settings/appearance', '#appearance .accent-swatches');
    const r = await p.evaluate(() => ({ offered: [...document.querySelectorAll('.accent-swatches .swatch[data-accent]')].map((b) => b.dataset.accent), wheel: getComputedStyle(document.querySelector('.swatch.custom')).backgroundImage }));
    const wheel = (r.wheel.match(/rgba?\([^)]*\)/g) || []).map((c) => T.parseColor(c.replace(/,/g, ' ')));
    ok('accents offered: none yellow, amber or olive; the custom swatch\'s wheel has no yellow or orange', !r.offered.some((a) => ['gold', 'sand', 'olive'].includes(a)) && r.offered.length >= 6 && wheel.length >= 4 && !wheel.some((c) => T.banned(c)), JSON.stringify(r));
    await ctx.close();
  }
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await br.close(); web.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
