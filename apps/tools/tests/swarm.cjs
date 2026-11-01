// A torrent up close on Android (the plugin faked): the Swarm card on its page — seeds and peers, the peers
// sending, the trackers and how each answers —, «Check the files again» and «Find peers now» sent to the engine,
// and the download's own limits; the card kept while the page redraws, and refreshed on its own.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript(() => {
    localStorage.setItem('kr.lang', 'en'); const listeners = {}; window.__calls = []; let n = 0;
    const task = { id: 'b', kind: 'torrent', name: 'Show S01 1080p', source: { magnet: 'magnet:?xt=urn:btih:' + 'c'.repeat(40) }, dir: '/sdcard/Download', state: 'downloading', done: 3e8, total: 1.2e9, downSpeed: 2.5e6, upSpeed: 1e5, peers: 12, seeds: 30, files: [{ index: 0, path: 'Show/e01.mkv', size: 1.2e9, done: 3e8, priority: 1 }], addedAt: Date.now() - 90e3, engine: 'native' };
    window.__emit = () => (listeners.tasksChanged || []).forEach((f) => f({ tasks: [task] }));
    const api = {
      addListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); return Promise.resolve({ remove() {} }); },
      list: async () => ({ tasks: [task] }),
      torrentDetail: async (o) => { n++; window.__calls.push(['detail', o.id]); return { seeds: 9, peersConnected: 14, seedsInSwarm: 210, peersInSwarm: 80, ratio: 0.12, limitDown: 0, limitUp: 0,
        peers: [{ ip: '1.2.3.4', client: 'qBittorrent 4.6', down: 900000 + n, up: 1000, progress: 1, total: 5e7, utp: true }, { ip: '5.6.7.8', client: 'Transmission 4.0', down: 300000, up: 0, progress: 0.4, total: 1e7, utp: false }],
        trackers: [{ url: 'udp://tracker.opentrackr.org:1337/announce', tier: 0, state: 'working', message: '', fails: 0 }, { url: 'udp://dead.example:6969/announce', tier: 1, state: 'failing', message: 'timed out', fails: 3 }] }; },
      recheck: async (o) => { window.__calls.push(['recheck', o.id]); }, reannounce: async (o) => { window.__calls.push(['reannounce', o.id]); }, setTaskLimits: async (o) => { window.__calls.push(['limits', o]); },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  });
  await p.goto(`http://127.0.0.1:${port}/#/task/b`); await p.waitForSelector('.kt-swarm .swarm-head .chip');
  const head = await p.$eval('.kt-swarm .swarm-head', (e) => e.innerText.replace(/\s+/g, ' ')); console.log('head:', head);
  check('seeds and peers of the swarm', /9 seeds of 210/.test(head) && /5 peers of 80/.test(head));
  await p.click('.kt-swarm .swarm-sec >> nth=0'); await p.click('.kt-swarm .swarm-sec summary >> nth=1');
  const peers = await p.$$eval('.kt-swarm .swarm-sec >> nth=0 >> .swarm-row', (r) => r.length).catch(async () => (await p.$$('.kt-swarm .swarm-sec:first-of-type .swarm-row')).length);
  const peerText = await p.$eval('.kt-swarm .swarm-list', (e) => e.innerText.replace(/\s+/g, ' ')); console.log('peers:', peerText);
  check('the peers, fastest first, with their clients', /^1\.2\.3\.4 qBittorrent 4\.6 · µTP · 100%/.test(peerText) && /5\.6\.7\.8/.test(peerText));
  const trs = await p.$$eval('.kt-swarm .swarm-sec:last-child .swarm-row', (r) => r.map((x) => x.className + ' ' + x.innerText.replace(/\s+/g, ' ')));
  console.log('trackers:', trs.join(' | ')); check('trackers with how each answers', trs.length === 2 && /tr-working/.test(trs[0]) && /tr-failing.*timed out.*Not answering/.test(trs[1]));
  check('trackers summed up', /Trackers · 1\/2/.test(await p.$eval('.kt-swarm .swarm-sec:last-child summary', (e) => e.textContent)));
  await p.click('.kt-swarm button:has-text("Check the files again")'); await p.click('.kt-swarm button:has-text("Find peers now")'); await p.waitForTimeout(300);
  check('recheck and reannounce sent', await p.evaluate(() => window.__calls.some((c) => c[0] === 'recheck' && c[1] === 'b') && window.__calls.some((c) => c[0] === 'reannounce')));
  await p.fill('.kt-swarm .swarm-limit input >> nth=0', '500'); await p.dispatchEvent('.kt-swarm .swarm-limit input >> nth=0', 'change'); await p.waitForTimeout(200);
  const lim = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'limits').pop()?.[1]); console.log('limits:', JSON.stringify(lim));
  check('the download\'s own limit sent in bytes', lim && lim.down === 512000 && lim.up === 0);
  // The page redraws on every change: the card stays (open sections too) and goes on refreshing.
  const before = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'detail').length);
  await p.evaluate(() => window.__emit()); await p.waitForTimeout(2600);
  check('the card kept open across a redraw', (await p.$$('.kt-swarm')).length === 1 && await p.$eval('.kt-swarm .swarm-sec:last-child', (e) => e.open));
  check('it refreshes on its own', (await p.evaluate(() => window.__calls.filter((c) => c[0] === 'detail').length)) > before);
  await p.screenshot({ path: 'shot-swarm.png', fullPage: true });
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForTimeout(2500);
  const after = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'detail').length); await p.waitForTimeout(2500);
  check('it stops when the page is left', (await p.evaluate(() => window.__calls.filter((c) => c[0] === 'detail').length)) === after);
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
