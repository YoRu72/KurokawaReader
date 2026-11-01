// The Downloads options on a stubbed phone: Filter (kind), Sort (name, and turned round), Display (names only,
// grouped by state), the search, and selecting several for one action.
const { chromium } = require('playwright'); const http = require('http'), fs = require('fs'), path = require('path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const srv = http.createServer((q, r) => { let p = q.url.split('?')[0]; if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': p.endsWith('.js') ? 'text/javascript' : p.endsWith('.css') ? 'text/css' : p.endsWith('.woff2') ? 'font/woff2' : 'text/html' }); fs.createReadStream(f).pipe(r); }).listen(0, async () => {
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 } }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); const now = Date.now(); window.__calls = [];
    const mk = (id, name, kind, state, done, total, ago, extra = {}) => ({ id, kind, name, source: kind === 'torrent' ? { magnet: 'magnet:?xt=urn:btih:' + id.padEnd(40, '0') } : { url: 'https://x/' + name }, dir: '/d', state, done, total, downSpeed: state === 'downloading' ? 2e6 : 0, upSpeed: 0, eta: state === 'downloading' ? 90 : undefined, peers: 12, seeds: 40, files: [], addedAt: now - ago * 3600e3, engine: 'native', ...extra });
    const tasks = [mk('a', 'Frieren - 05 (1080p).mkv', 'torrent', 'downloading', 4e8, 1.4e9, 1), mk('b', 'ubuntu-26.04.iso', 'http', 'done', 6e9, 6e9, 30), mk('c', 'Song.mp3', 'http', 'paused', 2e6, 8e6, 2), mk('d', 'Big Buck Bunny.mp4', 'http', 'failed', 0, 5e8, 200, { error: 'HTTP 404' }), mk('e', 'Lecture.webm', 'video', 'done', 9e7, 9e7, 50, { meta: { kind: 'video' } })];
    const plugin = new Proxy({ addListener: () => ({ remove() {} }), list: async () => ({ tasks }), pause: async (o) => window.__calls.push(['pause', o.id]), resume: async (o) => window.__calls.push(['resume', o.id]), remove: async (o) => window.__calls.push(['remove', o.id, o.deleteFiles]) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${srv.address().port}/`); await p.waitForSelector('.task-card');
  const names = async () => p.$$eval('.task-list > *', (e) => e.map((x) => x.classList.contains('task-group') ? '# ' + x.innerText.replace(/\s+/g, ' ') : x.querySelector('.task-name').textContent));
  console.log('initial:', (await names()).join(' | '));
  await p.click('.opt-badge'); await p.waitForSelector('.lib-sheet-panel'); console.log('filter tab:', (await p.$eval('.lib-sheet-panel', (e) => e.innerText)).replace(/\n+/g, ' / '));
  await p.click('.lib-opt:has-text("' + (lang === 'ar' ? 'روابط مباشرة' : 'Direct links') + '")'); const R = {}; R.direct = (await names()).join(' | '); console.log('direct only:', R.direct, '| badge', await p.$eval('.opt-badge', (e) => e.dataset.n));
  await p.click('.lib-sheet-tabs button >> nth=1'); await p.click('.lib-opt >> nth=1'); R.name = (await names()).join(' | '); console.log('by name:', R.name);
  await p.click('.lib-opt >> nth=1'); R.rev = (await names()).join(' | '); console.log('by name again (reversed):', R.rev);
  await p.click('.lib-sheet-tabs button >> nth=2'); await p.click('.lib-opt >> nth=2'); await p.click('.lib-opt >> nth=4');
  await p.screenshot({ path: path.join(__dirname, `shot-dlopts-sheet-${lang}.png`) });
  await p.click('.sheet-head button'); console.log('minimal, grouped by state:', (await names()).join(' | '), '| look', await p.$eval('.task-list', (e) => e.className));
  await p.click('.lib-sheet-tabs button', { trial: true }).catch(() => {});
  // search
  await p.click('.topbar-actions button[aria-label="' + (lang === 'ar' ? 'ابحث' : 'Search') + '"]').catch(async () => p.click('.topbar-actions button >> nth=0')); await p.fill('.dl-search input', 'song'); R.search = (await names()).join(' | '); console.log('search song:', R.search);
  await p.fill('.dl-search input', ''); 
  // select: long-press (contextmenu) then act
  await p.click('.task-card >> nth=0', { button: 'right' }); await p.waitForSelector('.select-bar:not([hidden])'); console.log('select bar:', (await p.$eval('.select-bar', (e) => e.innerText)).replace(/\s+/g, ' '));
  await p.screenshot({ path: path.join(__dirname, `shot-dlopts-${lang}.png`) });
  await p.click('.select-bar button[aria-label="' + (lang === 'ar' ? 'حدِّد الكل' : 'Select all') + '"]'); R.sel = await p.$eval('.select-bar .grow', (e) => e.textContent); console.log('selected:', R.sel);
  const pass = !errs.length && R.direct === 'Song.mp3 | ubuntu-26.04.iso | Big Buck Bunny.mp4' && R.name === 'Big Buck Bunny.mp4 | Song.mp3 | ubuntu-26.04.iso' && R.rev === 'ubuntu-26.04.iso | Song.mp3 | Big Buck Bunny.mp4' && /Song\.mp3$/.test(R.search) && /3/.test(R.sel);
  console.log(errs.length ? 'ERRORS ' + errs.join(' ; ') : pass ? 'all passed' : 'FAILED'); await b.close(); srv.close(); process.exit(pass ? 0 : 1); });
