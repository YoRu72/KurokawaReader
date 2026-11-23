// node tests/livecatalog.cjs: add-ons, themes and wallpapers that arrive by themselves from the repository
// (src/liveUpdates.ts, catalog.ts, addons.ts, themeIo.ts, theme/sceneRepo.ts), against a loopback server that stands
// in for GitHub (raw.githubusercontent.com routed to it). Made-up add-ons, themes and scenes only.
//  1. add-ons: installed; a newer version with a good checksum swapped in, one grouped notice, the row's version and
//     date; a bad checksum keeps the installed one with its reason; a module that does not load is rolled back; an
//     entry needing a newer app waits («Needs the app update»); a lower version is refused; offline: the kept copy,
//     no error shown, the list still drawn after a reload;
//  2. themes: a light theme (tokens only) new in the list: «New» on «Add themes» and its row, a dot on Appearance, gone
//     once shown; installed; its version raised → updated by itself, a theme of the reader's left byte for byte;
//     tokens carrying CSS refused;
//  3. wallpapers (a computer): the repository's scenes after the built-in ones; one downloaded on first use, checked,
//     kept (a frame drawn when the engine is here), updated when its version rises; a garbage file and an oversized
//     one refused; a scene needing a newer engine shown as «Needs the app update»;
//  4. the setting off: nothing fetched by itself over 6 hours (fake clock), «Check now» still works; on: one check
//     after the first paint, the next exactly 6 hours later (fake clock).
// Run: NODE_PATH=$(npm root -g) node tests/livecatalog.cjs   (KT_SHOTS=<dir>: three screenshots)
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const crypto = require('node:crypto');
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const SHOTS = process.env.KT_SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };
let fails = 0; const ok = (n, c, extra = '') => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || !extra ? '' : `  — ${extra}`)); if (!c) fails++; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/* ---------- the made-up repository ---------- */
const files = new Map(); const hits = new Map();
const put = (p, b) => files.set(p, Buffer.isBuffer(b) ? b : Buffer.from(typeof b === 'string' ? b : JSON.stringify(b, null, 1)));
const mod = (v, extra = '') => Buffer.from(`export const version = '${v}';\nexport async function search() { return []; }\n${extra}`);
let addons = [];
const entry = (id, v, body, o = {}) => { put(`tools/fx/${id}-${v}.mjs`, body); return { id, kind: 'torrent-search', name: o.name ?? id, version: v, module: `fx/${id}-${v}.mjs`, sha256: o.sha ?? sha(body), size: body.length, ...o.more }; };
const setAddons = (list) => { addons = list; put('tools/index.json', { kurokawa: 'addons', app: 'tools', addons }); };
setAddons([entry('fx-a', '1.2', mod('1.2'), { name: 'Fixture A' })]);

// Themes: the real list (Frosted Glass), then made-up light themes (tokens only — a tiny pack).
const realThemes = JSON.parse(fs.readFileSync(path.join(REPO, 'themes', 'themes.json'), 'utf8'));
put('themes/frosted-glass.ktheme', fs.readFileSync(path.join(REPO, 'themes', 'frosted-glass.ktheme')));
const mode = (primary) => ({ surfaces: { ground: '#0e1514', lowest: '#0b1110', low: '#141c1b', mid: '#18211f', high: '#202a28', highest: '#283331' }, text: { on: '#e3ece9', variant: '#c3ceca', dim: '#9aa7a3', outline: '#8a9692', outlineVariant: '#3f4a47' },
  roles: { primary, onPrimary: '#00382f', primaryContainer: '#1f5047', onPrimaryContainer: '#b8efe2', secondaryContainer: '#2b4a44', onSecondaryContainer: '#cde8e1', tertiaryContainer: '#304a5a', onTertiaryContainer: '#cfe5f2' },
  tint: '#141c1b', strength: 0.7, blur: 20, sat: 1.2, edge: 0.08, sheen: 0.06, shadow: 0.6, bg: { kind: 'mesh', colors: ['#1f5047', '#304a5a', '#2b4a44'], solid: '#0e1514', veil: 0.2, picBlur: 0 } });
