// node tests/subpackwalk.cjs [en|ar]: a show's subtitle sources walked end to end, made-up names and made-up lines
// only, every site and device stubbed (nothing leaves 127.0.0.1):
//   phone (360×800): a folder (nested two levels, a fonts folder, specials and a batch left unmatched), a second
//   folder, an archive, a granted tree read live; each source's counts and its unmatched files; removed, moved up;
//   the auto-pick by language, the in-app list (grouped by source, the pick and why, nearby first, the filter), a
//   correction learned for the next episode and forgotten; a +12 pack: nothing matched, the user's pick teaching +12
//   for the next ones; a +12 pack on a 12-episode show matched by itself, a guess said in a toast; the hand-over to
//   another app (the intent's extras); the player's search (pre-filled, ranked, badges, duplicates once, other
//   languages last, more, preview, a pack used for the show, one-tap apply remembered, empty, failed + Try again,
//   slow, timed out);
//   computer (1280×800): a folder path typed, the hand-over to mpv (the request, and the shell's own arguments).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const crypto = require('node:crypto'); const { execFileSync } = require('node:child_process');
const LANG = process.argv[2] === 'ar' ? 'ar' : 'en';
const DIST = path.join(__dirname, '..', 'dist'); const REPO = path.join(__dirname, '..', '..', '..', 'repo');
const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-subpackwalk-')); const SHOTS = process.env.KT_SHOTS || path.join(MEDIA, 'shots'); fs.mkdirSync(SHOTS, { recursive: true });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const T0 = Date.now(); const step = (n) => console.log(`--- ${n} (${Math.round((Date.now() - T0) / 1000)} s)`);
const mk = (d) => fs.mkdirSync(path.join(MEDIA, d), { recursive: true });
const W = (f, x) => { mk(path.dirname(f)); fs.writeFileSync(path.join(MEDIA, f), x); };
try { mk('Download'); execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '8', '-c:v', 'libvpx', '-b:v', '200k', '-c:a', 'libopus', path.join(MEDIA, 'Download', 'clip.webm')]); }
catch { console.log('ffmpeg not available — skipped'); process.exit(0); }
const srt = (x) => `1\n00:00:00,000 --> 00:01:00,000\n${x}\n`;
const ass = (x) => `[Script Info]\nScriptType: v4.00+\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize\nStyle: Default,Caladea,40\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:01:00.00,Default,,0,0,0,,${x}\n`;
const pad = (n) => String(n).padStart(2, '0');
// Kumo (12 episodes): a group's folder with fonts, a special and a batch; an Arabic folder two levels down; a zip; a tree.
for (let e = 1; e <= 12; e++) { W(`Subs/Kumo/[Kiri] Kumo - ${pad(e)} [ABCD12${pad(e)}].ass`, ass(`KIRI EP ${e}`)); W(`Subs/KumoAr/Season 1/Arabic/Kumo - ${pad(e)}.ar.srt`, srt(`AR EP ${e}`)); }
W('Subs/Kumo/Specials/[Kiri] Kumo - NCOP.ass', ass('NCOP')); W('Subs/Kumo/[Kiri] Kumo - 01-12 [Batch].ass', ass('BATCH'));
fs.copyFileSync(path.join(__dirname, 'fixtures', 'Caladea-Bold.ttf'), (mk('Subs/Kumo/Fonts'), path.join(MEDIA, 'Subs/Kumo/Fonts/Caladea-Bold.ttf')));
const zsrc = path.join(MEDIA, 'zsrc'); fs.mkdirSync(zsrc); for (const e of [1, 2, 3]) fs.writeFileSync(path.join(zsrc, `Kumo S01E0${e}.srt`), srt(`ZIP ${e}`));
const zipOf = (out, dir) => execFileSync('python3', ['-I', '-c', 'import sys,zipfile,os\nz=zipfile.ZipFile(sys.argv[1],"w")\nfor f in sorted(os.listdir(sys.argv[2])): z.write(os.path.join(sys.argv[2],f), f)\nz.close()', out, dir]);
zipOf(path.join(MEDIA, 'Subs', 'kumo.zip'), zsrc);
for (const e of [1, 2, 3]) W(`Tree/Kumo - ${pad(e)}.vtt`, `WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nTREE ${e}\n`);
// Hana (length unknown) and Sora (12 episodes): packs numbered from 13.
for (let e = 13; e <= 24; e++) { W(`Subs/Plus/[Mori] Hana - ${e}.srt`, srt(`PLUS ${e}`)); W(`Subs/Sora/[Mori] Sora - ${e}.srt`, srt(`SORA ${e}`)); }
for (const e of [1, 2, 3, 4]) fs.copyFileSync(path.join(MEDIA, 'Download', 'clip.webm'), path.join(MEDIA, 'Download', `Kumo ${pad(e)}.webm`));
for (const e of [1, 2]) { fs.copyFileSync(path.join(MEDIA, 'Download', 'clip.webm'), path.join(MEDIA, 'Download', `Hana ${pad(e)}.webm`)); fs.copyFileSync(path.join(MEDIA, 'Download', 'clip.webm'), path.join(MEDIA, 'Download', `Sora ${pad(e)}.webm`)); }
// What the stand-in subtitle source hands out.
mk('served'); const zs2 = path.join(MEDIA, 'zs2'); fs.mkdirSync(zs2); for (const e of [1, 2, 3]) fs.writeFileSync(path.join(zs2, `Kumo - ${pad(e)}.ar.ass`), ass(`SEASON ${e} first line`)); zipOf(path.join(MEDIA, 'served', 'season.zip'), zs2);
W('served/one.ass', ass('SEARCHED EP 2')); W('served/other.srt', srt('OTHER'));

