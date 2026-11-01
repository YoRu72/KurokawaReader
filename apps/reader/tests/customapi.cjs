// node tests/customapi.cjs: custom APIs in the AI translator's settings (services answered by stubs). An
// OpenRouter key is known by its form and its models listed — free ones first, prices and token limits shown; a
// key whose form fits several services (sk-…) is sent to none until one is picked (DeepSeek here); the API is
// tried, kept and used, and its tokens counted. OpenCode Zen is among the providers.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
(async () => {
  await new Promise((r) => server.listen(0, r)); const port = server.address().port;
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 420, height: 900 }, locale: 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message)); const hits = [];
  await p.route('**/*', (r) => {
    const u = r.request().url(); if (r.request().method() === 'OPTIONS' && !u.includes('127.0.0.1')) return r.fulfill({ status: 204, headers: cors });
    if (u === 'https://openrouter.ai/api/v1/models') { hits.push('openrouter'); return r.fulfill({ headers: cors, json: { data: [{ id: 'x-ai/grok-4', name: 'Grok 4', context_length: 256000, pricing: { prompt: '0.000003', completion: '0.000015' }, top_provider: { max_completion_tokens: 64000 } }, { id: 'deepseek/deepseek-chat:free', name: 'DeepSeek V3 (free)', context_length: 163840, pricing: { prompt: '0', completion: '0' } }, { id: 'openai/text-embedding-3', architecture: { modality: 'embedding' } }] } }); }
    if (u.startsWith('https://api.openai.com/')) { hits.push('openai'); return r.fulfill({ status: 401, headers: cors, body: '{}' }); }
    if (u === 'https://api.deepseek.com/v1/models') { hits.push('deepseek'); return r.fulfill({ headers: cors, json: { object: 'list', data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-reasoner', object: 'model' }] } }); }
    if (u === 'https://api.deepseek.com/v1/chat/completions') { const body = JSON.parse(r.request().postData()); hits.push('chat:' + body.model); return r.fulfill({ headers: cors, json: { choices: [{ message: { content: /JSON array/.test(body.messages[0].content) ? JSON.stringify(JSON.parse(body.messages[1].content).map((x) => `DS(${x})`)) : 'OK' } }], usage: { prompt_tokens: 120, completion_tokens: 30 } } }); }
    return r.fallback();
  });
  await p.goto(`http://127.0.0.1:${port}/`);
  await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); });
  await p.reload(); await p.waitForSelector('.library-view');
  // The AI settings, reached as the translator's settings are: the module's own sheet, opened from Settings.
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(1200);
  await p.evaluate(() => { const h = [...document.querySelectorAll('h3')].find((x) => /AI/.test(x.textContent)); if (h && h.closest('.card')?.classList.contains('collapsed')) h.click(); }); await p.waitForTimeout(200);
  await p.locator('button', { hasText: 'Provider, key, model, instructions' }).first().click();
  await p.waitForSelector('.sheet .pick-btn', { timeout: 8000 });
  const provField = p.locator('.sheet .field', { hasText: 'Provider' }).first();
  await provField.locator('.pick-btn').click(); const provs = await p.$$eval('.sheet:last-of-type .dest-row, .pick-sheet .dest-row', (e) => e.map((x) => x.textContent.trim()));
  console.log('providers:', provs.join(' | ')); ok('OpenCode Zen and custom APIs among the providers', provs.some((x) => /OpenCode Zen/.test(x)) && provs.some((x) => /Custom APIs/.test(x)));
  await p.locator('.dest-row', { hasText: 'Custom APIs' }).last().click(); await p.waitForSelector('.custom-apis:not([hidden])');
  // An OpenRouter key: known by its form, its models with prices, free ones first, token limits.
  await p.locator('.custom-apis button', { hasText: 'Add an API' }).click(); await p.fill('.sheet:last-of-type input[type=password]', 'sk-or-v1-abcdef'); await p.locator('.sheet:last-of-type button', { hasText: 'Detect' }).click();
  await p.waitForSelector('.api-model', { timeout: 8000 });
  const models = await p.$$eval('.api-model', (e) => e.map((x) => x.innerText.replace(/\s+/g, ' '))); console.log('models:', models.join(' | '));
  ok('OpenRouter told by its key', /OpenRouter/.test(await p.$eval('.api-service', (e) => e.textContent)));
  ok('free first, with prices and token limits; embeddings left out', models.length === 2 && /deepseek-chat:free/.test(models[0]) && /Free/.test(models[0]) && /\$3\.00 \/ \$15/.test(models[1]) && /256K in/.test(models[1]) && /64K out/.test(models[1]));
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  // A key of the form several use: none asked until one is picked.
  await p.locator('.custom-apis button', { hasText: 'Add an API' }).click(); const before = hits.length;
  await p.fill('.sheet:last-of-type input[type=password]', 'sk-0123456789abcdef0123456789abcdef'); await p.locator('.sheet:last-of-type button', { hasText: 'Detect' }).click(); await p.waitForTimeout(300);
  const chips = await p.$$eval('.api-found .chip', (e) => e.map((x) => x.textContent)); console.log('which:', chips.join(' | '));
  ok('an ambiguous key sent nowhere until a service is picked', chips.length >= 2 && chips.includes('DeepSeek') && hits.length === before);
  await p.locator('.api-found .chip', { hasText: 'DeepSeek' }).click(); await p.waitForSelector('.api-model');
  ok('only DeepSeek asked', hits.slice(before).join() === 'deepseek');
  await p.locator('.api-model', { hasText: 'deepseek-chat' }).click(); await p.locator('.sheet:last-of-type button', { hasText: 'Try it' }).click();
  await p.waitForFunction(() => /It works/.test([...document.querySelectorAll('.sheet')].pop().textContent), null, { timeout: 8000 });
  ok('tried: it answers', true);
  await p.locator('.sheet:last-of-type button', { hasText: 'Save' }).click(); await p.waitForTimeout(300);
  const st = await p.evaluate(() => JSON.parse(localStorage.getItem('kr.visual'))); console.log('kept:', JSON.stringify(st.aiCustomApis.map((x) => [x.name, x.model, x.style, x.base])), st.aiProvider);
  ok('kept and in use', st.aiProvider === 'custom' && st.aiCustomApis.length === 1 && st.aiCustomApis[0].model === 'deepseek-chat' && st.aiCustomApis[0].base === 'https://api.deepseek.com/v1');
  const card = await p.$eval('.api-card', (e) => e.innerText.replace(/\s+/g, ' ')); console.log('card:', card);
  ok('its use counted: requests and tokens today', /requests 1/.test(card) && /tokens in 120/.test(card));
  ok('no page errors', !errors.length); if (errors.length) console.log(errors);
  await b.close(); server.close();
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
