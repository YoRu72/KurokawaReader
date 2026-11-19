// node tests/themeeditor.cjs: the theme editor and «My themes» (src/theme/editor.ts, custom.ts, history.ts).
//  1. history: a slider drag is one step; undo/redo; sealing; a deferred removal undone and committed;
//  2. the import sanitiser: CSS injection, url(), unknown fields, wrong schema, oversized, wrong picture type — all
//     refused; names stripped of markup; numbers held to their ranges;
//  3. in the app (phone en, PC ar): edit → the live tokens change; undo/redo (buttons and Ctrl+Z); reset arrows;
//     the contrast warning and «Fix contrast»; Back with unsaved changes (Keep editing / Discard); save → «My themes»,
//     in use, still there after a reload; duplicate, rename, delete with Undo, delete for good; a picture background
//     kept and shown offline; export → import gives the same theme; a malicious file refused; Reset appearance + Undo.
//  4. (0.21, the editor's extras) accent and second accent, progress colour, surface tint and strength, spacing, size,
//     light/dark/auto each change the right token live; a yellow pick is moved out of the band with a note; colours per
//     background on a computer and none of that on a phone; «reset all»; the contrast corrected on save; the import caps
//     (fields the format lacks dropped, numbers clamped, colours strict, names cleaned and cut, too many backgrounds,
//     hostile values refused); export → import keeps every extra; the editor opened and closed leaves no listener behind.
// Only loopback and made-up data; no fixed waits.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const esbuild = require(path.join(__dirname, '..', 'node_modules', 'esbuild'));
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let fails = 0; const ok = (n, c, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || !extra ? '' : `  — ${extra}`)); if (!c) fails++; };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-editor-'));
const bundle = (name) => { esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src', 'theme', `${name}.ts`)], bundle: true, format: 'cjs', platform: 'node', outfile: path.join(tmp, `${name}.js`), logLevel: 'silent' }); return require(path.join(tmp, `${name}.js`)); };

(async () => {
  /* 1. history */
  const { History, deferred } = bundle('history');
  const h = new History(0);
  for (const v of [1, 2, 3, 4]) h.push(v, 'slider:blur'); h.seal(); h.push(10, 'slider:blur'); h.seal(); h.push(11);
  ok('history: a continuous drag is one step; sealed, the next drag is another', h.current === 11 && h.undo() === 10 && h.undo() === 4 && h.undo() === 0 && h.undo() === null && h.redo() === 4 && h.redo() === 10);
  h.push(99); ok('history: a new change after undo drops the redo branch', !h.canRedo && h.current === 99);
  h.clear(5); ok('history: cleared (saved or discarded) — nothing to undo', !h.canUndo && !h.canRedo && h.current === 5);
  let done = 0; const a = deferred(() => { done++; }, 60000); a.undo(); a.now(); const b2 = deferred(() => { done += 10; }, 60000); b2.now(); b2.undo();
  ok('deferred removal: undone never happens; done happens once', done === 10);

  /* 2. the sanitiser */
  const C = bundle('custom'); const P = bundle('packs');
  const good = { v: 1, id: 'my-abc123', name: 'Mine', base: 'frost', radius: 1, accent: 'app', at: 1, dark: { surfaces: { ground: '#0a0b0d', lowest: '#070809', low: '#111316', mid: '#15171b', high: '#1c1f24', highest: '#24282e' }, text: { on: '#e2e4e8', variant: '#b4b8bf', dim: '#8f949c', outline: '#7d828a', outlineVariant: '#2c3036' }, roles: null, tint: '#111316', strength: 0.66, blur: 28, sat: 1.35, edge: 0.07, sheen: 0.05, shadow: 0.7, bg: { kind: 'mesh', colors: ['#2b3540', '#3a3e45', '#2e3237'], solid: '#0a0b0d', veil: 0.2, picBlur: 0 } } };
  const J = (x) => JSON.parse(JSON.stringify(x));
  const pack = async (theme, assets = []) => { const p = await P.buildPack({ format: 1, id: 'x', name: 'x', version: '1', tokens: { kurokawaMyTheme: 1, theme } }, assets); return p; };
  const refused = (mut) => { const x = J(good); mut(x); try { C.sanitise(x); return false; } catch (e) { return e instanceof C.ThemeFileError; } };
  ok('a well-formed theme passes, and is rebuilt only from colours and numbers', (() => { const s = C.sanitise(J(good)); const def = C.toDef(s); return s.name === 'Mine' && /radial-gradient\(90% 48%/.test(def.dark.bg) && !/url\(/.test(def.dark.bg); })());
  ok('refused: a colour carrying CSS («red; background: url(…)»)', refused((x) => { x.dark.tint = 'red; background: url(https://x/y.png)'; }));
  ok('refused: url() in a background colour', refused((x) => { x.dark.bg.colors[0] = 'url(javascript:alert(1))'; }));
  ok('dropped: a raw CSS field the format does not have, and an unknown top-level field — never kept, never used', (() => { const x = J(good); x.dark.bg.css = 'linear-gradient(red, blue)'; x.style = '* { display: none }'; x.dark.onload = 'alert(1)'; const y = C.sanitise(x); const out = JSON.stringify(y) + JSON.stringify(C.toDef(y)); return !/css|style|onload|alert|display/.test(out); })());
  /* 2b. (0.21) the extras through the sanitiser */
  const extra = (() => { const x = J(good); Object.assign(x.dark, { accent: '#3a8fd9', accent2: '#c0136f', surfTint: '#3a8fd9', surfMix: 0.12, progress: '#22d3ee' }); x.density = 'compact'; x.scale = 1.1; x.perBg = [{ bg: 'scene:night-snowfall', accent: '#5b7cf0', dark: { primary: '#5b7cf0', onPrimary: '#0b1020', primaryContainer: '#1f2a4a', onPrimaryContainer: '#e0e6ff', secondaryContainer: '#22283a', onSecondaryContainer: '#e3e6ef', tertiaryContainer: '#3a2440', onTertiaryContainer: '#f3e0f6' } }]; return x; })();
  ok('extras kept: accents, surface tint and strength, progress, spacing, size, colours per background — and built into the tokens', (() => { const y = C.sanitise(J(extra)); const d = C.toDef(y); return y.dark.accent === '#3a8fd9' && y.dark.surfMix === 0.12 && y.density === 'compact' && y.scale === 1.1 && y.perBg.length === 1 && d.density === 'compact' && d.scale === 1.1 && d.dark.progress === '#22d3ee' && d.perBg['scene:night-snowfall'].dark.primary === '#5b7cf0'; })());
  ok('held: size and tint strength brought into their ranges', (() => { const x = J(extra); x.scale = 99; x.dark.surfMix = -5; const y = C.sanitise(x); return y.scale === 1.25 && y.dark.surfMix === 0; })());
  ok('refused: more than 12 backgrounds, a background id with a path or markup, a role that is not a colour, a spacing not in the list', refused((x) => { x.perBg = Array.from({ length: 13 }, (_, i) => ({ bg: `drift${i}`, accent: '#123456' })); })
    && refused((x) => { x.perBg = [{ bg: '../../etc', accent: '#123456' }]; }) && refused((x) => { x.perBg = [{ bg: '<script>', accent: '#123456' }]; })
    && refused((x) => { x.perBg = [{ bg: 'drift', accent: '#123456', dark: { ...extra.perBg[0].dark, primary: 'expression(alert(1))' } }]; }) && refused((x) => { x.density = 'tiny'; }) && refused((x) => { x.dark.accent = 'javascript:alert(1)'; }));
  ok('names cleaned and cut: direction overrides and markup dropped, at most 60 characters', (() => { const x = J(good); x.name = '\u202eevil\u202c <b>' + 'x'.repeat(200); const y = C.sanitise(x); return !/[\u202e\u202c<>]/.test(y.name) && [...y.name].length <= 60; })());
  ok('refused: a huge name list or a number where an object belongs (wrong types)', refused((x) => { x.dark = 5; }) && refused((x) => { x.dark.surfaces = 'red'; }) && refused((x) => { x.perBg = { bg: 'drift' }; }));
  ok('export → import keeps every extra (a pack round trip, data only)', await (async () => { const p = await pack(J(extra)); const { my } = await C.importTheme(p); const a = J(C.sanitise(J(extra))); delete a.id; delete a.at; const b = J(my); delete b.id; delete b.at; return JSON.stringify(a) === JSON.stringify(b); })());
  ok('refused: a wrong version, a missing mode, a bad id, a kind not in the list', refused((x) => { x.v = 2; }) && refused((x) => { delete x.dark; }) && refused((x) => { x.id = '../../x'; }) && refused((x) => { x.dark.bg.kind = 'css'; }));
  ok('refused: a number that is not a number (string, NaN, Infinity)', refused((x) => { x.dark.blur = '28px'; }) && refused((x) => { x.dark.sat = NaN; }) && refused((x) => { x.radius = Infinity; }));
  ok('held: numbers outside their ranges are brought into them; names lose markup and control characters', (() => { const x = J(good); x.dark.blur = 9999; x.dark.strength = -3; x.name = '<img src=x onerror=alert(1)>Bad\u0007name'; const s = C.sanitise(x); return s.dark.blur === 48 && s.dark.strength === 0 && !/[<>\u0007]/.test(s.name); })());
  const imp = async (bytes) => { try { await C.importTheme(bytes); return 'accepted'; } catch (e) { return e instanceof C.ThemeFileError ? e.code : `other: ${e.message}`; } };
  ok('import refuses: injected CSS in a file', (await imp(await pack((() => { const x = J(good); x.dark.tint = 'url(x)'; return x; })()))) === 'value');
  ok('import refuses: a file that is not a theme pack, and a pack whose header is not a theme', (await imp(new TextEncoder().encode('hello'))) === 'format' && (await imp(await P.buildPack({ format: 1, id: 'x', name: 'x', version: '1', tokens: { something: 1 } }, []))) === 'schema');
  ok('import refuses: an oversized file', (await imp(new Uint8Array(20 * 1024 * 1024))) === 'size');
  const svgTheme = J(good); svgTheme.dark.bg.kind = 'picture';
  ok('import refuses: a «picture» that is SVG or HTML (wrong type or wrong bytes)', (await imp(await pack(svgTheme, [{ name: 'mine-dark', type: 'image/svg+xml', bytes: new TextEncoder().encode('<svg onload="alert(1)"/>') }]))) === 'picture'
    && (await imp(await pack(svgTheme, [{ name: 'mine-dark', type: 'image/png', bytes: new TextEncoder().encode('<html><script>x</script>') }]))) === 'picture');
  ok('import refuses: a pack whose checksum was changed', await (async () => { const p = await pack(J(good)); const n = new DataView(p.buffer).getUint32(8); const head = JSON.parse(new TextDecoder().decode(p.subarray(12, 12 + n))); return head && (await imp((() => { const q = p.slice(); q[q.length - 1] ^= 1; return q; })())) !== 'accepted'; })());
  ok('contrast fix: a white solid background under dark glass is brought to ≥ 4.5:1', (() => { const x = C.sanitise(J(good)); x.dark.bg.kind = 'solid'; x.dark.bg.solid = '#ffffff'; x.dark.strength = 0.1; const before = C.lowestContrast(x, 'dark', 'default'); const f = C.fixContrast(x, 'dark', 'default'); return before < 4.5 && C.lowestContrast(f, 'dark', 'default') >= 4.5; })());

  /* 3. in the app */
  const web = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
  web.listen(0, '127.0.0.1'); await new Promise((r) => web.once('listening', r)); const port = web.address().port;
  const br = await chromium.launch(); const errors = [];
  for (const [lang, size, o] of [['en', 'phone', { width: 400, height: 860, isMobile: true, hasTouch: true }], ['ar', 'pc', { width: 1280, height: 860 }]]) {
    const ctx = await br.newContext({ viewport: { width: o.width, height: o.height }, isMobile: !!o.isMobile, hasTouch: !!o.hasTouch, locale: lang, serviceWorkers: 'block', acceptDownloads: true, colorScheme: 'dark' }); // (A dark system: the default mode follows it.)
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`${lang}: ${e.message}`));
    let offline = false; await ctx.route(/raw\.githubusercontent\.com/, (r) => (offline ? r.abort('internetdisconnected') : r.fulfill({ status: 404, body: '' })));
    await p.addInitScript((l) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('kr.lang', l); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], theme: 'frost', themeChosen: true, glassBlur: 'full', animBg: 'drift', animBgLevel: 'still' })); localStorage.setItem('kt.themeMigrated', '1'); }, lang);
    const tag = `(${lang}, ${size})`;
    const css = (k) => p.evaluate((k) => getComputedStyle(document.documentElement).getPropertyValue(k).trim(), k);
    const gallery = async () => { await p.goto(`http://127.0.0.1:${port}/#/settings/appearance`); await p.waitForSelector('.tg-card[data-theme="frost"] .tg-edit'); };
    const slide = (label, v, end = true) => p.evaluate(([i, v, end]) => { const r = document.querySelector(`.te-slider[data-path="${typeof i === 'number' ? ['strength', 'blur'][i] : i}"] input`); r.value = String(v); r.dispatchEvent(new Event('input', { bubbles: true })); if (end) r.dispatchEvent(new Event('change', { bubbles: true })); }, [label, v, end]);
    const frame = () => p.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

    await gallery(); await p.click('.tg-card[data-theme="frost"] .tg-edit'); await p.waitForSelector('.te-panel');
    const blur0 = await css('--g-blur');
    await slide(1, 40, false); await slide(1, 42, false); await slide(1, 44, true); await frame();
    ok(`edit: the live blur follows the slider ${tag}`, (await css('--g-blur')) === '44px' && blur0 !== '44px' && (await p.evaluate(() => document.documentElement.dataset.theme)) === 'my-preview');
    await slide(0, 0.9); await frame(); const pane = await css('--g-pane-t');
    ok(`edit: strength changes the glass tint live ${tag}`, /0\.9\)$/.test(pane), pane);
    if (size === 'pc') { await p.keyboard.press('Control+z'); } else { await p.click('.te-undo'); } await frame();
    ok(`undo: one step back (strength) ${tag}`, !/0\.9\)$/.test(await css('--g-pane-t')) && (await css('--g-blur')) === '44px');
    await p.click('.te-undo'); await frame();
    ok(`undo: the whole drag (40→42→44) is one step ${tag}`, (await css('--g-blur')) === blur0);
    if (size === 'pc') await p.keyboard.press('Control+Shift+z'); else await p.click('.te-redo'); await frame();
    ok(`redo ${tag}`, (await css('--g-blur')) === '44px');
    await p.click('.te-slider[data-path="blur"] .te-reset'); await frame();
    ok(`the reset arrow goes back to the theme's value, as an undoable step ${tag}`, (await css('--g-blur')) === blur0 && await p.$eval('.te-slider[data-path="blur"] .te-reset', (b) => b.disabled));
    await p.click('.te-undo'); await frame(); ok(`…and undoing the reset brings the change back ${tag}`, (await css('--g-blur')) === '44px');

    // The contrast guard: a white solid background under thin glass.
    await p.click('.te-chips .chip >> nth=2'); await p.waitForSelector('.te-colour[data-path="bg.solid"] input');
    await p.$eval('.te-colour[data-path="bg.solid"] input', (i) => { i.value = '#ffffff'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
    await slide(0, 0.05); await frame();
    ok(`contrast: a warning, with a figure under 4.5:1, never a block ${tag}`, await p.$eval('.te-guard', (g) => !g.hidden && /4[.,٫]5|٤٫٥/.test(g.textContent)) && !(await p.$('.te-foot .btn.filled[disabled]')));
    await p.click('.te-guard .btn'); await frame();
    ok(`«Fix contrast» brings it to 4.5:1 or more ${tag}`, await p.$eval('.te-guard', (g) => g.hidden));

    // Back with unsaved changes.
    const back = () => p.evaluate(() => { const b = document.querySelector('.panel.open .panel-head button'); b.click(); });
    await back(); await p.waitForSelector('.sheet .te-choice');
    ok(`Back with unsaved changes asks: Save / Discard / Keep editing ${tag}`, (await p.$$('.sheet .te-choice')).length === 3);
    await p.click('.sheet .te-choice >> nth=2'); await frame();
    ok(`«Keep editing» leaves the editor open ${tag}`, !!(await p.$('.te-panel')) && !(await p.$('.sheet .te-choice')));
    await back(); await p.waitForSelector('.sheet .te-choice'); await p.click('.sheet .te-choice >> nth=1'); await p.waitForSelector('.te-panel', { state: 'detached' });
    ok(`«Discard» closes it and the chosen theme is back ${tag}`, (await p.evaluate(() => document.documentElement.dataset.theme)) === 'frost' && (await css('--g-blur')) === blur0);
    /* 4. the extras, live */
    const listeners = async () => { const cdp = await ctx.newCDPSession(p); const { result } = await cdp.send('Runtime.evaluate', { expression: 'window' }); const w = await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId }); const { result: d } = await cdp.send('Runtime.evaluate', { expression: 'document' }); const dl = await cdp.send('DOMDebugger.getEventListeners', { objectId: d.objectId }); await cdp.detach(); return w.listeners.length + dl.listeners.length; };
    const lsn0 = await listeners();
    for (let i = 0; i < 3; i++) { await p.click('.tg-card[data-theme="frost"] .tg-edit'); await p.waitForSelector('.te-panel'); await p.click('.te-foot .btn.text'); await p.waitForSelector('.te-panel', { state: 'detached' }); }
    ok(`the editor opened and closed three times leaves no listener behind on window or document ${tag}`, (await listeners()) === lsn0, `${lsn0} → ${await listeners()}`);
    await p.click('.tg-card[data-theme="frost"] .tg-edit'); await p.waitForSelector('.te-panel');
    const pickColour = (path, v, sel = `.te-colour[data-path="${path}"] input`) => p.$eval(sel, (i, v) => { i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); }, v);
    const primary0 = await css('--md-primary');
    await pickColour('accent', '#3a8fd9'); await frame();
    ok(`accent: the picked colour is the accent, live, with its own containers ${tag}`, (await css('--md-primary')) === '#3a8fd9' && (await css('--md-primary-container')) !== '' && primary0 !== '#3a8fd9', await css('--md-primary'));
    const tc0 = await css('--md-tertiary-container'); await pickColour('accent2', '#c0136f'); await frame();
    ok(`second accent: the tertiary roles follow it ${tag}`, (await css('--md-tertiary-container')) !== tc0 && (await css('--md-primary')) === '#3a8fd9');
    await pickColour('accent', '#e0b45c'); await frame();
    const moved = await p.$eval('.te-colour[data-path="accent"] .te-hex', (e) => e.textContent);
    ok(`a yellow pick is moved out of the yellow–orange band, with a short note ${tag}`, moved !== '#e0b45c' && (await css('--md-primary')) === moved && !!(await p.waitForFunction(() => [...document.querySelectorAll('.toast')].some((e) => /Yellow|الأصفر/.test(e.textContent)), null, { timeout: 5000 }).catch(() => null)), moved);
    await pickColour('progress', '#22d3ee'); await frame();
    ok(`progress lines: their own colour (--th-progress) ${tag}`, (await css('--th-progress')) === '#22d3ee');
    const low0 = await css('--th-solid-low'); await pickColour('surfTint', '#5b7cf0'); await slide('surfMix', 0.3); await frame();
    ok(`surface tint and its strength: the surfaces take the hue ${tag}`, (await css('--th-solid-low')) !== low0 && await p.$eval('.te-slider[data-path="surfMix"] output', (o) => /30/.test(o.textContent)));
    await p.click('.te-segrow .te-seg >> nth=0 >> button >> nth=2'); await frame();
    ok(`light / dark / as the app: «light» shows the theme light ${tag}`, (await p.evaluate(() => document.documentElement.dataset.ui)) === 'light');
    await p.click('.te-segrow .te-seg >> nth=0 >> button >> nth=0'); await frame();
    const densityBtn = p.locator('.te-segrow', { hasText: lang === 'ar' ? 'التباعد' : 'Spacing' }).locator('button >> nth=1');
    await densityBtn.click(); await slide('scale', 1.1); await frame();
    ok(`spacing compact and size 110 % (× the app's own) ${tag}`, (await p.evaluate(() => [document.documentElement.dataset.density, document.documentElement.style.zoom])).join() === 'compact,1.1');
    const panelText = await p.$eval('.te-panel', (e) => e.textContent);
    if (size === 'phone') ok(`phone: the subset — no colours per background, no moving backgrounds; spacing and size there ${tag}`, !(await p.$('.te-perbg-add, .te-perbg')) && !/With a background/.test(panelText) && !/Frost drift/.test(panelText) && !!(await p.$('.te-slider[data-path="scale"]')));
    else {
      await p.click('.te-perbg-add'); await p.waitForSelector('.te-perbg[data-bg="drift"]');
      await pickColour('', '#8f7bff', '.te-perbg[data-bg="drift"] .te-swatch >> nth=0 >> input'); await frame();
      ok(`computer: colours of the theme's own while «Frost drift» is the background, live; the count «${lang === 'ar' ? 'العدد: 1 من 12' : '1 of 12'}» ${tag}`, (await css('--md-primary')) === '#8f7bff' && /1/.test(await p.$eval('.te-count', (e) => e.textContent)), `${await css('--md-primary')} ${await p.$eval('.te-count', (e) => e.textContent)} ${await p.evaluate(() => document.documentElement.className)}`);
    }
    if (size === 'pc') await p.screenshot({ path: path.join(tmp, 'extras-pc.png') }); else await p.screenshot({ path: path.join(tmp, 'extras-phone.png') });
    await p.click('.te-resetall .btn'); await frame();
    ok(`«reset all» goes back to the theme's own values (accent, spacing, size) ${tag}`, (await css('--md-primary')) === primary0 && (await p.evaluate(() => [document.documentElement.dataset.density ?? '', document.documentElement.style.zoom])).join() === ',' && !(await p.$('.te-perbg')));
    await p.click('.te-undo'); await frame();
    ok(`…and it is one step to undo ${tag}`, (await p.evaluate(() => document.documentElement.dataset.density)) === 'compact');
    await back(); await p.waitForSelector('.sheet .te-choice'); await p.click('.sheet .te-choice >> nth=1'); await p.waitForSelector('.te-panel', { state: 'detached' });
    ok(`discarded: spacing, size and accent back as they were ${tag}`, (await p.evaluate(() => [document.documentElement.dataset.density ?? '', document.documentElement.style.zoom])).join() === ',' && (await css('--md-primary')) === primary0);


    // Save as my theme.
    await p.click('.tg-card[data-theme="frost"] .tg-edit'); await p.waitForSelector('.te-panel');
    await p.fill('.te-name', 'Night glass'); await slide(1, 36); await frame();
    await p.click('.te-foot .btn.filled'); await p.waitForSelector('.te-panel', { state: 'detached' });
    await p.waitForSelector('.tg-card.mine');
    const id1 = await p.$eval('.tg-card.mine', (c) => c.dataset.theme);
    ok(`save: «Night glass» in My themes, in use, its blur kept ${tag}`, /^my-/.test(id1) && (await p.evaluate(() => document.documentElement.dataset.theme)) === id1 && (await css('--g-blur')) === '36px' && /Night glass/.test(await p.$eval('.tg-card.mine', (c) => c.textContent)));
    await p.reload(); await p.waitForFunction((id) => document.documentElement.dataset.theme === id, id1);
    await p.waitForSelector(`.tg-card[data-theme="${id1}"]`);
    ok(`after a reload it is still there, still in use ${tag}`, (await css('--g-blur')) === '36px', await css('--g-blur'));

    // Duplicate, rename, delete (+ Undo), delete for good.
    const menu = async (id, nth) => { await p.click(`.tg-card[data-theme="${id}"] .tg-more`); await p.waitForSelector('.sheet .te-choice'); await p.click(`.sheet .te-choice >> nth=${nth}`); };
    await menu(id1, 2); await p.waitForFunction(() => document.querySelectorAll('.tg-card.mine').length === 2);
    const ids = await p.$$eval('.tg-card.mine', (cs) => cs.map((c) => c.dataset.theme)); const id2 = ids.find((x) => x !== id1);
    ok(`duplicate: a second theme with its own id ${tag}`, !!id2);
    await menu(id2, 3); await p.waitForSelector('.sheet .te-name'); await p.fill('.sheet .te-name', 'Dawn glass'); await p.click('.sheet .te-choice'); await p.waitForFunction((id) => /Dawn glass/.test(document.querySelector(`.tg-card[data-theme="${id}"]`)?.textContent ?? ''), id2);
    ok(`rename ${tag}`, true);
    if (size === 'phone') await p.screenshot({ path: path.join(tmp, 'mythemes.png') });
    await menu(id2, 5); await p.waitForFunction(() => document.querySelectorAll('.tg-card.mine').length === 1);
    await p.click('.toast .toast-act'); await p.waitForFunction(() => document.querySelectorAll('.tg-card.mine').length === 2);
    ok(`delete shows a snackbar; «Undo» brings it back ${tag}`, true);
    await menu(id2, 5); await p.waitForFunction(() => document.querySelectorAll('.tg-card.mine').length === 1);
    await p.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 15000 });
    ok(`deleted for good once the snackbar is gone (and after a reload) ${tag}`, await (async () => { await p.reload(); await p.waitForSelector('.tg-card.mine'); return (await p.$$('.tg-card.mine')).length === 1 && !(await p.evaluate((id) => (localStorage.getItem('kt.myThemes') || '').includes(id), id2)); })());

    // A picture background: chosen, kept, shown offline.
    await menu(id1, 1); await p.waitForSelector('.te-panel');
    const png = await p.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 300, height: 200 } }); fs.writeFileSync(path.join(tmp, 'pic.png'), png);
    await p.click('.te-chips .chip >> nth=3'); await p.waitForSelector('.te-pic .btn');
    const [chooser] = await Promise.all([p.waitForEvent('filechooser'), p.click('.te-pic .btn')]); await chooser.setFiles(path.join(tmp, 'pic.png'));
    await p.waitForSelector('.te-pic img.te-thumb'); await p.click('.te-foot .btn.filled'); await p.waitForSelector('.te-panel', { state: 'detached' });
    offline = true; await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.picture === '1', null, { timeout: 15000 });
    ok(`a picture background is kept on the device and shown offline after a reload ${tag}`, /blob:/.test(await css('--th-bg')));
    offline = false;
    if (size === 'phone') await p.screenshot({ path: path.join(tmp, 'picture.png') });

    // Export → import: the same theme.
    await gallery(); const before = await p.evaluate((id) => JSON.parse(localStorage.getItem('kt.myThemes')).find((x) => x.id === id), id1);
    const [dl] = await Promise.all([p.waitForEvent('download'), menu(id1, 4)]); const file = path.join(tmp, 'exported.ktheme'); await dl.saveAs(file);
    const [ch2] = await Promise.all([p.waitForEvent('filechooser'), p.click('.tg-mine-actions .btn.text')]); await ch2.setFiles(file);
    await p.waitForFunction(() => document.querySelectorAll('.tg-card.mine').length === 2);
    const after = await p.evaluate((id) => JSON.parse(localStorage.getItem('kt.myThemes')).find((x) => x.id !== id), id1);
    const strip = (x) => { const y = J(x); delete y.id; delete y.at; for (const m of ['dark', 'light']) if (y[m]) delete y[m].bg.extremes; return y; };
    ok(`export → import: the same theme (new id), its picture with it ${tag}`, JSON.stringify(strip(before)) === JSON.stringify(strip(after)) && await p.evaluate((id) => new Promise((res) => { const r = indexedDB.open('kurokawa-tools'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => res(q.result.some((k) => String(k).startsWith(`mytheme:${id}:`))); }; }), after.id), JSON.stringify([strip(before), strip(after)]).slice(0, 300));

    // A malicious file.
    const bad = await (async () => { const x = J(good); x.dark.bg.colors[1] = '#000;}body{display:none'; return Buffer.from(await pack(x)); })(); fs.writeFileSync(path.join(tmp, 'bad.ktheme'), bad);
    const [ch3] = await Promise.all([p.waitForEvent('filechooser'), p.click('.tg-mine-actions .btn.text')]); await ch3.setFiles(path.join(tmp, 'bad.ktheme'));
    await p.waitForSelector('.toast.error');
    ok(`a malicious theme file is refused with a message, nothing added ${tag}`, (await p.$$('.tg-card.mine')).length === 2);
    // The contrast corrected on save: a white solid ground under thin glass, saved as it is.
    await p.click('.tg-card[data-theme="frost"] .tg-edit'); await p.waitForSelector('.te-panel');
    await p.click('.te-chips .chip >> nth=2'); await p.waitForSelector('.te-colour[data-path="bg.solid"] input');
    await p.$eval('.te-colour[data-path="bg.solid"] input', (i) => { i.value = '#ffffff'; i.dispatchEvent(new Event('input', { bubbles: true })); i.dispatchEvent(new Event('change', { bubbles: true })); });
    await slide(0, 0.05); await frame(); await p.waitForSelector('.te-guard:not([hidden])');
    await p.click('.te-foot .btn.filled'); await p.waitForSelector('.te-panel', { state: 'detached' });
    const fixedSave = await p.evaluate(() => { const l = JSON.parse(localStorage.getItem('kt.myThemes')); return l[l.length - 1]; });
    ok(`saved with text too faint: the contrast is corrected before it is kept, and a note says so ${tag}`, fixedSave.dark.strength > 0.05 && !!(await p.waitForFunction(() => [...document.querySelectorAll('.toast')].some((e) => /contrast|التباين/i.test(e.textContent)), null, { timeout: 5000 }).catch(() => null)), JSON.stringify(fixedSave.dark).slice(0, 120));

    // Reset appearance, with Undo.
    const inUse = await p.evaluate(() => document.documentElement.dataset.theme);
    await p.locator('#appearance .row', { hasText: lang === 'ar' ? 'أعِد ضبط المظهر' : 'Reset appearance' }).locator('button').click();
    await p.waitForFunction(() => document.documentElement.dataset.theme === 'classic');
    await p.click('.toast .toast-act'); await p.waitForFunction((id) => document.documentElement.dataset.theme === id, inUse);
    ok(`Reset appearance shows a snackbar; «Undo» puts the theme back ${tag}`, true);
    await ctx.close();
  }
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  if (process.env.KT_SHOTS) for (const f of ['mythemes.png', 'picture.png', 'extras-pc.png', 'extras-phone.png']) if (fs.existsSync(path.join(tmp, f))) fs.copyFileSync(path.join(tmp, f), path.join(process.env.KT_SHOTS, f));
  await br.close(); web.close(); fs.rmSync(tmp, { recursive: true, force: true });
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
