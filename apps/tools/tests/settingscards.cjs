// Settings cards that come with add-ons: AniList (with the Anime add-on), near the top, and Subtitle languages
// (with the Subtitles or Player add-on) — the first one starred, a tap putting another first. Absent without them.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const errors = []; const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const open = async (addons) => {
    const p = await br.newPage({ viewport: { width: 400, height: 860 } }); p.on('pageerror', (e) => errors.push(e.message));
    await p.addInitScript((a) => { localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: a, subLangs: ['en', 'ar', 'ja'] })); }, addons);
    await p.goto(`http://127.0.0.1:${port}/#/settings`); await p.waitForSelector('.settings-view .card'); await p.waitForTimeout(500); return p;
  };
  let p = await open([]);
  check('no AniList, subtitle or episode cards without the add-ons', !(await p.$('#anilist')) && !(await p.$('#sublangs')) && !(await p.$('#episodes')));
  await p.close();
  p = await open(['anime', 'subtitles']);
  const ids = await p.$$eval('.settings-view section.card', (c) => c.map((x) => x.id)); console.log('cards:', ids.join(' '));
  check('AniList right after General', ids.indexOf('anilist') === ids.indexOf('general') + 1);
  check('the AniList card offers to link', await p.$eval('#anilist', (e) => !!e.querySelector('button.btn.primary')));
  check('Watched episodes card with the Anime add-on', await p.$eval('#episodes', (e) => /After watching/.test(e.textContent) && /Delete the watched ones/.test(e.textContent)).catch(() => false));
  check('the Anime card no longer repeats the account', !(await p.$eval('#anime', (e) => /anilist\.co\/settings\/developer/.test(e.innerHTML))));
  await p.click('#sublangs h3').catch(() => undefined); await p.waitForTimeout(200);
  const chips = () => p.$$eval('#sublangs .lang-chips .chip', (c) => c.map((x) => (x.classList.contains('on') ? '*' : '') + x.textContent.trim()));
  const before = await chips(); console.log('languages:', before.join(' | ')); check('the languages in order, the first starred', before.length === 3 && before[0].startsWith('*'));
  await p.click('#sublangs .lang-chips .chip >> nth=2'); await p.waitForTimeout(200);
  const after = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.settings')).subLangs); console.log('after a tap:', after.join(','));
  check('a tap puts a language first', after[0] === 'ja' && after.length === 3);
  await p.close();
  p = await open(['player']); check('with the Player add-on alone: subtitle languages, no AniList', !!(await p.$('#sublangs')) && !(await p.$('#anilist'))); await p.close();
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
