// node tests/localtranslate.cjs [shots dir]: TranslateGemma and the light Gemma (src/translategemma.ts, src/localai.ts,
// src/ui/aisettings.ts, src/ai.ts), against a stand-in local server answered here (no network):
//  1. the prompt builder: ja→ar, en→ar and «auto» (the source read from the text) give the exact format;
//  2. the catalogue: Gemma 3 1B (chat 'gemma'); TranslateGemma 4B not on the device (a 2.49 GB file); the order
//     differs on a phone (Gemma 3 1B first) and on a computer (Gemma 2 2B, then Gemma 3 1B);
//  3. the server's tasks: translation → TranslateGemma; another task never goes to it (the main model, or a clear
//     refusal when it is the only model);
//  4. the settings: the server lists it → marked «Recommended for translation», first, and chosen; the translation
//     request is the one user message, the reply taken as is; none installed → the hint with `translategemma:4b`.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const esbuild = require(path.resolve(__dirname, '../node_modules/esbuild'));
const run = (file, mocks) => { const src = esbuild.transformSync(fs.readFileSync(path.resolve(__dirname, '../src', file), 'utf8'), { loader: 'ts', format: 'cjs', target: 'es2020' }).code; const module = { exports: {} }; new Function('require', 'exports', 'module', src)((n) => { if (mocks && n in mocks) return mocks[n]; throw new Error('no ' + n); }, module.exports, module); return module.exports; };
const TG = run('translategemma.ts');
const exact = (S, SC, T, TC, text) => `You are a professional ${S} (${SC}) to ${T} (${TC}) translator. Your goal is to accurately convey the meaning and nuances of the original ${S} text while adhering to ${T} grammar, vocabulary, and cultural sensitivities.\nProduce only the ${T} translation, without any additional explanations or commentary. Please translate the following ${S} text into ${T}:\n\n\n${text}`;
ok('prompt ja→ar', TG.translateGemmaPrompt('猫がいる。', 'ja', 'ar') === exact('Japanese', 'ja', 'Arabic', 'ar', '猫がいる。'));
ok('prompt en→ar', TG.translateGemmaPrompt('The book.', 'en', 'ar') === exact('English', 'en', 'Arabic', 'ar', 'The book.'));
ok('prompt auto (kana) → ja', TG.translateGemmaPrompt('これは本です', 'auto', 'ar') === exact('Japanese', 'ja', 'Arabic', 'ar', 'これは本です'));
ok('prompt auto (Latin) → en', TG.translateGemmaPrompt('Hello', 'auto', 'ar') === exact('English', 'en', 'Arabic', 'ar', 'Hello'));
ok('prompt auto (Arabic) → ar, to en', TG.translateGemmaPrompt('مرحبا', '', 'en') === exact('Arabic', 'ar', 'English', 'en', 'مرحبا'));
const body = TG.translateGemmaBody('translategemma:4b', 'Hi', 'auto', 'ar');
ok('body: one user message, no system', body.messages.length === 1 && body.messages[0].role === 'user' && body.model === 'translategemma:4b');
ok('name match', TG.isTranslateGemma('translategemma:4b') && TG.isTranslateGemma('library/TranslateGemma:12b') && !TG.isTranslateGemma('gemma2:2b'));
ok('pick: translategemma first', TG.pickTranslationModel(['llama3:8b', 'translategemma:12b']) === 'translategemma:12b' && TG.pickTranslationModel(['llama3:8b']) === '');
// The catalogue and the order.
const src = fs.readFileSync(path.resolve(__dirname, '../src/localai.ts'), 'utf8');
const row = /\{ id: 'gemma-3-1b'[^}]*\}/.exec(src)?.[0] || '';
ok('catalogue: Gemma 3 1B, 806 MB, chat gemma', /sizeMB: 806/.test(row) && /chat: 'gemma'/.test(row) && /ggml-org\/gemma-3-1b-it-GGUF/.test(row) && /gemma-3-1b-it-Q4_K_M\.gguf/.test(row) && /ram: '2 GB'/.test(row), row);
ok('catalogue: no TranslateGemma on the device', !/id: 'translategemma/.test(src));
const ids = [{ id: 'qwen2.5-0.5b' }, { id: 'qwen2.5-3b' }, { id: 'gemma-3-1b' }, { id: 'gemma-2-2b' }];
ok('order on a phone: no Gemma 3 1B, the list as it is, nothing recommended', TG.deviceOrder(ids, true).map((x) => x.id).join() === 'qwen2.5-0.5b,qwen2.5-3b,gemma-2-2b' && TG.recommendedDevice(true) === '', TG.deviceOrder(ids, true));
ok('recommended on a computer: Gemma 2 2B', TG.recommendedDevice(false) === 'gemma-2-2b');
ok('order on a computer: Gemma 2 2B, Gemma 3 1B', TG.deviceOrder(ids, false).map((x) => x.id).join() === 'gemma-2-2b,gemma-3-1b,qwen2.5-0.5b,qwen2.5-3b');

// The server's tasks (localai.ts run here with a stand-in settings store and server).
const seen = []; let models = ['llama3:8b', 'translategemma:4b'];
global.window = {}; global.navigator = { userAgent: 'x' };
global.fetch = async (url, init) => { if (/\/models$/.test(url)) return { status: 200, text: async () => JSON.stringify({ data: models.map((id) => ({ id })) }) }; const b = JSON.parse(init.body); seen.push(b); return { status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '  رد  ' } }] }) }; };
let S = { localServer: 'http://x/v1', localServerModel: '', localTranslateModel: '' };
const L = run('localai.ts', { './settings': { getSettings: () => S, updateSettings: (o) => { S = { ...S, ...o }; } }, './i18n': { t: (k) => k }, './translategemma': TG });
(async () => {
  ok('translation model: TranslateGemma when listed', await L.translationModel() === 'translategemma:4b');
  S.localServerModel = 'llama3:8b'; ok('translation model: still TranslateGemma with another main model', await L.translationModel() === 'translategemma:4b');
  S.localTranslateModel = 'llama3:8b'; ok("translation model: the reader's own choice wins", await L.translationModel() === 'llama3:8b'); S.localTranslateModel = '';
  models = ['llama3:8b']; ok('no TranslateGemma: the main model translates', await L.translationModel() === 'llama3:8b'); models = ['llama3:8b', 'translategemma:4b'];
  seen.length = 0; S.localServerModel = 'translategemma:4b'; await L.serverChat('sys', 'define this', false, 'other');
  ok('another task (main set to TranslateGemma) goes to the other model', seen.at(-1).model === 'llama3:8b' && seen.at(-1).messages[0].role === 'system', seen.at(-1));
  models = ['translategemma:4b']; S.localServerModel = 'translategemma:4b'; let err = ''; try { await L.serverChat('sys', 'define this', false, 'other'); } catch (e) { err = e.message; }
  ok('another task with only TranslateGemma: refused, never sent', err === 'localTranslateOnly' && seen.length === 1, err);
  S.localServerModel = ''; models = ['llama3:8b', 'translategemma:4b']; seen.length = 0; await L.serverChat('sys', 'summarise', false, 'other');
  ok('another task with no main model chosen: not TranslateGemma', seen[0].model === 'llama3:8b');
  seen.length = 0; const out = await L.serverTranslateGemma('translategemma:4b', 'The book is on the table.', 'ar');
  ok('serverTranslateGemma: exact request, reply trimmed', seen[0].messages.length === 1 && seen[0].messages[0].content === exact('English', 'en', 'Arabic', 'ar', 'The book is on the table.') && out === 'رد', seen[0]);

  // The settings and the translation, in a browser.
  const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.wasm': 'application/wasm' };
  const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('content-type', MIME[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f)); });
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const shots = process.argv[2] || path.join(os.tmpdir(), 'kr-localtranslate'); fs.mkdirSync(shots, { recursive: true });
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'en', colorScheme: 'dark' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  let list = ['llama3:8b', 'translategemma:4b']; const asked = []; const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'POST, GET', 'content-type': 'application/json' };
  await p.route('https://ai.test/**', async (r) => {
    const req = r.request(); if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    if (/\/models$/.test(req.url())) return r.fulfill({ headers: CORS, body: JSON.stringify({ data: list.map((id) => ({ id })) }) });
    asked.push(JSON.parse(req.postData())); await r.fulfill({ headers: CORS, body: JSON.stringify({ choices: [{ message: { content: '  الكتاب على الطاولة.  ' } }] }) });
  });
  const setVisual = (o) => p.evaluate((o) => { const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, o); localStorage.setItem('kr.visual', JSON.stringify(v)); }, o);
  await p.goto(`http://localhost:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); });
  const open = async () => { await p.evaluate(() => { location.hash = '#/'; }); await p.reload(); await p.waitForSelector('.library-view'); await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { state: 'attached' });
    await p.evaluate(() => { [...document.querySelectorAll('.settings-body button')].find((x) => /Provider, key, model, instructions/.test(x.textContent)).click(); });
    await p.waitForSelector('[data-translate-model] button', { state: 'attached', timeout: 15000 }); await p.waitForTimeout(800); await p.evaluate(() => document.querySelector('[data-translate-model]').scrollIntoView({ block: 'center' })); await p.waitForTimeout(400); };
  const closeSheets = () => p.evaluate(() => document.querySelectorAll('.sheet').forEach((x) => x.remove()));
  await setVisual({ aiProvider: 'local', localEngine: 'server', localServer: 'https://ai.test/v1', localServerModel: 'llama3:8b', aiTarget: 'ar', aiTask: 'translate', aiPrefetch: false });
  await open();
  const label = await p.textContent('[data-translate-model] button');
  ok('settings: TranslateGemma shown as the translation model, recommended', /translategemma:4b/.test(label) && /Recommended for translation/.test(label), label);
  ok('settings: no pull hint when installed', !(await p.$('[data-pull-hint]')));
  await p.click('[data-translate-model] button'); await p.waitForSelector('.dest-row');
  const rows = await p.$$eval('.dest-row', (e) => e.map((x) => x.textContent.trim()));
  ok('the choice: Automatic, then TranslateGemma first and marked', rows[0] === 'Automatic' && /^translategemma:4b · Recommended for translation$/.test(rows[1]) && rows[2] === 'llama3:8b', rows);
  await p.click('.dest-row >> nth=0'); await p.waitForTimeout(400);
  await p.evaluate(() => { const bt = [...document.querySelectorAll('.local-ai .tool-bar button')].find((x) => /Try it/.test(x.textContent)); bt.click(); });
  await p.waitForFunction(() => /الكتاب/.test(document.body.textContent), null, { timeout: 15000 }).catch(() => {});
  const tr = asked.at(-1);
  ok('Try it: the request is one user message in the exact format', !!tr && tr.model === 'translategemma:4b' && tr.messages.length === 1 && tr.messages[0].role === 'user' && tr.messages[0].content === exact('English', 'en', 'Arabic', 'ar', 'The book is on the table.'), tr);
  ok('Try it: the reply shown without its surrounding spaces', /الكتاب على الطاولة\./.test(await p.evaluate(() => document.body.textContent)));
  // None installed: the hint.
  list = ['llama3:8b']; await open();
  const hint = await p.textContent('[data-pull-hint]').catch(() => '');
  ok('no TranslateGemma: the hint names translategemma:4b (and :12b)', /translategemma:4b/.test(hint) && /translategemma:12b/.test(hint), hint);
  ok('no TranslateGemma: not recommended', !/Recommended for translation/.test(await p.textContent('[data-translate-model] button')));
  await p.screenshot({ path: path.join(shots, 'R7-ai-settings.png') });
  // On-device list: a phone (this context): no Gemma 3 1B, nothing recommended, the quiet line shown; then a computer.
  await setVisual({ localEngine: 'device' }); await p.evaluate(() => { location.hash = '#/'; }); await p.reload(); await p.waitForSelector('.library-view'); await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { state: 'attached' }); await p.evaluate(() => { [...document.querySelectorAll('.settings-body button')].find((x) => /Provider, key, model, instructions/.test(x.textContent)).click(); }); await p.waitForSelector('.local-models .local-row', { state: 'attached', timeout: 15000 });
  const names = await p.$$eval('.local-models .local-row .local-name b', (e) => e.map((x) => x.textContent));
  ok('on-device list (phone): no Gemma 3 1B, no TranslateGemma', !names.some((n) => /Gemma 3 1B|TranslateGemma/i.test(n)) && names.length > 0, names);
  ok('on-device (phone): no Recommended for translation mark', (await p.$$eval('.local-models .chip', (e) => e.filter((x) => /Recommended for translation/.test(x.textContent)).length)) === 0 && !/Recommended for translation/.test(await p.$eval('.local-models', (e) => e.textContent)));
  ok('on-device (phone): the quiet line is shown', /computer or an online provider/.test(await p.textContent('.local-phone-note').catch(() => '')));
  await p.screenshot({ path: path.join(shots, 'R9-phone-device-models.png') });
  // A computer: Gemma 2 2B recommended, Gemma 3 1B present, no phone line.
  const pc = await (await b.newContext({ viewport: { width: 1280, height: 800 }, locale: 'en', colorScheme: 'dark' })).newPage();
  pc.on('pageerror', (e) => errors.push(e.message));
  await pc.goto(`http://localhost:${port}/`); await pc.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); const v = JSON.parse(localStorage.getItem('kr.visual') || '{}'); Object.assign(v, { aiProvider: 'local', localEngine: 'device' }); localStorage.setItem('kr.visual', JSON.stringify(v)); });
  await pc.reload(); await pc.waitForSelector('.library-view'); await pc.evaluate(() => { location.hash = '#/settings'; }); await pc.waitForSelector('.settings-body .card', { state: 'attached' });
  await pc.evaluate(() => { [...document.querySelectorAll('.settings-body button')].find((x) => /Provider, key, model, instructions/.test(x.textContent)).click(); }); await pc.waitForSelector('.local-models .local-row', { state: 'attached', timeout: 15000 });
  const pcNames = await pc.$$eval('.local-models .local-row .local-name b', (e) => e.map((x) => x.textContent));
  const pcRec = await pc.$$eval('.local-models .local-row', (e) => e.filter((x) => /Recommended for translation/.test(x.textContent)).map((x) => x.querySelector('b').textContent));
  ok('on-device (computer): Gemma 2 2B first and recommended, Gemma 3 1B present', pcNames[0] === 'Gemma 2 2B Instruct' && pcNames.includes('Gemma 3 1B Instruct') && pcRec.join() === 'Gemma 2 2B Instruct', { pcNames, pcRec });
  ok('on-device (computer): no phone line', !(await pc.$('.local-phone-note')));
  ok('no page errors', !errors.length, errors);
  await b.close(); server.close(); console.log(fails ? `${fails} FAILED` : 'all ok'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
