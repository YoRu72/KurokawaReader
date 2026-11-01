// A post's media by its link (the desktop bridge faked, the sites' APIs answered from saved replies): an X post's
// video at its best MP4 and photos at their original size, a Bluesky post's four photos — named after the post —,
// and the Add sheet offering the post's media when such a link is pasted.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const FX = path.join(__dirname, 'fixtures');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const PHOTOS = { code: 200, message: 'OK', tweet: { id: '1700000000000000001', text: 'Two photos', author: { screen_name: 'someone' }, media: { all: [
  { type: 'photo', url: 'https://pbs.twimg.com/media/AAAA1111.jpg', width: 4096, height: 2048 },
  { type: 'photo', url: 'https://pbs.twimg.com/media/BBBB2222?format=png&name=small', width: 800, height: 600 }] } } };
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const cors = { 'access-control-allow-origin': '*' };
  await p.route('https://api.fxtwitter.com/**', (r) => r.fulfill({ headers: cors, contentType: 'application/json', body: /1585341984679469056/.test(r.request().url()) ? fs.readFileSync(path.join(FX, 'fxtwitter-video.json')) : JSON.stringify(PHOTOS) }));
  await p.route('https://public.api.bsky.app/**', (r) => r.fulfill({ headers: cors, contentType: 'application/json', body: fs.readFileSync(path.join(FX, 'bsky-post.json')) }));
  await p.route(/pbs\.twimg\.com|cdn\.bsky\.app/, (r) => r.fulfill({ status: 404 }));
  await p.addInitScript(() => {
    const tasks = []; window.__added = [];
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => { window.__added.push(o); return { id: 't' + window.__added.length, name: o.name || 'x', ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/home/u/Downloads', pickDir: async () => '/x', onTasks: (cb) => { cb(tasks); return () => {}; } };
  });
  const grab = async (link) => {
    await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.fab'); await p.evaluate(() => { window.__added = []; });
    await p.click('.fab'); await p.locator('.fab-item', { hasText: 'Grab' }).click(); await p.waitForSelector('.sheet input[type=url]');
    await p.fill('.sheet input[type=url]', link); await p.press('.sheet input[type=url]', 'Enter'); await p.waitForSelector('.grab-row', { timeout: 10000 });
    return p.$$eval('.grab-row', (r) => r.map((x) => ({ title: x.querySelector('.result-title').textContent, sub: x.querySelector('.src')?.textContent ?? '', thumb: !!x.querySelector('.grab-thumb'), on: x.querySelector('input').checked })));
  };
  // An X video (fixupx link): one row, the 1080p MP4.
  let rows = await grab('https://fixupx.com/elonmusk/status/1585341984679469056?s=20');
  console.log('x video:', JSON.stringify(rows)); check('x video listed with its thumbnail', rows.length === 1 && rows[0].thumb && /1080p/.test(rows[0].title));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length);
  let added = await p.evaluate(() => window.__added); console.log('added:', JSON.stringify(added.map((a) => [a.source.url, a.name])));
  check('the best MP4, named after the post', /1920x1080\/aeoVUvTgj4wHShhN\.mp4/.test(added[0].source.url) && added[0].name === 'elonmusk-1585341984679469056-1.mp4');
  // X photos (x.com link): the original size.
  rows = await grab('https://x.com/someone/status/1700000000000000001');
  check('two photos', rows.length === 2);
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 2);
  added = await p.evaluate(() => window.__added); console.log('added:', JSON.stringify(added.map((a) => [a.source.url, a.name])));
  check('photos at their original size', added[0].source.url === 'https://pbs.twimg.com/media/AAAA1111.jpg?name=orig' && added[1].source.url === 'https://pbs.twimg.com/media/BBBB2222?format=png&name=orig' && added[1].name === 'someone-1700000000000000001-2.png');
  // Bluesky: four photos.
  rows = await grab('https://bsky.app/profile/bsky.app/post/3myx7vphq3s2j');
  await p.screenshot({ path: 'shot-social.png' }); console.log('bluesky:', rows.length, rows[0]?.title); check('bluesky photos', rows.length === 4 && rows.every((r) => r.on));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length === 4);
  added = await p.evaluate(() => window.__added); check('named after the post', added.every((a, i) => a.name === `bsky.app-3myx7vphq3s2j-${i + 1}.jpg` && /cdn\.bsky\.app\/img\/feed_fullsize/.test(a.source.url)));
  // The Add sheet: a post link offers its media.
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet textarea');
  await p.fill('.sheet textarea', 'https://twitter.com/someone/status/1700000000000000001'); await p.waitForSelector('.hf-offer:not([hidden]) button', { timeout: 5000 });
  await p.click('.hf-offer button'); await p.waitForSelector('.grab-row'); check('add sheet opens the post', (await p.$$('.grab-row')).length === 2);
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
