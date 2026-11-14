// The time from a pasted link to what the Add sheet offers (the number a person feels), with stand-ins only: a fake
// yt-dlp behind the desktop bridge or the phone's plugin (a configurable start-up and answer delay), the X readers
// (FxTwitter, VxTwitter) and every other request answered in the page by the fake bridge — no real site, no real
// yt-dlp. Each case reports its milliseconds and what ran (yt-dlp runs, reader calls, page probes).
// node tests/ytspeed.cjs [--json]   (prints a table; exits 1 only when a case never shows its result)
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = process.env.KT_DIST || path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo'); const FX = path.join(__dirname, 'data');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const FXVIDEO = fs.readFileSync(path.join(FX, 'fxtwitter-video.json'), 'utf8');
// (Delays: yt-dlp's start (Python on a phone is slower) and its answer; each web request's.)
const CFG = { desk: { start: 400, answer: 300, http: 120 }, phone: { start: 1500, answer: 400, http: 160 } };

(async () => {
  const web = serve(DIST).listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const rows = []; let bad = 0;
  const one = async (name, plat, link, want, opts = {}) => {
    const ctx = await br.newContext({ viewport: { width: 420, height: 860 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await ctx.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: 'text/plain' }); });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>' }));
    await p.addInitScript(({ plat, cfg, fxvideo, readerFails }) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.video.checked', String(Date.now()));
      localStorage.setItem('kt.settings', JSON.stringify({ addons: ['video'] }));
      const c = cfg[plat]; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.__n = { info: 0, ready: 0, http: 0, head: 0, reader: 0, ryd: 0 };
      const raw = { id: 'abc', title: 'A short film about trains', thumbnail: 'https://i.ytimg.com/vi/abc/hq.jpg', duration: 754, extractor_key: 'Youtube', webpage_url: 'https://www.youtube.com/watch?v=abc', uploader: 'Rail Channel', subtitles: { en: [] },
        formats: [{ format_id: '140', url: 'x', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ext: 'm4a', filesize: 9e6 }, { format_id: '137', url: 'x', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, tbr: 4000, ext: 'mp4', filesize: 300e6 }, { format_id: '22', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, tbr: 2000, ext: 'mp4', filesize: 120e6 }] };
      const xraw = { id: '1585341984679469056', title: 'X post', extractor_key: 'Twitter', webpage_url: 'https://x.com/a/status/1585341984679469056', formats: [{ format_id: 'http-2176', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 1080, tbr: 2176, ext: 'mp4' }] };
      const info = async (o) => { window.__n.info++; await wait(c.start + c.answer); if (/youtube|youtu\.be/.test(o.url)) return raw; if (/x\.com|twitter/.test(o.url)) return xraw; throw new Error('ERROR: Unsupported URL: ' + o.url); };
      const httpFake = async (o) => {
        window.__n.http++; await wait(c.http); const u = String(o.url);
        if ((o.method || 'GET') === 'HEAD' || (o.headers && (o.headers.Range || o.headers.range))) { window.__n.head++; return { status: 200, url: u, headers: { 'content-type': 'text/html' }, body: '' }; }
        if (/api\.(fx|vx)twitter\.com/.test(u)) { window.__n.reader++; if (readerFails) return { status: 500, url: u, headers: {}, body: '' }; if (/vxtwitter/.test(u)) return { status: 500, url: u, headers: {}, body: '' }; return { status: 200, url: u, headers: { 'content-type': 'application/json' }, body: fxvideo }; }
        if (/KurokawaTools-packs\.json/.test(u)) return { status: 200, url: u, headers: {}, body: JSON.stringify({ versions: { python: '3.11', ffmpeg: '7' }, packs: {} }) };
        if (/returnyoutubedislike/.test(u)) { window.__n.ryd++; return { status: 200, url: u, headers: {}, body: '{"likes":10,"dislikes":1}' }; }
        return { status: 404, url: u, headers: {}, body: '' };
      };
      window.__t0 = 0;
      if (plat === 'desk') {
        window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => [], onTasks: (cb) => { cb([]); return () => {}; }, defaultDir: async () => '/home/u/Downloads',
          videoReady: async () => { window.__n.ready++; return { ok: true }; }, videoInfo: info, videoVersion: async () => ({ version: '2026.10.10', ready: true }), http: httpFake, packStatus: async () => ({ ffmpeg: { version: '7', size: 1 } }) },
        { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
      } else {
        const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), videoInfo: async (o) => ({ json: JSON.stringify(await info(o)) }), videoVersion: async () => ({ version: '2026.10.10', ready: true }), httpRequest: httpFake,
          packStatus: async () => ({ python: { version: '3.11', size: 1 }, ffmpeg: { version: '7', size: 1 } }), videoWarm: async () => { window.__n.warm = (window.__n.warm || 0) + 1; return {}; } };
        const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
      }
    }, { plat, cfg: CFG, fxvideo: FXVIDEO, readerFails: !!opts.readerFails });
    await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-input');
    await p.waitForTimeout(300);
    // (A paste as a browser makes it: the text in, then «input» with inputType insertFromPaste.)
    const t0 = await p.evaluate((link) => { const ta = document.querySelector('.add-input'); ta.focus(); ta.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: false })); ta.value = link; ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste', data: link })); return performance.now(); }, link);
    const ok = await p.waitForFunction((sel) => !!document.querySelector(sel), want, { timeout: 15000, polling: 10 }).then(() => true, () => false);
    const t1 = await p.evaluate(() => performance.now());
    await p.waitForTimeout(400); const n = await p.evaluate(() => window.__n);
    const ms = Math.round(t1 - t0); rows.push({ name, ms: ok ? ms : null, ...n, errors: errs.length });
    if (!ok) bad++;
    await ctx.close();
  };
  const YT = 'https://www.youtube.com/watch?v=abc'; const YTL = 'https://www.youtube.com/watch?v=abc&list=PLxyz'; const X = 'https://x.com/elonmusk/status/1585341984679469056';
  for (const plat of ['desk', 'phone']) {
    await one(`${plat}: YouTube video`, plat, YT, '.video-choices');
    await one(`${plat}: YouTube video in a playlist`, plat, YTL, '.video-choices');
    await one(`${plat}: X post with a video`, plat, X, '.post-tile');
    await one(`${plat}: X post, reader fails`, plat, X, '.video-choices', { readerFails: true });
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify(rows));
  console.log('case'.padEnd(40), 'ms'.padStart(6), ' yt-dlp  reader  probes  ryd  errors');
  for (const r of rows) console.log(r.name.padEnd(40), String(r.ms ?? 'never').padStart(6), String(r.info).padStart(7), String(r.reader).padStart(7), String(r.head).padStart(7), String(r.ryd).padStart(4), String(r.errors).padStart(7));
  await br.close(); web.close(); process.exit(bad ? 1 : 0);
})();
