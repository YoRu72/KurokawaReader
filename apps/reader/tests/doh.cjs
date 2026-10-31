// node tests/doh.cjs: Settings → the app's browser opened as a browser (no address needed), and DNS over HTTPS
// chosen, tested and turned off — through a stand-in for the desktop bridge.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5461, r));
  const b = await chromium.launch(); const p = await (await b.newContext({ viewport: { width: 1100, height: 900 }, locale: process.env.LANG_UI || 'en' })).newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(() => {
    window.__calls = [];
    window.kurokawaDesktop = {
      onOpenFile: () => {},
      openWebView: async (o) => { window.__calls.push(['open', o]); return { passed: true }; },
      browserFetch: async () => ({ status: 200, headers: {}, body: '' }),
      setDoh: async (provider, test) => { window.__calls.push(['doh', provider, test]); return test ? { provider: 'cloudflare', ok: true, ms: 42 } : { provider }; },
    };
  });
  await p.goto('http://localhost:5461/'); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }, process.env.LANG_UI || 'en'); await p.reload();
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(1200);
  await p.locator('h3.card-title').filter({ hasText: /In-app browser|متصفح التطبيق/ }).first().click(); await p.waitForTimeout(300);
  const btn = p.locator('button:has-text("Open the browser"), button:has-text("افتح المتصفح")').first();
  await btn.scrollIntoViewIfNeeded(); await btn.click(); await p.waitForTimeout(300);
  const open = await p.evaluate(() => window.__calls.find((c) => c[0] === 'open')?.[1]);
  ok('the browser opens on a start page, as a browser', !!open && open.browse === true && /^https:\/\//.test(open.url) && open.stay === true);
  const field = p.locator('.field').filter({ has: p.locator('.pick-btn') }).filter({ hasText: 'DNS' });
  ok('the DoH field is there', await field.count() > 0);
  await field.locator('.pick-btn').click(); await p.waitForTimeout(300);
  await p.locator('label.dest-row').filter({ hasText: 'Cloudflare' }).click(); await p.waitForTimeout(300);
  ok('a provider chosen reaches the app', await p.evaluate(() => window.__calls.some((c) => c[0] === 'doh' && c[1] === 'cloudflare')) && await p.evaluate(() => localStorage.getItem('kr.doh')) === 'cloudflare');
  await field.locator('button:has-text("Test"), button:has-text("اختبره")').click(); await p.waitForTimeout(400);
  const st = await field.locator('.hint').last().textContent();
  ok('the test says it works', /42|٤٢/.test(st));
  await field.locator('.pick-btn').click(); await p.waitForTimeout(300);
  await p.locator('label.dest-row').filter({ hasText: /Another resolver|خادم آخر/ }).click(); await p.waitForTimeout(300);
  const inp = field.locator('input[type=url]'); ok('a resolver of one\'s own can be given', await inp.isVisible());
  await inp.fill('https://dns.example/dns-query'); await field.locator('button:has-text("Save"), button:has-text("حفظ")').first().click(); await p.waitForTimeout(300);
  ok('…and is set', await p.evaluate(() => window.__calls.some((c) => c[0] === 'doh' && c[1] === 'https://dns.example/dns-query')));
  await field.scrollIntoViewIfNeeded(); await p.screenshot({ path: path.join(process.env.OUT || '/tmp', 'doh.png') });
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