const real = (p0) => path.join(MEDIA, p0.replace(/^\/sdcard\/?/, ''));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webm': 'video/webm' };
const web = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = p.startsWith('/media/') ? path.join(MEDIA, p.slice(7)) : path.join(DIST, p);
  if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  const size = fs.statSync(f).size; const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || ''); const type = MIME[path.extname(f)] || 'application/octet-stream';
  if (range) { const a = Number(range[1]), b = range[2] ? Number(range[2]) : size - 1; res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1, 'access-control-allow-origin': '*' }); fs.createReadStream(f, { start: a, end: b }).pipe(res); return; }
  res.writeHead(200, { 'content-type': type, 'accept-ranges': 'bytes', 'content-length': size, 'access-control-allow-origin': '*' }); fs.createReadStream(f).pipe(res);
});
const al = (id, en, romaji, episodes) => ({ id, idMal: id + 1, title: { romaji, english: en, native: en, userPreferred: en }, synonyms: [], coverImage: { large: '', extraLarge: '', color: '#5c6bc0' }, format: 'TV', status: 'FINISHED', episodes, season: 'FALL', seasonYear: 2025, startDate: { year: 2025, month: 10, day: 1 }, genres: [], averageScore: 70, popularity: 1, isAdult: false, siteUrl: `https://anilist.co/anime/${id}`, nextAiringEpisode: null, mediaListEntry: null, duration: 24, description: 'Made up.', studios: { nodes: [] }, airingSchedule: { nodes: [] }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] } });
const SHOWS = { 5151: al(5151, 'Kumo', 'Kumo no Ue', 12), 5252: al(5252, 'Hana', 'Hana no Ue', null), 5353: al(5353, 'Sora', 'Sora no Ue', 12) };
// The stand-in subtitle source: what it answers is set by the test (globalThis.__subMode).
const MOD = `export async function search(q) {
  const B = globalThis.__subBase; const m = globalThis.__subMode || 'many'; (globalThis.__subQ ??= []).push({ title: q.title, episode: q.animeEpisode ?? q.episode });
  if (m === 'empty') return [];
  if (m === 'error') throw new Error('made-up failure 503');
  if (m === 'hang') return new Promise(() => {});
  if (m === 'slow') await new Promise((ok) => setTimeout(ok, 7500));
  const out = [{ title: 'Kumo - whole season [ASS]', language: 'ar', site: 'Stand-in', url: B + '/media/served/season.zip', archive: 'zip', downloads: 40 },
    { title: 'Kumo - 02 [ASS]', language: 'ar', site: 'Stand-in', url: B + '/media/served/one.ass', episode: 2, downloads: 30 },
    { title: 'Kumo - 02 [ASS]', language: 'ar', site: 'Stand-in', url: B + '/media/served/one.ass?dup', episode: 2, downloads: 3 },
    { title: 'Kumo - 02', language: 'fr', site: 'Stand-in', url: B + '/media/served/other.srt', episode: 2, downloads: 999 }];
  if (m === 'many' || m === 'slow') for (let i = 0; i < 200; i++) out.push({ title: 'Kumo - ' + String(1 + (i % 12)).padStart(2, '0') + ' v' + i, language: i % 3 ? 'en' : 'de', site: 'Stand-in', url: B + '/media/served/other.srt?' + i, episode: 1 + (i % 12), downloads: i });
  return out; }`;
