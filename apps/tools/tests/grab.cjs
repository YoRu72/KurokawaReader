// The grabber with Prism's crawl depth: a page linking to two sub-pages (and one outside its folder, and another
// site): with depth 1 and «under this folder», the files of the page and its two sub-pages are found and nothing
// from outside; kept as a project, it is listed and runs again.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en'; const asked = [];
const SITE = {
  '/site/files/': '<a href="a/">A</a> <a href="b/">B</a> <a href="/other/">elsewhere</a> <a href="https://example.org/x.zip">far</a> <a href="top.zip">top</a>',
  '/site/files/a/': '<a href="one.mkv">one</a> <a href="deeper/">deeper</a>', '/site/files/b/': '<a href="two.mkv">two</a> <a href="../a/">back</a>',
  '/site/files/a/deeper/': '<a href="three.mkv">three</a>', '/other/': '<a href="/other/no.mkv">no</a>',
};
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (SITE[p]) { asked.push(p); res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<html><body>${SITE[p]}</body></html>`); return; } if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => localStorage.setItem('kr.lang', lang), lang);
  const base = `http://127.0.0.1:${web.address().port}/`;
  await p.goto(base); await p.waitForTimeout(800);
  // Open the grabber through the + menu
  await p.click('.fab'); await p.waitForSelector('.fab-item');
  const items = await p.$$eval('.fab-item', (r) => r.map((x) => x.innerText.replace(/\s+/g, ' ')));
  const gi = items.findIndex((x) => /Grab|التقط|اجمع|Prism|grab/i.test(x)); await p.locator('.fab-item').nth(gi >= 0 ? gi : 4).click();
  await p.waitForSelector('.sheet input[type=url]');
  await p.fill('.sheet input[type=url]', base + 'site/files/');
  await p.click('.sheet .chip[data-d="1"]'); await p.press('.sheet input[type=url]', 'Enter');
  await p.waitForSelector('.grab-list .file-row', { timeout: 15000 }); await p.waitForTimeout(300);
  const found = await p.$$eval('.grab-list .file-row', (r) => r.map((x) => x.innerText.trim())); console.log('depth 1 found:', found.join(', '), '| pages:', asked.join(' '));
  const ok1 = found.length === 2 && found.some((x) => /one/.test(x)) && found.some((x) => /two/.test(x)) && !asked.includes('/other/') && !asked.includes('/site/files/a/deeper/');
  await p.screenshot({ path: path.join(__dirname, `shot-grab-${lang}.png`) });
  const chipsText = await p.$eval('.sheet .chip-row.wrap:not(.grab-projects)', (e) => e.innerText.replace(/\s+/g, ' ')); console.log('kinds:', chipsText);
  await p.locator('.sheet .btn.text', { hasText: /Keep as a project|احفظه مشروعًا/ }).click(); await p.waitForTimeout(200);
  const projects = await p.$$eval('.grab-projects .proj', (r) => r.map((x) => x.innerText.trim())); console.log('projects:', projects.join(', '));
  // depth 2 reaches «deeper»
  asked.length = 0; await p.click('.sheet .chip[data-d="2"]'); await p.press('.sheet input[type=url]', 'Enter'); await p.waitForTimeout(1200);
  const found2 = await p.$$eval('.grab-list .file-row', (r) => r.map((x) => x.innerText.trim())); console.log('depth 2 found:', found2.join(', '));
  const pass = ok1 && projects.length === 1 && found2.some((x) => /three/.test(x)) && !found2.some((x) => /no\.mkv/.test(x));
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
