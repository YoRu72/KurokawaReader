// The iOS app installer, on an iPhone (Safari's identity): «Install an iOS app» in the + menu; an IPA picked and
// looked into — name, identifier, version and build, iOS needed, devices, icon, what it asks to use, its
// extension and framework, its profile (ad hoc, expired: said); a link to an IPA typed in Add: offered to
// SideStore, AltStore and TrollStore by their own addresses. Not on Android's app (the APK installer is there).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const { execFileSync } = require('node:child_process'); const os = require('node:os');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const ipa = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kt-ipa-')), 'Demo.ipa'); execFileSync('python3', [path.join(__dirname, 'ipa', 'make.py'), ipa]);
  const web = serve(DIST).listen(0); const port = web.address().port; const lang = process.argv[2] || 'en';
  const br = await chromium.launch(); const errors = [];
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const ctx = await br.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1' });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript((lang) => { localStorage.setItem('kr.lang', lang); }, lang);
  await p.goto(`http://127.0.0.1:${port}/`); await p.waitForSelector('.fab'); await p.click('.fab'); await p.waitForSelector('.fab-item');
  const items = await p.$$eval('.fab-item', (e) => e.map((x) => x.getAttribute('data-act')));
  check('the + menu offers an iOS app on an iPhone', items.includes('apps'));
  const chooser = p.waitForEvent('filechooser'); await p.click('.fab-item[data-act="apps"]'); const fc = await chooser; await fc.setFiles(ipa);
  await p.waitForSelector('.ipa-sheet .ipa-facts', { timeout: 10000 });
  const head = await p.$eval('.ipa-head', (e) => e.innerText.replace(/\s+/g, ' ')); const facts = await p.$eval('.ipa-facts', (e) => e.innerText.replace(/\s+/g, ' '));
  console.log('head:', head); console.log('facts:', facts);
  check('name, identifier, version and build', /Demo Reader/.test(head) && /app\.kurokawa\.demo/.test(head) && /1\.4\.2 \(142\)/.test(head));
  check('iOS needed, devices, extension, framework', /iOS 15\.0/.test(facts) && /iPhone · iPad/.test(facts) && /Widget/.test(facts) && /1/.test(facts));
  check('the profile: ad hoc, its team, expired, its devices', /Kurokawa Team/.test(facts) && /3/.test(facts) && !!(await p.$('.ipa-row.warn')) && !!(await p.$('.ipa-sheet .plan-note.bad')));
  check('the icon shown (the largest)', await p.$eval('.ipa-icon', (e) => e.tagName === 'IMG' && e.naturalWidth === 180).catch(() => false));
  check('what it asks to use', /2/.test(await p.$eval('.ipa-uses summary', (e) => e.textContent)));
  await p.waitForTimeout(400); await p.screenshot({ path: path.join(__dirname, `shot-ipa-${lang}.png`) });
  await p.keyboard.press('Escape'); await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim').forEach((e) => e.remove()));
  // A link to an IPA typed in Add.
  await p.click('.fab'); await p.click('.fab-item[data-act="link"]'); await p.waitForSelector('.sheet textarea');
  await p.fill('.sheet textarea', 'https://example.com/apps/Demo.ipa'); await p.waitForSelector('.hf-offer:not([hidden])', { timeout: 5000 });
  await p.click('.hf-offer .btn'); await p.waitForSelector('.ipa-sheet .ipa-installers a');
  const hrefs = await p.$$eval('.ipa-sheet .ipa-installers a', (e) => e.map((x) => x.getAttribute('href'))); console.log('installers:', hrefs.join(' | '));
  check('the link handed to SideStore, AltStore, TrollStore', hrefs.some((h) => h === 'sidestore://install?url=https%3A%2F%2Fexample.com%2Fapps%2FDemo.ipa') && hrefs.some((h) => h.startsWith('altstore://install?url=')) && hrefs.some((h) => h.startsWith('apple-magnifier://install?url=')));
  await ctx.close();
  // Not on a computer's browser.
  const c2 = await br.newContext({ viewport: { width: 1200, height: 800 } }); const p2 = await c2.newPage(); await p2.addInitScript(() => localStorage.setItem('kr.lang', 'en'));
  await p2.goto(`http://127.0.0.1:${port}/`); await p2.waitForTimeout(1200);
  const fab2 = await p2.$('.fab, .rail-fab, [data-fab]'); if (fab2) { await fab2.click(); await p2.waitForTimeout(300); }
  check('no iOS installer away from an iPhone', !(await p2.$('.fab-item[data-act="apps"]')));
  check('no page errors', !errors.length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
