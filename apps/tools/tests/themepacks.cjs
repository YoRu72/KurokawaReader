// node tests/themepacks.cjs: theme packs from the repository, against a loopback server that stands in for it.
// The Frosted Glass card shows its size and a download button; the download shows progress, is checked, kept, and
// the theme becomes usable with its pictures; it works again offline after a reload; remove frees it. Designed
// failures: the list unreachable (not published yet / offline), a checksum that differs (nothing kept), storage full.
// Also: the pack format read by the app equals what scripts/themes.mjs writes, and the MIT notice ships in the pack
// and in Settings → About → Open-source licences. Only loopback, no fixed waits.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let fails = 0; const ok = (n, c, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || !extra ? '' : `  — ${extra}`)); if (!c) fails++; };

// The packs are what the script makes from themes-src (checked first).
execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'themes.mjs'), '--check'], { stdio: 'inherit' });
const index = JSON.parse(fs.readFileSync(path.join(REPO, 'themes', 'themes.json'), 'utf8'));
const packBytes = fs.readFileSync(path.join(REPO, 'themes', 'frosted-glass.ktheme'));
ok('the index lists the Frosted Glass pack with its size and checksum', index.themes[0].id === 'frosted-glass' && index.themes[0].size === packBytes.length && index.themes[0].sha256 === crypto.createHash('sha256').update(packBytes).digest('hex'));
const headLen = packBytes.readUInt32BE(8); const head = JSON.parse(packBytes.subarray(12, 12 + headLen).toString('utf8'));
ok('the pack carries the MIT notice with its copyright line, and both pictures unchanged', /Copyright \(c\) 2025 Wessam Lauf/.test(head.license.notice) && /MIT License/.test(head.license.notice)
  && head.assets.every((a) => { const src = fs.readFileSync(path.join(__dirname, '..', 'themes-src', 'frosted-glass', a.name === 'bg-dark' ? 'frosted-glass-dark-background.jpg' : 'frosted-glass-light-background.jpg')); return Buffer.compare(src, packBytes.subarray(12 + headLen + a.offset, 12 + headLen + a.offset + a.size)) === 0; }));

// The stand-in for the repository: modes switched by the test.
let mode = 'ok'; let hold = null; let served = 0;
const repo = http.createServer(async (req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]);
  if (mode === '404') { res.writeHead(404); res.end(); return; }
  if (p.endsWith('/themes.json')) { const ix = JSON.parse(JSON.stringify(index)); if (mode === 'badsum') ix.themes[0].sha256 = '0'.repeat(64); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(ix)); return; }
  if (p.endsWith('/frosted-glass.ktheme')) {
    served++; if (hold) await hold;
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': packBytes.length }); res.end(packBytes); return;
  }
  res.writeHead(404); res.end();
});
const web = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const getLoop = (port, p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (r) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(b), type: r.headers['content-type'] })); }).on('error', reject));

