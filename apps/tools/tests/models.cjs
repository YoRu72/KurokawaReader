// AI models (Hugging Face): the + menu opens the model window; trending shows; a GGUF repo opens with Q4_K_M and its
// mmproj ticked, the folder <models>/<owner>/<name>; another version swaps the ticks; Download adds each file pinned
// to the commit with its SHA-256, small first, and no token is sent for a public model.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const web = http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); }).listen(0, async () => {
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => {
    localStorage.setItem('kr.lang', lang); window.__calls = []; window.__urls = [];
    const sha = (c) => c.repeat(64);
    const repo = { id: 'acme/Tiny-GGUF', sha: '0123456789abcdef0123', pipeline_tag: 'text-generation', downloads: 12345, likes: 67, siblings: [
      { rfilename: '.gitattributes', size: 1500 }, { rfilename: 'README.md', size: 4000 },
      { rfilename: 'Tiny-Q4_K_M.gguf', size: 4.1e9, lfs: { sha256: sha('a'), size: 4.1e9 } }, { rfilename: 'Tiny-Q8_0.gguf', size: 7.6e9, lfs: { sha256: sha('b'), size: 7.6e9 } },
      { rfilename: 'Tiny-Q2_K.gguf', size: 2.2e9, lfs: { sha256: sha('c'), size: 2.2e9 } }, { rfilename: 'mmproj-F16.gguf', size: 6e8, lfs: { sha256: sha('d'), size: 6e8 } }] };
    const trending = [{ id: 'acme/Tiny-GGUF', downloads: 12345, likes: 67, pipeline_tag: 'text-generation' }, { id: 'meta/Gated-7B', gated: 'manual', downloads: 9e6 }];
    const plugin = new Proxy({
      addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), defaultDir: async () => ({ dir: '/storage/emulated/0/Download' }),
      httpRequest: async (o) => { window.__urls.push(o.url + (o.headers && o.headers.Authorization ? ' [auth]' : '')); const body = /\/api\/models\/acme\/Tiny-GGUF\/revision\//.test(o.url) ? repo : /\/api\/models\?/.test(o.url) ? trending : null; return body ? { status: 200, url: o.url, headers: {}, body: JSON.stringify(body) } : { status: 404, url: o.url, headers: {}, body: '{"error":"Repository not found"}' }; },
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async (a) => { window.__calls.push([k, a]); return k === 'add' ? { task: { id: 'n' + window.__calls.length, kind: 'http', name: a && a.name, state: 'queued', files: [], done: 0, total: 0, downSpeed: 0, upSpeed: 0, addedAt: Date.now(), source: a && a.source } } : {}; }) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, lang);
  await p.goto(`http://127.0.0.1:${web.address().port}/`); await p.waitForSelector('.fab'); await p.waitForTimeout(500);
  await p.click('.fab'); await p.waitForSelector('.fab-item'); const items = await p.$$('.fab-item'); await items[items.length - 1].click();
  await p.waitForSelector('.models-sheet .result-row'); const hits = (await p.$eval('.models-sheet', (e) => e.innerText)).replace(/\s+/g, ' '); console.log('trending:', hits.slice(0, 160));
  await p.click('.models-sheet .result-row >> nth=0'); await p.waitForSelector('.models-files .file-row');
  const ticked = await p.$$eval('.models-files .file-row.on', (r) => r.map((x) => x.innerText.split('\n')[0].trim())); console.log('ticked:', ticked.join(', '));
  const dest = await p.$eval('.models-dest', (e) => e.innerText.trim()); console.log('dest:', dest, '|', await p.$eval('.models-total', (e) => e.innerText));
  await p.screenshot({ path: path.join(__dirname, `shot-models-${lang}.png`) });
  await p.click('.models-sheet .chip-row .chip:has-text("Q8_0")'); await p.waitForTimeout(100);
  const ticked2 = await p.$$eval('.models-files .file-row.on', (r) => r.map((x) => x.innerText.split('\n')[0].trim())); console.log('after Q8_0:', ticked2.join(', '));
  await p.click('.models-sheet .btn.primary'); await p.waitForTimeout(800);
  const adds = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'add').map((c) => c[1]));
  for (const a of adds) console.log('add:', a.name, a.dir, a.source.url, a.meta && a.meta.sha256 && a.meta.sha256.slice(0, 4), a.source.headers ? 'HEADERS' : '');
  const urls = await p.evaluate(() => window.__urls); const auth = urls.some((u) => u.includes('[auth]'));
  const pass = ticked.includes('Tiny-Q4_K_M.gguf') && ticked.includes('mmproj-F16.gguf') && !ticked.includes('Tiny-Q8_0.gguf') && ticked2.includes('Tiny-Q8_0.gguf') && !ticked2.includes('Tiny-Q4_K_M.gguf')
    && /\/storage\/emulated\/0\/Download\/Models\/acme\/Tiny-GGUF/.test(dest) && adds.length >= 2 && adds.every((a) => /\/resolve\/0123456789abcdef0123\//.test(a.source.url) && a.dir === '/storage/emulated/0/Download/Models/acme/Tiny-GGUF' && !a.source.headers)
    && adds[0].name !== 'Tiny-Q8_0.gguf' && !auth;
  console.log(errors.length ? 'errors ' + JSON.stringify(errors) : pass ? 'all passed' : 'FAILED');
  await br.close(); web.close(); process.exit(errors.length || !pass ? 1 : 0);
});
