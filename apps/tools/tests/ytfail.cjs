// node tests/ytfail.cjs: YouTube and X in the Add sheet, stand-ins only (a fake desktop bridge, the readers answered in the
// page, a loopback server for a short link — never a real site, never a real yt-dlp):
// 1. the error table (src/video/errors.ts, pure): yt-dlp's raw lines → a plain message and an action, per platform;
// 2. the failure as shown: the message, its action in view (Sign in / Try again), the raw line under «Details», and no
//    icon in the sheet larger than 48 px; «Try again» reads again; the Tauri «Sign in» keeps the site's sign-in;
// 3. an X post: the post reader alone (yt-dlp not run, the Video add-on not set up); the reader failing → yt-dlp; the
//    reader's states said; «Choose a quality» asks yt-dlp only then;
// 4. FxTwitter slow → VxTwitter after its head start wins; VxTwitter's non-media left out, a GIF named as one;
// 5. a t.co link followed once (loopback) and read as the post it leads to;
// 6. no HEAD probe of a video site's page; Return YouTube Dislike asked once per video, after the qualities.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const esbuild = require('esbuild');
const DIST = path.join(__dirname, '..', 'dist'); const FXV = fs.readFileSync(path.join(__dirname, 'data', 'fxtwitter-video.json'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
// 1. The table.
{
  const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/video/errors.ts')], bundle: true, write: false, format: 'cjs', platform: 'node' });
  const m = {}; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports = {}); const E = m.exports;
  const T = [
    ["ERROR: [youtube] abc: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.", 'tauri', 'botCheck', 'signIn'],
    ['ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.', 'android', 'ageGate', 'signIn'],
    ['ERROR: [youtube] abc: Private video. Sign in if you\'ve been granted access to this video', 'electron', 'private', 'signIn'],
    ['ERROR: [youtube] abc: Join this channel to get access to members-only content like this video', 'tauri', 'members', 'signIn'],
    ['ERROR: [instagram] x: Requested content is not available, rate-limit reached or login required. Use --cookies', 'tauri', 'rateLimit', 'retryLater'],
    ['ERROR: [youtube] abc: HTTP Error 429: Too Many Requests', 'android', 'rateLimit', 'retryLater'],
    ['ERROR: [youtube] abc: The uploader has not made this video available in your country', 'tauri', 'geo', null],
    ['ERROR: [youtube] abc: Video unavailable. This video has been removed by the uploader', 'electron', 'gone', null],
    ['ERROR: [youtube] abc: This live event will begin in 3 hours.', 'tauri', 'notLive', 'retryLater'],
    ['WARNING: [youtube] No supported JavaScript runtime could be found. Only images are available', 'tauri', 'noJs', 'getDeno'],
    ['WARNING: [youtube] No supported JavaScript runtime could be found.', 'electron', 'noJs', 'retry'],
    ['ERROR: [youtube] abc: Unable to extract uploader id; please report this issue on https://github.com/yt-dlp/yt-dlp/issues', 'tauri', 'outdated', 'retry'],
    ['ERROR: timed out', 'android', 'timeout', 'retry'],
    ['ERROR: [generic] Unsupported URL: https://example.test/page', 'tauri', 'unsupported', null],
    ['ERROR: Unable to download webpage: <urlopen error [Errno -2] Name or service not known>', 'tauri', 'network', 'retry'],
    ['something else entirely', 'tauri', 'other', 'retry'],
    ['ERROR: [youtube] abc: Sign in to confirm your age.', 'web', 'ageGate', null],
  ];
  for (const [line, shell, kind, action] of T) { const r = E.videoError(new Error(line), shell); ok(`table: ${kind} on ${shell}`, r.kind === kind && r.action === action && !!r.key && !/^ERROR/.test(r.raw), r); }
  ok('table: the raw line tidied («ERROR: [youtube] abc:» off)', E.rawLine(new Error('ERROR: [youtube] abc: Video unavailable')) === 'Video unavailable');
  ok('table: every key is a string the app has', (() => { const en = fs.readFileSync(path.join(__dirname, '..', 'src/i18n/en.ts'), 'utf8'); return T.every(([l, s]) => new RegExp(`\\b${E.videoError(l, s).key}:`).test(en)) && /\bvErrNoJsElectron:/.test(en); })());
  ok('table: healable kinds', E.healable('outdated') && E.healable('noJs') && !E.healable('private'));
}
const serve = () => http.createServer((req, res) => {
  // (A short link's server: a 301 to the post. The fake bridge plays the shell's request layer, which follows it: it asks for the hop's target.)
  if (req.url.startsWith('/tco/')) { const to = 'https://x.com/sample_user/status/1700000000000000042'; if (req.headers['x-kt-follow']) { res.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' }); res.end(to); return; } res.writeHead(301, { location: to }); res.end(); return; }
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  const web = serve().listen(0); const port = web.address().port; const base = `http://127.0.0.1:${port}/`;
  const br = await chromium.launch();
  const open = async (o = {}) => {
    const ctx = await br.newContext({ viewport: { width: 420, height: 900 } }); const p = await ctx.newPage(); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"/>' }));
    await p.addInitScript(({ o, fxv, port }) => {
      localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.video.checked', String(Date.now()));
      localStorage.setItem('kt.settings', JSON.stringify({ addons: o.noAddon ? [] : ['video'] }));
      window.__KT_SHELL__ = 'tauri'; window.__n = { info: 0, http: [], cookies: [], addon: 0 }; let fail = o.fail || null; window.__setFail = (f) => { fail = f; };
      const raw = { id: 'abc', title: 'Made-up clip', extractor_key: 'Youtube', webpage_url: 'https://www.youtube.com/watch?v=abc', formats: [{ format_id: '22', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, tbr: 2000, ext: 'mp4' }] };
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'linux', list: async () => [], onTasks: (cb) => { cb([]); return () => {}; }, defaultDir: async () => '/d',
        videoReady: async () => ({ ok: true }), videoVersion: async () => ({ version: '2026.10.10', ready: true }), videoUpdate: async () => ({ version: '2026.10.10' }), packStatus: async () => ({ ffmpeg: { version: '7', size: 1 } }), browse: async () => true,
        videoInfo: async (q) => { window.__n.info++; await wait(o.infoDelay || 30); if (fail) throw new Error(fail); return /x\.com/.test(q.url) ? { ...raw, extractor_key: 'Twitter', webpage_url: q.url } : raw; },
        videoCookies: async (q) => { window.__n.cookies.push(q.op); return q.op === 'save' ? { site: 'youtube.com', count: 3 } : []; },
        http: async (q) => {
          const u = String(q.url); window.__n.http.push(`${q.method || 'GET'} ${u}`);
          if (/^https:\/\/t\.co\//.test(u)) { const r = await fetch(`http://127.0.0.1:${port}/tco/${u.split('/').pop()}`, { headers: { 'x-kt-follow': '1' } }); return { status: 200, url: await r.text(), headers: {}, body: '' }; }
          if (/api\.fxtwitter\.com/.test(u)) { if (o.fx === 'slow') await wait(5000); if (o.fx === '404') return { status: 404, url: u, headers: {}, body: '{"code":404,"message":"NOT_FOUND"}' }; if (o.fx === '401') return { status: 401, url: u, headers: {}, body: '{"code":401,"message":"PRIVATE_TWEET"}' }; if (o.fx === 'down') return { status: 500, url: u, headers: {}, body: '' }; return { status: 200, url: u, headers: {}, body: fxv }; }
          if (/api\.vxtwitter\.com/.test(u)) { if (o.vx === 'ok') return { status: 200, url: u, headers: {}, body: JSON.stringify({ text: 'A made-up post', user_screen_name: 'sample_user', tweetID: '1700000000000000042', media_extended: [{ type: 'gif', url: 'https://video.twimg.com/tweet_video/SAMPLE.mp4', thumbnail_url: 'https://pbs.twimg.com/tweet_video_thumb/SAMPLE.jpg' }, { type: 'image', url: 'https://example.test/not-media-page' }, { type: 'video', url: 'https://video.twimg.com/x/pl/SAMPLE.m3u8' }] }) }; if (o.vx === '404') return { status: 404, url: u, headers: {}, body: '{"error":"not found"}' }; return { status: 500, url: u, headers: {}, body: '' }; }
          if (/returnyoutubedislike/.test(u)) return { status: 200, url: u, headers: {}, body: '{"likes":10,"dislikes":1}' };
          return { status: 404, url: u, headers: {}, body: '' };
        } },
      { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    }, { o, fxv: FXV, port });
    await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-input');
    const paste = (link) => p.evaluate((link) => { const ta = document.querySelector('.add-input'); ta.value = link; ta.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertFromPaste' })); }, link);
    return { p, ctx, errs, paste, n: () => p.evaluate(() => window.__n) };
  };
  const bigIcons = (p) => p.$$eval('.sheet svg', (xs) => xs.filter((x) => x.getClientRects().length).map((x) => x.getBoundingClientRect()).filter((r) => r.width > 48 || r.height > 48).length);
  const inView = (p, sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight; }).catch(() => false);
  // 2. Failures as shown.
  for (const [line, want, btn] of [["ERROR: [youtube] abc: Sign in to confirm you're not a bot.", /not a bot/, 'Sign in'], ['ERROR: [youtube] abc: HTTP Error 429: Too Many Requests', /limiting requests/, 'Try again'], ['ERROR: [youtube] abc: Video unavailable', /unavailable/, null]]) {
    const s = await open({ fail: line }); await s.paste('https://www.youtube.com/watch?v=abc'); await s.p.waitForSelector('.video-failed', { timeout: 8000 });
    const msg = await s.p.$eval('.video-err-msg', (e) => e.textContent); ok(`failure «${line.slice(25, 60)}»: the plain message`, want.test(msg), msg);
    ok('  no icon larger than 48 px in the sheet', (await bigIcons(s.p)) === 0, await bigIcons(s.p));
    if (btn) { const b = s.p.locator('.video-err-actions .btn', { hasText: btn }); ok(`  «${btn}» shown and in view`, (await b.count()) === 1 && (await b.evaluate((e) => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }))); }
    else ok('  no action for a removed video', (await s.p.$$('.video-err-actions .btn')).length === 0);
    ok('  the raw line under «Details»', (await s.p.$eval('.video-why', (e) => e.textContent)).includes(line.replace(/^ERROR: \[youtube\] abc: /, '')) && await inView(s.p, '.video-why summary'));
    if (btn === 'Try again') { await s.p.evaluate(() => window.__setFail(null)); const before = (await s.n()).info; await s.p.click('.video-err-actions .btn'); await s.p.waitForSelector('.video-choices', { timeout: 5000 }); ok('  «Try again» reads again and shows the qualities', (await s.n()).info === before + 1); }
    if (btn === 'Sign in') { await s.p.click('.video-err-actions .btn:has-text("Sign in")'); await s.p.waitForSelector('.sheet .btn.primary:has-text("Use my sign-in")'); await s.p.evaluate(() => window.__setFail(null)); await s.p.click('.sheet .btn.primary:has-text("Use my sign-in")'); await s.p.waitForSelector('.video-choices', { timeout: 5000 }); ok('  «Sign in» → the site\'s sign-in kept, the link read again', (await s.n()).cookies.includes('save')); }
    ok('  no page errors', !s.errs.length, s.errs); await s.ctx.close();
  }
  // 3. X: the reader alone; the add-on not set up for it.
  { const s = await open({ noAddon: true }); await s.paste('https://x.com/sample_user/status/1700000000000000042'); await s.p.waitForSelector('.post-tile', { timeout: 8000 }); await s.p.waitForTimeout(400); const n = await s.n();
    ok('X: the post read by the reader, yt-dlp not run', n.info === 0); ok('X: the Video add-on not set up for a post the reader read', !(await s.p.$('.video-panel:not([hidden])')) && !JSON.parse(await s.p.evaluate(() => localStorage.getItem('kt.settings'))).addons.includes('video'));
    ok('X: no HEAD or range probe of the post page', !n.http.some((x) => /^HEAD https:\/\/x\.com/.test(x)), n.http); await s.ctx.close(); }
  { const s = await open(); await s.paste('https://x.com/sample_user/status/1700000000000000042'); await s.p.waitForSelector('.post-chooser'); await s.p.click('.post-chooser'); await s.p.waitForSelector('.video-choices', { timeout: 5000 });
    ok('X: «Choose a quality» asks yt-dlp only then', (await s.n()).info === 1); await s.ctx.close(); }
  for (const [fx, vx, want] of [['404', '404', /not found/], ['401', 'down', /private/], ['down', 'down', /did not answer/]]) {
    const s = await open({ fx, vx, infoDelay: 1500 }); await s.paste('https://x.com/sample_user/status/1700000000000000042'); await s.p.waitForSelector('.post-state', { timeout: 8000 });
    const st = await s.p.$eval('.post-state', (e) => e.textContent).catch(() => ''); await s.p.waitForSelector('.video-choices', { timeout: 8000 }); const n = await s.n();
    ok(`X reader ${fx}/${vx}: then yt-dlp once`, n.info === 1, n.info); ok(`X reader ${fx}/${vx}: its state said while yt-dlp reads`, want.test(st), st); ok(`X reader ${fx}/${vx}: the note put away once yt-dlp read it`, !(await s.p.$('.post-state'))); await s.ctx.close();
  }
  // 4. FxTwitter slow: VxTwitter after its head start wins; only media, a GIF named so, a stream left to the Video add-on.
  { const s = await open({ fx: 'slow', vx: 'ok' }); const t0 = Date.now(); await s.paste('https://x.com/sample_user/status/1700000000000000042'); await s.p.waitForSelector('.post-tile', { timeout: 8000 }); const ms = Date.now() - t0;
    ok('X: a slow FxTwitter does not hold the sheet (VxTwitter after its head start)', ms < 3500, ms);
    const tiles = await s.p.$$eval('.post-tile', (xs) => xs.length); ok('X (VxTwitter): the non-media item left out', tiles === 2, tiles);
    await s.p.click('.sheet .btn.primary'); await s.p.waitForTimeout(300); await s.ctx.close(); }
  { // (pure check of the VxTwitter items through the module)
    const out = esbuild.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/downloads/social.ts')], bundle: true, write: false, format: 'cjs', platform: 'node', define: { window: 'globalThis' } });
    const m = {}; globalThis.window = globalThis; globalThis.kurokawaTools = { http: async (q) => (/vxtwitter/.test(q.url) ? { status: 200, url: q.url, headers: {}, body: JSON.stringify({ text: 'A made-up post', user_screen_name: 'sample_user', tweetID: '1', media_extended: [{ type: 'gif', url: 'https://video.twimg.com/tweet_video/SAMPLE.mp4' }, { type: 'image', url: 'https://example.test/not-media-page' }, { type: 'video', url: 'https://video.twimg.com/x/pl/SAMPLE.m3u8' }, { type: 'image', url: 'https://pbs.twimg.com/media/SAMPLE.jpg' }] }) } : { status: 500, url: q.url, headers: {}, body: '' }) };
    new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports = {}, require); const post = await m.exports.socialPost('https://x.com/sample_user/status/1700000000000000042');
    const xs = post.items.map((x) => [x.kind, x.name, x.viaVideo ? 'via' : x.href.split('/').pop()]);
    ok('VxTwitter: a GIF named «…-gif.mp4», a stream to the Video add-on, a photo at its original size, the rest left out', JSON.stringify(xs) === JSON.stringify([['gif', 'sample_user-1700000000000000042-1-gif.mp4', 'SAMPLE.mp4'], ['video', 'sample_user-1700000000000000042-3.mp4', 'via'], ['image', 'sample_user-1700000000000000042-4.jpg', 'SAMPLE.jpg?name=orig']]), xs);
    ok('bestMp4: never a playlist or a page', m.exports.bestMp4({ type: 'video', url: 'https://v/x.m3u8', formats: [] }) === null && m.exports.bestMp4({ type: 'video', url: 'https://v/x.m3u8', variants: [{ url: 'https://v/a.mp4', content_type: 'video/mp4', bitrate: 5 }] }) === 'https://v/a.mp4');
  }
  // 5. A t.co link, followed on loopback.
  { const s = await open(); await s.paste('https://t.co/Sample01'); await s.p.waitForSelector('.post-tile', { timeout: 8000 }); const v = await s.p.$eval('.add-input', (e) => e.value); const n = await s.n();
    ok('t.co: followed once, the field shows where it leads, the post read', v === 'https://x.com/sample_user/status/1700000000000000042' && n.http.filter((x) => /t\.co/.test(x)).length === 1, { v, http: n.http }); await s.ctx.close(); }
  // 6. A YouTube page: no probe; RYD once, after the qualities, whatever is redrawn.
  { const s = await open(); await s.paste('https://www.youtube.com/watch?v=abc'); await s.p.waitForSelector('.video-choices'); await s.p.waitForTimeout(200);
    for (let i = 0; i < 3; i++) { await s.p.click('.video-choices .chip >> nth=1').catch(() => undefined); await s.p.waitForTimeout(60); }
    const n = await s.n(); ok('YouTube: no HEAD or range probe of the page', !n.http.some((x) => /^HEAD .*youtube/.test(x) || /youtube\.com\/watch/.test(x)), n.http);
    ok('Return YouTube Dislike asked once, however often the panel is redrawn', n.http.filter((x) => /returnyoutubedislike/.test(x)).length === 1, n.http); await s.ctx.close(); }
  await br.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
