// Translate on screen (the add-on's page; the Android plugin faked): what Android must allow shown and asked for;
// the bubble not started without permission to appear on top, nor without the chosen translator's key; started
// with the settings and the bubble's words in the app's language; DeepL's key and the AI's service, model and
// address (a custom API's own); «Try» translating through the phone; the history listed and cleared; the + menu
// and Settings leading to it; nothing of it away from Android; no overflow on a small phone in Arabic.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const stub = (lang) => {
    localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['screen'] }));
    window.__calls = []; window.__st = { overlay: false, a11y: false, running: false, capture: false, notify: true, battery: false, tile: true };
    const api = {
      addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }),
      screenStatus: async () => ({ ...window.__st }),
      screenPermission: async (o) => { window.__calls.push(['perm', o.what]); if (o.what === 'overlay') setTimeout(() => { window.__st.overlay = true; }, 200); },
      screenConfig: async (o) => { window.__calls.push(['config', o.config, !!o.clearFixed]); },
      screenStart: async () => { window.__calls.push(['start']); window.__st.running = true; },
      screenStop: async () => { window.__calls.push(['stop']); window.__st.running = false; },
      screenTranslate: async (o) => { window.__calls.push(['try', o.texts, o.config.engine]); return { texts: o.texts.map((x) => '«' + x + '»→' + o.config.target) }; },
      screenHistory: async (o) => { window.__calls.push(['history', !!o.clear]); if (o.clear) window.__hist = []; return { items: window.__hist ?? [{ o: 'Hello', t: 'مرحبًا', at: Date.now() - 60000 }, { o: 'Exit', t: 'خروج', at: Date.now() - 120000 }] }; },
    };
    const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  };
  const ctx = await br.newContext({ viewport: { width: 360, height: 780 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(stub, lang);
  const calls = () => p.evaluate(() => window.__calls);
  await p.goto(`http://127.0.0.1:${port}/#/screen`); await p.waitForSelector('.screen-step');
  check('what Android must allow: appear on top marked as needed', await p.$eval('.screen-step[data-step="overlay"]', (e) => e.classList.contains('need')));
  check('notifications already allowed: no button', !(await p.$('.screen-step[data-step="app"] .btn')));
  check('the tile offered (Android 13+)', !!(await p.$('.screen-step[data-step="tile"] .btn')));
  // 1. Not allowed to appear on top: not started, asked for.
  await p.click('.screen-go'); await p.waitForTimeout(400);
  let c = await calls(); check('not started without permission to appear on top; its page opened', !c.some((x) => x[0] === 'start') && c.some((x) => x[0] === 'perm' && x[1] === 'overlay'));
  await p.evaluate(() => window.dispatchEvent(new Event('focus'))); await p.waitForTimeout(500);
  check('back from Android: allowed now', await p.$eval('.screen-step[data-step="overlay"]', (e) => e.classList.contains('done')));
  // 2. DeepL without a key: not started; the key field there.
  await p.click('[data-name="engine"] [data-v="deepl"]'); await p.waitForSelector('input[name="deeplKey"]');
  await p.click('.screen-go'); await p.waitForTimeout(300);
  c = await calls(); check('DeepL without a key: not started', !c.some((x) => x[0] === 'start'));
  await p.fill('input[name="deeplKey"]', 'abc:fx'); await p.waitForTimeout(400);
  check('the key kept', JSON.parse(await p.evaluate(() => localStorage.getItem('kt.screen'))).deeplKey === 'abc:fx');
  // 3. Started: the settings and the bubble's words sent first.
  await p.selectOption('select[name="target"]', 'ja'); await p.waitForTimeout(350);
  await p.click('.screen-go'); await p.waitForTimeout(400);
  c = await calls(); const startAt = c.findIndex((x) => x[0] === 'start'); const before = c.slice(0, startAt).filter((x) => x[0] === 'config').pop();
  check('started', startAt >= 0);
  check('with the settings: DeepL, its key, to Japanese', before && before[1].engine === 'deepl' && before[1].deeplKey === 'abc:fx' && before[1].target === 'ja');
  check('with the bubble\'s words in the app\'s language', before && typeof before[1].labels?.translateScreen === 'string' && (lang !== 'ar' || /[؀-ۿ]/.test(before[1].labels.translateScreen)));
  await p.waitForTimeout(700);
  check('the button now closes the bubble', await p.$eval('.screen-go', (e) => e.classList.contains('danger')));
  // 4. AI: a service's address and model filled in; a custom API's own.
  await p.click('[data-name="engine"] [data-v="ai"]'); await p.waitForSelector('select[name="preset"]');
  await p.fill('input[name="aiKey"]', 'K1'); await p.waitForTimeout(400);
  let last = (await calls()).filter((x) => x[0] === 'config').pop()[1];
  check('Gemini: its address, style and model filled in', last.engine === 'ai' && last.ai.style === 'gemini' && /generativelanguage/.test(last.ai.base) && !!last.ai.model && last.ai.key === 'K1');
  await p.selectOption('select[name="preset"]', 'custom'); await p.waitForSelector('input[name="aiBase"]');
  await p.fill('input[name="aiBase"]', 'http://192.168.1.5:11434/v1/'); await p.fill('input[name="aiModel"]', 'qwen3'); await p.selectOption('select[name="aiStyle"]', 'openai'); await p.waitForTimeout(400);
  last = (await calls()).filter((x) => x[0] === 'config').pop()[1];
  check('custom API: its own address (no trailing slash), model and style', last.ai.base === 'http://192.168.1.5:11434/v1' && last.ai.model === 'qwen3' && last.ai.style === 'openai');
  // 5. Try it.
  await p.click('[data-name="engine"] [data-v="google"]'); await p.waitForSelector('.screen-try .btn');
  await p.click('.screen-try .btn'); await p.waitForFunction(() => /→ja/.test(document.querySelector('.screen-try-out')?.textContent || ''));
  check('«Try» translated through the phone', /«.+»→ja/.test(await p.textContent('.screen-try-out')));
  // 6. Reading, auto, look.
  await p.click('[data-name="read"] [data-v="picture"]'); await p.click('[data-name="auto"] [data-v="interval"]'); await p.waitForSelector('input[name="interval"]');
  await p.click('button:has-text("' + (lang === 'ar' ? 'انسَ المنطقة الثابتة' : 'Forget the fixed region') + '")'); await p.waitForTimeout(400);
  c = await calls(); last = c.filter((x) => x[0] === 'config').pop();
  check('read as a picture, auto every few seconds, the fixed region forgotten', last[1].read === 'picture' && last[1].auto === 'interval' && last[2] === true);
  // 7. History.
  check('the history listed', (await p.$$('.screen-hist-item')).length === 2);
  await p.click('#scr-history .btn.danger'); await p.waitForTimeout(300);
  check('the history cleared', (await p.$$('.screen-hist-item')).length === 0 && !!(await p.$('#scr-history .empty')));
  // 8. Small phone, no overflow.
  const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('no sideways overflow at 360 px (' + over + ')', over <= 1);
  await p.screenshot({ path: path.join(__dirname, `shot-screen-${lang}.png`), fullPage: false });
  // 9. Reached from the + menu and from Settings.
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.fab'); await p.click('.fab'); await p.waitForSelector('.fab-item');
  check('the + menu leads to it', !!(await p.$('.fab-item[data-act="translate"]')));
  await p.click('.fab-item[data-act="translate"]'); await p.waitForSelector('.screen-view');
  await p.goto(`http://127.0.0.1:${port}/#/settings/addons`); await p.waitForTimeout(1200);
  check('Settings has its card', !!(await p.$('#screen a[href="#/screen"]')));
  await ctx.close();
  // 10. Away from Android: nothing of it.
  const c2 = await br.newContext({ viewport: { width: 1100, height: 800 } }); const p2 = await c2.newPage(); p2.on('pageerror', (e) => errors.push(e.message));
  await p2.addInitScript((lang) => { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['screen'] })); }, lang);
  await p2.goto(`http://127.0.0.1:${port}/#/screen`); await p2.waitForSelector('.screen-view');
  check('elsewhere: said to be Android\'s, nothing to set', !(await p2.$('.screen-go')) && !!(await p2.$('.screen-body .card p')));
  await p2.goto(`http://127.0.0.1:${port}/#/`); await p2.waitForTimeout(800); const fab = await p2.$('.fab:visible, .rail-fab:visible'); if (fab) { await fab.click(); await p2.waitForTimeout(300); }
  check('elsewhere: not in the + menu', !(await p2.$('.fab-item[data-act="translate"]')));
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