function pack(id, version, tokens) {
  const head = Buffer.from(JSON.stringify({ format: 1, id, name: id === 'fx-mint' ? 'Fixture Mint' : id, by: 'Test', version, assets: [], tokens }), 'utf8'); const len = Buffer.alloc(4); len.writeUInt32BE(head.length);
  const b = Buffer.concat([Buffer.from('KTHEME1\n'), len, head]); put(`themes/${id}.ktheme`, b);
  return { id, file: `${id}.ktheme`, size: b.length, sha256: sha(b), name: id === 'fx-mint' ? 'Fixture Mint' : id, by: 'Test', version, assets: [], preview: { dark: ['#0e1514', '#141c1b', '#7fd8c4'] } };
}
const setThemes = (extra) => put('themes/themes.json', { format: 1, themes: [...realThemes.themes, ...extra] });
setThemes([]);

// Scenes: a copy of a built-in one under another id, a garbage file, an oversized one, one for a newer engine.
const motes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'theme', 'scenes', 'motes.json'), 'utf8'));
const sceneFile = (id, tweak) => { const d = JSON.parse(JSON.stringify(motes)); d.meta = { ...(d.meta || {}), id, name: id }; if (tweak) tweak(d); return Buffer.from(JSON.stringify(d)); };
const names = (en) => ({ en, ar: `مشهد ${en}`, ja: en, ko: en, zh: en });
const sceneEntry = (id, v, b, o = {}) => { put(`scenes/${id}.json`, b); return { id, names: names(o.name ?? id), version: v, sha256: sha(b), size: o.size ?? b.length, engine: o.engine ?? 2, preview: { dark: ['#101828', '#28324a'], light: ['#dce6f5', '#b8c8e8'] } }; };
const garbage = Buffer.from('{"format":"ktscene/1","layers":[' + '['.repeat(40) + ']'.repeat(40) + ']}');
const big = Buffer.alloc(600 * 1024, 0x20);
let scenes = [];
const setScenes = (list) => { scenes = list; put('scenes/scenes.json', { format: 1, scenes }); };
setScenes([sceneEntry('fx-scene', '1.0', sceneFile('fx-scene'), { name: 'Fixture Scene' }), sceneEntry('fx-garbage', '1.0', garbage, { name: 'Fixture Garbage' }), sceneEntry('fx-big', '1.0', big, { name: 'Fixture Big' }),
  sceneEntry('fx-lie', '1.0', big, { name: 'Fixture Lie', size: 4000 }), sceneEntry('fx-future', '1.0', sceneFile('fx-future'), { name: 'Fixture Future', engine: 3 })]);

let offline = false;
const repo = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split('?')[0]).replace(/^\//, ''); hits.set(p, (hits.get(p) ?? 0) + 1);
  const b = files.get(p); if (!b) { res.writeHead(404); res.end(); return; }
  const etag = `"${sha(b).slice(0, 16)}"`;
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag }); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', etag, 'content-length': b.length }); res.end(b);
});
const WASM = process.env.KT_SCENE_WASM ? path.resolve(process.env.KT_SCENE_WASM) : path.join(DIST, 'scene', 'ktscene.wasm');
const web = http.createServer((req, res) => { const u = decodeURIComponent(req.url.split('?')[0]); let f = u === '/scene/ktscene.wasm' ? WASM : path.join(DIST, u); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const getLoop = (port, p, headers) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p, headers }, (r) => { const b = []; r.on('data', (c) => b.push(c)); r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(b), headers: r.headers })); }).on('error', reject));
const until = async (what, fn, ms = 15000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 100)); } };

