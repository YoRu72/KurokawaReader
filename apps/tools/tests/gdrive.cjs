// node tests/gdrive.cjs: Google Drive links on a stubbed phone, against a Drive played here — a file link (its name and
// size from Drive's download endpoint, added as that address); a folder with a subfolder and a Google Doc (listed from
// Drive's embeddable view, sizes filled in as found, one file left out, the rest added inside the folder's own folder,
// the large one past Drive's «can't scan for viruses» page by its form); a private link and a much-downloaded one
// (their reasons, said); a page with Drive links written as text (offered).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!c) fails++; };
const FILE = '1FiLeAbCdEfGhIjK', FOLDER = '1FoLdErAbCdEfGhI', SUB = '1SuBfOlDeRaBcDeF', F1 = '1EpIsOdE01aBcDeF', F2 = '1EpIsOdE02aBcDeF', DOC = '1DoCuMeNtAbCdEfG', PRIV = '1PrIvAtEaBcDeFgH', QUOTA = '1QuOtAaBcDeFgHiJ';
const entry = (id, href, name) => `<div class="flip-entry" id="entry-${id}" tabindex="0" role="link"><div class="flip-entry-info"><a href="${href}" target="_blank"><div class="flip-entry-list-icon"></div><div class="flip-entry-title">${name}</div><div class="flip-entry-last-modified"><div>Nov 3</div></div></a></div></div>`;
const view = (title, entries) => `<!DOCTYPE html><html><head><title>${title}</title></head><body><div class="flip-entries">${entries.join('')}</div></body></html>`;
function drive(url, headers) {
  const u = new URL(url); const id = u.searchParams.get('id'); const range = headers.Range || headers.range;
  const bin = (name, size) => ({ status: range ? 206 : 200, headers: { 'content-type': 'video/x-matroska', 'content-disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`, ...(range ? { 'content-range': `bytes 0-0/${size}`, 'content-length': '1' } : { 'content-length': String(size) }) }, body: 'x' });
  const html = (status, body) => ({ status, headers: { 'content-type': 'text/html; charset=utf-8' }, body });
  if (u.pathname === '/embeddedfolderview') {
    if (id === FOLDER) return html(200, view('Show', [entry(F1, `https://drive.google.com/file/d/${F1}/view?usp=drive_web`, 'Ep 01.mkv'), entry(SUB, `https://drive.google.com/drive/folders/${SUB}`, 'Extras'), entry(DOC, `https://docs.google.com/document/d/${DOC}/edit?usp=drive_web`, 'Notes')]));
    if (id === SUB) return html(200, view('Extras', [entry(F2, `https://drive.google.com/file/d/${F2}/view?usp=drive_web`, 'Ep 02 [1080p].mkv')]));
    return html(404, 'not found');
  }
  if (u.hostname === 'docs.google.com' && u.pathname.includes(DOC)) return { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'content-disposition': 'attachment; filename="Notes.docx"' }, body: 'x' };
  if (u.hostname === 'drive.usercontent.google.com') {
    if (id === FILE) return bin('Movie (2024).mkv', 734003200);
    if (id === F1) return bin('Ep 01.mkv', 1000);
    if (id === F2 && u.searchParams.get('uuid') === 'U-1' && u.searchParams.get('confirm') === 't') return bin('Ep 02 [1080p].mkv', 2147483648);
    if (id === F2) return html(200, `<html><body><div class="uc-warning-subcaption"><span class="uc-name-size"><a href="/open?id=${F2}">Ep 02 [1080p].mkv</a> (2.0G)</span> is too large for Google to scan for viruses.</div><form id="download-form" action="https://drive.usercontent.google.com/download" method="get"><input type="submit" value="Download anyway"><input type="hidden" name="id" value="${F2}"><input type="hidden" name="export" value="download"><input type="hidden" name="confirm" value="t"><input type="hidden" name="uuid" value="U-1"></form></body></html>`);
    if (id === PRIV) return html(200, `<html><body><form action="https://accounts.google.com/v3/signin/identifier" method="post"><input name="Email"></form>Sign in</body></html>`);
    if (id === QUOTA) return html(200, `<html><body><p>Sorry, you can't view or download this file at this time.</p><p>Too many users have viewed or downloaded this file recently. Please try accessing the file again later.</p></body></html>`);
    return html(404, 'not found');
  }
  return null;
}
(async () => {
  const web = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); r.end(); return; } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }).listen(0);
  const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 412, height: 900 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.exposeFunction('__drive', (url, headers) => JSON.stringify(drive(url, headers || {})));
  const pageText = `Batch: https://drive.google.com/drive/folders/${FOLDER}?usp=sharing. Movie https://drive.google.com/file/d/${FILE}/view — and the notes https://docs.google.com/document/d/${DOC}/edit`;
  await p.addInitScript((pageText) => {
    window.__adds = []; window.__asked = []; const tasks = [];
    const plugin = new Proxy({
      addListener: async () => ({ remove() {} }), list: async () => ({ tasks }), defaultDir: async () => ({ dir: '/sdcard/Download' }),
      add: async (o) => { window.__adds.push(o); return { task: { id: 't' + window.__adds.length, kind: 'http', name: o.name, source: o.source, dir: o.dir, state: 'queued', done: 0, total: 0, downSpeed: 0, upSpeed: 0, files: [], addedAt: Date.now(), engine: 'native', meta: o.meta } }; },
      httpRequest: async (o) => { window.__asked.push(o.url); if (/google\.com/.test(o.url)) { const r = JSON.parse(await window.__drive(o.url, o.headers)); if (r) return { url: o.url, ...r }; } if (/forum\.example/.test(o.url)) return { status: 200, url: o.url, headers: { 'content-type': 'text/html' }, body: `<html><body><p>${pageText}</p></body></html>` }; return { status: 404, url: o.url, headers: {}, body: '' }; },
    }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }, pageText);
  const base = `http://127.0.0.1:${web.address().port}/`;
  const openAdd = async (link) => { await p.goto('about:blank'); await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.evaluate(() => { window.__adds = []; }); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.add-sheet'); await p.fill('.add-input', link); await p.dispatchEvent('.add-input', 'input'); };
  const line = async (re) => { await p.waitForFunction((re) => new RegExp(re).test(document.querySelector('.add-size')?.textContent || ''), re, { timeout: 8000 }).catch(() => undefined); return p.$eval('.add-size', (e) => e.textContent); };
  const go = async () => { await p.evaluate(() => [...document.querySelectorAll('.sheet .btn.primary')].pop()?.click()); await p.waitForTimeout(900); return p.evaluate(() => window.__adds); };
  // A file link.
  await openAdd(`https://drive.google.com/file/d/${FILE}/view?usp=sharing`);
  let l = await line('Google Drive ·'); ok('a Drive file link read: its name and size', /Movie \(2024\)\.mkv/.test(l) && /700 MB/.test(l), l);
  ok('its name filled in to save as', (await p.inputValue('.save-as input >> nth=0')) === 'Movie (2024)', await p.inputValue('.save-as input >> nth=0'));
  let adds = await go();
  ok('added as Drive\'s download address, with its id', adds.length === 1 && /drive\.usercontent\.google\.com\/download\?id=1FiLe/.test(adds[0].source.url) && adds[0].name === 'Movie (2024).mkv' && adds[0].meta?.gdrive === FILE, adds);
  // A folder: a subfolder, a Doc, a large file.
  await openAdd(`https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`);
  await p.waitForSelector('.mega-file', { timeout: 8000 }).catch(() => undefined);
  const listed = await p.$$eval('.mega-file', (e) => e.map((x) => x.textContent.replace(/\s+/g, ' ')));
  ok('a folder link: its files listed, subfolders\' and Docs too', listed.length === 3 && /Ep 01\.mkv/.test(listed[0]) && /Extras\/Ep 02 \[1080p\]\.mkv/.test(listed[1]) && /Notes\.docx/.test(listed[2]), listed);
  await p.waitForFunction(() => /2(\.0)? GB/.test(document.querySelector('.mega-files')?.textContent || ''), null, { timeout: 8000 }).catch(() => undefined);
  const sizes = await p.$$eval('.mega-file small', (e) => e.map((x) => x.textContent));
  ok('sizes filled in as found (the large one past Drive\'s scan page)', /1,?000 B|1 KB/.test(sizes[0]) && /2(\.0)? GB/.test(sizes[1]) && sizes[2] === '—', sizes);
  l = await line('Show'); ok('the folder\'s name and count shown', /Google Drive · Show/.test(l) && /3/.test(l), l);
  await p.locator('.mega-file', { hasText: 'Notes' }).locator('input').uncheck();
  adds = await go();
  const ep2 = adds.find((x) => x.name === 'Ep 02 [1080p].mkv');
  ok('the chosen two added, each in the folder\'s own folder', adds.length === 2 && /(^|\/)Show$/.test(adds.find((x) => x.name === 'Ep 01.mkv')?.dir ?? '') && /(^|\/)Show\/Extras$/.test(ep2?.dir ?? ''), adds.map((x) => [x.name, x.dir]));
  ok('the large one by the scan page\'s form (confirm and uuid)', /confirm=t/.test(ep2?.source.url ?? '') && /uuid=U-1/.test(ep2?.source.url ?? ''), ep2?.source.url);
  // A private link, a much-downloaded one.
  await openAdd(`https://drive.google.com/file/d/${PRIV}/view`); l = await line('Google Drive:'); ok('a private link: says it isn\'t shared', /isn't shared/.test(l), l);
  await openAdd(`https://drive.google.com/open?id=${QUOTA}`); l = await line('Google Drive:'); ok('a much-downloaded file: says to try later', /too many people/i.test(l), l);
  // Links written as text.
  await p.goto('about:blank'); await p.goto(base + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item[data-act="search"]'); await p.waitForSelector('.sheet input');
  await p.fill('.sheet input[type=url], .sheet input', 'https://forum.example/thread/2'); await p.keyboard.press('Enter'); await p.waitForTimeout(1500);
  const offered = await p.evaluate(() => [...document.querySelectorAll('.sheet .file-row')].map((x) => x.textContent));
  ok('a page\'s Drive links (written as text) offered', offered.filter((x) => /Google Drive|drive\.google|docs\.google/.test(x)).length >= 3, offered);
  ok('no page errors', !errors.length, errors);
  await b.close(); web.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})();
