// A site behind a shield (server.elscione.com behind Cloudflare), end to end against tests/sources/server.cjs
// with its shield up: the app on a platform with its own browser (a desktop bridge stands in for the native
// side — its plain requests made from here, its browser's marked as a browser's, as the shield tells them
// apart). Plain requests refused: the site reached through the app's browser, added, indexed, searched, a
// volume's cover and file fetched. A check the browser cannot pass alone: the reader asked once ("confirm you
// are human"), then everything goes on. No browser in the app: the refusal said plainly, no empty index kept.
// h5ai's search turned off: the index from its items, two levels a request. Plain connections cut outright:
// the browser tried and kept. A site refusing even a browser: said so. The site opened in the app's browser
// for the reader (as Mihon's WebView).
// node tests/sources/lane.cjs <dir with alice-in-wonderland.epub>
const { chromium, devices } = require('playwright'); const http = require('http'); const fs = require('fs'); const path = require('path'); const { spawn } = require('child_process');
const DIST = path.resolve(__dirname, '../../dist'); const BOOKS = path.resolve(process.argv[2] || '.');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.ttf': 'font/ttf' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const MOCK = 'http://localhost:5411';
const SITE = 'https://server.elscione.com';
const OTL_URL = `${SITE}/Officially%20Translated%20Light%20Novels/`;
const MANIFEST = 'https://raw.githubusercontent.com/YoRu72/KurokawaReader/main/extensions/otl.json';
const toMock = (u) => (u === MANIFEST ? `${MOCK}/extensions/otl.json` : u.startsWith(SITE) ? MOCK + u.slice(SITE.length) : u);
const shield = (q) => fetch(`${MOCK}/__otl/shield?${q}`).then((r) => r.json());

let cutPlain = false;   // the site's shield cutting plain connections outright (no answer at all)
/** The native side of a platform, done from here: a plain request, or the app's browser's (marked so). */
async function nativeRequest(o, byBrowser) {
  if (cutPlain && !byBrowser && o.url.startsWith(SITE)) throw new Error('Request failed: Connection reset');
  const headers = { ...(o.headers || {}) }; delete headers['accept-encoding'];
  if (byBrowser) headers['x-kr-browser'] = '1';
  const r = await fetch(toMock(o.url), { method: o.method || 'GET', headers, body: o.body == null ? undefined : (o.bodyBase64 ? Buffer.from(o.body, 'base64') : o.body), redirect: 'follow' });
  const buf = Buffer.from(await r.arrayBuffer()); const hs = {}; r.headers.forEach((v, k) => { hs[k.toLowerCase()] = v; });
  const out = { status: r.status, headers: hs, body: o.binary ? buf.toString('base64') : buf.toString('utf8'), url: o.url };
  if (byBrowser && r.status === 403) {
    // (What the app's browser answers when its page cannot get through: a check it waited out of sight for,
    // or a refusal.)
    if (hs['cf-mitigated'] === 'challenge') out.headers['x-kr-lane'] = 'challenge';
    else if (/Sorry, you have been blocked/.test(buf.toString('utf8'))) out.headers['x-kr-lane'] = 'blocked';
    out.via = 'browser';
  }
  return out;
}

