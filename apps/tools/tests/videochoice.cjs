// node tests/videochoice.cjs [en|ar]: the video chooser in the Add sheet on a stubbed desktop bridge. Only the heights the page has
// (with sizes); Audio → MP3 → 320 adds the exact argument list; without the ffmpeg pack an ffmpeg-needing choice shows the get-ffmpeg
// card and adds nothing, while M4A taken as it is still adds (no -x, no embedding); the choice is remembered; «use my default» adds
// in one tap; the page is read ONCE for the sheet and the add; a playlist link offers this video / the whole list / a range (one task
// a video, numbered by its place); a plain playlist link offers the list and a range. No page errors in either language.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const lang = process.argv[2] || 'en';
const TX = lang === 'ar' ? { audio: 'الصوت وحده', extras: 'إضافات', one: 'هذا الفيديو فقط', all: 'القائمة كلها', range: 'نطاق منها' } : { audio: 'Audio only', extras: 'Extras', one: 'This video only', all: 'Whole playlist', range: 'A range' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const MANIFEST = { version: '1.0.0', packs: { ffmpeg: { 'linux-x64': { file: 'ffmpeg-linux-x64.zip', size: 40e6, sha256: 'bb' } } } };
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1].split('?')[0]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: 'text/plain', headers: { 'access-control-allow-origin': '*' } }); });
  await p.route(/i\.ytimg\.com/, (r) => r.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="90"><rect width="160" height="90" fill="#c33"/></svg>' }));
  await p.addInitScript(([lang, manifest, first]) => {
    if (first && !sessionStorage.getItem('seeded')) { localStorage.clear(); sessionStorage.setItem('seeded', '1'); }
    localStorage.setItem('kr.lang', lang); window.__added = []; window.__info = []; window.__ff = sessionStorage.getItem('ffmissing') ? { version: null, size: 0 } : { version: '1.0.0', size: 4e7 };
    const raw = { id: 'abc', title: 'A short film about trains', thumbnail: 'https://i.ytimg.com/vi/abc/hq.jpg', duration: 754, extractor_key: 'Youtube', webpage_url: 'https://www.youtube.com/watch?v=abc', uploader: 'Rail Channel', subtitles: { en: [] }, automatic_captions: { en: [], de: [] }, chapters: [{}, {}],
      formats: [{ format_id: '140', url: 'x', vcodec: 'none', acodec: 'mp4a.40.2', abr: 128, ext: 'm4a', filesize: 9e6 }, { format_id: '137', url: 'x', vcodec: 'avc1', acodec: 'none', height: 1080, fps: 30, tbr: 4000, ext: 'mp4', filesize: 300e6 }, { format_id: '22', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 720, fps: 30, tbr: 2000, ext: 'mp4', filesize: 120e6 }, { format_id: '18', url: 'x', vcodec: 'avc1', acodec: 'mp4a', height: 360, fps: 30, tbr: 500, ext: 'mp4', filesize: 40e6 }] };
    const list = { _type: 'playlist', title: 'Rail Mix', webpage_url: 'https://www.youtube.com/playlist?list=PL1', entries: [1, 2, 3, 4].map((n) => ({ url: 'https://www.youtube.com/watch?v=e' + n, title: 'Part ' + n, id: 'e' + n })) };
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => [], add: async (o) => { window.__added.push(o); return { id: 't' + window.__added.length, name: o.video?.title || o.source.url, ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/home/u/Downloads', pickDir: async () => null, onTasks: (cb) => { cb([]); return () => {}; },
      http: async (o) => (/KurokawaTools-packs\.json$/.test(o.url) ? { status: 200, url: o.url, headers: {}, body: JSON.stringify(manifest) } : { status: 404, url: o.url, headers: {}, body: '' }),
      packStatus: async () => ({ ffmpeg: window.__ff, platform: 'linux', arch: 'x64' }), packInstall: async () => {}, packCancel: async () => {}, packRemove: async () => {}, onPackProgress: () => () => {},
      videoReady: async () => true, videoInfo: async (o) => { window.__info.push({ url: o.url, playlist: !!o.playlist }); await new Promise((r) => setTimeout(r, 120)); if (!/youtube/.test(o.url)) throw new Error('Unsupported URL'); return o.playlist ? list : raw; }, videoVersion: async () => ({ version: '2026.10.10', ready: true }), videoUpdate: async () => ({ version: '2026.10.22', updated: true }) };
  }, [lang, MANIFEST, true]);
  const base = `http://127.0.0.1:${port}/`;
  const openSheet = async (url) => { if (await p.$('.sheet')) { await p.keyboard.press('Escape'); await p.waitForSelector('.sheet', { state: 'detached', timeout: 4000 }).catch(() => 0); } await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet'); await p.fill('.add-input', url); };
  const num = (s) => Number(String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[^\d]/g, ''));
  const chipOn = (text) => p.evaluate((x) => [...document.querySelectorAll('.video-chooser .chip.on')].some((c) => c.textContent.includes(x)), text);
  const clickChip = (text) => p.evaluate((x) => { const c = [...document.querySelectorAll('.video-chooser .chip')].find((e) => e.textContent.trim().startsWith(x)); if (!c) throw new Error('no chip ' + x); c.click(); }, text);
  const A = (i) => p.evaluate((k) => window.__added[k], i);
  const URLV = 'https://www.youtube.com/watch?v=abc';

  // 1. only the heights the page has, with sizes; the page is read once
  await openSheet(URLV); await p.waitForSelector('.video-qualities', { timeout: 10000 });
  const q = await p.$$eval('.video-qualities .chip', (cs) => cs.map((c) => ({ t: c.querySelector('span')?.textContent ?? '', s: c.querySelector('small')?.textContent ?? '' })));
  ok('qualities: Best + exactly the heights the page has (1080, 720, 360)', q.length === 4 && JSON.stringify(q.slice(1).map((x) => num(x.t))) === '[1080,720,360]', q);
  ok('each height shows an approximate size', q.slice(1).every((x) => /\d/.test(x.s)), q);
  await p.screenshot({ path: path.join(__dirname, `shot-videochoice-${lang}.png`) });
  // 2. audio → MP3 → 320 → add
  await clickChip(TX.audio); await p.waitForSelector('.video-chooser .chip:has-text("MP3")');
  ok('MP3 at 320 kbps is the first choice made', await chipOn('MP3') && await p.evaluate(() => [...document.querySelectorAll('.video-chooser .chip.on')].some((c) => /320/.test(c.textContent.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))))));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 1);
  const a0 = (await A(0)).video.args.join(' ');
  ok('MP3 320 passes the exact arguments to the bridge', a0.startsWith('-f ba/b -x --audio-format mp3 --audio-quality 320K --embed-thumbnail --convert-thumbnails jpg --embed-metadata --embed-chapters --no-playlist -o %(title)s [%(id)s].%(ext)s') && /-N \d+ --http-chunk-size 10M/.test(a0), a0);
  ok('…and no folder or program option came from the page', !/(^| )-P |--ffmpeg-location|--exec|--cookies/.test(a0));
  ok('the page was read once for the sheet and the add', (await p.evaluate(() => window.__info.length)) === 1, await p.evaluate(() => window.__info));
  // 3. remembered
  await openSheet(URLV); await p.waitForSelector('.video-chooser');
  ok('the last choice is the default next time (Audio, MP3)', await chipOn(TX.audio) && await chipOn('MP3'));
  ok('…and the link read again does not run yt-dlp again', (await p.evaluate(() => window.__info.length)) === 1);
  // 4. no ffmpeg pack: MP3 needs it → the card, nothing added; M4A as is still adds
  await p.evaluate(() => { window.__ff.version = null; window.__ff.size = 0; sessionStorage.setItem('ffmissing', '1'); });
  await p.click('.sheet .btn.primary'); await p.waitForSelector('.get-card', { timeout: 8000 });
  ok('MP3 without ffmpeg: the get-ffmpeg card appears', true);
  ok('…and nothing was added', (await p.evaluate(() => window.__added.length)) === 1);
  await p.click('.get-card .btn.text'); await p.waitForTimeout(300);
  await clickChip('M4A'); await p.waitForTimeout(200);
  ok('M4A (as is) says without ffmpeg the cover and tags are left out', !!(await p.$('.video-ffmpeg')));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 2, null, { timeout: 8000 });
  const a1 = (await A(1)).video.args;
  ok('M4A as is adds with no ffmpeg need: ba[ext=m4a]/ba, no -x, nothing embedded', a1[0] === '-f' && a1[1] === 'ba[ext=m4a]/ba' && !a1.includes('-x') && !a1.some((x) => /^--embed/.test(x)), a1);
  ok('…without the card', await p.waitForSelector('.get-card', { state: 'detached', timeout: 3000 }).then(() => true, () => false));
  // 5. M4A remembered; «use my default» in one tap
  await openSheet(URLV); await p.waitForSelector('.video-chooser');
  ok('M4A is the default now', await chipOn('M4A'));
  await p.click('.video-ask input'); await p.waitForTimeout(100);
  await openSheet(URLV); await p.waitForSelector('.video-using');
  ok('with «always ask» off the sheet shows one line and Change, not the chooser', !(await p.$('.video-chooser')) && !!(await p.$('.video-using button')));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 3);
  ok('one tap adds with the default (the same arguments as the last add)', JSON.stringify((await A(2)).video.args) === JSON.stringify(a1));
  ok('Change opens the chooser', await (async () => { await openSheet(URLV); await p.waitForSelector('.video-using'); await p.click('.video-using button'); return !!(await p.waitForSelector('.video-chooser', { timeout: 3000 }).catch(() => null)); })());
  // 6. a video link with a list: this video / the whole list / a range
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.videoAsk = true; localStorage.setItem('kt.settings', JSON.stringify(s)); });
  await p.reload(); const n0 = await p.evaluate(() => window.__info.length);
  await openSheet(URLV + '&list=PL1'); await p.waitForSelector('.video-chooser');
  await p.click(`.video-extras summary`); await p.waitForSelector('.video-extras[open]');
  const names = await p.$$eval('.video-extras .chip', (cs) => cs.map((c) => c.textContent.trim()));
  ok('a video link with a list offers this video / the whole list / a range', [TX.one, TX.all, TX.range].every((x) => names.includes(x)), names);
  ok('…read once so far', (await p.evaluate(() => window.__info.length)) === 1, await p.evaluate(() => window.__info));
  await clickChip(TX.range); await p.waitForSelector('.video-range'); await p.fill('.video-range', '2-3'); await p.waitForFunction(() => window.__info.length === 2, null, { timeout: 8000 }).catch(() => 0);
  ok('the list is read (flat) once when a list choice is made', (await p.evaluate(() => window.__info.map((i) => i.playlist))).join() === 'false,true', await p.evaluate(() => window.__info));
  await p.click('.sheet .btn.primary'); await p.waitForFunction((k) => window.__added.length === k, 2, { timeout: 8000 });
  const [l1, l2] = [(await A(0)).video, (await A(1)).video]; const o1 = l1.args[l1.args.indexOf('-o') + 1], o2 = l2.args[l2.args.indexOf('-o') + 1];
  ok('the range 2-3 adds the 2nd and 3rd as their own tasks, numbered by place', (await p.evaluate(() => window.__added.map((a) => a.source.url))).join() === 'https://www.youtube.com/watch?v=e2,https://www.youtube.com/watch?v=e3' && /^02 - /.test(o1) && /^03 - /.test(o2) && l1.args.includes('--no-playlist'), [o1, o2]);
  // 7. a plain playlist link: the list and a range only
  await openSheet('https://www.youtube.com/playlist?list=PL1'); await p.waitForSelector('.video-chooser'); await p.click(`.video-extras summary`);
  const n2 = await p.$$eval('.video-extras .chip', (cs) => cs.map((c) => c.textContent.trim()));
  ok('a playlist link offers the whole list and a range, not «this video»', n2.includes(TX.all) && n2.includes(TX.range) && !n2.includes(TX.one), n2);
  ok('english and arabic render without page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} FAILED` : 'all passed'); await br.close(); web.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
