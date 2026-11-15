// The back stack, table-driven: every kind of layer that registers with it (ui/backstack.ts) opened for real, Back
// pressed, and what must follow — on a pretend phone (Android's back key, the App plugin faked) and on a computer
// (Esc, the mouse's back button, Alt+←). The stack is read from the page (window.__ktBack) so a layer that forgot to
// register, or forgot to go, shows. Then the tab trail: Back at a tab's top goes to the tab the reader came from,
// never round between two. Each kind the app registers must be covered by a row.
// Run: NODE_PATH=$(npm root -g) node tests/backlayers.cjs
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const covered = new Set();

async function phone(br, port) {
  const ctx = await br.newContext({ viewport: { width: 412, height: 860 }, hasTouch: true, isMobile: true });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'files', 'subtitles'], playerWith: 'app', playerEngine: 'web' }));
    window.__min = 0;
    const task = { id: 'b', kind: 'http', name: 'Show 04.mkv', source: { url: 'https://x/a.mkv' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native' };
    const V = (id, folder, name) => ({ id, path: `/sdcard/${folder}/${name}`, name, folder, duration: 60000, size: 1e7, width: 1280, height: 720, mtime: Date.now() - id });
    const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [task] }), mediaAccess: async () => ({ granted: true }), mediaVideos: async () => ({ videos: [V(1, 'Kurokawa', 'a.mp4'), V(2, 'Kurokawa', 'b.mp4'), V(3, 'Camera', 'c.mp4')] }), videoThumb: async () => { throw new Error('none'); }, mpvAvailable: async () => ({ available: false }) };
    const App = { addListener: (ev, fn) => { if (ev === 'backButton') window.__back = fn; return { remove() {} }; }, minimizeApp: () => { window.__min++; }, exitApp: () => {} };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }), App }, PluginHeaders: [] };
  });
  const hash = () => p.evaluate(() => location.hash || '#/');
  const kinds = () => p.evaluate(() => (window.__ktBack ? window.__ktBack.layers.filter((l) => !l.on || l.on()).map((l) => l.kind) : null));
  const back = async () => { await p.evaluate(() => window.__back()); await p.waitForTimeout(450); };
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.task-card'); await p.waitForFunction(() => !!window.__ktBack); await p.waitForTimeout(200);
  const home = async () => { await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.downloads-view .task-card'); await p.waitForTimeout(250); };
  const player = async () => { await p.evaluate(() => window.dispatchEvent(new CustomEvent('kt:play', { detail: { url: 'http://127.0.0.1:1/none.mp4', name: 'Test video' } }))); await p.waitForSelector('.kt-player'); await p.waitForTimeout(300); };
  // [name, the kind that must be on top once it is open, open it, what Back must leave]
  const rows = [
    ['a sheet (the add sheet)', 'sheet', async () => { await home(); await p.click('.fab'); await p.locator('.fab-item').first().click(); await p.waitForSelector('.sheet'); }, async () => !(await p.$('.sheet')) && (await hash()) === '#/'],
    ['the + menu', 'menu', async () => { await home(); await p.click('.fab'); await p.waitForSelector('.fab-menu'); }, async () => !(await p.$('.fab-menu')) && (await hash()) === '#/'],
    ['the downloads\' selection', 'selection', async () => { await home(); await p.click('.downloads-view .topbar button[data-icon="check"]'); await p.waitForSelector('.downloads-view.selecting'); }, async () => !(await p.$('.downloads-view.selecting')) && (await hash()) === '#/'],
    ['the downloads\' search', 'selection', async () => { await home(); await p.click('.downloads-view .topbar button[data-icon="search"]'); await p.waitForSelector('.dl-search:not([hidden])'); await p.fill('.dl-search input', 'show'); }, async () => !!(await p.$('.dl-search[hidden]')) && (await hash()) === '#/'],
    ['a folder of Videos', 'drill', async () => { await p.click('[data-dest="videos"]'); await p.waitForSelector('.video-folder'); await p.click('.video-folder:has-text("Kurokawa")'); await p.waitForSelector('.videos-crumb'); }, async () => !(await p.$('.videos-crumb')) && /^#\/videos/.test(await hash())],
    ['a search in a folder of Videos', 'search', async () => { await p.click('.video-folder:has-text("Kurokawa")'); await p.waitForSelector('.videos-crumb'); await p.fill('.videos-tools input[type=search]', 'a'); await p.waitForTimeout(100); }, async () => !!(await p.$('.videos-crumb')) && (await p.inputValue('.videos-tools input[type=search]')) === ''],
    ['Files (at its top)', 'drill', async () => { await p.click('[data-dest="files"]'); await p.waitForSelector('.files-view'); await p.waitForTimeout(300); }, async () => !(await p.$('.files-view')) && /^#\/videos/.test(await hash())],
    ['a search in Settings', 'search', async () => { await p.click('[data-dest="settings"]'); await p.waitForSelector('.settings-view .settings-search'); await p.fill('.settings-view .settings-search', 'player'); await p.waitForTimeout(100); }, async () => /^#\/settings/.test(await hash()) && (await p.inputValue('.settings-view .settings-search')) === ''],
    ['the player', 'player', async () => { await home(); await player(); }, async () => !(await p.$('.kt-player')) && (await hash()) === '#/'],
    ['the player\'s full screen', 'fullscreen', async () => { await player(); await p.evaluate(() => document.querySelector('.kt-player .kt-bottom button[data-icon="fullscreen"]').click()); await p.waitForFunction(() => !!document.fullscreenElement || !!document.querySelector('.kt-player.kt-full'), null, { timeout: 8000 }).catch(() => undefined); await p.waitForTimeout(200); }, async () => !!(await p.$('.kt-player')) && !(await p.evaluate(() => !!document.fullscreenElement))],
    ['(then the player under it)', 'player', async () => {}, async () => !(await p.$('.kt-player'))],
    ['the player, locked', 'player', async () => { await player(); await p.evaluate(() => document.querySelector('.kt-player .kt-bottom button[data-icon="lock"]').click()); await p.waitForTimeout(150); }, async () => !!(await p.$('.kt-player.locked')) && !(await p.$eval('.kt-unlock', (b) => b.hidden))],
    ['(unlocked, then closed)', 'player', async () => { await p.evaluate(() => document.querySelector('.kt-unlock').click()); await p.waitForTimeout(150); }, async () => !(await p.$('.kt-player'))],
    ['a page in a tab (a download\'s details)', null, async () => { await home(); await p.click('.task-card .task-main'); await p.waitForSelector('.task-view'); }, async () => (await hash()) === '#/'],
  ];
  for (const [name, kind, open, after] of rows) {
    try { await open(); } catch (e) { ok(`[phone] ${name}: opened`, false, String(e.message).split('\n')[0]); continue; }
    const ks = await kinds();
    if (kind) { ok(`[phone] ${name}: on the stack as «${kind}»`, ks && ks[ks.length - 1] === kind || (ks || []).slice().reverse().find((k) => k !== 'drill' && k !== 'view' && k !== 'selection' && k !== 'search') === kind || (ks || []).includes(kind), ks); covered.add(kind); }
    await back(); ok(`[phone] ${name}: Back`, await after(), await hash());
  }
  ok('[phone] no layer left behind once everything was closed', (await p.evaluate(() => window.__ktBack.layers.filter((l) => !l.on || l.on()).every((l) => ['selection', 'drill', 'search', 'view'].includes(l.kind)))), await kinds());
  // The tab trail: downloads → Search → Videos → Settings; Back at each top goes back the way the reader came.
  // (Videos tapped twice: its top — it was left inside a folder above, which it would bring back.)
  await home(); await p.click('[data-dest="search"]'); await p.waitForSelector('.search-view'); await p.click('[data-dest="videos"]'); await p.waitForSelector('.videos-view'); await p.click('[data-dest="videos"]'); await p.waitForTimeout(300); await p.click('[data-dest="settings"]'); await p.waitForSelector('.settings-view'); await p.waitForTimeout(200);
  await back(); ok('[phone] Back at Settings\' top: Videos, where the reader came from', /^#\/videos/.test(await hash()), await hash());
  await back(); ok('[phone] Back at Videos\' top: Search', /^#\/search/.test(await hash()), await hash());
  await back(); ok('[phone] Back at Search\'s top: the downloads', (await hash()) === '#/', await hash());
  await back(); ok('[phone] Back at the downloads\' top: a warning, the app stays', (await p.evaluate(() => window.__min)) === 0 && (await hash()) === '#/');
  // (Never round: Videos ↔ Files and back again, then Back twice reaches the downloads.)
  await p.click('[data-dest="videos"]'); await p.waitForSelector('.videos-view'); await p.click('[data-dest="files"]'); await p.waitForSelector('.files-view'); await p.click('[data-dest="videos"]'); await p.waitForSelector('.videos-view'); await p.waitForTimeout(200);
  await back(); ok('[phone] Videos → Files → Videos, Back: Files', /^#\/files/.test(await hash()), await hash());
  await back(); ok('[phone] Back again: the downloads — not round to Videos', (await hash()) === '#/', await hash());
  // The in-page arrow of Settings does what Back does.
  await p.click('[data-dest="search"]'); await p.waitForSelector('.search-view'); await p.click('[data-dest="settings"]'); await p.waitForSelector('.settings-view');
  await p.click('.settings-view .topbar button[data-icon="back"]'); await p.waitForTimeout(400); ok('[phone] Settings\' arrow: the tab the reader came from (Search)', /^#\/search/.test(await hash()), await hash());
  ok('[phone] no page errors', !errors.length, errors);
  await ctx.close();
}

async function pc(br, port) {
  const ctx = await br.newContext({ viewport: { width: 1366, height: 800 } });
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404 }));
  const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'files'], playerWith: 'app' })); localStorage.setItem('kt.pc.starter', '1');
    const task = { id: 'b', kind: 'http', name: 'Show 04.mkv', source: { url: 'https://x/a.mkv' }, dir: '/d', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'desktop' };
    window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [task], onTasks: (cb) => { cb([task]); return () => {}; }, defaultDir: async () => '/d' }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  });
  const hash = () => p.evaluate(() => location.hash || '#/');
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.task-card'); await p.waitForFunction(() => !!window.__ktBack); await p.waitForTimeout(200);
  await p.click('.downloads-view .topbar button[data-icon="check"]'); await p.waitForSelector('.downloads-view.selecting');
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); ok('[pc] Esc leaves the selection', !(await p.$('.downloads-view.selecting')));
  await p.click('.downloads-view .topbar button[data-icon="check"]'); await p.waitForSelector('.downloads-view.selecting');
  await p.mouse.move(600, 400); await p.mouse.down({ button: 'back' }).catch(() => undefined); await p.evaluate(() => window.dispatchEvent(new MouseEvent('mouseup', { button: 3, bubbles: true }))); await p.waitForTimeout(200);
  ok('[pc] the mouse\'s back button: the same', !(await p.$('.downloads-view.selecting')));
  await p.click('[data-dest="settings"]'); await p.waitForSelector('.settings-view'); await p.fill('.settings-view .settings-search', 'player'); await p.locator('.settings-view .topbar .title').click();
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); ok('[pc] Esc lets go of the settings search', (await p.inputValue('.settings-view .settings-search')) === '' && /^#\/settings/.test(await hash()));
  await p.keyboard.press('Escape'); await p.waitForTimeout(200); ok('[pc] Esc never leaves a page or a tab', /^#\/settings/.test(await hash()), await hash());
  await p.keyboard.press('Alt+ArrowLeft'); await p.waitForTimeout(300); ok('[pc] Alt+←: back to the downloads', (await hash()) === '#/', await hash());
  await p.evaluate(() => window.dispatchEvent(new CustomEvent('kt:play', { detail: { url: 'http://127.0.0.1:1/none.mp4', name: 'Test video' } }))); await p.waitForSelector('.kt-player'); await p.waitForTimeout(200);
  await p.keyboard.press('Escape'); await p.waitForTimeout(250); ok('[pc] Esc closes the player (once: the page stays)', !(await p.$('.kt-player')) && (await hash()) === '#/');
  ok('[pc] no page errors', !errors.length, errors);
  await ctx.close();
}

(async () => {
  const web = serve().listen(0); const port = web.address().port; const br = await chromium.launch();
  await phone(br, port); await pc(br, port);
  for (const k of ['sheet', 'menu', 'selection', 'search', 'drill', 'player', 'fullscreen']) ok(`a row covers the «${k}» layers`, covered.has(k));
  await br.close(); web.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
