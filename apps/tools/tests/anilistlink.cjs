// Linking AniList without knowing an ID (Android faked): the guide; AniList's developer page opened in the app's
// window and the client's ID taken from the client's page it ends on; then the sign-in, its token taken from the
// address AniList ends on; the account linked. Also: an ID pasted as the client's link is read as the number.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 412, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.route('https://graphql.anilist.co/**', (r) => { const auth = r.request().headers().authorization; r.fulfill({ json: /Viewer/.test(r.request().postData() || '') ? { data: { Viewer: { id: 7, name: 'Keyaru', avatar: { medium: '' }, mediaListOptions: { scoreFormat: 'POINT_10' } } }, _auth: auth } : { data: {} } }); });
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['anime'], settingsLayout: 'list' })); window.__opened = [];
    const api = {
      addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [] }),
      httpRequest: async (r) => { window.__gql = (window.__gql || []).concat([r.headers && (r.headers.Authorization || r.headers.authorization)]); return { status: 200, headers: {}, body: JSON.stringify({ data: { Viewer: { id: 7, name: 'Keyaru', avatar: { medium: '' }, mediaListOptions: { scoreFormat: 'POINT_10' } } } }) }; },
      captureUrl: async (o) => { window.__opened.push(o.url); if (/settings\/developer/.test(o.url)) return { url: 'https://anilist.co/settings/client/31415' }; if (/oauth\/authorize/.test(o.url)) return { url: 'https://anilist.co/api/v2/oauth/pin#access_token=TOKEN123&token_type=Bearer&expires_in=31536000' }; return { url: null }; },
    };
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${port}/#/settings`); await p.waitForSelector('#anilist');
  await p.evaluate(() => { const c = document.querySelector('#anilist'); if (c?.classList.contains('collapsed')) c.querySelector('h3')?.click(); });
  await p.click('#anilist .btn.primary'); await p.waitForSelector('.al-link .al-step');
  check('the guide: four steps, the redirect address to copy', (await p.$$('.al-step')).length === 4 && /oauth\/pin/.test(await p.$eval('.al-link', (e) => e.textContent)));
  await p.waitForTimeout(700); await p.screenshot({ path: path.join(__dirname, `shot-anilistlink-${lang}.png`) });
  await p.fill('.al-id', 'https://anilist.co/settings/client/27182'); await p.dispatchEvent('.al-id', 'change');
  check('a client\'s link pasted: its number kept', (await p.inputValue('.al-id')) === '27182');
  await p.fill('.al-id', ''); await p.dispatchEvent('.al-id', 'change'); await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.anilistClientId = ''; localStorage.setItem('kt.settings', JSON.stringify(s)); });
  // The developer page opened in the app's window: the client's ID taken from its page, then signed in at once.
  await p.click('.al-step >> nth=0 >> button'); await p.waitForFunction(() => window.__opened.length >= 2, null, { timeout: 8000 });
  const opened = await p.evaluate(() => window.__opened); console.log('opened:', opened.join(' | '));
  check('the client found by itself, then the sign-in with it', /settings\/developer/.test(opened[0]) && /client_id=31415/.test(opened[1]) && /response_type=token/.test(opened[1]));
  await p.waitForSelector('#anilist .track-user', { timeout: 8000 });
  check('linked: the account shown', /Keyaru/.test(await p.$eval('#anilist .track-user', (e) => e.textContent)) && await p.evaluate(() => Object.values(localStorage).some((v) => v === 'TOKEN123')));
  
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
