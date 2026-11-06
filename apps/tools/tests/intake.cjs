// Links coming in: «From the clipboard» on a phone reads the phone's clipboard (Android's own, through the app — the
// web view's clipboard is not allowed there), as does the sheet's «Paste»; a post on X or Instagram that yt-dlp reads
// shows its qualities and none of an ordinary file's parts («a web page, not a file», its name); the link field's
// clear button empties it and what was found for the old link.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const X = 'https://x.com/someone/status/2118677898651406360?t=pO2W7ur85HgvgZ9z9CE&s=19';
const IG = 'https://www.instagram.com/reel/C9abcDEFghi/?igsh=MWx4';
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };

  // ---- a phone: the clipboard through the app
  { const p = await br.newPage({ viewport: { width: 420, height: 860 } }); p.setDefaultTimeout(5000); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((X) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ socialAuto: false }));
      Object.defineProperty(navigator, 'clipboard', { value: { readText: () => Promise.reject(new Error('NotAllowedError')), writeText: () => Promise.resolve() } });
      const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [] }), clipboardText: async () => ({ text: X }) };
      const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }, X);
    await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab');
    await p.click('.fab-item:has-text("From the clipboard")'); await p.waitForSelector('.add-sheet .add-input', { timeout: 4000 }).catch(() => undefined);
    check('«From the clipboard» opens the sheet with the phone clipboard\'s link', (await p.$eval('.add-input', (e) => e.value).catch(() => '')) === X);
    await p.click('.add-sheet .add-clear').catch(() => undefined);
    check('the clear button empties the field', (await p.$eval('.add-input', (e) => e.value).catch(() => '?')) === '');
    await p.click('.add-sheet .add-tools .btn:has-text("Paste")'); await p.waitForTimeout(200);
    check('the sheet\'s «Paste» reads the phone clipboard too', (await p.$eval('.add-input', (e) => e.value)) === X);
    await p.close(); }

  // ---- a computer with yt-dlp: a post on X, then one on Instagram («Show them» first: the automatic list off)
  const desk = async (auto) => { const p = await br.newPage({ viewport: { width: 420, height: 860 } }); p.setDefaultTimeout(5000); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((auto) => { window.__auto = auto;
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify(window.__auto ? { addons: ['video'] } : { addons: ['video'], socialAuto: false })); window.__added = [];
      const raw = (u, title, ex) => ({ id: '1', title, duration: 90, extractor_key: ex, webpage_url: u, uploader: 'someone', formats: [{ format_id: 'hls-1080', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 1080, ext: 'mp4', tbr: 3000 }, { format_id: 'hls-720', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 720, ext: 'mp4', tbr: 1500 }] });
      window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], add: async (o) => { window.__added.push(o); return { id: 't' + window.__added.length, name: o.video?.title || o.source.url, ...o }; },
        pause: async () => {}, resume: async () => {}, remove: async () => {}, on: () => () => {}, onTasks: () => () => {}, freeSpace: async () => 5e9,
        probe: async () => ({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><html></html>' }),
        http: async (o) => ({ status: 200, url: o.url, headers: { 'content-type': 'text/html; charset=utf-8' }, body: '<!doctype html><html></html>' }),
        videoReady: async () => true, videoVersion: async () => ({ version: '2026.10.10', ready: true }),
        videoInfo: async (o) => { await new Promise((r) => setTimeout(r, 120)); if (/x\.com/.test(o.url)) return raw(o.url, 'A post on X', 'Twitter'); if (/instagram/.test(o.url)) return raw(o.url, 'A reel', 'Instagram'); throw new Error('Unsupported URL'); } };
    }, auto);
    return p; };
  { const p = await desk(false);
    await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet');
    for (const [label, u] of [['X', X], ['Instagram', IG]]) {
      await p.click('.add-sheet .add-clear').catch(() => undefined); await p.fill('.add-input', u);
      const read = await p.waitForSelector('.video-choices', { timeout: 6000 }).then(() => true, () => false);
      check(`a post on ${label}: yt-dlp's qualities shown`, read); await p.waitForTimeout(400);
      const fileBits = await p.evaluate(() => { const vis = (s) => [...document.querySelectorAll(s)].some((e) => e.offsetParent !== null); return { page: vis('.add-size .danger'), name: vis('.save-as .save-as-row') }; });
      check(`a post on ${label}: no «web page, not a file», no file name`, !fileBits.page && !fileBits.name);
    }
    await p.click('.add-sheet .add-clear');
    const after = await p.evaluate(() => ({ v: document.querySelector('.add-input').value, panel: document.querySelector('.video-panel')?.hidden ?? true }));
    check('the clear button empties the field and the old link\'s video panel', after.v === '' && after.panel);
    // A video site's link yt-dlp cannot read: nothing added — never its page —, and said so.
    await p.fill('.add-input', 'https://www.youtube.com/watch?v=gone'); await p.waitForTimeout(700); await p.click('.sheet .btn.primary'); await p.waitForTimeout(400);
    const refused = await p.evaluate(() => ({ added: window.__added.length, toast: document.querySelector('.toast')?.textContent || '' }));
    check('a video site\'s link that cannot be read adds nothing (not its page)', refused.added === 0 && /could not be read/.test(refused.toast));
    // A link that gives a web page: asked first; «Find the files on it» opens the grabber, nothing added.
    await p.click('.add-sheet .add-clear'); await p.fill('.add-input', 'https://example.com/some/page'); await p.waitForTimeout(900); await p.click('.add-sheet .btn.primary');
    const asked = await p.waitForSelector('.sheet:has-text("This link is a web page")', { timeout: 3000 }).then(() => true, () => false);
    if (asked) await p.click('.sheet:has-text("This link is a web page") .btn.primary');
    const grabbing = await p.waitForFunction(() => [...document.querySelectorAll('.sheet')].some((x) => /Grab links from a page/.test(x.textContent || '')), null, { timeout: 3000 }).then(() => true, () => false);
    check('a web page link asks first, and can look for the files on it', asked && grabbing && (await p.evaluate(() => window.__added.length)) === 0);
    await p.evaluate(() => document.querySelectorAll('.sheet, .scrim').forEach((x) => x.remove())); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet');
    await p.fill('.add-input', IG); await p.waitForSelector('.video-choices', { timeout: 6000 }); await p.click('.sheet .btn.primary');
    await p.waitForFunction(() => window.__added.length === 1, null, { timeout: 4000 }).catch(() => undefined);
    const added = await p.evaluate(() => window.__added[0]);
    check('Download adds the reel as a video', !!added && !!added.video && added.source.url === IG);
    await p.close(); }

  // ---- by default a post's photos and videos open at once
  { const p = await desk(true);
    await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet');
    await p.fill('.add-input', X);
    const opened = await p.waitForFunction(() => [...document.querySelectorAll('.sheet')].some((s) => /Grab links from a page/.test(s.textContent || '')) && !document.querySelector('.add-sheet'), null, { timeout: 6000 }).then(() => true, () => false);
    check('a post\'s link opens its photos and videos at once (no «Show them»)', opened);
    await p.close(); }
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
