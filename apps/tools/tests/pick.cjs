// Picking files from a batch, the desktop bridge faked: a magnet pasted in the Add sheet shows its files with each
// episode read from the name and the extras (creditless openings, previews) left unticked; «this range» ticks only
// those episodes; the download is added with just the ticked files.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = (root) => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(root, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
(async () => {
  const web = serve(DIST).listen(0); const port = web.address().port;
  const br = await chromium.launch(); const p = await br.newPage({ viewport: { width: 420, height: 860 } });
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  await p.addInitScript(() => {
    const tasks = []; window.__added = [];
    const files = [
      ...Array.from({ length: 12 }, (_, i) => ({ index: i, path: `[Group] Show (BD 1080p)/[Group] Show - ${String(i + 1).padStart(2, '0')} (BD 1080p) [ABCD1234].mkv`, size: 1.2e9 })),
      { index: 12, path: '[Group] Show (BD 1080p)/Extras/[Group] Show - NCOP1 (BD 1080p).mkv', size: 1e8 },
      { index: 13, path: '[Group] Show (BD 1080p)/Extras/[Group] Show - NCED1 (BD 1080p).mkv', size: 1e8 },
      { index: 14, path: '[Group] Show (BD 1080p)/Extras/[Group] Show - PV1.mkv', size: 5e7 },
      { index: 15, path: '[Group] Show (BD 1080p)/[Group] Show - 03 (BD 1080p) [ABCD1234].ass', size: 4e4 },
      { index: 16, path: '[Group] Show (BD 1080p)/Fonts/Roboto.ttf', size: 2e5 },
    ];
    window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => { window.__added.push(o); return { id: 't1', name: 'Show', ...o }; }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {},
      torrentInfo: async () => { await new Promise((r) => setTimeout(r, 150)); return { name: '[Group] Show (BD 1080p)', infoHash: 'a'.repeat(40), total: 1, files }; },
      open: async () => {}, defaultDir: async () => '/home/u/Downloads/Kurokawa', pickDir: async () => '/mnt/x', onTasks: (cb) => { cb(tasks); return () => {}; } };
  });
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet textarea');
  await p.fill('.sheet textarea', 'magnet:?xt=urn:btih:' + 'a'.repeat(40) + '&dn=Show'); await p.waitForSelector('.file-chooser .pick-row');
  const rows = await p.$$eval('.pick-row', (r) => r.map((x) => ({ name: x.querySelector('.pick-name').textContent, tags: x.querySelector('.src')?.textContent ?? '', on: x.querySelector('input').checked, extra: x.classList.contains('extra') })));
  console.log(rows.map((r) => `${r.on ? '[x]' : '[ ]'} ${r.name} — ${r.tags}`).join('\n'));
  check('episodes ticked', rows.filter((r) => /Show - \d\d \(BD/.test(r.name) && r.name.endsWith('.mkv')).every((r) => r.on));
  check('extras marked and unticked', ['NCOP1', 'NCED1', 'PV1'].every((k) => { const r = rows.find((x) => x.name.includes(k)); return r && r.extra && !r.on; }));
  check('episode numbers read', rows.some((r) => /Episode 7/.test(r.tags)));
  check('episodes sorted first, in order', /- 01 /.test(rows[0].name) && /- 02 /.test(rows[1].name));
  await p.screenshot({ path: 'shot-pick-add.png' });
  // A range: episodes 3–5 (and episode 3's subtitles).
  await p.fill('.pick-range input >> nth=0', '3'); await p.fill('.pick-range input >> nth=1', '5'); await p.click('.pick-range button');
  const on = await p.$$eval('.pick-row', (r) => r.filter((x) => x.querySelector('input').checked).map((x) => x.querySelector('.pick-name').textContent));
  console.log('range:', on.join(' | ')); check('range picks 3–5 and the subtitles', on.length === 4 && on.some((x) => x.endsWith('.ass')));
  console.log('total:', await p.$eval('.file-chooser .models-total', (e) => e.textContent));
  await p.click('.sheet .btn.primary'); await p.waitForFunction(() => window.__added.length);
  const added = await p.evaluate(() => window.__added[0]); console.log('added files:', JSON.stringify(added.files));
  check('added with the ticked files only', JSON.stringify([...added.files].sort((a, b) => a - b)) === JSON.stringify([2, 3, 4, 15]));
  // None ticked: refused.
  await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet textarea');
  await p.fill('.sheet textarea', 'magnet:?xt=urn:btih:' + 'b'.repeat(40)); await p.waitForSelector('.file-chooser .pick-row');
  await p.click('.pick-tools .chip:has-text("Deselect all")'); await p.click('.sheet .btn.primary'); await p.waitForSelector('.toast:has-text("No file")');
  check('nothing ticked is refused', (await p.evaluate(() => window.__added.length)) === 1);
  // The + button tapped again while its menu is open closes it (it once threw «Cannot access … before initialization»).
  await p.keyboard.press('Escape'); await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.click('.fab'); await p.waitForSelector('.fab-menu'); await p.evaluate(() => document.querySelector('.fab').click()); await p.waitForTimeout(200);
  check('the + button closes its menu', !(await p.$('.fab-menu')));
  check('no page errors', !errors.filter((e) => e !== 'no page errors').length);
  await br.close(); web.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
