// node tests/petsui.cjs [en|ar]: the pets in the page (a computer, 1280×800) with made-up packs of plain shapes
// (tests/pets-fixtures.cjs) — no character anywhere:
//  1. A fresh install: nothing of the pets fetched or in the page; Settings → Pets holds only «Add a pet».
//  2. «Add a pet»: the Suggested list (the one link, opened outside through the shell, nothing fetched), the line
//     «Import only packs you are allowed to use», the steps; links added (https only) and removed.
//  3. Our pet.json pack imported from a folder: in the library (credit, frames), shown at once; the pet falls to the
//     window's bottom edge; its canvas takes the pointer only over its opaque pixels (a click on its transparent
//     corner reaches the page); dragged onto a panel it walks on the panel's top; thrown, it flies and lands again;
//     a click makes it react; it moves out of the way of a pointer heading for a control under it.
//  4. A folder of frames: the mapping screen (groups, suggestions, live preview), saved as a pack.
//  5. A Shimeji pack from a zip: imported, its report offered; three pets shown at most.
//  6. Settings: size, activity…; less motion: the pets stand still and nothing is scheduled; «Hide pets» from the
//     pet's own menu, with Undo; off: no element, listener or timer of the pets left.
//  7. A phone: no Pets card, nothing fetched.
// Screenshots (PET_SHOTS=dir) and, with PET_VIDEO=dir, a short recording of the pet walking, falling, dragged and
// thrown. Only loopback. Run: NODE_PATH=$(npm root -g) node tests/petsui.cjs en
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const { petPack, shimejiPack, framesPack, writeDir, zip } = require('./pets-fixtures.cjs');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist');
const SHOTS = process.env.PET_SHOTS || ''; const VIDEO = process.env.PET_VIDEO || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const PC = { viewport: { width: 1280, height: 800 } };
const PHONE = { viewport: { width: 360, height: 780 }, hasTouch: true, isMobile: true };
const T = LANG === 'ar' ? { add: 'أضِف رفيقًا', folder: 'اختر مجلّدًا', zip: 'اختر ملفَّ zip', open: 'افتح الصفحة', save: 'احفَظ', hide: 'أخفِ الرفيق', size: 'الحجم', large: 'كبير', addLink: 'أضِف رابطًا', allowed: 'لا تستورد إلا حزمًا يحقّ لك استعمالها.', report: 'تقرير الاستيراد', undo: 'تراجع' } : { add: 'Add a pet', folder: 'Choose a folder', zip: 'Choose a zip', open: 'Open page', save: 'Save', hide: 'Hide pets', size: 'Size', large: 'Large', addLink: 'Add a link', allowed: 'Import only packs you are allowed to use.', report: 'Import report', undo: 'Undo' };