(async () => {
  await new Promise((r) => server.listen(5412, r));
  const mock = spawn('node', [path.join(__dirname, 'server.cjs'), '5411', BOOKS], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 700));
  const browser = await chromium.launch();
  const ok = (name, cond) => console.log((cond ? 'ok  ' : 'FAIL'), name);
  const base = 'http://localhost:5412/';
  const errors = [];
  /** A fresh app (its own storage) on a platform with a browser (`withBrowser`), the reader passing checks
   *  when asked (`readerPasses`). */
  async function app({ withBrowser = true, readerPasses = true } = {}) {
    const ctx = await browser.newContext({ ...devices['Pixel 7'], locale: 'en' });
    const log = { checks: [], resets: [], forgets: [], plain: 0, browser: 0 };
    await ctx.exposeFunction('__krNative', (o) => { log.plain++; return nativeRequest(o, false); });
    await ctx.exposeFunction('__krBrowser', (o) => { log.browser++; return nativeRequest(o, true); });
    await ctx.exposeFunction('__krCheck', async (o) => {
      log.checks.push(o);
      if (o.hidden) return { passed: false, blocked: false, title: 'Just a moment...' };
      if (!readerPasses) return { passed: false, blocked: false, title: 'Just a moment...' };
      await shield('passed=1');
      return { passed: true, blocked: false, title: 'Officially Translated Light Novels' };
    });
    await ctx.exposeFunction('__krReset', (u) => { log.resets.push(u); return true; });
    await ctx.exposeFunction('__krForget', (u, all) => { log.forgets.push([u, all]); return { cleared: 1 }; });
    await ctx.addInitScript((withBrowser) => {
      window.kurokawaDesktop = {
        platform: 'linux', onOpenFile() {},
        http: (o) => window.__krNative(o),
        openWebView: (o) => window.__krCheck(typeof o === 'string' ? { url: o } : o),
        ...(withBrowser ? { browserFetch: (o) => window.__krBrowser(o), browserReset: (u) => window.__krReset(u), browserForget: (u, all) => window.__krForget(u, !!all) } : {}),
      };
    }, withBrowser);
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(base); await page.evaluate(() => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kr.update.lastCheck', String(Date.now())); }); await page.reload(); await page.waitForSelector('.library-view');
    return { ctx, page, log };
  }
  async function add(page, given) {
    await page.goto(base + '#/sources'); await page.waitForSelector('.sources-hub'); await page.waitForTimeout(300);
    await page.click('.topbar-actions button[data-icon="plus"]'); await page.waitForSelector('.sheet input[type=url]');
    await page.fill('.sheet input[type=url]', given); await page.press('.sheet input[type=url]', 'Enter');
    await page.waitForFunction(() => document.querySelectorAll('.folder-card').length === 1, null, { timeout: 30000 }); await page.waitForTimeout(300);
  }
  const indexText = (page) => page.$eval('.src-index', (e) => e.textContent).catch(() => '');
  try {
    // 1. Plain requests refused (a Cloudflare 403 page): the site reached through the app's browser.
    await shield('kind=403&nosearch=0');
    {
      const { ctx, page, log } = await app();
      await add(page, OTL_URL);
      const card = await page.$eval('.folder-card', (c) => `${c.querySelector('b')?.textContent}|${c.querySelector('small')?.textContent}`);
      ok('added by its address though its plain requests are refused: through the app\'s browser', card === 'Officially Translated Light Novels|server.elscione.com/Officially Translated Light Novels' && log.browser >= 1);
      ok('… the site kept as one reached through the browser', await page.evaluate(() => (JSON.parse(localStorage.getItem('kr.browserHosts') || '{}')['server.elscione.com'] ?? 0) > Date.now()));
      await page.click('.folder-card .source-head');
      await page.waitForFunction(() => /Indexed: 113 series/.test(document.querySelector('.src-index')?.textContent || '') && document.querySelectorAll('.src-card.folder').length >= 20, null, { timeout: 60000 });
      const s1 = await shield('');
      ok('opened and indexed through the browser: every series there, the plain way asked once at most', /Indexed: 113 series, \d+ volumes · Today/.test(await indexText(page)) && s1.browser > 3 && s1.plain <= 1);
      if (!(s1.plain <= 1)) console.log('  shield:', JSON.stringify(s1));
      await page.fill('.src-search', 'goblin'); await page.press('.src-search', 'Enter');
      await page.waitForFunction(() => /found/.test(document.querySelector('.topbar .title')?.textContent || '') && /Goblin/.test(document.querySelector('.src-grid')?.textContent || ''), null, { timeout: 20000 });
      ok('searched', true);
      await page.goto(base + (await page.evaluate(() => location.hash)).replace(/\?.*$/, '') + '?shelf=' + encodeURIComponent('Alpha%20Saga')); await page.waitForSelector('.series-block', { timeout: 20000 });
      await page.waitForFunction(() => { const b = document.querySelector('.sources-view .src-body'); if (b) b.scrollTop += 300; return document.querySelectorAll('.vol-row .vol-cover img').length >= 3; }, null, { timeout: 60000, polling: 400 });
      ok('a series\' page with its volumes\' covers, read in pieces through the browser', (await page.$$('.vol-row')).length === 4);
      await page.click('.vol-row >> nth=0 >> .vol-actions button'); await page.waitForSelector('.vol-row >> nth=0 >> .vol-actions .btn.primary', { timeout: 60000 });
      ok('a volume fetched through the browser into the library', true);
      // The site itself in the app's browser (as Mihon's WebView): it stays until closed, then the browser
      // opens the site afresh with what was done there.
      const resetsBefore = log.resets.length;
      await page.click('.topbar-actions button[data-icon="globe"]'); await page.waitForTimeout(800);
      const opened = log.checks[log.checks.length - 1] ?? {};
      ok('"Open the site in the app\'s browser": a window that stays, saying what it is for', opened.stay === true && /server\.elscione\.com in the app’s browser/.test(opened.message || '') && log.resets.length > resetsBefore);
      await ctx.close();
    }
    // 2. A check the app's browser cannot pass by itself: the reader is asked once, then all goes on.
    await shield('kind=challenge');
    {
      const { ctx, page, log } = await app();
      await add(page, 'OTL');
      await page.click('.folder-card .source-head');
      await page.waitForFunction(() => /Indexed: 113 series/.test(document.querySelector('.src-index')?.textContent || ''), null, { timeout: 60000 });
      const shown = log.checks.filter((c) => !c.hidden);
      ok('the reader asked once, in a window that says what to do', shown.length === 1 && /^Confirm you’re human on server\.elscione\.com/.test(shown[0].message || '') && shown[0].done === 'Close' && shown[0].reload === 'Reload' && shown[0].fresh === true);
      if (shown.length !== 1) console.log('  checks:', JSON.stringify(log.checks));
      ok('… not first waited for out of sight again (the browser had waited already)', log.checks.filter((c) => c.hidden).length === 0);
      ok('… the browser opened again on the site afterwards, with the new cookies', log.resets.length >= 1);
      ok('… the extension\'s manifest said to go through the browser from the first request', (await shield('')).plain === 0);
      await ctx.close();
    }
    // 3. No browser in the app, the site refusing: said plainly — no "Indexed: 0 series" kept.
    await shield('kind=403');
    {
      const { ctx, page, log } = await app({ withBrowser: false, readerPasses: false });
      await add(page, 'OTL');
      await page.click('.folder-card .source-head');
      await page.waitForFunction(() => /make sure you’re a person/.test(document.querySelector('.src-body')?.textContent || ''), null, { timeout: 60000 });
      await page.waitForTimeout(1500);
      const txt = await page.$eval('.src-body', (e) => e.textContent);
      ok('a refusal said as such, with the way through offered', /Confirm I’m human/.test(txt) && !!(await page.$('.src-body button:has-text("Confirm I’m human")')));
      ok('… no empty index kept or shown', !/Indexed: 0 series/.test(txt) && !/Indexed:/.test(await indexText(page)));
      ok('… the reader was asked (the check window), and declined', log.checks.some((c) => !c.hidden));
      await page.click('.src-body button:has-text("Confirm I’m human")'); await page.waitForTimeout(800);
      ok('"Confirm I’m human" opens the site\'s check for the reader', log.checks.filter((c) => !c.hidden).length >= 2 && log.checks.filter((c) => !c.hidden).every((c) => /server\.elscione\.com/.test(c.url)));
      await ctx.close();
    }
    // 4. h5ai's search turned off: the index from its items, two levels a request (no shield).
    await shield('kind=off&nosearch=1');
    {
      const { ctx, page } = await app();
      await fetch(`${MOCK}/__otl/reset-posts`);
      await add(page, 'OTL');
      await page.click('.folder-card .source-head');
      await page.waitForFunction(() => /Indexed: 113 series/.test(document.querySelector('.src-index')?.textContent || ''), null, { timeout: 60000 });
      const posts = await (await fetch(`${MOCK}/__otl/posts`)).json();
      const deep = posts.filter((b) => /"what":2/.test(b));
      // (One for the root and every series in it; then one per series with side folders — never a side folder
      // by itself, never a request per series as a walk would.)
      const sides = deep.filter((b) => /%21|!/.test(b)).length;
      ok('search off: indexed from h5ai\'s items, two levels a request (the root, then each series with side folders)', deep.length >= 2 && deep.length <= 20 && sides === 0 && /Indexed: 113 series, \d+ volumes/.test(await indexText(page)));
      if (!(deep.length >= 2 && deep.length <= 20 && sides === 0)) console.log('  what=2 posts:', deep.length, 'side folders asked:', sides);
      await page.fill('.src-search', 'monogatari'); await page.press('.src-search', 'Enter');
      await page.waitForFunction(() => /found/.test(document.querySelector('.topbar .title')?.textContent || ''), null, { timeout: 20000 });
      ok('… the volumes of the side folders in it too', /Side Story Collection|Monogatari/.test(await page.$eval('.src-grid', (e) => e.textContent)));
      await ctx.close();
    }
    // 5. Plain connections cut outright (no answer at all): the app's browser tried, and kept for the site.
    await shield('kind=off&nosearch=0'); cutPlain = true;
    {
      const { ctx, page, log } = await app();
      await add(page, OTL_URL);
      ok('plain connections cut: added through the app\'s browser, the site kept as one reached through it', log.browser >= 1 && await page.evaluate(() => (JSON.parse(localStorage.getItem('kr.browserHosts') || '{}')['server.elscione.com'] ?? 0) > Date.now()));
      await ctx.close();
    }
    cutPlain = false;
    // 6. A site refusing even a browser: said plainly, with what its page says — no check offered.
    await shield('kind=blockall');
    {
      const { ctx, page } = await app();
      await add(page, 'OTL');
      await page.click('.folder-card .source-head');
      await page.waitForFunction(() => /refuses the app/.test(document.querySelector('.src-body')?.textContent || ''), null, { timeout: 60000 });
      const txt = await page.$eval('.src-body', (e) => e.textContent);
      ok('a site refusing even the app\'s browser: said so, with its page\'s words, no check offered', /even through its built-in browser \(its page says “Attention Required! \| Cloudflare”\)/.test(txt) && !/Confirm I’m human/.test(txt) && /Clear the site’s cookies/.test(txt));
      if (!/even through its built-in browser/.test(txt)) console.log('  text:', txt.slice(0, 300));
      await ctx.close();
    }
    await shield('kind=off&nosearch=0');
  } catch (e) { console.log('FAIL', 'threw:', e && e.stack || e); }
  finally {
    if (errors.length) console.log('page errors:', errors.slice(0, 5));
    await browser.close(); mock.kill(); server.close();
  }
})();
