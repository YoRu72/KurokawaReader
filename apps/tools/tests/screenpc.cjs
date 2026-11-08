// Translate on screen on a computer (the desktop bridge faked): the shortcuts turned on and set by pressing keys,
// a shortcut another app holds said; the tray and starting with the computer; reading by the computer's OCR or by
// AI. Then the windows over the screen: a region drawn on the frozen screen, its lines translated (Google answered
// here) and drawn over the words on the colour around them, copied with a click, closed with Esc; «auto»'s caption
// translated; the clipboard's text translated by the mouse. And the OCR results read: Tesseract's TSV, Windows'
// and macOS's JSON.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const Module = require('node:module');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const errors = []; const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
// The OCR readers (desktop/screentr.cjs with Electron faked).
{ const load = Module._load; Module._load = function (req, ...a) { if (req === 'electron') return new Proxy({}, { get: () => function () { return {}; } }); return load.call(this, req, ...a); };
  const S = require('../desktop/screentr.cjs'); Module._load = load;
  const tsv = 'level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n5\t1\t1\t1\t1\t1\t10\t20\t40\t12\t91\tHello\n5\t1\t1\t1\t1\t2\t55\t21\t50\t12\t88\tworld\n5\t1\t1\t1\t2\t1\t10\t40\t30\t12\t20\tnoise\n5\t1\t2\t1\t1\t1\t100\t200\t60\t14\t95\tExit\n';
  const l = S.tsvLines(tsv); console.log('tesseract lines:', JSON.stringify(l));
  check('Tesseract: words joined into lines with their box; unsure words left out', l.length === 2 && l[0].text === 'Hello world' && l[0].x === 10 && l[0].width === 95 && l[0].height === 13 && l[1].text === 'Exit');
  check('Windows/macOS JSON read (one line, or many, after any noise)', S.parseLines('warning\n{"text":"A","x":1,"y":2,"width":3,"height":4}').length === 1 && S.parseLines('[{"text":"A"},{"text":" "},{"text":"B"}]').length === 2 && S.parseLines('nothing').length === 0);
  check('default shortcuts', S.DEFAULT_KEYS.region === 'Alt+Shift+T' && S.DEFAULT_KEYS.clipboard === 'Alt+Shift+C'); }
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch();
  const bridge = (lang) => {
    localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['screen'] }));
    window.__calls = []; let on = false; let keys = {};
    const status = () => ({ platform: 'win32', on, keys: Object.fromEntries(Object.entries({ region: 'Alt+Shift+T', full: 'Alt+Shift+F', repeat: 'Alt+Shift+R', auto: 'Alt+Shift+A', clipboard: 'Alt+Shift+C', ...keys }).map(([k, v]) => [k, { acc: v, ok: v !== 'Alt+Shift+F' }])), tray: true, auto: false, region: null, ocr: 'windows' });
    const c = document.createElement('canvas'); c.width = 800; c.height = 500; const x = c.getContext('2d'); x.fillStyle = '#ffffff'; x.fillRect(0, 0, 800, 500); x.fillStyle = '#203080'; x.fillRect(100, 100, 300, 60); x.fillStyle = '#fff'; x.font = '30px sans-serif'; x.fillText('Hello there', 120, 140);
    window.__job = { mode: 'region', image: c.toDataURL(), width: 800, height: 500, scale: 1 };
    let capCb = null; window.__caption = (t) => capCb && capCb({ text: t });
    window.kurokawaTools = {
      platform: 'desktop', available: true, reason: '', os: 'win32', ready: async () => {}, list: async () => [], onTasks: () => () => {}, onBrowser: () => () => {}, onUpdateProgress: () => () => {}, onPackProgress: () => () => {}, packStatus: async () => ({}),
      http: async (o) => { window.__calls.push(['http', o.url]); const q = new URL(o.url).searchParams.get('q'); return { status: 200, headers: {}, body: JSON.stringify([[['TR(' + q + ')', q]], null, 'en']) }; },
      screenStatus: async () => status(),
      screenConfig: async (o) => { window.__calls.push(['config', o.config]); on = !!o.config.pcOn; keys = o.config.pc?.keys ?? {}; return status(); },
      screenAction: async (a) => { window.__calls.push(['action', a]); },
      screenJob: async () => window.__job,
      screenRegion: async (r) => { window.__calls.push(['region', r]); return { blocks: [{ text: 'Hello there', x: 105, y: 110, width: 280, height: 40 }, { text: '42', x: 10, y: 10, width: 20, height: 10 }] }; },
      screenClose: async () => { window.__calls.push(['close']); },
      screenCaptionSize: async () => {}, onScreenCaption: (cb) => { capCb = cb; return () => {}; },
    };
  };
  const ctx = await br.newContext({ viewport: { width: 1000, height: 760 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(bridge, lang);
  const calls = () => p.evaluate(() => window.__calls); const lastCfg = async () => (await calls()).filter((x) => x[0] === 'config').pop()?.[1];
  await p.goto(`http://127.0.0.1:${port}/#/screen`); await p.waitForSelector('#scr-keys input[name="key-region"]');
  check('a computer: shortcuts, background, no bubble or Android steps', !!(await p.$('#scr-bg')) && !(await p.$('#scr-bubble')) && !(await p.$('.screen-step[data-step="overlay"]')));
  check('the computer\'s OCR named', !!(await p.$('.screen-step[data-step="ocr"].done')));
  await p.click('.screen-go'); await p.waitForTimeout(500);
  check('turned on: the shortcuts and the tray sent', (await lastCfg())?.pcOn === true && (await lastCfg())?.pc?.tray === true && (await lastCfg())?.pc?.keys?.region === 'Alt+Shift+T');
  check('a shortcut another app holds said', !!(await p.$('.screen-step[data-step="key-full"]')));
  await p.click('input[name="key-region"]'); await p.keyboard.press('Control+Alt+KeyK'); await p.waitForTimeout(400);
  check('a shortcut set by pressing keys', (await lastCfg())?.pc?.keys?.region === 'Control+Alt+K' && (await p.inputValue('input[name="key-region"]')) === 'Control+Alt+K');
  await p.click('input[name="key-clipboard"]'); await p.keyboard.press('Shift'); await p.keyboard.press('KeyQ'); await p.waitForTimeout(300);
  check('a key without a modifier not taken', (await lastCfg())?.pc?.keys?.clipboard === 'Alt+Shift+C');
  await p.locator('#scr-bg .switch-row', { hasText: lang === 'ar' ? 'ابدأ مع الحاسوب' : 'Start with the computer' }).locator('input').check(); await p.waitForTimeout(400);
  check('start with the computer', (await lastCfg())?.pc?.startup === true);
  await p.click('[data-name="ocr"] [data-v="ai"]'); await p.waitForTimeout(400);
  check('read by AI', (await lastCfg())?.pc?.ocr === 'ai');
  await p.click('[data-name="ocr"] [data-v="system"]'); await p.waitForTimeout(400);
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth); check('no sideways overflow', over <= 1);
  await p.screenshot({ path: path.join(__dirname, `shot-screenpc-${lang}.png`) });
  // The frozen screen: a region drawn.
  const o = await ctx.newPage(); o.on('pageerror', (e) => errors.push(e.message)); await o.addInitScript(bridge, lang); await o.setViewportSize({ width: 800, height: 500 });
  await o.goto(`http://127.0.0.1:${port}/#/overlay`); await o.waitForSelector('.kt-ov-shot');
  await o.mouse.move(90, 90); await o.mouse.down(); await o.mouse.move(300, 150, { steps: 4 }); await o.mouse.move(420, 180, { steps: 4 }); await o.mouse.up();
  await o.waitForSelector('.kt-ov-box', { timeout: 8000 });
  const oc = await o.evaluate(() => window.__calls); const reg = oc.find((x) => x[0] === 'region');
  check('the region drawn sent (in screen pixels)', reg && reg[1].x === 90 && reg[1].y === 90 && reg[1].width === 330 && reg[1].height === 90);
  const box = await o.$eval('.kt-ov-box', (e) => ({ text: e.textContent, left: e.style.left, top: e.style.top, bg: getComputedStyle(e).backgroundColor, img: getComputedStyle(e).backgroundImage.slice(0, 30), erased: e.classList.contains('erased'), color: getComputedStyle(e).color }));
  console.log('box:', JSON.stringify(box));
  check('translated, over the words', box.text === 'TR(Hello there)' && box.left === '105px' && box.top === '110px');
  check('on the picture behind with the words taken off (dark blue: white text)', box.erased && /^url\("data:image\/png/.test(box.img) && box.color === 'rgb(255, 255, 255)');
  check('lines without letters not sent to the translator', !oc.some((x) => x[0] === 'http' && /q=42/.test(x[1])));
  await o.click('.kt-ov-box'); check('a click on a translation copies it', await o.$eval('.kt-ov-box', (e) => e.classList.contains('copied')));
  await o.keyboard.press('Escape'); await o.waitForTimeout(200);
  check('Esc closes it', (await o.evaluate(() => window.__calls)).some((x) => x[0] === 'close'));
  // Auto's caption.
  const cap = await ctx.newPage(); cap.on('pageerror', (e) => errors.push(e.message)); await cap.addInitScript(bridge, lang);
  await cap.goto(`http://127.0.0.1:${port}/#/overlay?caption=1`); await cap.waitForSelector('.kt-ov-cap', { state: 'attached' });
  await cap.evaluate(() => window.__caption('Where are you\ngoing?')); await cap.waitForFunction(() => /TR\(/.test(document.querySelector('.kt-ov-cap').textContent));
  check('auto: the watched region\'s text translated in its caption (lines joined)', (await cap.textContent('.kt-ov-cap')) === 'TR(Where are you going?)');
  // The clipboard.
  const pop = await ctx.newPage(); pop.on('pageerror', (e) => errors.push(e.message)); await pop.addInitScript(bridge, lang); await pop.addInitScript(() => { window.__job = { mode: 'text', text: 'Good night' }; });
  await pop.goto(`http://127.0.0.1:${port}/#/overlay?text=1`); await pop.waitForFunction(() => /TR\(/.test(document.querySelector('.kt-ov-tr')?.textContent || ''));
  check('the clipboard translated by the mouse', (await pop.textContent('.kt-ov-tr')) === 'TR(Good night)' && /Good night/.test(await pop.textContent('.kt-ov-orig')));
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
