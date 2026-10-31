const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = '/home/claude/KurokawaReader/apps/tools/dist'; const REPO = '/home/claude/KurokawaReader/repo';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0);
(async () => {
  const [route, out, lang, w, hgt, script] = process.argv.slice(2);
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: Number(w || 420), height: Number(hgt || 860) } });
  p.on('pageerror', (e) => console.log('ERR', e.message));
  await p.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, (r) => { const f = path.join(REPO, r.request().url().split('/main/repo/')[1]); if (!fs.existsSync(f)) return r.fulfill({ status: 404 }); r.fulfill({ body: fs.readFileSync(f), contentType: 'text/plain' }); });
  await p.route(/api\.github\.com/, (r) => r.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await p.addInitScript((lang) => { localStorage.setItem('kr.lang', lang || 'en'); }, lang);
  await p.goto(`http://127.0.0.1:${web.address().port}/#${route}`); await p.waitForTimeout(1200);
  if (script) await eval(script);
  await p.screenshot({ path: out }); await br.close(); web.close();
})();