(async () => {
  web.listen(0, '127.0.0.1'); await new Promise((r) => web.on('listening', r)); const port = web.address().port; const BASE = `http://127.0.0.1:${port}`;
  const ix = JSON.parse(fs.readFileSync(path.join(REPO, 'tools', 'index.json'), 'utf8'));
  ix.addons = ix.addons.filter((a) => a.kind !== 'subtitle-source'); ix.addons.find((a) => a.id === 'subtitles').children = ['subs-standin'];
  ix.addons.push({ id: 'subs-standin', kind: 'subtitle-source', parent: 'subtitles', name: 'Stand-in', description: 'A test source.', version: '1.0.0', module: 'subs/standin.mjs', sha256: crypto.createHash('sha256').update(MOD).digest('hex'), size: Buffer.byteLength(MOD), icon: 'subtitles' });
  const br = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] }); const errors = [];
  const routes = async (p) => p.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => {
    const u = r.request().url(); const m = /\/main\/repo\/(.*)$/.exec(u);
    if (m && m[1] === 'tools/index.json') return r.fulfill({ json: ix });
    if (m && m[1] === 'tools/subs/standin.mjs') return r.fulfill({ body: MOD, contentType: 'text/plain' });
    if (m) { const f = path.join(REPO, m[1]); return fs.existsSync(f) ? r.fulfill({ body: fs.readFileSync(f) }) : r.fulfill({ status: 404, body: '' }); }
    return r.fulfill({ status: 404, body: '' });
  });
  const httpStub = (o) => {
    if (/graphql\.anilist\.co/.test(o.url)) { const b = JSON.parse(o.body || '{}'); const q = b.query || ''; const id = b.variables?.id ?? (Object.keys(SHOWS).find((k) => JSON.stringify(b.variables || {}).includes(SHOWS[k].title.english)) || 5151); const show = SHOWS[id] ?? SHOWS[5151]; return { status: 200, headers: {}, body: JSON.stringify({ data: /Media\(id/.test(q) ? { Media: show } : { Page: { pageInfo: { hasNextPage: false }, media: [show] } } }) }; }
    const sv = /^http:\/\/127\.0\.0\.1:\d+\/media\/(served\/[^?]*)/.exec(o.url);
    if (sv) { const f = path.join(MEDIA, decodeURIComponent(sv[1])); if (fs.existsSync(f)) { const b = fs.readFileSync(f); return { status: 200, headers: { 'content-type': 'application/octet-stream' }, body: o.binary ? b.toString('base64') : b.toString('utf8') }; } }
    return { status: 404, headers: {}, body: '' };
  };
  const clear = (p) => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim, .toast').forEach((e) => e.remove()));
  const cue = (p, re, ms = 10000) => p.waitForFunction((s) => new RegExp(s).test(document.querySelector('.kt-subs')?.textContent || ''), re.source, { timeout: ms }).then(() => true, () => false);
  const page = async (p, id) => { await p.goto(`${BASE}/#/anime/${id}`); await p.waitForSelector('.subs-btn', { timeout: 15000 }); };
  const packSheet = async (p) => { await clear(p); await p.click('.subs-btn'); await p.waitForSelector('.pack-sheet .pack-sources'); };
  const play = async (p, e) => { await clear(p); await p.click(`.ep-row[data-ep="${e}"] button[data-icon="play"]`); await p.waitForSelector('.kt-player video.kt-video'); };
  const closePlayer = async (p) => { await clear(p); await p.click('.kt-top button[data-icon="back"]'); await p.waitForSelector('.kt-player', { state: 'detached' }); };
  const subsSheet = async (p) => { await clear(p); await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .kt-pack'); };
  const srcRows = (p) => p.$$eval('.pack-sheet .pack-src', (els) => els.map((e) => ({ path: e.dataset.path, stat: e.querySelector('.pack-src-stat')?.textContent ?? '', un: e.querySelector('.pack-unmatched-list summary')?.textContent ?? '', unList: [...e.querySelectorAll('.pack-unmatched-list .src')].map((x) => x.textContent) })));
  const waitStats = (p, n) => p.waitForFunction((n) => { const r = [...document.querySelectorAll('.pack-sheet .pack-src')]; return r.length === n && r.every((e) => /\d/.test(e.querySelector('.pack-src-stat')?.textContent ?? '')); }, n, { timeout: 10000 }).catch(() => undefined);
  const task = (id, name, meta) => ({ id, kind: 'http', name, source: { url: `https://x/${id}.webm` }, dir: '/sdcard/Download', state: 'done', done: 1, total: 1, downSpeed: 0, upSpeed: 0, files: [{ index: 0, path: name, size: 1, done: 1, priority: 1 }], addedAt: Date.now() - 60e3, doneAt: Date.now(), engine: 'native', meta });
  const TASKS = [...[1, 2, 3, 4].map((e) => task(`k${e}`, `Kumo ${pad(e)}.webm`, { anilistId: 5151, episode: e, title: 'Kumo' })), ...[1, 2].map((e) => task(`h${e}`, `Hana ${pad(e)}.webm`, { anilistId: 5252, episode: e, title: 'Hana' })), ...[1, 2].map((e) => task(`s${e}`, `Sora ${pad(e)}.webm`, { anilistId: 5353, episode: e, title: 'Sora' }))];

  /* ================= the phone ================= */
  {
    step('phone');
    const p = await br.newPage({ viewport: { width: 360, height: 800 }, hasTouch: true, isMobile: true }); p.on('pageerror', (e) => errors.push('phone: ' + e.message));
    await routes(p);
    await p.exposeFunction('__http', httpStub);
    await p.exposeFunction('__ls', (dir) => { const d = real(dir); if (!fs.existsSync(d)) return { exists: false, entries: [] }; return { exists: true, entries: fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return { name: n, path: `${dir.replace(/\/$/, '')}/${n}`, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }) }; });
    await p.exposeFunction('__vls', (vp) => { const rel = vp.replace(/^saf:\/\/0\/?/, ''); const d = path.join(MEDIA, 'Tree', rel); return { entries: fs.existsSync(d) ? fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return { name: n, dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }) : [] }; });
    await p.exposeFunction('__mkdir', (d) => { fs.mkdirSync(real(d), { recursive: true }); return {}; });
    await p.exposeFunction('__write', (o) => { fs.mkdirSync(path.dirname(real(o.path)), { recursive: true }); fs.writeFileSync(real(o.path), o.text); return {}; });
    await p.addInitScript(([port, lang, tasks]) => {
      if (!localStorage.getItem('kt.settings')) { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime', 'subtitles'], playerWith: 'app', subLangs: ['ar', 'en'], downloadDir: '/sdcard/Download', extAskWatched: false })); localStorage.setItem('kt.player', JSON.stringify({ autoSubs: false, resume: 'never' })); localStorage.setItem('kt.update.lastCheck', String(Date.now())); }
      globalThis.__subBase = `http://127.0.0.1:${port}`; window.__intents = [];
      const TREE = 'content://com.android.externalstorage.documents/tree/1234-ABCD%3ASubs';
      const api = {
        addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks }),
        localUrl: async (o) => ({ url: `http://127.0.0.1:${port}/media/${o.path.replace(/^\/sdcard\//, '')}` }), siblings: async () => ({ paths: [] }),
        filesList: async (o) => window.__ls(o.path), filesMkdir: async (o) => window.__mkdir(o.path), filesWrite: async (o) => window.__write(o), defaultDir: async () => ({ dir: '/sdcard/Download' }),
        pickDir: async () => ({ dir: window.__pickDir }), pickFile: async () => ({ paths: [window.__pickFile] }), httpRequest: async (o) => window.__http(o),
        vfsRoots: async () => ({ shell: null, trees: [{ id: 0, uri: TREE, name: 'Card' }], shizuku: false }), vfsList: async (o) => window.__vls(o.path), vfsFetch: async (o) => ({ path: `/sdcard/Tree/${o.path.replace(/^saf:\/\/0\//, '')}`, size: 1 }),
        openPlayerApp: async (o) => { window.__intents.push(o); return { code: 0, extras: {} }; },
      };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
    }, [port, LANG, TASKS]);

    step('sources on the phone');
    await page(p, 5151); await packSheet(p);
    ok('phone: no path box (that is a computer\'s)', !(await p.$('.pack-sheet .pack-path')));
    await p.evaluate(() => { window.__pickDir = '/sdcard/Subs/Kumo'; }); await p.click('.pack-sheet .pack-pick-folder'); await waitStats(p, 1);
    let rows = await srcRows(p);
    ok('a folder: its subtitle files (12 + a special + a batch, fonts not counted), 12 matched', rows.length === 1 && /14/.test(rows[0].stat) && /12/.test(rows[0].stat), rows);
    ok('…the unmatched listed: the special (nested folder) and the batch', /2/.test(rows[0].un) && rows[0].unList.some((x) => /NCOP/.test(x)) && rows[0].unList.some((x) => /Batch/.test(x)), rows[0]);
    await p.evaluate(() => { window.__pickDir = '/sdcard/Subs/KumoAr'; }); await p.click('.pack-sheet .pack-pick-folder'); await waitStats(p, 2);
    await p.evaluate(() => { window.__pickFile = '/sdcard/Subs/kumo.zip'; }); await p.click('.pack-sheet .pack-pick-archive'); await waitStats(p, 3);
    await p.evaluate(() => { window.__pickDir = 'content://com.android.externalstorage.documents/tree/1234-ABCD%3ASubs'; }); await p.click('.pack-sheet .pack-pick-folder'); await waitStats(p, 4);
    rows = await srcRows(p);
    ok('two folders, an archive and a granted tree: four sources in order', rows.length === 4 && /KumoAr/.test(rows[1].path) && /kumo\.zip/.test(rows[2].path) && /^content:/.test(rows[3].path), rows.map((r) => r.path));
    ok('the nested folder (Season 1/Arabic): 12 files, 12 matched', /12.*12/.test(rows[1].stat), rows[1]);
    ok('the archive: 3 files, 3 matched; the tree (read live, not copied): 3, 3', /3.*3/.test(rows[2].stat) && /3.*3/.test(rows[3].stat), [rows[2].stat, rows[3].stat]);
    ok('the tree shown by its name, its access said kept', /Card/.test(await p.$eval('.pack-sheet .pack-src:nth-child(4)', (e) => e.textContent)));
    // (Live: a file added to the tree later is found without adding it again.)
    W('Tree/Kumo - 04.vtt', 'WEBVTT\n\n00:00:00.000 --> 00:01:00.000\nTREE 4\n');
    await clear(p); await p.waitForTimeout(16000); await packSheet(p); await waitStats(p, 4); rows = await srcRows(p);
    ok('a file added to the tree later: found without adding it again', /4.*4/.test(rows[3].stat), rows[3]);
    await p.evaluate(() => document.querySelector('.pack-sheet .pack-sources')?.scrollIntoView({ block: 'start' })); await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, `SB-sources-${LANG}.png`) });
    await p.click('.pack-sheet .pack-src[data-path$="kumo.zip"] .pack-src-remove'); await waitStats(p, 3); rows = await srcRows(p);
    ok('a source removed: the archive gone, the others kept', rows.length === 3 && !rows.some((r) => /zip/.test(r.path)), rows.map((r) => r.path));
    await p.click('.pack-sheet .pack-src:nth-child(3) .pack-src-up'); await waitStats(p, 3); rows = await srcRows(p);
    ok('a source moved up', /^content:/.test(rows[1].path), rows.map((r) => r.path));
    await p.click('.pack-sheet .pack-src:nth-child(2) .pack-src-remove'); await waitStats(p, 2);

    step('the in-app player');
    await play(p, 2);
    ok('the pick by language: the Arabic file (Arabic first in the languages)', await cue(p, /AR EP 2/));
    await subsSheet(p); await p.waitForSelector('.sheet .kt-pack .pack-file');
    const lst = await p.evaluate(() => ({ picked: document.querySelector('.sheet .pack-picked')?.textContent ?? '', why: document.querySelector('.sheet .pack-picked .pack-why')?.textContent ?? '', heads: [...document.querySelectorAll('.sheet .kt-pack .pack-src-head')].map((x) => x.textContent), first: [...document.querySelectorAll('.sheet .kt-pack .pack-file .name')].slice(0, 3).map((x) => x.textContent), filter: !!document.querySelector('.sheet .kt-pack .pack-filter') }));
    ok('the list: the pick marked, with why (a number and the language)', /02\.ar\.srt/.test(lst.picked) && lst.why.length > 3, lst);
    ok('…grouped by source, nearby episodes first, a filter (more than 12 files)', lst.heads.length === 2 && /0[123]/.test(lst.first.join()) && lst.filter, lst);
    if (LANG === 'en') { await p.evaluate(() => document.querySelector('.sheet .kt-pack')?.scrollIntoView({ block: 'start' })); await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, 'SB-list-player-en.png') }); }
    await p.fill('.sheet .kt-pack .pack-filter', 'NCOP'); await p.waitForTimeout(150);
    ok('the filter: only the special', JSON.stringify(await p.$$eval('.sheet .kt-pack .pack-file .name', (e) => e.map((x) => x.textContent))) === '["[Kiri] Kumo - NCOP.ass"]');
    await p.fill('.sheet .kt-pack .pack-filter', '');
    await p.locator('.sheet .kt-pack .pack-file', { hasText: '[Kiri] Kumo - 02' }).click();
    ok('another file chosen: loaded at once', await cue(p, /KIRI EP 2/));
    await closePlayer(p); await play(p, 3);
    ok('the correction learned: the next episode gets the same kind', await cue(p, /KIRI EP 3/));
    await closePlayer(p); await packSheet(p);
    ok('«Forget corrections» offered', !!(await p.$('.pack-sheet .pack-forget'))); await p.click('.pack-sheet .pack-forget'); await clear(p);
    await play(p, 3); ok('forgotten: the language decides again', await cue(p, /AR EP 3/)); await closePlayer(p);

    step('a pack numbered from 13');
    await page(p, 5252); await packSheet(p); await p.evaluate(() => { window.__pickDir = '/sdcard/Subs/Plus'; }); await p.click('.pack-sheet .pack-pick-folder'); await waitStats(p, 1);
    rows = await srcRows(p); ok('length unknown: none of its 12 files matched yet', /12/.test(rows[0].stat) && /\b0\b/.test(rows[0].stat.split('·')[1] ?? ''), rows[0]);
    // (Its episodes are not listed on its page — the length unknown —: played from the downloads.)
    const playTask = async (name) => { await clear(p); await p.goto(`${BASE}/#/`); await p.waitForSelector('.task-card', { timeout: 15000 }); await p.click(`.task-card:has-text("${name}") button[aria-label="${LANG === 'ar' ? 'تشغيل' : 'Play'}"]`); await p.waitForSelector('.kt-player video.kt-video'); };
    await playTask('Hana 01'); const t1 = await p.waitForSelector('.toast', { timeout: 6000 }).then((e) => e.textContent(), () => ''); ok('episode 1: the pack has no file for it (said)', /1/.test(t1), t1);
    await subsSheet(p); await p.locator('.sheet .kt-pack .pack-file', { hasText: '- 13' }).click();
    ok('file 13 chosen for episode 1', await cue(p, /PLUS 13/));
    ok('…the +12 it teaches said, with «Forget»', !!(await p.waitForSelector('.toast.with-action', { timeout: 3000 }).catch(() => null)));
    await closePlayer(p); await playTask('Hana 02'); ok('learned: episode 2 → file 14 by itself', await cue(p, /PLUS 14/)); await closePlayer(p);
    const learned = await p.evaluate(() => JSON.parse(localStorage.getItem('kt.subPacks'))['al:5252'].learned);
    ok('…kept per show and source: +12', Object.values(learned).some((x) => x.shift === 12), learned);
    await page(p, 5353); await packSheet(p); await p.evaluate(() => { window.__pickDir = '/sdcard/Subs/Sora'; }); await p.click('.pack-sheet .pack-pick-folder');
    await p.waitForFunction(() => document.querySelectorAll('.pack-ep').length === 12 && /24/.test(document.querySelector('.pack-ep[data-ep="12"] .name')?.textContent || ''), null, { timeout: 8000 }).catch(() => undefined);
    const sora = await p.$$eval('.pack-ep .name', (e) => e.map((x) => x.textContent));
    ok('a 12-episode show with a pack numbered 13–24: every episode matched (1 → 13 … 12 → 24)', sora.length === 12 && sora.every((n, i) => n.includes(`- ${i + 13}`)), sora);
    await play(p, 1); const guess = await p.waitForSelector('.toast.with-action', { timeout: 8000 }).then((e) => e.textContent(), () => '');
    ok('played: the pick loaded, and said to be a guess with «Change»', (await cue(p, /SORA 13/)) && guess.length > 3, guess);
    if (LANG === 'ar') await p.screenshot({ path: path.join(SHOTS, 'SB-guess-toast-ar.png') });
    await p.click('.toast.with-action .toast-act'); ok('«Change» opens the list', !!(await p.waitForSelector('.sheet .kt-pack .pack-file', { timeout: 5000 }).catch(() => null)));
    await closePlayer(p);

    step('the player\'s search');
    await page(p, 5151); await play(p, 2); await cue(p, /AR EP 2/); await clear(p); await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .sub-find-btn'); await p.click('.sheet .sub-find-btn');
    await p.waitForSelector('.subs-find .sub-result', { timeout: 15000 });
    await p.waitForFunction(() => !document.querySelector('.subs-find .chip.busy'), null, { timeout: 15000 }).catch(() => undefined);
    const sr = await p.evaluate(() => ({ q: document.querySelector('.subs-find .sub-find-q')?.value, ep: document.querySelector('.subs-find .sub-find-num')?.value, rows: [...document.querySelectorAll('.subs-find .sub-result')].map((r) => ({ t: r.querySelector('.result-title')?.textContent, b: [...r.querySelectorAll('.sub-badges > *')].map((x) => x.textContent), other: r.classList.contains('other-lang') })), otherHead: !!document.querySelector('.subs-find .sub-other-head'), more: !!document.querySelector('.subs-find .sub-more') }));
    ok('pre-filled from the show and the episode (not the file\'s name)', sr.q === 'Kumo' && sr.ep === '2', { q: sr.q, ep: sr.ep });
    ok('ranked: this episode in the first language first, with its badges (language, format)', sr.rows[0] && /Kumo - 02 \[ASS\]/.test(sr.rows[0].t) && sr.rows[0].b.includes('AR') && sr.rows[0].b.includes('ASS'), sr.rows.slice(0, 3));
    ok('a duplicate (same name and language, two addresses) kept once', sr.rows.filter((r) => r.t === 'Kumo - 02 [ASS]').length === 1);
    ok('the season\'s archive badged «whole season»', sr.rows.some((r) => /whole season/.test(r.t) && r.b.length >= 2));
    ok('200+ results: 60 shown, «Show more»', sr.more && sr.rows.length === 60, { n: sr.rows.length });
    for (let i = 0; i < 5; i++) { const n0 = await p.$$eval('.subs-find .sub-result', (e) => e.length); if (!(await p.evaluate(() => { const b = document.querySelector('.subs-find .sub-more'); b?.click(); return !!b; }))) break; await p.waitForFunction((n0) => document.querySelectorAll('.subs-find .sub-result').length > n0, n0, { timeout: 5000 }).catch(() => undefined); }
    const all = await p.$$eval('.subs-find .sub-result', (els) => els.map((r) => r.classList.contains('other-lang')));
    ok('languages not asked for come last, under their own heading', !!(await p.$('.subs-find .sub-other-head')) && all.indexOf(true) > 0 && all.slice(all.indexOf(true)).every(Boolean), { n: all.length, first: all.indexOf(true) });
    await p.locator('.subs-find .sub-result', { hasText: 'whole season' }).locator('.icon-btn').click();
    await p.waitForSelector('.subs-find .sub-preview:not([hidden]) .sub-line', { timeout: 8000 }).catch(() => undefined);
    const pv = await p.$eval('.subs-find .sub-preview:not([hidden])', (e) => e.textContent).catch(() => '');
    ok('preview: the archive\'s files counted, this episode\'s first lines shown', /3/.test(pv) && /SEASON 2 first line/.test(pv), pv);
    if (LANG === 'en') { await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, 'SB-search-en.png') }); }
    await p.click('.subs-find .sub-preview:not([hidden]) .sub-use-show');
    await p.waitForFunction(() => (JSON.parse(localStorage.getItem('kt.subPacks'))['al:5151'].more || []).some((m) => /Subtitles\/Kumo/.test(m.path)), null, { timeout: 8000 }).catch(() => undefined);
    ok('«Use for this show»: the pack became one of the show\'s sources', await p.evaluate(() => (JSON.parse(localStorage.getItem('kt.subPacks'))['al:5151'].more || []).some((m) => /Subtitles\/Kumo/.test(m.path))));
    await clear(p); await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .sub-find-btn'); await p.click('.sheet .sub-find-btn'); await p.waitForSelector('.subs-find .sub-result', { timeout: 15000 });
    await p.locator('.subs-find .sub-result', { hasText: 'Kumo - 02 [ASS]' }).locator('.sub-row-main').click();
    ok('one tap applies a result', await cue(p, /SEARCHED EP 2/));
    await clear(p); await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .sub-find-btn'); await p.click('.sheet .sub-find-btn'); await p.waitForSelector('.subs-find .sub-result.applied', { timeout: 15000 }).catch(() => undefined);
    ok('…remembered for the episode: first, badged', await p.evaluate(() => document.querySelector('.subs-find .sub-result')?.classList.contains('applied')));
    const again = async (mode) => { await clear(p); await p.evaluate((m) => { globalThis.__subMode = m; }, mode); await p.click('.kt-top button[data-icon="subtitles"]'); await p.waitForSelector('.sheet .sub-find-btn'); await p.click('.sheet .sub-find-btn'); };
    await again('empty'); await p.waitForSelector('.subs-find .sub-list .empty', { timeout: 15000 }).catch(() => undefined);
    ok('nothing found: said', /\S/.test(await p.$eval('.subs-find .sub-list', (e) => e.textContent).catch(() => '')) && !(await p.$('.subs-find .sub-result')));
    await again('error'); await p.waitForSelector('.subs-find .sub-find-retry', { timeout: 15000 }).catch(() => undefined);
    const err = await p.$eval('.subs-find', (e) => e.textContent);
    ok('a failing source: said plainly, with «Try again»', /made-up failure 503/.test(err) && !!(await p.$('.subs-find .sub-find-retry')), err.slice(0, 200));
    await p.evaluate(() => { globalThis.__subMode = 'many'; }); await p.click('.subs-find .sub-find-retry'); ok('«Try again» searches again', !!(await p.waitForSelector('.subs-find .sub-result', { timeout: 15000 }).catch(() => null)));
    await again('slow'); const slow = await p.waitForSelector('.subs-find .sub-find-slow:not([hidden])', { timeout: 9000 }).then((e) => e.textContent(), () => '');
    ok('a slow source: its wait said by name', /Stand-in/.test(slow), slow); ok('…then its results', !!(await p.waitForSelector('.subs-find .sub-result', { timeout: 12000 }).catch(() => null)));
    await p.fill('.subs-find .sub-find-q', 'Kumo no Ue'); await p.click('.subs-find .sub-search button[type="submit"]'); await p.waitForSelector('.subs-find .sub-result', { timeout: 15000 });
    await again('many'); await p.waitForSelector('.subs-find .sub-find-q');
    ok('the last words kept when the search opens again', (await p.$eval('.subs-find .sub-find-q', (e) => e.value)) === 'Kumo no Ue');
    await again('hang'); const to = await p.waitForSelector('.subs-find .sub-find-fail', { timeout: 32000 }).then((e) => e.textContent(), () => '');
    ok('a source that never answers: «did not answer in time» within the budget', /Stand-in/.test(to), to);
    await p.evaluate(() => { globalThis.__subMode = 'many'; }); await closePlayer(p);

    step('the hand-over to another app');
    await p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.settings')); s.playerWith = 'external'; s.extPlayers = { android: { local: 'out' } }; localStorage.setItem('kt.settings', JSON.stringify(s)); });
    await page(p, 5151); await p.reload(); await p.waitForSelector('.subs-btn', { timeout: 15000 }); await clear(p); await p.click('.ep-row[data-ep="2"] .name, .ep-row[data-ep="2"] .grow').catch(() => undefined); await p.waitForSelector('.ep-sheet', { timeout: 5000 }).catch(() => undefined);
    const row = await p.waitForSelector('.ep-sheet .ep-sub-row', { timeout: 8000 }).then((e) => e.textContent(), () => '');
    if (process.env.KT_DEBUG) console.log('ep sheet:', await p.evaluate(() => [...document.querySelectorAll('.sheet')].map((e) => e.className + ': ' + e.textContent.slice(0, 300))), await p.$$eval('.ep-row[data-ep="2"] *', (e) => e.slice(0, 12).map((x) => x.className?.baseVal ?? x.className)));
    ok('another app the default: the episode\'s sheet shows the subtitle it will get, with «Change»', /02\.ar\.(srt|ass)/.test(row) && !!(await p.$('.ep-sheet .ep-sub-change')), row);
    await clear(p); await p.click('.ep-row[data-ep="2"] button[data-icon="play"]');
    await p.waitForFunction(() => window.__intents.length > 0, null, { timeout: 15000 }).catch(() => undefined);
    if (process.env.KT_DEBUG) console.log('screen:', await p.evaluate(() => [...document.querySelectorAll('.sheet, .toast, .kt-player')].map((e) => e.className + ': ' + e.textContent.slice(0, 160))));
    const it = await p.evaluate(() => window.__intents[0]); const ex = Object.fromEntries((it?.extras ?? []).map((e) => [e.k, e]));
    console.log('intent extras:', JSON.stringify(it?.extras ?? []).slice(0, 900));
    ok('the intent: the subtitles as a list (Uri[]), with names', ex.subs?.t === 'ua' && ex.subs.v.length >= 3 && ex['subs.name']?.v.length === ex.subs.v.length, ex);
    ok('…the pick first, named, the one enabled, and the single-subtitle extra kept', /02\.ar\.(srt|ass)/.test(ex['subs.name']?.v[0]) && ex['subs.enable']?.v[0] === ex.subs.v[0] && ex.subtitles_location?.v === ex.subs.v[0], ex);
    ok('…the nearby episodes as further choices (and the other group\'s file of this one)', ex['subs.name']?.v.some((n) => /03\.ar/.test(n)) && ex['subs.name']?.v.some((n) => /01\.ar/.test(n)) && ex['subs.name']?.v.some((n) => /\[Kiri\] Kumo - 02/.test(n)), ex['subs.name']?.v);
    ok('…every one a readable address (loopback http)', ex.subs.v.every((u) => /^http:\/\/127\.0\.0\.1:\d+\//.test(u)));
    const wrong = await p.waitForSelector('.toast.with-action', { timeout: 6000 }).then((e) => e.textContent(), () => '');
    ok('back from the app: «Wrong subtitle?»', wrong.length > 3, wrong);
    await p.close();
  }

  /* ================= the computer ================= */
  {
    step('computer');
    const p = await br.newPage({ viewport: { width: 1280, height: 800 } }); p.on('pageerror', (e) => errors.push('pc: ' + e.message)); await routes(p);
    await p.exposeFunction('__http', httpStub);
    await p.exposeFunction('__listDir', (d) => { if (!fs.existsSync(d) || !fs.statSync(d).isDirectory()) return { exists: false, entries: [] }; return { exists: true, entries: fs.readdirSync(d).map((n) => { const st = fs.statSync(path.join(d, n)); return { name: n, path: path.join(d, n), dir: st.isDirectory(), size: st.size, mtime: st.mtimeMs }; }) }; });
    await p.exposeFunction('__read', (f) => (fs.existsSync(f) ? fs.readFileSync(f).toString('base64') : null));
    const ptasks = TASKS.filter((x) => x.meta.anilistId === 5151).map((x) => ({ ...x, dir: '/videos', engine: 'aria2' }));
    await p.addInitScript(([port, lang, tasks, media]) => {
      if (!localStorage.getItem('kt.settings')) { localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['player', 'anime', 'subtitles'], playerWith: 'external', subLangs: ['ar', 'en'], extPlayers: { desktop: { local: 'out', http: 'out' } }, extAskWatched: false, settingsLayout: 'tabs' })); localStorage.setItem('kt.update.lastCheck', String(Date.now())); }
      window.__calls = []; let st = 0;
      const api = {
        platform: 'desktop', available: true, os: 'linux', list: async () => tasks, onTasks: (fn) => { setTimeout(() => fn(tasks), 50); return () => {}; }, freeSpace: async () => 5e11,
        http: async (o) => window.__http(o), listDir: async (d) => window.__listDir(d), readFile: async (f) => { const b = await window.__read(f); if (b == null) throw new Error('missing'); return Uint8Array.from(atob(b), (c) => c.charCodeAt(0)).buffer; },
        fileUrl: async (pth) => `http://127.0.0.1:${port}/media/${pth.slice(media.length + 1).split('/').map(encodeURIComponent).join('/')}?t=RUNTOKEN`, pickDir: async () => null,
        extPlayers: async () => ({ found: [{ id: 'mpv', name: 'mpv' }], chosen: null }),
        extPlayerStart: async (o) => { window.__calls.push(['extPlayerStart', o]); return { id: 'x1', reports: true }; },
        extPlayerStatus: async () => (++st < 2 ? { running: true, code: null, pos: 10, dur: 1440, eof: false } : { running: false, code: 0, pos: 30, dur: 1440, eof: false }),
        relayOpen: async (o) => ({ token: 'tok', url: 'http://127.0.0.1:3/r/tok/v/x', subs: (o.subs || []).map(() => '') }), relayClose: async () => undefined, relayStatus: async () => ({ open: false }),
        writeTemp: async (name, text) => { window.__calls.push(['writeTemp', { name, text }]); return `/tmp/kurokawa-clip/${name}`; }, extPlayerDropSub: async () => undefined, streamDone: async () => undefined,
      };
      window.kurokawaTools = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
    }, [port, LANG, ptasks, MEDIA]);
    await page(p, 5151); await packSheet(p);
    ok('computer: a box for a folder\'s path', !!(await p.$('.pack-sheet .pack-path')));
    await p.fill('.pack-sheet .pack-path', path.join(MEDIA, 'nowhere')); await p.click('.pack-sheet .pack-path-add');
    ok('a path with no folder: said, nothing added', !!(await p.waitForSelector('.toast', { timeout: 3000 }).catch(() => null)) && !(await p.$('.pack-sheet .pack-src')));
    await p.fill('.pack-sheet .pack-path', path.join(MEDIA, 'Subs', 'Kumo')); await p.click('.pack-sheet .pack-path-add'); await waitStats(p, 1);
    await p.fill('.pack-sheet .pack-path', `"${path.join(MEDIA, 'Subs', 'KumoAr')}"`); await p.press('.pack-sheet .pack-path', 'Enter'); await waitStats(p, 2);
    const prow = await srcRows(p); ok('typed paths (one pasted in quotes): two sources, counted', prow.length === 2 && /14.*12/.test(prow[0].stat) && /12.*12/.test(prow[1].stat), prow);
    await p.evaluate(() => document.querySelector('.pack-sheet .pack-sources')?.scrollIntoView({ block: 'start' })); await p.waitForTimeout(400); await p.screenshot({ path: path.join(SHOTS, `SB-pc-${LANG}.png`) });
    await clear(p); await p.click('.ep-row[data-ep="2"] button[data-icon="play"]');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'extPlayerStart'), null, { timeout: 15000 }).catch(() => undefined);
    const start = await p.evaluate(() => window.__calls.find((c) => c[0] === 'extPlayerStart')?.[1]); const temps = await p.evaluate(() => window.__calls.filter((c) => c[0] === 'writeTemp').map((c) => c[1]));
    console.log('mpv request:', JSON.stringify({ subs: start?.subs, fontsDir: start?.fontsDir, slang: start?.slang }).slice(0, 700));
    ok('to mpv: the pick first and marked, the nearby files as further subtitles, saved copies', start && start.subs.length >= 3 && start.subs[0].isDefault && start.subs.slice(1).every((s) => !s.isDefault) && start.subs.every((s) => /^\/tmp\/kurokawa-clip\/kt-sub-/.test(s.at)) && /AR EP 2/.test(temps[0]?.text ?? ''), { subs: start?.subs, t0: temps[0] });
    ok('…the pack\'s fonts folder passed; the pick\'s language first', start?.fontsDir === path.join(MEDIA, 'Subs', 'Kumo', 'Fonts') && start?.slang?.[0] === 'ar', { f: start?.fontsDir, s: start?.slang });
    // (The shell's own arguments for that request: extcmd.cjs, as the computer app runs it.)
    const X = require('../desktop/extcmd.cjs'); fs.mkdirSync(path.join(os.tmpdir(), 'kurokawa-clip'), { recursive: true });
    const q = X.check({ ...start, target: 'https://cdn.test/v/a.mkv', subs: start.subs.map((s) => ({ ...s, at: path.join(os.tmpdir(), 'kurokawa-clip', path.basename(s.at)) })) }, X.tempDirs());
    const args = q.req ? X.build('mpv', q.req).args : [];
    console.log('mpv arguments:', JSON.stringify(args.filter((a) => /^--sub|^--slang/.test(a))).slice(0, 700));
    ok('mpv\'s arguments: a --sub-file for each, the pick first, --sub-fonts-dir', q.req && args.filter((a) => a.startsWith('--sub-file=')).length === start.subs.length && args.find((a) => a.startsWith('--sub-file=')).endsWith(path.basename(start.subs[0].at)) && args.includes(`--sub-fonts-dir=${path.join(MEDIA, 'Subs', 'Kumo', 'Fonts')}`), { e: q.error, args });
    ok('…a fonts folder that is not there refused by the shell', X.check({ target: 'https://a/b', fontsDir: path.join(MEDIA, 'nofonts') }, X.tempDirs()).error === 'fonts' && X.check({ target: 'https://a/b', fontsDir: 'rel/fonts' }, X.tempDirs()).error === 'fonts');
    await p.close();
  }
  await br.close(); web.close();
  ok('no page errors', errors.length === 0, errors);
  fs.rmSync(MEDIA, { recursive: true, force: true });
  console.log(`${Math.round((Date.now() - T0) / 1000)} s`);
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.log('FAIL', e && e.stack || e); process.exit(1); });