function init({ lang, settings, phone, desk }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.themeMigrated', '1'); localStorage.setItem('kt.mainTheme', '1');
  if (!localStorage.getItem('kt.settings')) localStorage.setItem('kt.settings', JSON.stringify({ themeChosen: true, autoUpdateCheck: false, uiMode: 'dark', ...settings }));
  const c = (window.__pt = { listeners: 0, timers: new Set(), opened: [] });
  const add = EventTarget.prototype.addEventListener, rem = EventTarget.prototype.removeEventListener; const seen = new WeakMap();
  const counted = (t) => t === window || t === document || t instanceof MediaQueryList;
  // (Only the pets' own listeners are counted: their functions' source names the stage.)
  const mine = (f) => typeof f === 'function' && /this\.(gate|move|dirty|wake|video|onBattery)|closeMenu|queueMicrotask\(vid\)/.test(String(f));
  EventTarget.prototype.addEventListener = function (ty, f, o) { if (counted(this) && mine(f)) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); let m = seen.get(this); if (!m) seen.set(this, (m = new Map())); let s = m.get(k); if (!s) m.set(k, (s = new Set())); if (!s.has(f)) { s.add(f); c.listeners++; } } return add.call(this, ty, f, o); };
  EventTarget.prototype.removeEventListener = function (ty, f, o) { if (counted(this) && f) { const k = ty + (typeof o === 'boolean' ? o : !!o?.capture); const s = seen.get(this)?.get(k); if (s?.delete(f)) c.listeners--; } return rem.call(this, ty, f, o); };
  const st = window.setTimeout, ct = window.clearTimeout; const ours = (f) => typeof f === 'function' && /this\.timer = 0; this\.frame\(\)/.test(String(f));
  window.setTimeout = function (f, ms, ...a) { if (!ours(f)) return st.call(window, f, ms, ...a); const id = st.call(window, (...b) => { c.timers.delete(id); f(...b); }, ms, ...a); c.timers.add(id); return id; };
  window.clearTimeout = function (id) { c.timers.delete(id); return ct.call(window, id); };
  window.__ptSnap = () => ({ listeners: c.listeners, timers: c.timers.size, host: document.querySelectorAll('#kt-pets').length, pets: document.querySelectorAll('#kt-pets .kt-pet').length });
  const now = Date.now(); const ts = []; for (let i = 0; i < 6; i++) ts.push({ id: 't' + i, kind: 'http', name: `made-up-${i}.bin`, source: { url: `https://example.test/${i}` }, dir: '/d', state: 'done', done: 4e8, total: 4e8, downSpeed: 0, upSpeed: 0, files: [], addedAt: now - i * 60000 });
  if (phone) { const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }) }; window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] }; }
  const fake = (window.__petCalls = []); const fx = (window.__petFx = { cursor: { x: 5, y: 5 }, active: desk === 'tauri' ? { x: 40, y: 300, w: 1200, h: 400 } : null });
  const pet = desk ? async (o) => { fake.push(JSON.parse(JSON.stringify(o))); if (o.action === 'screen') return { work: { x: 0, y: 0, w: 1280, h: 800 }, cursor: fx.cursor, scale: 1 }; if (o.action === 'active') return { rect: fx.active }; return { ok: true }; } : undefined;
  if (desk === 'tauri') { window.__KT_SHELL__ = 'tauri'; localStorage.setItem('kt.firstrun.done', '1'); }
  if (desk === 'tauri') window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', pet, ready: async () => ({}), list: async () => ts, onTasks: (cb) => { cb(ts); return () => {}; }, defaultDir: async () => '/d', openExternal: async () => {} }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  else if (!phone) window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', pet, ready: async () => ({}), list: async () => ts, onTasks: (cb) => { cb(ts); return () => {}; }, defaultDir: async () => '/d', openExternal: async (u) => { c.opened.push(u); } }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
}

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-pets-'));
  const petDir = writeDir(path.join(tmp, 'Pebble'), petPack());
  const framesDir = path.join(writeDir(path.join(tmp, 'frames'), framesPack()), 'Hopper');
  const shZip = path.join(tmp, 'blocky.zip'); fs.writeFileSync(shZip, zip(shimejiPack()));
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `pets-${name}-${LANG}.png`) }); } };
  const open = async (o, opts, route = '#/', ctxOpts = {}) => {
    const ctx = await br.newContext({ ...o, ...ctxOpts }); const p = await ctx.newPage(); const errs = []; const reqs = [];
    p.on('pageerror', (e) => errs.push(e.message)); p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errs.push(m.text()); }); p.on('request', (r) => reqs.push(r.url()));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => { reqs.push('EXTERNAL ' + r.request().url()); return r.fulfill({ status: 404, body: '' }); });
    await ctx.addInitScript(init, { lang: LANG, ...opts }); await p.goto(base + route); await p.waitForSelector('.view'); await p.waitForTimeout(600);
    return { p, ctx, errs, reqs, fetched: () => reqs.some((u) => /chunk-(stage|boot|ui)-|pets/i.test(u) && !/chunk-(en|ar)-/.test(u)) };
  };
  const pet = (p, i = 0) => p.evaluate((i) => { const c = document.querySelectorAll('#kt-pets .kt-pet')[i]; if (!c) return null; const r = c.getBoundingClientRect(); return { state: c.dataset.state, on: c.dataset.on, x: Number(c.dataset.x), y: Number(c.dataset.y), frame: Number(c.dataset.frame), flip: !!c.dataset.flip, l: r.left, t: r.top, w: r.width, h: r.height, pe: c.style.pointerEvents }; }, i);
  const waitPet = (p, fn, ms = 6000, i = 0) => p.waitForFunction(([src, i]) => { const c = document.querySelectorAll('#kt-pets .kt-pet')[i]; if (!c) return false; return new Function('c', `return ${src}`)(c); }, [fn, i], { timeout: ms }).then(() => true, () => false);
  const importFolder = async (p, dir) => { await p.locator('.sheet .pet-pick button', { hasText: T.folder }).waitFor(); const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.locator('.sheet .pet-pick button', { hasText: T.folder }).click()]); await fc.setFiles(dir); };
  const importZip = async (p, file) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.locator('.sheet .pet-pick button', { hasText: T.zip }).click()]); await fc.setFiles(file); };
  /** The pointer over the pet's middle, pressed, moved along `path` (window points), let go. */
  const drag = async (p, pts, stepMs = 16) => { const v = await pet(p); await p.mouse.move(v.l + v.w / 2, v.t + v.h / 2); await p.waitForTimeout(40); await p.mouse.down(); for (const [x, y] of pts) { await p.mouse.move(x, y, { steps: 2 }); await p.waitForTimeout(stepMs); } await p.mouse.up(); };

  /* ---------- 1. fresh ---------- */
  let store = null;
  {
    const { p, ctx, errs, reqs, fetched } = await open(PC, { settings: {} });
    ok('fresh: nothing of the pets in the page, nothing fetched', !(await p.evaluate(() => document.getElementById('kt-pets'))) && !fetched(), reqs.filter((u) => /pets|stage|boot/.test(u)));
    await p.goto(base + '#/settings/pets'); await p.waitForSelector('#pets .pet-add'); await p.waitForTimeout(300);
    const only = await p.evaluate(() => ({ switches: document.querySelectorAll('#pets input[type=checkbox]').length, buttons: Array.from(document.querySelectorAll('#pets button')).map((b) => b.textContent.trim()) }));
    ok('Settings → Pets: only «Add a pet» until a pet exists', only.switches === 0 && only.buttons.length === 1 && only.buttons[0] === T.add, only);
    await shot(p, 'empty');
    /* ---------- 2. «Add a pet» ---------- */
    await p.locator('#pets .pet-add').click(); await p.waitForSelector('.sheet .pet-import');
    const sheet = await p.evaluate(() => ({ links: Array.from(document.querySelectorAll('.sheet .pet-link')).map((r) => r.textContent), allowed: document.querySelector('.sheet .pet-allowed')?.textContent, steps: document.querySelectorAll('.sheet .pet-steps li').length, imgs: document.querySelectorAll('.sheet img').length }));
    ok('«Add a pet»: one suggested link (MikuPet), the «allowed» line, five steps, no pictures', sheet.links.length === 1 && /github\.com\/CharlesWiiFlowers\/MikuPet/.test(sheet.links[0]) && sheet.allowed === T.allowed && sheet.steps === 5 && sheet.imgs === 0, sheet);
    await p.waitForTimeout(500); await shot(p, 'add');
    await p.locator('.sheet .pet-link button', { hasText: T.open }).click(); await p.waitForTimeout(200);
    const opened = await p.evaluate(() => window.__pt.opened);
    ok('«Open page»: handed to the system browser through the shell; the app fetched nothing from it', opened.length === 1 && opened[0] === 'https://github.com/CharlesWiiFlowers/MikuPet' && !reqs.some((u) => /CharlesWiiFlowers/i.test(u)), { opened, ext: reqs.filter((u) => /EXTERNAL/.test(u)) });
    await p.locator('.sheet .pet-link-form button', { hasText: T.addLink }).click();
    await p.locator('.sheet .pet-link-form input[type=text]').fill('Made-up page'); await p.locator('.sheet .pet-link-form input[type=url]').fill('http://example.test/x');
    await p.locator('.sheet .pet-link-form .btn.filled').click(); await p.waitForTimeout(150);
    ok('a link that is not https refused', (await p.locator('.sheet .pet-link-err').textContent()).length > 0 && (await p.locator('.sheet .pet-link').count()) === 1);
    await p.locator('.sheet .pet-link-form input[type=url]').fill('https://example.test/made-up-pack'); await p.locator('.sheet .pet-link-form .btn.filled').click(); await p.waitForTimeout(150);
    ok('an https link added to the list (kept in the settings)', (await p.locator('.sheet .pet-link').count()) === 2 && (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).pets.links.length)) === 2);
    await p.locator('.sheet .pet-link').nth(1).locator('.icon-btn').click(); await p.waitForTimeout(150);
    ok('…and removed', (await p.locator('.sheet .pet-link').count()) === 1);
    /* ---------- 3. our pack ---------- */
    await importFolder(p, petDir);
    ok('pet.json pack imported: in the library, shown', await p.waitForSelector('#pets .pet-row', { timeout: 8000 }).then(() => true, () => false));
    const row = await p.locator('#pets .pet-row').first().textContent();
    ok('library row: name, credit, frames', /Pebble/.test(row) && /Made-up test maker/.test(row) && /(11|١١)/.test(row), row);
    ok('the pet is in the page, falls and lands on the window\'s bottom edge', await waitPet(p, "c.dataset.on === 'floor'"), await pet(p));
    let v = await pet(p); ok('…its feet on the bottom edge (800)', v.y === 800 && Math.abs(v.t + v.h - 800) < 2, v);
    await p.waitForTimeout(300); await shot(p, 'library');
    // Hit testing: the transparent corner passes the click to the page; the middle takes it.
    v = await pet(p);
    await p.mouse.move(v.l + 3, v.t + 3); await p.waitForTimeout(60);
    const corner = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return { pet: !!e?.closest('#kt-pets'), pe: document.querySelector('#kt-pets .kt-pet').style.pointerEvents }; }, [v.l + 3, v.t + 3]);
    v = await pet(p); await p.mouse.move(v.l + v.w / 2, v.t + v.h / 2); await p.waitForTimeout(60);
    const mid = await p.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return { pet: !!e?.closest('#kt-pets'), pe: document.querySelector('#kt-pets .kt-pet').style.pointerEvents }; }, [v.l + v.w / 2, v.t + v.h / 2]);
    ok('pointer only on opaque pixels: the corner reaches the page, the middle the pet', !corner.pet && corner.pe !== 'auto' && mid.pet && mid.pe === 'auto', { corner, mid });
    // Click: it reacts.
    // (It may be walking: clicked where it is now, a few times at most.)
    let clicked = false; for (let i = 0; i < 4 && !clicked; i++) { v = await pet(p); await p.mouse.move(v.l + v.w / 2, v.t + v.h / 2); await p.mouse.click(v.l + v.w / 2, v.t + v.h / 2); clicked = await waitPet(p, "c.dataset.state === 'click'", 400); }
    ok('a click: it reacts (its click animation)', clicked, await pet(p));
    await p.waitForTimeout(800);
    // Dragged onto a panel: lands on its top and walks there.
    const panel = await p.evaluate(() => { const c = document.querySelector('#pets > .row, #pets > label.row'); const r = c.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width }; });
    await drag(p, [[panel.l + panel.w / 2 - 60, Math.max(20, panel.t - 70)], [panel.l + panel.w / 2, Math.max(20, panel.t - 50)], [panel.l + panel.w / 2, Math.max(20, panel.t - 50)]], 30);
    await p.waitForTimeout(400);
    ok('dragged above a panel and let go: it lands on the panel\'s top edge', await waitPet(p, `/^s\\d+$/.test(c.dataset.on) && Math.abs(Number(c.dataset.y) - ${Math.round(panel.t)}) <= 2`, 4000), { panel, pet: await pet(p) });
    await p.waitForTimeout(500); await shot(p, 'panel');
    // Thrown: flies, bounces, rests on something.
    v = await pet(p); const sx = v.l + v.w / 2, sy = v.t + v.h / 2;
    await p.mouse.move(sx, sy); await p.waitForTimeout(40); await p.mouse.down(); await p.mouse.move(420, 420, { steps: 8 }); await p.waitForTimeout(60);
    for (let i = 1; i <= 5; i++) { await p.mouse.move(420 + i * 70, 420 - i * 20); await p.waitForTimeout(12); } await p.mouse.up();
    ok('thrown: it flies off with the pointer\'s speed', await waitPet(p, "c.dataset.state === 'thrown'", 600), await pet(p));
    ok('…and comes to rest again', await waitPet(p, "c.dataset.on !== ''", 6000));
    // Moving aside: a control under it, the pointer coming at it.
    await p.evaluate(() => { const b = document.createElement('button'); b.id = 'made-up-ctl'; b.textContent = 'made-up control'; Object.assign(b.style, { position: 'fixed', left: '600px', bottom: '0px', width: '160px', height: '40px', zIndex: '33' }); document.body.append(b); });
    await drag(p, [[680, 600], [680, 700], [680, 700]], 30); await waitPet(p, "c.dataset.on === 'floor'", 4000); await p.waitForTimeout(200);
    const x0 = (await pet(p)).x;
    for (let i = 0; i < 8; i++) { await p.mouse.move(680 + (8 - i) * 30, 560 + i * 25); await p.waitForTimeout(100); }
    await p.waitForTimeout(500); const x1 = (await pet(p)).x;
    ok('a pointer heading for a control under the pet: it moves out of the way', Math.abs(x1 - x0) > 30, { x0, x1 });
    await p.evaluate(() => document.getElementById('made-up-ctl').remove());
    /* ---------- 4. a folder of frames: the mapping screen ---------- */
    await p.locator('#pets .pet-add').click(); await importFolder(p, framesDir);
    ok('a folder of frames: the mapping screen opens', await p.waitForSelector('.pet-map-sheet', { timeout: 8000 }).then(() => true, () => false));
    await p.waitForTimeout(900);
    const map = await p.evaluate(() => ({ labels: Array.from(document.querySelectorAll('.pet-map-sheet .pet-map-rows .pick-label')).map((e) => e.textContent), tiles: document.querySelectorAll('.pet-map-sheet .pet-tile').length, painted: Array.from(document.querySelectorAll('.pet-map-sheet .pet-tile-cv')).some((c) => { const d = c.getContext('2d').getImageData(0, 0, 72, 72).data; for (let i = 3; i < d.length; i += 4) if (d[i]) return true; return false; }) }));
    ok('mapping: groups suggested by name (idle, walk, sit, fall) and a live preview drawn', map.labels[0].startsWith('idle') && map.labels[1].startsWith('walk') && map.labels[2].startsWith('sitting') && map.tiles >= 4 && map.painted, map);
    await shot(p, 'mapping');
    await p.locator('.pet-map-sheet .sheet-actions .btn.filled').click();
    ok('mapping saved: a second pet in the library and on screen', await p.waitForFunction(() => document.querySelectorAll('#pets .pet-row').length === 2 && document.querySelectorAll('#kt-pets .kt-pet').length === 2, null, { timeout: 8000 }).then(() => true, () => false));
    ok('mapping sheet closed, its preview timer gone', (await p.locator('.pet-map-sheet').count()) === 0);
    /* ---------- 5. Shimeji from a zip; three at most ---------- */
    await p.locator('#pets .pet-add').click(); await importZip(p, shZip);
    ok('a Shimeji pack from a zip: imported, three pets shown', await p.waitForFunction(() => document.querySelectorAll('#pets .pet-row').length === 3 && document.querySelectorAll('#kt-pets .kt-pet').length === 3, null, { timeout: 10000 }).then(() => true, () => false));
    ok('…its report offered (what was skipped)', await p.locator('.toast', { hasText: T.report }).count().then((n) => n > 0) || await p.locator('.snackbar, [role=status]', { hasText: T.report }).count().then((n) => n > 0));
    await p.locator('#pets .pet-add').click(); await importFolder(p, petDir);
    await p.waitForFunction(() => document.querySelectorAll('#pets .pet-row').length === 4, null, { timeout: 8000 }).catch(() => undefined);
    ok('a fourth pet is kept in the library but not shown (three at most)', (await p.evaluate(() => document.querySelectorAll('#kt-pets .kt-pet').length)) === 3 && (await p.locator('#pets .pet-shown:checked').count()) === 3);
    await p.waitForTimeout(400); await shot(p, 'library3');
    // Leave one pet for the rest.
    for (let i = 3; i >= 1; i--) { const r = p.locator('#pets .pet-row').nth(i); if (await r.locator('.pet-shown').isChecked()) { await r.locator('.pet-shown-label').click(); await p.waitForTimeout(200); } }
    ok('pets taken off the screen one by one', (await p.evaluate(() => document.querySelectorAll('#kt-pets .kt-pet').length)) === 1);
    /* ---------- 6. settings ---------- */
    const w0 = (await pet(p)).w;
    await p.locator('#pets .row', { hasText: T.size }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: T.large }).locator('input').click(); await p.waitForTimeout(400);
    ok('Size Large: the pet is drawn bigger', (await pet(p)).w > w0 * 1.3, { w0, w: (await pet(p)).w });
    await p.evaluate(() => document.querySelector('#pets h4:nth-of-type(2)')?.scrollIntoView()); await p.waitForTimeout(200); await shot(p, 'settings');
    await p.emulateMedia({ reducedMotion: 'reduce' }); await p.waitForTimeout(400);
    const r1 = await pet(p); await p.waitForTimeout(800); const r2 = await pet(p); const snapR = await p.evaluate(() => window.__ptSnap());
    ok('less motion: the pet stands on the floor, still, nothing scheduled', r1.on === 'floor' && r1.state === 'idle' && r1.x === r2.x && r1.frame === r2.frame && snapR.timers === 0, { r1, r2, snapR });
    // Hide from the pet's own menu (while it stands still), then Undo. (Snackbars of the imports out of the way first.)
    await p.evaluate(() => document.querySelectorAll('.toast').forEach((x) => x.remove()));
    v = await pet(p); await p.mouse.move(v.l + v.w / 2, v.t + v.h / 2); await p.waitForTimeout(60); await p.mouse.click(v.l + v.w / 2, v.t + v.h / 2, { button: 'right' });
    await p.locator('.kt-pet-menu button', { hasText: T.hide }).click(); await p.waitForTimeout(300);
    await p.emulateMedia({ reducedMotion: 'no-preference' });
    const hidden = await p.evaluate(() => window.__ptSnap());
    ok('«Hide pets» from the pet\'s menu: gone at once, no listener or timer of it left', hidden.host === 0 && hidden.listeners === 0 && hidden.timers === 0 && (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).pets.on)) === false, hidden);
    await p.locator('.toast button, .snackbar button', { hasText: T.undo }).first().click().catch(() => undefined); await p.waitForTimeout(500);
    ok('…and Undo brings it back', (await p.evaluate(() => window.__ptSnap())).pets === 1);
    // Off and on five times: nothing left behind.
    let clean = true;
    for (let i = 0; i < 5; i++) {
      await p.locator('#pets .pets-on').uncheck(); await p.waitForTimeout(200); const s = await p.evaluate(() => window.__ptSnap()); if (s.host || s.listeners || s.timers) clean = false;
      await p.locator('#pets .pets-on').check(); await p.waitForTimeout(200);
    }
    ok('off and on five times: when off, no element, listener or timer of the pets', clean && (await p.evaluate(() => window.__ptSnap())).pets === 1);
    store = await p.evaluate(() => localStorage.getItem('kt.settings'));
    ok('no page errors', !errs.length, errs); await ctx.close();
  }
  /* ---------- the walk on the downloads page (a fresh window with the pets of before) ---------- */
  {
    const { p, ctx, errs, reqs } = await open(PC, { settings: {} }, '#/');
    ok('a new window: nothing fetched until the pets are on (they are not: a fresh profile)', !reqs.some((u) => /chunk-stage-/.test(u)));
    void store; await ctx.close(); void errs;
  }
  /* ---------- 7. a phone ---------- */
  {
    const { p, ctx, errs, fetched } = await open(PHONE, { phone: true, settings: { pets: { on: true, active: ['x'] } } }, '#/settings');
    await p.waitForTimeout(500);
    ok('a phone: no Pets card, nothing of the pets fetched, even with the setting carried over', (await p.locator('#pets').count()) === 0 && !fetched() && !(await p.evaluate(() => document.getElementById('kt-pets'))));
    ok('no page errors (phone)', !errs.length, errs); await ctx.close();
  }
  /* ---------- 8. on the desktop (Tier B) with a pretend shell ---------- */
  for (const shell of ['electron', 'tauri']) {
    const { p, ctx, errs } = await open(PC, { desk: shell, settings: {} }, '#/settings/pets');
    await p.locator('#pets .pet-add').click(); await importFolder(p, petDir); await p.waitForSelector('#pets .pet-row', { timeout: 8000 });
    const id = await p.locator('#pets .pet-row').first().getAttribute('data-pet');
    const rows = await p.evaluate(() => Array.from(document.querySelectorAll('#pets .row')).map((r) => r.textContent));
    const LW = LANG === 'ar' ? { where: 'أين يظهر', desk: 'على سطح المكتب', follow: 'اتبَعِ النافذة النشطة' } : { where: 'Where', desk: 'On the desktop', follow: 'Follow the active window' };
    await p.locator('#pets .row', { hasText: LW.where }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: LW.desk }).locator('input').click(); await p.waitForTimeout(600);
    const calls = await p.evaluate(() => window.__petCalls);
    ok(`${shell}: «On the desktop» opens the pet's own window (and none in the page)`, calls.some((c) => c.action === 'open' && c.id === id) && !(await p.evaluate(() => document.querySelector('#kt-pets .kt-pet'))), calls);
    const followRow = (await p.locator('#pets .row', { hasText: LW.follow }).count()) > 0;
    ok(`${shell}: «Follow the active window» offered only in the Tauri build`, followRow === (shell === 'tauri'), rows);
    if (shell === 'tauri') await shot(p, 'settings-desktop');
    // The pet window itself (#/pet/<id>), in the same profile.
    const pw = await ctx.newPage(); const perrs = []; pw.on('pageerror', (e) => perrs.push(e.message));
    await pw.goto(base + `#/pet/${id}`); await pw.waitForFunction(() => window.__petCalls.some((c) => c.action === 'move'), null, { timeout: 8000 }).catch(() => undefined);
    await pw.waitForTimeout(2500);
    const moves = await pw.evaluate(() => window.__petCalls.filter((c) => c.action === 'move'));
    const lastMove = moves[moves.length - 1] || {};
    ok(`${shell}: the pet window is sized to the pet (not the screen) and moved as it falls`, moves.length > 3 && lastMove.w < 200 && lastMove.h < 200, lastMove);
    if (shell === 'tauri') ok('tauri: following the active window: the pet stands on its top edge (fake rectangle)', Math.abs(lastMove.y + lastMove.h - 2 - 300) <= 3, lastMove);
    else ok('electron: the pet stands on the work area\'s floor', Math.abs(lastMove.y + lastMove.h - 2 - 800) <= 3, lastMove);
    ok(`${shell}: clicks go through at first`, !(await pw.evaluate(() => window.__petCalls.some((c) => c.action === 'through' && c.on === false))));
    await pw.evaluate(([m]) => { window.__petFx.cursor = { x: m.x + m.w / 2, y: m.y + m.h / 2 }; }, [lastMove]); await pw.waitForTimeout(400);
    ok(`${shell}: the pointer over the pet: the window takes the clicks`, await pw.evaluate(() => { const t = window.__petCalls.filter((c) => c.action === 'through'); return t.length > 0 && t[t.length - 1].on === false; }));
    await pw.evaluate(() => { window.__petFx.cursor = { x: 5, y: 5 }; }); await pw.waitForTimeout(400);
    ok(`${shell}: the pointer away: clicks pass through again`, await pw.evaluate(() => { const t = window.__petCalls.filter((c) => c.action === 'through'); return t[t.length - 1].on === true; }));
    ok(`${shell}: the pet window never asks for the focus`, !(await pw.evaluate(() => window.__petCalls.some((c) => /focus|show/i.test(c.action)))));
    // «Hide pets» from the pet window's own menu: the main window learns it and closes them all.
    await pw.locator('canvas.pet-win-cv').click({ button: 'right', position: { x: 30, y: 30 }, force: true });
    await pw.locator('.pet-win-menu button').first().click(); await p.waitForTimeout(600);
    ok(`${shell}: «Hide pets» in the pet window → the main window's setting off, every pet window closed`, await p.evaluate(() => window.__petCalls.some((c) => c.action === 'closeAll')) && (await pw.evaluate(() => window.__petCalls.some((c) => c.action === 'closeAll'))), await p.evaluate(() => window.__petCalls.slice(-3)));
    ok(`${shell}: no page errors`, !errs.length && !perrs.length, [...errs, ...perrs]); await ctx.close();
  }
  /* ---------- the recording ---------- */
  if (VIDEO) {
    fs.mkdirSync(VIDEO, { recursive: true });
    const { p, ctx } = await open(PC, { settings: {} }, '#/settings/pets', { recordVideo: { dir: VIDEO, size: { width: 1280, height: 800 } } });
    await p.locator('#pets .pet-add').click(); await importFolder(p, petDir); await waitPet(p, "c.dataset.on === 'floor'");
    await p.waitForTimeout(3500);
    const panel = await p.evaluate(() => { const c = document.querySelector('#pets > .row, #pets > label.row'); const r = c.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width }; });
    await drag(p, [[700, 500], [panel.l + panel.w / 2, Math.max(20, panel.t - 50)], [panel.l + panel.w / 2, Math.max(20, panel.t - 50)]], 60); await p.waitForTimeout(4000);
    const v = await pet(p); await p.mouse.move(v.l + v.w / 2, v.t + v.h / 2); await p.mouse.down(); for (let i = 1; i <= 6; i++) { await p.mouse.move(v.l + v.w / 2 + i * 70, v.t + v.h / 2 - i * 45); await p.waitForTimeout(14); } await p.mouse.up();
    await p.waitForTimeout(3500);
    const v2 = await pet(p); await p.mouse.click(v2.l + v2.w / 2, v2.t + v2.h / 2); await p.waitForTimeout(2500);
    const vid = p.video(); await ctx.close(); const file = await vid.path(); const out = path.join(VIDEO, `pet-placeholder-${LANG}.webm`); fs.renameSync(file, out); console.log('video:', out);
  }
  await br.close(); web.close();
  console.log(fails ? `\n${fails} FAILED` : '\nall passed');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