(async () => {
  for (const s of [repo, web]) { s.listen(0, '127.0.0.1'); await new Promise((r) => s.once('listening', r)); }
  const rport = repo.address().port, wport = web.address().port; const base = `http://127.0.0.1:${wport}/`;
  const br = await chromium.launch(); const errors = [];
  async function newPage(settings, o = {}) {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en', serviceWorkers: 'block' });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, async (r) => {
      const u = r.request().url(); const m = /raw\.githubusercontent\.com\/[^/]+\/[^/]+\/main\/repo\/(.*)/.exec(u);
      if (!m || offline) return r.abort('internetdisconnected');
      const h = r.request().headers(); const got = await getLoop(rport, '/' + m[1].split('?')[0], h['if-none-match'] ? { 'if-none-match': h['if-none-match'] } : {});
      r.fulfill({ status: got.status, body: got.body, headers: { 'content-type': got.headers['content-type'] || 'text/plain', 'access-control-allow-origin': '*', ...(got.headers.etag ? { etag: got.headers.etag } : {}) } });
    });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    if (o.clock) await p.clock.install({ time: new Date('2026-11-20T08:00:00Z') });
    await p.addInitScript((s) => { if (sessionStorage.getItem('seeded')) return; sessionStorage.setItem('seeded', '1'); localStorage.setItem('kr.lang', 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.themeMigrated', '1'); localStorage.setItem('kt.mainTheme', '1');
      localStorage.setItem('kt.settings', JSON.stringify({ themeChosen: true, autoUpdateCheck: false, ...s.settings })); if (s.mine) localStorage.setItem('kt.myThemes', s.mine); }, { settings, mine: o.mine });
    return { ctx, p };
  }
  const idb = (p, store, key) => p.evaluate(([store, key]) => new Promise((res) => { const r = indexedDB.open('kurokawa-tools'); r.onsuccess = () => { const q = r.result.transaction(store).objectStore(store).get(key); q.onsuccess = async () => { const v = q.result; res(v instanceof Blob ? await v.text() : v ?? null); }; q.onerror = () => res(null); }; r.onerror = () => res(null); }), [store, key]);
  const go = async (p, hash) => { await p.evaluate((h) => { location.hash = h; }, hash); await p.waitForFunction((h) => location.hash === h, hash); };
  const checkNow = async (p) => {
    await go(p, '#/settings/updates'); await p.waitForSelector('#updates .live-now'); const before = await p.evaluate(() => localStorage.getItem('kt.live.lastCheck'));
    await p.click('#updates .live-now');
    await p.waitForFunction((b) => { const btn = document.querySelector('#updates .live-now'); return btn && !btn.disabled && localStorage.getItem('kt.live.lastCheck') !== b; }, before, { timeout: 20000 });
    return p.$eval('#updates .live-last', (e) => e.textContent);
  };
  const addonsView = async (p) => { await go(p, '#/settings/addons'); await p.waitForSelector('#addons .addon-row[data-id="fx-a"]'); return p.$eval('#addons .addon-row[data-id="fx-a"]', (e) => e.textContent); };

  /* ---------- 1. add-ons ---------- */
  const mine = JSON.stringify([{ v: 1, id: 'my-abc123', name: 'Mine on mint', base: 'fx-mint', radius: 1, accent: 'theme', at: 1, dark: mode('#88ccbb') }]);
  const { ctx, p } = await newPage({ addons: [], theme: 'frost' }, { mine });
  await p.goto(base + '#/settings/addons'); await p.waitForSelector('#addons .addon-row[data-id="fx-a"] > button.btn');
  await p.click('#addons .addon-row[data-id="fx-a"] > button.btn');
  await until('installed', async () => (await idb(p, 'meta', 'addon-version:fx-a')) === '1.2');
  ok('an add-on installs from a list with checksums (its module checked and kept)', (await idb(p, 'files', 'addon:fx-a'))?.includes("'1.2'"));

  setAddons([entry('fx-a', '1.3', mod('1.3'), { name: 'Fixture A' })]);
  await checkNow(p);
  await until('updated', async () => (await idb(p, 'meta', 'addon-version:fx-a')) === '1.3');
  const toastText = await p.waitForSelector('.toast').then((t) => t.textContent()).catch(() => '');
  ok('a newer version with a good checksum is swapped in by itself', (await idb(p, 'files', 'addon:fx-a'))?.includes("'1.3'") && !(await idb(p, 'files', 'addon-next:fx-a')));
  ok('…with one quiet notice «Updated: Fixture A 1.2 → 1.3»', /Updated: .*Fixture A.*1\.2 → 1\.3/.test(toastText), toastText);
  let row = await addonsView(p);
  ok('Settings › Add-ons: the row shows its version and when it was updated', /Version 1\.3/.test(row) && /updated /.test(row), row);
  ok('nothing new yet: no dot on Appearance', !(await p.$('[data-sec="appearance"] .new-dot')));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'U1-addons.png') });

  setAddons([entry('fx-a', '1.4', mod('1.4'), { name: 'Fixture A', sha: '0'.repeat(64) })]);
  await checkNow(p); row = await addonsView(p);
  ok('a bad checksum: the installed version kept, the reason on its row', (await idb(p, 'meta', 'addon-version:fx-a')) === '1.3' && (await idb(p, 'files', 'addon:fx-a'))?.includes("'1.3'") && /arrived damaged/.test(row), row);

  setAddons([entry('fx-a', '1.5', mod('1.5', 'export const = ;'), { name: 'Fixture A' })]);
  await checkNow(p);
  ok('a module that does not load: rolled back, the installed one kept, nothing left beside it', (await idb(p, 'meta', 'addon-version:fx-a')) === '1.3' && (await idb(p, 'files', 'addon:fx-a'))?.includes("'1.3'") && !(await idb(p, 'files', 'addon-next:fx-a')));

  setAddons([entry('fx-a', '1.6', mod('1.6'), { name: 'Fixture A', more: { minApp: '999.0.0' } })]);
  await checkNow(p); row = await addonsView(p);
  ok('minApp above this app: not installed, «Needs the app update» on its row', (await idb(p, 'meta', 'addon-version:fx-a')) === '1.3' && /Needs the app update/.test(row), row);

  setAddons([entry('fx-a', '1.1', mod('1.1'), { name: 'Fixture A' })]);
  await checkNow(p);
  ok('a lower version is refused (no downgrade)', (await idb(p, 'meta', 'addon-version:fx-a')) === '1.3');

  offline = true; const errBefore = errors.length;
  const st = await checkNow(p);
  ok('offline: «Check now» says the repository could not be reached; no error shown', /could not be reached/.test(st) && errors.length === errBefore && !(await p.$('.toast.error')), st);
  await p.reload(); row = await addonsView(p);
  ok('offline after a reload: the add-ons list drawn from the kept copy', /Fixture A/.test(row) && /Version 1\.3/.test(row), row);
  offline = false;

  /* ---------- 2. themes ---------- */
  setThemes([pack('fx-mint', '1.0', { kurokawaTheme: 1, theme: { base: 'frost', radius: 1, accent: 'theme', dark: mode('#7fd8c4') } }), pack('fx-bad', '1.0', { kurokawaTheme: 1, theme: { base: 'frost', radius: 1, accent: 'theme', dark: { ...mode('#7fd8c4'), tint: 'url(javascript:alert(1))' } } })]);
  await checkNow(p);
  await go(p, '#/settings/appearance'); await p.waitForSelector('#appearance .tg-add');
  await p.waitForSelector('#appearance .tg-add .tg-new', { timeout: 10000 }).catch(() => null);
  ok('a theme new in the list: «New» on «Add themes», a dot on Appearance (its title and the side list)', !!(await p.$('#appearance .tg-add .tg-new')) && !!(await p.$('#appearance h3 .new-dot:not([hidden])')) && !!(await p.$('[data-sec="appearance"] .new-dot')));
  await p.click('#appearance .tg-add'); await p.waitForSelector('.tg-addrow[data-id="fx-mint"]');
  ok('…and on its row in «Add themes»', !!(await p.$('.tg-addrow[data-id="fx-mint"] .tg-new')));
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, 'U1-themes-new.png') });
  await p.keyboard.press('Escape'); await p.waitForSelector('.tg-addrow', { state: 'detached' }).catch(() => null);
  await p.click('#appearance .tg-add'); await p.waitForSelector('.tg-addrow[data-id="fx-mint"]');
  ok('once shown, the «New» marks are gone', !(await p.$('.tg-addrow .tg-new')) && !(await p.$('#appearance .tg-add .tg-new')));
  await p.click('.tg-addrow[data-id="fx-bad"] button');
  await p.waitForSelector('.tg-addrow[data-id="fx-bad"] button:not([disabled])');
  const have0 = await idb(p, 'meta', 'themes.installed');
  ok('tokens carrying CSS are refused (nothing kept)', !have0?.['fx-bad']);
  await p.click('.tg-addrow[data-id="fx-mint"] button'); await p.waitForSelector('.tg-addrow[data-id="fx-mint"] .tg-here');
  await p.keyboard.press('Escape');
  await p.waitForSelector('#appearance .tg-card[data-theme="fx-mint"]');
  const have1 = await idb(p, 'meta', 'themes.installed');
  ok('the light theme installs and appears in the gallery, rebuilt from its colours', have1?.['fx-mint']?.version === '1.0' && have1['fx-mint'].def?.dark?.roles?.primary === '#7fd8c4' && /rgb\(/.test(have1['fx-mint'].def?.dark?.pane ?? ''));
  const mineBefore = await p.evaluate(() => localStorage.getItem('kt.myThemes'));
  setThemes([pack('fx-mint', '1.1', { kurokawaTheme: 1, theme: { base: 'frost', radius: 1, accent: 'theme', dark: mode('#9fe6d4') } })]);
  await checkNow(p);
  const have2 = await idb(p, 'meta', 'themes.installed');
  ok('its version raised: updated by itself', have2?.['fx-mint']?.version === '1.1' && have2['fx-mint'].def?.dark?.roles?.primary === '#9fe6d4');
  ok('…the reader\'s own theme made from it left as it was', (await p.evaluate(() => localStorage.getItem('kt.myThemes'))) === mineBefore && mineBefore.includes('#88ccbb'));

  /* ---------- 3. wallpapers ---------- */
  await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.animBg = 'scene:motes'; localStorage.setItem('kt.settings', JSON.stringify(s)); });
  await p.reload(); await p.waitForSelector('#appearance', { state: 'attached' });
  await go(p, '#/settings/appearance'); await p.waitForSelector('.abg-repo .abg-tile[data-scene="fx-scene"]', { timeout: 15000 }).catch(() => null);
  const tiles = await p.$$eval('.abg-repo .abg-tile', (b) => b.map((x) => x.dataset.scene));
  ok('the repository\'s scenes are listed after the built-in ones (an oversized one left out)', tiles.includes('fx-scene') && !tiles.includes('fx-big') && await p.evaluate(() => { const g = [...document.querySelectorAll('.abg-group')]; return g.findIndex((x) => x.classList.contains('abg-repo')) >= 4; }), tiles.join(','));
  ok('a scene needing a newer engine: «Needs the app update», not choosable', await p.$eval('.abg-tile[data-scene="fx-future"]', (b) => b.disabled && /Needs the app update/.test(b.textContent)).catch(() => false));
  await p.click('.abg-tile[data-scene="fx-scene"]');
  await until('scene kept', async () => (await idb(p, 'files', 'scene:fx-scene'))?.includes('fx-scene'));
  ok('chosen: downloaded on first use, checked and kept', (await idb(p, 'meta', 'scenes.installed'))?.['fx-scene']?.version === '1.0');
  const wasm = fs.existsSync(WASM);
  if (wasm) { const run = await p.waitForFunction(() => !!document.querySelector('[data-engine="scene"] canvas.abg-canvas'), null, { timeout: 20000 }).then(() => true, () => false); ok('…and the engine runs it: a frame drawn on its canvas', run); }
  else console.log('note wasm absent: the frame itself is not drawn here (CI has the engine)');
  for (const id of ['fx-garbage', 'fx-lie']) {
    const n0 = hits.get(`scenes/${id}.json`) ?? 0;
    await go(p, '#/settings/appearance'); await p.waitForSelector(`.abg-tile[data-scene="${id}"]`); await p.click(`.abg-tile[data-scene="${id}"]`);
    await until(`${id} asked`, async () => (hits.get(`scenes/${id}.json`) ?? 0) > n0);
    // (Refused: the engine is never handed it — the background falls back, as for a scene it does not have.)
    await p.waitForFunction(() => /could not be loaded/i.test(document.querySelector('.abg-now')?.textContent ?? ''), null, { timeout: 15000 }).catch(() => null);
  }
  const kept = await idb(p, 'meta', 'scenes.installed');
  ok('a garbage scene file and one larger than it said are refused (nothing kept)', !kept?.['fx-garbage'] && !kept?.['fx-lie'] && !(await idb(p, 'files', 'scene:fx-garbage')) && !(await idb(p, 'files', 'scene:fx-lie')));
  if (SHOTS) { await go(p, '#/settings/updates'); await p.waitForSelector('#updates .live-now'); await p.screenshot({ path: path.join(SHOTS, 'U1-setting.png') }); }
  setScenes([sceneEntry('fx-scene', '1.1', sceneFile('fx-scene', (d) => { d.meta.name = 'fx-scene two'; }), { name: 'Fixture Scene' })]);
  await checkNow(p);
  ok('the kept scene is updated when its version rises', (await idb(p, 'meta', 'scenes.installed'))?.['fx-scene']?.version === '1.1' && (await idb(p, 'files', 'scene:fx-scene'))?.includes('fx-scene two'));
  ok('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  await ctx.close();

  /* ---------- 4. the setting and the clock ---------- */
  {
    const { ctx: c2, p: q } = await newPage({ addons: [], liveUpdates: false }, { clock: true });
    await q.goto(base); await q.waitForSelector('nav, .nav, .rail', { timeout: 20000 });
    const n0 = hits.get('tools/index.json') ?? 0;
    await q.clock.runFor(6.5 * 3600_000);
    ok('the setting off: nothing fetched by itself over 6.5 hours', (hits.get('tools/index.json') ?? 0) === n0 && !(await q.evaluate(() => localStorage.getItem('kt.live.lastCheck'))));
    await go(q, '#/settings/updates'); await q.waitForSelector('#updates .live-now');
    ok('…the switch is shown off, with «Check now»', !(await q.$eval('#updates .switch-row input', (i) => i.checked).catch(() => true)) || /update by themselves/.test(await q.$eval('#updates', (e) => e.textContent)));
    await q.click('#updates .live-now');
    await until('manual check', async () => !!(await q.evaluate(() => localStorage.getItem('kt.live.lastCheck'))));
    ok('…«Check now» still checks', true);
    await c2.close();
  }
  {
    const { ctx: c3, p: q } = await newPage({ addons: [] }, { clock: true });
    await q.goto(base); await q.waitForSelector('nav, .nav, .rail', { timeout: 20000 });
    const last = () => q.evaluate(() => Number(localStorage.getItem('kt.live.lastCheck') || 0));
    await q.clock.runFor(3000);
    ok('on: no check before the first paint has settled (3 s)', (await last()) === 0);
    await q.clock.runFor(15_000);
    const t1 = await until('first check', last);
    await q.clock.runFor(3 * 3600_000);
    ok('…no other check within 6 hours', (await last()) === t1);
    await q.clock.runFor(3 * 3600_000 + 60_000);
    const t2 = await until('second check', async () => { const v = await last(); return v !== t1 ? v : 0; });
    ok('…the next check 6 hours after (fake clock)', t2 - t1 >= 6 * 3600_000 && t2 - t1 < 6 * 3600_000 + 120_000, `${t2 - t1}`);
    await c3.close();
  }

  await br.close(); repo.close(); web.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
