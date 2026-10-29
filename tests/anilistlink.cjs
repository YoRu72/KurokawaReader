// node tests/anilistlink.cjs: AniList linked without copying a token — the sign-in opened in the app's browser
// (a stand-in for the desktop bridge) closes on the page holding the token, and the account is linked.
const { chromium } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path');
const DIST = path.resolve(__dirname, '../dist'); const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c) => { console.log((c ? 'ok   ' : 'FAIL ') + n); if (!c) fails++; };
(async () => {
  await new Promise((r) => server.listen(5464, r));
  const b = await chromium.launch(); const ctx = await b.newContext({ viewport: { width: 1000, height: 900 }, locale: 'en' }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  let auth = '';
  await p.addInitScript(() => {
    window.__opened = [];
    window.kurokawaDesktop = {
      onOpenFile: () => {},
      browserFetch: async () => ({ status: 200, headers: {}, body: '' }),
      openWebView: async (o) => { window.__opened.push(o); return o.until ? { passed: true, url: 'https://anilist.co/api/v2/oauth/pin#access_token=TOKEN123&token_type=Bearer&expires_in=31536000' } : { passed: true }; },
      http: async (o) => { const r = await fetch(o.url, { method: o.method, headers: o.headers, body: o.body }); return { status: r.status, headers: {}, body: await r.text() }; },
    };
  });
  await ctx.route('https://graphql.anilist.co/**', async (route) => { auth = route.request().headers().authorization || ''; return route.fulfill({ status: 200, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }, body: JSON.stringify({ data: { Viewer: { id: 7, name: 'Reader', avatar: { medium: '' }, mediaListOptions: { scoreFormat: 'POINT_10' } } } }) }); });
  await p.goto('http://localhost:5464/'); await p.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await p.reload();
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('section.card h3');
  await p.locator('h3.card-title').filter({ hasText: /Tracking|AniList/ }).first().click(); await p.waitForTimeout(300);
  const en = p.locator('label.row:has-text("AniList") input[type=checkbox]').first();
  if (!(await en.isChecked())) { await en.check(); await p.waitForTimeout(400); }
  await p.fill('label.row:has-text("Client ID") input', '12345'); await p.press('label.row:has-text("Client ID") input', 'Tab');
  await p.click('button:has-text("Sign in")'); await p.waitForTimeout(1200);
  const opened = await p.evaluate(() => window.__opened[0]);
  ok('the sign-in opens in the app\'s browser, watched for the token', !!opened && /oauth\/authorize\?client_id=12345/.test(opened.url) && opened.until === 'access_token=');
  ok('… and the account is linked by itself, with the token from the page', auth === 'Bearer TOKEN123' && /Linked as Reader|Reader/.test(await p.evaluate(() => document.body.textContent)));
  console.log(fails ? `${fails} FAILED` : 'all passed', 'errors', errors);
  await b.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