(async () => {
  for (const s of [repo, web]) { s.listen(0, '127.0.0.1'); await new Promise((r) => s.once('listening', r)); }
  const rport = repo.address().port, wport = web.address().port;
  const br = await chromium.launch(); const errors = [];
  const ctx = await br.newContext({ viewport: { width: 400, height: 860 }, isMobile: true, hasTouch: true, locale: 'en', serviceWorkers: 'block' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  let offline = false;
  await ctx.route(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/, async (r) => {
    if (offline) return r.abort('internetdisconnected');
    const sub = '/' + r.request().url().split('/main/repo/')[1].split('?')[0];
    const got = await getLoop(rport, sub);
    r.fulfill({ status: got.status, body: got.body, headers: { 'content-type': got.type || 'application/octet-stream', 'access-control-allow-origin': '*', 'content-length': String(got.body.length) } });
  });
  await p.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player'], theme: 'frost', themeChosen: true })); localStorage.setItem('kt.themeMigrated', '1'); }
    // (Storage full, when the test asks: every IndexedDB write refused as a full disk would.)
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...a) { if (localStorage.getItem('test.full') && this.name === 'files') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError'); return put.apply(this, a); };
  });
  const card = '.tg-card[data-theme="frosted-glass"]';
  const openGallery = async () => { await p.goto(`http://127.0.0.1:${wport}/#/settings/appearance`); await p.waitForSelector(`${card} .tg-state`); };
  const stateText = () => p.$eval(`${card} .tg-state`, (e) => e.textContent);
  const stored = () => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-tools'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => res(q.result.filter((k) => String(k).startsWith('theme:'))); }; }));

  // Not published yet: the list answers 404.
  mode = '404'; await openGallery();
  await p.waitForFunction((c) => /Pictures to download/.test(document.querySelector(`${c} .tg-state`).textContent), card);
  ok('before any download, the card says pictures are to download, with the size', /\d+ KB/.test(await stateText()) && !!(await p.$(`${card} .tg-dl`)));
  await p.click('.tg-add'); await p.waitForSelector('.tg-addlist .tg-empty');
  ok('«Add themes» while the list is not published: says so, offers to try again', /isn’t published yet/.test(await p.$eval('.tg-addlist', (e) => e.textContent)) && !!(await p.$('.tg-addlist .btn')));
  await p.keyboard.press('Escape');
  await p.click(`${card} .tg-dl`); await p.waitForSelector(`${card}.failed`);
  ok('a download while the list is not published: a designed message and a retry button', /Not published yet/.test(await stateText()) && !!(await p.$(`${card} .tg-dl.retry`)));

  // Offline.
  mode = 'ok'; offline = true; await openGallery(); await p.click(`${card} .tg-dl`); await p.waitForSelector(`${card}.failed`);
  ok('offline: «Check your connection», nothing kept', /Check your connection/.test(await stateText()) && (await stored()).length === 0);
  offline = false;

  // A checksum that differs.
  mode = 'badsum'; await openGallery(); await p.click(`${card} .tg-dl`); await p.waitForSelector(`${card}.failed`);
  ok('a checksum that differs: «arrived damaged», nothing kept', /damaged/.test(await stateText()) && (await stored()).length === 0);

  // Storage full.
  mode = 'ok'; await p.evaluate(() => localStorage.setItem('test.full', '1')); await openGallery(); await p.click(`${card} .tg-dl`); await p.waitForSelector(`${card}.failed`);
  ok('storage full: «Not enough room», with how much to free', /Not enough room/.test(await stateText()) && /KB|MB/.test(await stateText()) && (await stored()).length === 0, await stateText());
  await p.evaluate(() => localStorage.removeItem('test.full'));

  // The download: progress, checked, kept, then the theme in use with its pictures.
  let release; hold = new Promise((r) => { release = r; });
  await openGallery(); await p.click(`${card} .tg-pick`);
  await p.waitForSelector(`${card}.busy .tg-progress`);
  ok('tapping the card starts the download: a progress bar and «Downloading …»', /Downloading/.test(await stateText()));
  release(); hold = null;
  await p.waitForSelector(`${card}.on .tg-rm`, { timeout: 20000 }).catch(async () => console.log('STATE', await stateText(), await p.evaluate(() => [document.documentElement.dataset.theme, document.documentElement.dataset.picture])));
  await p.waitForFunction(() => document.documentElement.dataset.theme === 'frosted-glass' && document.documentElement.dataset.picture === '1', null, { timeout: 20000 });
  const bg = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--th-bg'));
  ok('installed and in use: its pictures drawn from the device (blob: URL), the card «On this device», remove offered', /blob:/.test(bg) && /On this device/.test(await stateText()) && (await stored()).length === 2);
  ok('its credit is shown: «by Wessam Lauf»', /by Wessam Lauf/.test(await p.$eval(card, (e) => e.textContent)));

  // Offline after a reload: still there.
  offline = true; const before = served; await p.reload(); await p.waitForFunction(() => document.documentElement.dataset.picture === '1', null, { timeout: 20000 });
  ok('offline after a reload, the downloaded theme still shows its pictures (nothing fetched)', served === before);
  offline = false;

  // The licences.
  await p.goto(`http://127.0.0.1:${wport}/#/settings/about`); await p.waitForSelector('#about');
  await p.locator('#about button', { hasText: 'Open-source licences' }).click(); await p.waitForSelector('.licence-text');
  const lic = await p.$eval('.sheet', (e) => e.textContent);
  ok('About → Open-source licences: the Frosted Glass MIT notice in full', /Copyright \(c\) 2025 Wessam Lauf/.test(lic) && /Permission is hereby granted/.test(lic) && /Frosted Glass/.test(lic));
  await p.keyboard.press('Escape');

  // Remove.
  await openGallery(); await p.click(`${card} .tg-rm`); await p.waitForSelector(`${card} .tg-dl`);
  ok('remove frees the room: nothing kept, the download button back, the theme stays on its drawn background', (await stored()).length === 0 && await p.evaluate(() => document.documentElement.dataset.theme === 'frosted-glass' && !document.documentElement.dataset.picture));

  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await br.close(); repo.close(); web.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
