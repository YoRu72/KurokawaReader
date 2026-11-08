// The player (REX Player's and VLC's features) on a finished download (the Android plugin faked, a short WebM
// made by ffmpeg and served here, its subtitle beside it): the subtitle found and shown; double taps seeking and
// adding up; the equaliser's presets; rotation, looks and sharpness; bookmarks on the bar; jumping to a time;
// line-by-line subtitle seeking and VLC's two-tap sync; previews over the seek bar; the preferences panel.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const { execFileSync } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-player-'));
try { execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '12', '-c:v', 'libvpx', '-b:v', '300k', '-c:a', 'libopus', path.join(MEDIA, 'clip.webm')]); }
catch { console.log('ffmpeg not available — skipped'); process.exit(0); }
fs.writeFileSync(path.join(MEDIA, 'clip.srt'), '1\n00:00:01,000 --> 00:00:03,000\nFirst line\n\n2\n00:00:05,000 --> 00:00:07,000\nSecond line\n\n3\n00:00:09,000 --> 00:00:11,000\nThird line\n');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg', '.webm': 'video/webm', '.srt': 'text/plain' };
const serve = () => http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
});
(async () => {
  const web = serve().listen(0); const port = web.address().port;
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const p = await br.newPage({ viewport: { width: 900, height: 520 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript((port) => {
    localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], playerWith: 'app' }));
    const task = { id: 'v', kind: 'http', name: 'clip.webm', source: { url: 'https://x/clip.webm' }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: 'clip.webm', size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native' };
    const api = {
      addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [task] }),
      localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.split('/').pop()}` }), siblings: async () => ({ paths: ['/sdcard/Download/clip.srt'] }),
      ffmpeg: async (o) => (window.__ffOn ? window.__ff(o.args) : { code: 1, log: 'off' }), writeTemp: async (o) => ({ path: await window.__tmp(o.name, o.text) }), clipsDir: async () => ({ dir: '/sdcard/Movies/KUROKAWACLIPS' }),
      packStatus: async () => ({ python: { version: null, size: 0 }, ffmpeg: { version: window.__ffOn ? 'test' : null, size: 1 }, mpv: { version: null, size: 0 } }),
      progressNote: async (o) => { (window.__notes ??= []).push(o); }, mediaScan: async (o) => { window.__scanned = o.path; }, openWith: async () => {},
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, port);
  const real = (x) => x.replace('/sdcard/Download/', MEDIA + '/').replace('/sdcard/Movies/KUROKAWACLIPS/', MEDIA + '/').replace('/sdcard/tmp/', MEDIA + '/');
  await p.exposeFunction('__ff', (args) => { try { require('node:child_process').execFileSync('ffmpeg', args.map(real), { stdio: ['ignore', 'pipe', 'pipe'] }); return { code: 0, log: '' }; } catch (e) { return { code: e.status || 1, log: String(e.stderr || e.message) }; } });
  await p.exposeFunction('__tmp', (name, text) => { fs.writeFileSync(path.join(MEDIA, name), text || ''); return '/sdcard/tmp/' + name; });
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.task-card');
  await p.click('.task-card button[aria-label="Play"]'); await p.waitForSelector('.kt-player video.kt-video');
  await p.waitForFunction(() => document.querySelector('.kt-video').currentTime > 0.3, null, { timeout: 15000 });
  check('the video plays', true);
  const T = () => p.evaluate(() => document.querySelector('.kt-video').currentTime);
  const seek = (s) => p.evaluate((s) => { document.querySelector('.kt-video').currentTime = s; }, s);
  await seek(1.5); await p.waitForTimeout(500);
  check('the subtitle beside the file found and shown', /First line/.test(await p.$eval('.kt-subs', (e) => e.textContent)));
  // On a phone held upright: the line inside the picture (not in the bar below it, nor over the controls), sized from
  // the picture, its font valid (a size the browser threw away left the page's own font).
  {
    await p.setViewportSize({ width: 412, height: 900 }); await p.waitForTimeout(500);
    const g = await p.evaluate(() => { const v = document.querySelector('.kt-player video').getBoundingClientRect(); const c = document.querySelector('.kt-subs .kt-cue'); const r = c.getBoundingClientRect(); const cs = getComputedStyle(c); return { v: [v.top, v.bottom], vw: document.querySelector('.kt-player video').videoWidth, vh: document.querySelector('.kt-player video').videoHeight, cue: [r.top, r.bottom], size: parseFloat(cs.fontSize), weight: cs.fontWeight, lh: cs.lineHeight, bar: document.querySelector('.kt-bottom')?.getBoundingClientRect().top ?? 0 }; });
    const picH = 412 * g.vh / g.vw; const picTop = (900 - picH) / 2, picBottom = picTop + picH; console.log('portrait:', JSON.stringify(g), 'picture', Math.round(picTop), Math.round(picBottom));
    check('upright phone: the subtitle inside the picture', g.cue[0] >= picTop - 2 && g.cue[1] <= picBottom + 2);
    check('…sized from the picture, its own font kept (600, line-height set)', g.size >= 15 && g.size <= 0.12 * picH + 15 && g.weight === '600' && g.lh !== 'normal');
    await p.setViewportSize({ width: 900, height: 520 }); await p.waitForTimeout(400);
  }
  // Double taps on the right: +10, then +10 more (adding up in the ripple).
  await p.evaluate(() => document.querySelector('.kt-video').pause()); await seek(0);
  const box = await p.$eval('.kt-stage', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.92, y: r.top + r.height / 2 }; });
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(60); await p.mouse.click(box.x, box.y); await p.waitForTimeout(120);
  const t1 = await T(); const r1 = await p.$eval('.kt-ripple', (e) => (e.hidden ? '' : e.textContent));
  await p.mouse.click(box.x, box.y); await p.waitForTimeout(150);
  const r2 = await p.$eval('.kt-ripple', (e) => (e.hidden ? '' : e.textContent)); console.log('double tap:', t1.toFixed(1), r1, '→', r2);
  check('a double tap on the right seeks ten seconds', t1 >= 9.5 && t1 <= 10.5 && /\+10s/.test(r1));
  check('tapping again adds up', /\+20s/.test(r2) || (await T()) >= 11.5);
  // The equaliser.
  await p.click('.kt-top button[aria-label="Sound"]'); await p.waitForSelector('.sheet .kt-eq');
  await p.locator('.sheet .row', { hasText: 'Preset' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: /^\s*Rock\s*$/ }).last().click(); await p.waitForTimeout(200);
  let prefs = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.player'))); console.log('eq:', prefs.eqOn, prefs.eqPreset, JSON.stringify(prefs.eq));
  check('a preset sets the ten bands and turns the equaliser on', prefs.eqOn && prefs.eqPreset === 'rock' && prefs.eq[0] === 8 && prefs.eq.length === 10);
  check('ten band sliders', (await p.$$('.sheet .kt-eq input[type=range]')).length === 10);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  // The picture: a quarter turn, a look, sharpness.
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Picture' }).first().click(); await p.waitForSelector('.sheet .chips');
  await p.locator('.sheet .chip', { hasText: '90°' }).click(); await p.locator('.sheet .chip', { hasText: 'Vivid' }).click(); await p.waitForTimeout(150);
  const st = await p.$eval('.kt-video', (v) => ({ tr: v.style.transform, f: v.style.filter })); console.log('picture:', JSON.stringify(st));
  check('rotated a quarter turn', /rotate\(90deg\)/.test(st.tr));
  check('a look applied (with the sharpening filter)', /saturate/.test(st.f) && /url\("?#kt-fx/.test(st.f));
  await p.locator('.sheet .btn.tonal', { hasText: 'Reset' }).click(); await p.waitForTimeout(150);
  check('reset takes it all back', !(await p.$eval('.kt-video', (v) => v.style.transform)));
  // Bookmarks.
  await seek(4); await p.waitForTimeout(150);
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Bookmarks' }).click(); await p.locator('.sheet .btn.primary', { hasText: 'Bookmark' }).click(); await p.waitForTimeout(150);
  check('a bookmark on the bar and remembered', (await p.$$('.kt-seek .kt-bm')).length === 1 && await p.evaluate(() => Object.values(JSON.parse(localStorage.getItem('kt.player.memory'))).some((m) => (m.marks || []).length === 1)));
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  // Jump to a time.
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Jump to a time' }).click(); await p.fill('.sheet input[type=text]', '0:08'); await p.press('.sheet input[type=text]', 'Enter'); await p.waitForTimeout(200);
  check('jumped to 0:08', Math.abs((await T()) - 8) < 0.3);
  // Line by line, and the two-tap sync.
  await seek(1.2); await p.waitForTimeout(100); await p.keyboard.press('Control+ArrowRight'); await p.waitForTimeout(150);
  const tl = await T(); console.log('next line at', tl.toFixed(2)); check('Ctrl+→ goes to the next subtitle line', Math.abs(tl - 5) < 0.2);
  await p.keyboard.press('Shift+H'); await seek(6); await p.waitForTimeout(80); await p.keyboard.press('Shift+J'); await p.waitForTimeout(150);
  const flashText = await p.$eval('.kt-flash', (e) => e.textContent); console.log('sync:', flashText);
  check('heard, then shown: the delay is the difference', /-1\.00/.test(flashText) || /−1\.00/.test(flashText));
  // Seek-bar previews.
  const bar = await p.$eval('.kt-seek', (e) => { const r = e.getBoundingClientRect(); return { x: r.left + r.width * 0.5, y: r.top + r.height / 2 }; });
  await p.evaluate(() => document.querySelector('.kt-player').classList.remove('hide-ui'));
  await p.mouse.move(bar.x, bar.y); await p.mouse.down(); await p.mouse.move(bar.x + 30, bar.y, { steps: 3 }); await p.waitForTimeout(600);
  const pv = await p.$eval('.kt-preview', (e) => ({ shown: !e.hidden, label: e.textContent })).catch(() => ({ shown: false })); await p.mouse.up();
  console.log('preview:', JSON.stringify(pv)); check('a preview over the bar while dragging', pv.shown && /\d:\d\d/.test(pv.label));
  // Your own buttons: +85 s on the bar.
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Your own buttons' }).click(); await p.locator('.sheet .btn.primary', { hasText: 'Add a button' }).click(); await p.waitForTimeout(100);
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); await seek(0); await p.evaluate(() => document.querySelector('.kt-player').classList.remove('hide-ui'));
  const cb = await p.$eval('.kt-custom .kt-chip', (e) => e.textContent).catch(() => ''); await p.click('.kt-custom .kt-chip'); await p.waitForTimeout(150);
  console.log('custom:', cb, (await T()).toFixed(1)); check('a button of your own on the bar, doing its job', cb === '+85s' && (await T()) > 10);
  // The clip sheet: A at 2 s, B at 5 s; the length shown, A moved a second on, a GIF's options.
  await seek(2); await p.waitForTimeout(80); await p.keyboard.press('a'); await seek(5); await p.waitForTimeout(80); await p.keyboard.press('a');
  check('A and B on the bar, to be dragged', (await p.$$('.kt-seek .kt-mark:not([hidden])')).length === 2);
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Cut a clip' }).click(); await p.waitForSelector('.sheet .cut-track');
  const len1 = await p.$eval('.sheet .cut-badge', (e) => e.textContent); await p.locator('.sheet .cut-end >> nth=0').locator('.chip', { hasText: '+1s' }).click();
  const len2 = await p.$eval('.sheet .cut-badge', (e) => e.textContent); const aVal = await p.$eval('.sheet .cut-end >> nth=0 >> input', (e) => e.value); console.log('clip:', len1, '→', len2, 'A', aVal);
  check('the range\'s length, and A nudged a second on', /00:03\.000/.test(len1) && /00:02\.000/.test(len2) && /00:00:03\.000/.test(aVal));
  await p.locator('.sheet .cut-opts .row', { hasText: 'What to make' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: 'GIF' }).last().click(); await p.waitForTimeout(100);
  check('a GIF: its width and frame rate offered', /Width/.test(await p.$eval('.sheet .cut-opts', (e) => e.textContent)));
  // A fast clip, cut for real (the machine's ffmpeg): from 7 s, it begins on the keyframe at or before it — not seconds
  // late —, in the background (its card, its notifications), saved where clips go, with a pop-up when done.
  {
    await p.evaluate(() => { document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()); window.__ffOn = true; window.__notes = []; });
    const kfs = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time', '-of', 'csv=p=0', path.join(MEDIA, 'clip.webm')]).toString().trim().split('\n').map(Number).filter((x) => x <= 7.05);
    const kf = Math.max(...kfs); console.log('keyframes up to 7 s:', kfs.join(', '));
    await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Cut a clip' }).click(); await p.waitForSelector('.sheet .cut-track');
    await p.locator('.sheet .cut-opts .row', { hasText: 'What to make' }).locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: 'Video' }).last().click(); await p.waitForTimeout(100);
    for (const [i, v] of [[1, '00:00:11.000'], [0, '00:00:07.000']]) { const inp = p.locator(`.sheet .cut-end >> nth=${i} >> input`); await inp.fill(v); await inp.dispatchEvent('change'); }
    const fastRow = p.locator('.sheet .cut-opts .row', { hasText: /Way|Mode|How/ }); if (await fastRow.count()) { await fastRow.first().locator('.pick-btn').click(); await p.locator('.sheet .dest-row', { hasText: /Fast/ }).last().click(); }
    await p.click('.sheet .btn.primary:has-text("Export")');
    await p.waitForSelector('.clip-tray .clip-card', { timeout: 10000 });
    check('cut in the background: the sheet gone, its card on the page', !(await p.$('.sheet .cut-track')) && !!(await p.$('.clip-tray .clip-card')));
    await p.waitForSelector('.clip-card.done', { timeout: 30000 }).catch(() => {});
    const out = fs.readdirSync(MEDIA).find((f) => /^clip 000007000-000011000\.webm$/.test(f));
    const toastTxt = await p.$eval('.toast', (e) => e.textContent).catch(() => ''); const card = await p.$eval('.clip-card', (e) => e.textContent).catch(() => '');
    console.log('clip:', out, '| toast:', toastTxt, '| card:', card, '| notes:', await p.evaluate(() => window.__notes.map((n) => `${n.percent ?? ''}${n.done ? ' done' : ''}`).join(',')));
    const dur = out ? Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path.join(MEDIA, out)]).toString()) : 0;
    check('saved in the clips folder, named by its range', !!out && (await p.evaluate(() => window.__scanned)) === `/sdcard/Movies/KUROKAWACLIPS/${out}`);
    console.log('clip length', dur, 'want', 11 - kf); check('it begins on the keyframe before A: as long as B − that keyframe (not seconds short)', Math.abs(dur - (11 - kf)) < 0.6);
    check('a pop-up says so, with the clip to open; the notifications too', /Clip saved/.test(toastTxt) && /Open/.test(toastTxt) && (await p.evaluate(() => window.__notes.some((n) => n.done))));
    if (kf < 6.95) check('…and says where it starts', /starts at 0:0\d/.test(card));
    await p.evaluate(() => { window.__ffOn = false; document.querySelectorAll('.clip-tray').forEach((e) => e.remove()); });
  }
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  // The preferences panel.
  await p.click('.kt-top button[aria-label="More"]'); await p.locator('.sheet .dest-row', { hasText: 'Player settings' }).click(); await p.waitForSelector('.sheet .pp-group');
  const groups = await p.$$eval('.sheet .pp-group > summary', (e) => e.map((x) => x.textContent)); console.log('groups:', groups.join(' | '));
  check('the groups of preferences (the decoder\'s too, on a phone)', groups.length === 8 || (groups.length === 9 && groups.includes('Decoder')));
  // A subtitle from a file: a site's .zip (a season — the playing episode's taken), a .gz, and one dropped on the
  // player from the computer.
  {
    const srt = (line) => `1\n00:00:00,500 --> 00:00:11,500\n${line}\n`;
    execFileSync('python3', ['-c', `import zipfile,sys\nz=zipfile.ZipFile(sys.argv[1],'w',zipfile.ZIP_DEFLATED)\nz.writestr('__MACOSX/._x.srt','junk')\nz.writestr('Show/Show - 01.srt',sys.argv[2])\nz.writestr('Show/Show - 02.srt',sys.argv[3])\nz.close()`, path.join(MEDIA, 'pack.zip'), srt('Zip one'), srt('Zip two')]);
    const gz = require('node:zlib').gzipSync(srt('Gzipped line'));
    await p.keyboard.press('Escape').catch(() => {}); await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
    const shown = async () => { await seek(2); await p.waitForTimeout(400); return p.$eval('.kt-subs', (e) => e.textContent); };
    const pick = async (name, buffer) => { await p.click('.kt-top button[aria-label="Subtitles"]'); await p.waitForSelector('.sheet input[type=file]', { state: 'attached' }); await p.setInputFiles('.sheet input[type=file]', { name, mimeType: 'application/octet-stream', buffer }); await p.waitForTimeout(600); await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); };
    check('the phone\'s file picker is not limited to types it cannot name (.ass)', await (async () => { await p.click('.kt-top button[aria-label="Subtitles"]'); await p.waitForSelector('.sheet input[type=file]', { state: 'attached' }); const a = await p.$eval('.sheet input[type=file]', (e) => e.getAttribute('accept')); await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); return a === null; })());
    await pick('pack.zip', fs.readFileSync(path.join(MEDIA, 'pack.zip')));
    const z = await shown(); console.log('zip:', z); check('a .zip: its subtitle loaded and shown', /Zip (one|two)/.test(z));
    const names = await (async () => { await p.click('.kt-top button[aria-label="Subtitles"]'); await p.waitForSelector('.sheet .dest-row'); const n = await p.$$eval('.sheet .dest-row .name', (e) => e.map((x) => x.textContent)); await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); return n; })();
    check('a .zip: every subtitle in it a track, no Mac junk', names.includes('Show - 01.srt') && names.includes('Show - 02.srt') && !names.some((x) => /^\._/.test(x)));
    await pick('x.srt.gz', gz); check('a .gz: unpacked and shown', /Gzipped line/.test(await shown()));
    await p.evaluate((text) => { const dt = new DataTransfer(); dt.items.add(new File([text], 'dropped.srt')); const root = document.querySelector('.kt-player'); root.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true })); root.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); }, srt('Dropped line'));
    await p.click('.kt-top button[aria-label="Subtitles"]'); await p.click('.sheet button:has-text("Find subtitles")'); await p.waitForTimeout(400);
    check('search without subtitle sites: says so, with a way to add them', await p.isVisible('.sheet button:has-text("Add subtitle sites")'));
    await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
    await p.waitForTimeout(500); check('a subtitle dropped on the player: shown', /Dropped line/.test(await shown()));
  }
  {
    // The main subtitle font: a font file added from the subtitle style, chosen at once, the plain lines drawn in it.
    { await seek(2); await p.waitForTimeout(300); const f0 = await p.$eval('.kt-subs .kt-cue', (c) => getComputedStyle(c).fontFamily).catch(() => ''); check('with no font chosen, Arabic letters in Uthman Taha Naskh (Latin in the regular font)', /KT Uthman/.test(f0) && /KT Uthman.*(Inter|system-ui|sans)/.test(f0), f0); }
    await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
    await p.click('.kt-top button[aria-label="Subtitles"]'); await p.click('.sheet .sub-font-btn'); await p.waitForSelector('.sheet .sub-font-row');
    check('the font sheet: the system font first, chosen', await p.$eval('.sheet .sub-font-row', (e) => e.classList.contains('on')));
    await p.setInputFiles('.sheet input[type=file]', path.join(__dirname, 'fixtures', 'Caladea-Bold.ttf')); await p.waitForTimeout(800);
    const fam = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.player.prefs') || localStorage.getItem('kt.playerPrefs') || '{}').subFont ?? null);
    const css = await p.evaluate(() => getComputedStyle(document.querySelector('.kt-player')).getPropertyValue('--sub-font'));
    check('a font file added from the player becomes the subtitle font', /Caladea/.test(css), { fam, css });
    check('…loaded into the page', await p.evaluate(() => document.fonts.check('16px "Caladea"') && [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Caladea' && f.status === 'loaded')));
    check('…listed and chosen in the sheet', await p.$$eval('.sheet .sub-font-row', (rs) => rs.some((r) => r.classList.contains('on') && /Caladea/.test(r.textContent))));
    await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
    const ff = await (async () => { await seek(2); await p.waitForTimeout(400); return p.$eval('.kt-subs .kt-cue', (c) => getComputedStyle(c).fontFamily).catch(() => ''); })();
    check('the plain lines drawn in it', /Caladea/.test(ff), ff);
  }
  check('no page errors', !errors.length);
  await br.close(); web.close(); fs.rmSync(MEDIA, { recursive: true, force: true });
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
