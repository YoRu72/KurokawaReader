// Prism round 2 on the downloads list: a failed download takes a new address (setUrl); a finished one is downloaded
// again (removed with its file, added back); removed ones are listed in «Recently removed» and put back; «Remove
// the ones whose files are gone» asks which files are there; Settings → Connection tells the engine.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__calls = []; const listeners = {};
    const now = Date.now(); const mk = (id, name, state, extra = {}) => ({ id, kind: 'http', name, source: { url: `https://x/${name}` }, dir: '/sdcard/Download', state, done: state === 'done' ? 5e8 : 1e8, total: 5e8, downSpeed: 0, upSpeed: 0, files: [], addedAt: now - 9e5, engine: 'native', ...extra });
    window.__tasks = [mk('a', 'expired.zip', 'failed', { error: 'HTTP 403' }), mk('b', 'movie.mkv', 'done'), mk('c', 'gone.iso', 'done'), mk('d', 'waiting.bin', 'queued')];
    const emit = () => (listeners.tasksChanged || []).forEach((f) => f({ tasks: window.__tasks }));
    const plugin = new Proxy({
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return { remove() {} }; }, list: async () => ({ tasks: window.__tasks }),
      remove: async (o) => { window.__calls.push(['remove', o]); window.__tasks = window.__tasks.filter((x) => x.id !== o.id); setTimeout(emit, 10); },
      add: async (o) => { window.__calls.push(['add', o]); const tk = mk('n' + window.__calls.length, o.name || 'restored', 'queued', { source: o.source }); window.__tasks = [...window.__tasks, tk]; setTimeout(emit, 10); return { task: tk }; },
      exists: async (o) => { window.__calls.push(['exists', o]); return { exists: o.paths.map((x) => !x.includes('gone.iso')) }; },
      hosts: async () => ({ hosts: { 'cdn.example.com': 2 } }),
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async (a) => { window.__calls.push([k, a]); return {}; }) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  const base = `http://127.0.0.1:${web.address().port}/`;
  await p.goto(base); await p.waitForSelector('.task-card'); await p.waitForTimeout(600);
  const card = (name) => p.locator('.task-card', { hasText: name });
  const sheetRow = (i) => p.locator('.sheet .dest-row').filter({ has: p.locator(`svg`) }).nth(i);
  const menuRow = async (iconName) => { const rows = await p.$$('.sheet .dest-row'); for (const r of rows) if (await r.evaluate((e, n) => !!e.querySelector('svg') && e.querySelector('svg').outerHTML.includes(n), iconName)) { await r.click(); return true; } return false; };
  const net = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'configure' && c[1] && c[1].net).length); console.log('net at start:', net);
  // New address
  await card('expired.zip').locator('button[aria-label]').last().click(); await p.waitForSelector('.sheet .dest-row');
  const rows1 = (await p.$$eval('.sheet .dest-row', (r) => r.map((x) => x.innerText.trim()))); console.log('failed menu:', rows1.join(' | '));
  await p.locator('.sheet .dest-row', { hasText: /New address|عنوان جديد/ }).click(); await p.waitForSelector('.sheet input[type=url]');
  await p.screenshot({ path: path.join(__dirname, `shot-newurl-${lang}.png`) });
  await p.fill('.sheet input[type=url]', 'https://fresh.example.com/expired.zip?sig=2'); await p.click('.sheet .btn.primary'); await p.waitForTimeout(300);
  const setUrl = await p.evaluate(() => window.__calls.find((c) => c[0] === 'setUrl')); console.log('setUrl:', JSON.stringify(setUrl));
  // Download again
  await card('movie.mkv').locator('button[aria-label]').last().click(); await p.waitForSelector('.sheet .dest-row');
  await p.locator('.sheet .dest-row', { hasText: /Download again|نزِّله من جديد/ }).click(); await p.waitForTimeout(400);
  const again = await p.evaluate(() => window.__calls.filter((c) => (c[0] === 'remove' && c[1].id === 'b') || (c[0] === 'add' && c[1].name === 'movie.mkv')).map((c) => c[0] + (c[1].deleteFiles ? '+files' : '')));
  console.log('again:', again.join(','));
  // Remove missing
  await p.locator('.topbar-actions > button').last().click(); await p.waitForSelector('.sheet .dest-row');
  await p.locator('.sheet .dest-row', { hasText: /whose files are gone|فُقدت ملفاته/ }).click(); await p.waitForTimeout(400);
  const missing = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'remove' && c[1].id === 'c').length); console.log('removed missing:', missing);
  // Recently removed: gone.iso and movie.mkv (the old one) are there; put gone.iso back
  await p.locator('.topbar-actions > button').last().click(); await p.waitForSelector('.sheet .dest-row');
  await p.locator('.sheet .dest-row', { hasText: /Recently removed|المحذوفة حديثًا/ }).click(); await p.waitForSelector('.trash-row'); await p.waitForTimeout(600);
  const trash = await p.$$eval('.trash-row', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ').trim())); console.log('trash:', trash.join(' || '));
  await p.screenshot({ path: path.join(__dirname, `shot-trash-${lang}.png`) });
  await p.locator('.trash-row', { hasText: 'gone.iso' }).locator('button').click(); await p.waitForTimeout(400);
  const back = await p.evaluate(() => window.__calls.find((c) => c[0] === 'add' && c[1].name === 'gone.iso')); console.log('restored:', !!back, await p.$$eval('.trash-row', (r) => r.length));
  await p.keyboard.press('Escape');
  // Queue: moved up; the list goes to queue order
  await card('waiting.bin').locator('button[aria-label]').last().click(); await p.waitForSelector('.sheet .move-row');
  await p.locator('.sheet .move-row button').nth(1).click(); await p.waitForTimeout(300);
  const moved = await p.evaluate(() => window.__calls.find((c) => c[0] === 'move')); const sortNow = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings') || localStorage.getItem('kr.tools.settings') || '{}').sort);
  console.log('move:', JSON.stringify(moved), 'sort:', sortNow);
  await p.keyboard.press('Escape'); await p.waitForTimeout(200);
  // Settings → Connection
  await p.goto(base + '#/settings/connection'); await p.waitForSelector('#connection'); await p.waitForTimeout(400);
  const conn = (await p.$eval('#connection', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('connection:', conn.slice(0, 260));
  const before = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'configure' && c[1] && c[1].net).length);
  await p.fill('#connection input[type=number] >> nth=0', '9'); await p.press('#connection input[type=number] >> nth=0', 'Tab'); await p.waitForTimeout(300);
  const last = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'configure' && c[1] && c[1].net).pop()); console.log('configure:', JSON.stringify(last && last[1]));
  await p.screenshot({ path: path.join(__dirname, `shot-connection-${lang}.png`), fullPage: false });
  const pass = moved && moved[1].how === -1 && moved[1].id === 'd' && net >= 1 && setUrl && setUrl[1].url.includes('fresh.example.com') && setUrl[1].id === 'a' && again.join(',') === 'remove+files,add' && missing === 1 && trash.some((x) => x.includes('gone.iso')) && back && last && last[1].net.retries === 9 && /cdn\.example\.com/.test(conn);
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
