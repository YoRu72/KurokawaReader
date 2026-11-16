// A show's own cover, and notes and reviews (0.21 P7), against stand-in servers on loopback only (a made-up show and
// made-up users; the app's test hook window.__ktTestApi, which takes loopback addresses only):
//   covers — set from a file (made small), from an address, refused (not a web address, not a picture, an HTML page,
//     an error, too large), kept across a reload, shown on the show's page, the season chart, Discover, Continue
//     watching and the schedule, and back to the original;
//   notes — saved, edited and deleted on the device with nothing sent; the «before sending» sheet showing exactly what
//     goes; AniList's text activity (and its update), the list entry's notes (the user's own text kept), a review
//     (its minimum lengths enforced before Send), a refused send kept and sent again, a rate limit waited out and
//     reported; deleting here and online; MyAnimeList's sign-in (PKCE «plain», no secret) and its list comments, and
//     its «no reviews from apps»; the Arabic layout. Screenshots at phone and PC size.
// node tests/animenotes.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const lang = process.argv[2] || 'en';
const SHOTS = process.env.KT_SHOTS || path.join(__dirname, 'shots-animenotes'); fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
let fails = 0; const check = (what, ok, extra) => { console.log((ok ? 'ok   ' : 'FAIL ') + what + (ok || extra === undefined ? '' : '  ' + JSON.stringify(extra).slice(0, 400))); if (!ok) fails++; };

// ---- the stand-ins: the app, AniList's GraphQL, MyAnimeList's API and sign-in, and pictures ----
const calls = []; const mal = []; const flags = { refuse: 0, limit: 0 }; let png = null; let actId = 500;
let listNotes = 'My own words about it\n[Ep 1] an older line';
const SMALL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAYAAAA7KqwyAAAAEklEQVR42mP8z8DwnxEPYBxVSAoA0KkFE3ZgS1AAAAAASUVORK5CYII=', 'base64');
const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, accept', 'access-control-allow-methods': 'GET, POST, PATCH, PUT, OPTIONS', 'access-control-expose-headers': 'retry-after, content-type, content-length' };
let BASE = '';
const MEDIA = (id) => ({ id, idMal: 501, title: { romaji: 'Hoshizora Kissa', english: 'Starlit Cafe', native: '星空喫茶', userPreferred: 'Starlit Cafe' }, synonyms: [], coverImage: { large: `${BASE}/img/orig.png`, extraLarge: `${BASE}/img/orig.png`, color: '#5c6bc0' }, format: 'TV', status: 'RELEASING', episodes: 12, season: 'FALL', seasonYear: 2026, startDate: { year: 2026, month: 10, day: 1 }, genres: ['Slice of Life'], averageScore: 77, popularity: 1000, isAdult: false, siteUrl: `https://anilist.co/anime/${id}`, nextAiringEpisode: { airingAt: Math.floor(Date.now() / 1000) + 90000, episode: 6 }, mediaListEntry: null, duration: 24, description: 'A made-up show.', studios: { nodes: [{ id: 1, name: 'Made-up Studio' }] }, airingSchedule: { nodes: [1, 2, 3, 4, 5].map((e) => ({ airingAt: Math.floor(Date.now() / 1000) - (6 - e) * 604800, episode: e })) }, streamingEpisodes: [], externalLinks: [], relations: { edges: [] }, bannerImage: null, trailer: null });
const answer = (q, v) => {
  if (/SaveTextActivity/.test(q)) return { SaveTextActivity: { id: v.id ?? ++actId } };
  if (/DeleteActivity|DeleteReview/.test(q)) return { DeleteActivity: { deleted: true }, DeleteReview: { deleted: true } };
  if (/SaveMediaListEntry/.test(q)) { listNotes = v.notes; return { SaveMediaListEntry: { id: 77, notes: v.notes } }; }
  if (/SaveReview/.test(q)) return { SaveReview: { id: 900 } };
  if (/mediaListEntry \{ id notes \}/.test(q)) return { Media: { mediaListEntry: { id: 77, notes: listNotes } } };
  if (/Viewer/.test(q)) return { Viewer: { id: 9001, name: 'Test Viewer', mediaListOptions: { scoreFormat: 'POINT_10' } } };
  if (/Media\(id/.test(q)) return { Media: MEDIA(101) };
  if (/airingSchedules/.test(q)) return { Page: { pageInfo: { hasNextPage: false }, airingSchedules: [{ airingAt: Math.floor(Date.now() / 1000) + 3600, episode: 6, media: MEDIA(101) }] } };
  if (/trending: Page/.test(q)) { const p = { media: [MEDIA(101)] }; return { trending: p, airing: p, season: p, top: p, movies: p }; }
  if (/GenreCollection/.test(q)) return { GenreCollection: ['Slice of Life'], MediaTagCollection: [] };
  if (/MediaListCollection/.test(q)) return { MediaListCollection: { lists: [] } };
  if (/activities|Activity/.test(q)) return { Page: { pageInfo: { hasNextPage: false }, activities: [] } };
  return { Page: { pageInfo: { hasNextPage: false }, media: [MEDIA(101)], studios: [] } };
};
const read = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x'); const send = (status, body, type = 'application/json', extra = {}) => { res.writeHead(status, { ...cors, 'content-type': type, ...extra }); res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body)); };
  if (req.method === 'OPTIONS') return send(204, '');
  if (u.pathname === '/graphql') {
    const body = JSON.parse(await read(req)); calls.push({ ...body, auth: req.headers.authorization, at: Date.now() });
    if (/SaveTextActivity/.test(body.query) && flags.limit) { flags.limit--; return send(429, { data: null, errors: [{ message: 'Too Many Requests.', status: 429 }] }, 'application/json', { 'retry-after': '1' }); }
    if (/SaveTextActivity/.test(body.query) && flags.refuse) { flags.refuse--; return send(400, { data: null, errors: [{ message: 'Mock refusal', status: 400 }] }); }
    return send(200, { data: answer(body.query, body.variables || {}) });
  }
  if (u.pathname === '/img/orig.png') return send(200, SMALL, 'image/png');
  if (u.pathname === '/img/big.png') return send(200, png, 'image/png');
  if (u.pathname === '/img/page.html') return send(200, '<!doctype html><title>x</title>', 'text/html');
  if (u.pathname === '/img/fake.png') return send(200, 'this is text, not a picture', 'image/png');
  if (u.pathname === '/img/missing.png') return send(404, 'no', 'text/plain');
  if (u.pathname === '/img/huge.png') { const b = Buffer.alloc(21 << 20); SMALL.copy(b); return send(200, b, 'image/png'); }
  // MyAnimeList
  if (u.pathname === '/v1/oauth2/token') { const f = new URLSearchParams(await read(req)); mal.push({ token: Object.fromEntries(f), auth: req.headers.authorization }); return send(200, { token_type: 'Bearer', expires_in: 2415600, access_token: 'MAL-ACCESS-1', refresh_token: 'MAL-REFRESH-1' }); }
  if (u.pathname === '/v2/users/@me') { mal.push({ me: req.headers.authorization }); return send(200, { id: 1, name: 'mal_tester' }); }
  if (/^\/v2\/anime\/501$/.test(u.pathname) && req.method === 'GET') { mal.push({ get: u.search, auth: req.headers.authorization }); return send(200, { id: 501, my_list_status: { status: 'watching', comments: 'Mine on MAL' } }); }
  if (/^\/v2\/anime\/501\/my_list_status$/.test(u.pathname)) { const f = Object.fromEntries(new URLSearchParams(await read(req))); mal.push({ set: f, method: req.method, auth: req.headers.authorization }); return send(200, { status: 'watching', comments: f.comments }); }
  // the app
  let p = decodeURIComponent(u.pathname); if (p === '/') p = '/index.html'; const f = path.join(DIST, p);
  if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return send(404, 'no', 'text/plain');
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const mutations = () => calls.filter((c) => /^\s*mutation/.test(c.query));

(async () => {
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok)); BASE = `http://127.0.0.1:${server.address().port}`;
  const br = await chromium.launch();
  const newPage = async (viewport, phone) => {
    const ctx = await br.newContext({ viewport, ...(phone ? { hasTouch: true, isMobile: true, deviceScaleFactor: 2 } : {}) });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));   // (never the real sites)
    const p = await ctx.newPage(); p.errors = []; p.on('pageerror', (e) => p.errors.push(e.message));
    await p.addInitScript(([base, lang, phone]) => {
      window.__ktTestApi = { anilist: `${base}/graphql`, mal: base };
      if (!localStorage.getItem('kt.settings')) {
        localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['anime'], settingsLayout: 'list' }));
        localStorage.setItem('kt.anilist.token', 'MADE-UP-TOKEN'); localStorage.setItem('kt.anilist.user', JSON.stringify({ id: 9001, name: 'Test Viewer', scoreFormat: 'POINT_10' }));
        localStorage.setItem('kt.player.memory', JSON.stringify({ k1: { pos: 600, duration: 1440, at: Date.now(), anilistId: 101, episode: 3, show: 'Starlit Cafe', cover: `${base}/img/orig.png` } }));
        localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      }
      window.__opened = [];
      if (phone) {
        // (The phone's plugin, faked: its sign-in window answers with the address MyAnimeList would send it to.)
        const api = { addListener: () => Promise.resolve({ remove() {} }), list: async () => ({ tasks: [] }), httpRequest: undefined, listDir: undefined,
          captureUrl: async (o) => { window.__opened.push(o.url); const q = new URL(o.url).searchParams; return { url: `${q.get('redirect_uri')}?code=MADEUPCODE&state=${encodeURIComponent(q.get('state'))}` }; } };
        window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
      } else window.open = (u) => { window.__opened.push(u); return null; };
    }, [BASE, lang, phone]);
    return p;
  };
  const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `p7-${name}-${lang}.png`) });
  const closeSheets = (p) => p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  const sheetGone = (p, sel) => p.waitForSelector(sel, { state: 'detached', timeout: 8000 });

  // ================= the phone =================
  const p = await newPage({ width: 360, height: 780 }, true);
  // A large picture for the file and the address, made by the browser itself (1200×1800).
  await p.goto(`${BASE}/#/anime/101`); await p.waitForSelector('.anime-head');
  png = Buffer.from(await p.evaluate(async () => { const c = document.createElement('canvas'); c.width = 1200; c.height = 1800; const x = c.getContext('2d'); const g = x.createLinearGradient(0, 0, 1200, 1800); g.addColorStop(0, '#2d3a5c'); g.addColorStop(1, '#6b8f8a'); x.fillStyle = g; x.fillRect(0, 0, 1200, 1800); x.fillStyle = '#e8eef0'; x.font = 'bold 160px sans-serif'; x.fillText('MY COVER', 140, 900); const b = await new Promise((r) => c.toBlob(r, 'image/png')); const a = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); }), 'base64');
  check('the show page: the cover is a button, the notes card is there', !!(await p.$('.anime-head .cover-btn img')) && !!(await p.waitForSelector('.anime-notes', { timeout: 8000 }).catch(() => null)));
  check('the original cover first', /\/img\/orig\.png$/.test(await p.$eval('.anime-head .cover-btn img', (e) => e.getAttribute('src'))));

  // ---- covers ----
  await p.click('.anime-head .cover-btn'); await p.waitForSelector('.cover-sheet');
  check('the chooser: no reset while the cover is the original', await p.$eval('.cover-reset', (e) => e.hidden));
  await p.waitForTimeout(300); await shot(p, 'cover-chooser-phone');
  const msg = () => p.$eval('.cover-msg', (e) => ({ text: e.textContent, bad: e.classList.contains('bad') }));
  const waitMsg = () => p.waitForFunction(() => { const m = document.querySelector('.cover-msg'); return m && m.textContent && !/…$/.test(m.textContent); }, null, { timeout: 15000 });
  await p.setInputFiles('.cover-file', { name: 'mine.png', mimeType: 'image/png', buffer: png }); await waitMsg();
  let m = await msg(); const idx = () => p.evaluate(() => JSON.parse(localStorage.getItem('kt.anime.covers') || '{}')['101']);
  let info = await idx(); check('a picture from a file: kept, made small (600×900 at most)', !m.bad && info && info.from === 'file' && info.w === 600 && info.h === 900 && info.bytes < png.length, { m, info });
  check('the page shows it at once', /^blob:/.test(await p.$eval('.anime-head .cover-btn img', (e) => e.getAttribute('src'))));
  const tryUrl = async (u) => { await p.fill('.cover-url-in', u); await p.click('.cover-use'); await waitMsg(); return msg(); };
  m = await tryUrl('ftp://example.invalid/x.png'); check('not a web address: refused, said so', m.bad && m.text.length > 5, m);
  m = await tryUrl(`${BASE}/img/page.html`); check('an HTML page: refused as not a picture', m.bad, m);
  m = await tryUrl(`${BASE}/img/fake.png`); check('text named .png: refused as not a picture', m.bad, m);
  m = await tryUrl(`${BASE}/img/missing.png`); check('an error answer: refused with its status', m.bad && /404|٤٠٤/.test(m.text), m);
  m = await tryUrl(`${BASE}/img/huge.png`); check('too large: refused', m.bad && /20|٢٠/.test(m.text), m);
  check('a refused picture leaves the chosen one', (await idx())?.from === 'file');
  m = await tryUrl(`${BASE}/img/big.png`); info = await idx(); check('a picture from an address: fetched once and kept', !m.bad && info.from === 'url' && info.url === `${BASE}/img/big.png` && info.w === 600, { m, info });
  check('the reset is offered now', !(await p.$eval('.cover-reset', (e) => e.hidden)));
  await closeSheets(p);
  // Kept across a reload, and shown wherever the show's cover is.
  await p.reload(); await p.waitForSelector('.anime-head .cover-btn img');
  check('kept across a reload', /^blob:/.test(await p.$eval('.anime-head .cover-btn img', (e) => e.getAttribute('src'))));
  await p.waitForTimeout(400); await shot(p, 'show-custom-cover-phone');
  await p.goto(`${BASE}/#/anime?tab=season`); await p.waitForSelector('.anime-card img');
  check('the season chart\'s card', /^blob:/.test(await p.$eval('.anime-card img', (e) => e.getAttribute('src'))));
  await p.goto(`${BASE}/#/anime?tab=schedule`); await p.waitForSelector('.sched-row img');
  check('the schedule', /^blob:/.test(await p.$eval('.sched-row img', (e) => e.getAttribute('src'))));
  await p.goto(`${BASE}/#/anime?tab=discover`); await p.waitForSelector('.dc-poster img', { timeout: 10000 });
  check('Discover\'s posters', /^blob:/.test(await p.$eval('.dc-poster img', (e) => e.getAttribute('src'))));
  const cont = await p.waitForFunction(() => { const x = [...document.querySelectorAll('.dc-cont img')].map((e) => e.getAttribute('src')); return x.length ? x : null; }, null, { timeout: 8000 }).then((h) => h.jsonValue()).catch(() => []);
  check('Continue watching (from the player\'s history)', cont.some((s) => /^blob:/.test(s || '')), cont);
  // Back to the original.
  await p.goto(`${BASE}/#/anime/101`); await p.waitForSelector('.anime-head .cover-btn img'); await p.click('.anime-head .cover-btn'); await p.waitForSelector('.cover-sheet');
  await p.click('.cover-reset'); await p.waitForFunction(() => !JSON.parse(localStorage.getItem('kt.anime.covers') || '{}')['101']);
  check('back to the original: the page and the index', /\/img\/orig\.png$/.test(await p.$eval('.anime-head .cover-btn img', (e) => e.getAttribute('src'))) && (await p.$eval('.cover-reset', (e) => e.hidden)));
  check('...and the picture gone from the device', await p.evaluate(() => new Promise((ok) => { const r = indexedDB.open('kurokawa-tools'); r.onsuccess = () => { const q = r.result.transaction('files').objectStore('files').get('anime-cover:101'); q.onsuccess = () => ok(q.result === undefined); }; })));
  await closeSheets(p);

  // ---- notes on the device ----
  check('no notes yet: the hint', !!(await p.$('.anime-notes .hint')));
  const before = mutations().length;
  await p.click('.ep-row[data-ep="2"] .ep-title'); await p.waitForSelector('.ep-sheet .dest-row');
  await p.waitForFunction(() => document.querySelectorAll('.ep-sheet .dest-row').length >= 4, null, { timeout: 8000 });
  await p.locator('.ep-sheet .dest-row').last().click(); await p.waitForSelector('.note-sheet .note-text');
  await p.fill('.note-sheet .note-text', 'The second episode was calm and warm.'); await p.click('.note-scores .chip >> nth=8');
  await p.waitForTimeout(300); await shot(p, 'note-editor-phone');
  await p.click('.note-save'); await sheetGone(p, '.note-sheet'); await p.waitForSelector('.note-row');
  check('a note saved on the device, nothing sent', (await p.$$('.note-row')).length === 1 && mutations().length === before);
  check('its episode marked in the list', !!(await p.$('.ep-row[data-ep="2"] .ep-note-btn.on')));
  check('its score and «only on this device»', /8/.test(await p.$eval('.note-row .note-score', (e) => e.textContent)) && !(await p.$('.note-row .note-status.bad')));
  await p.click('.note-row [data-icon="pen"]'); await p.waitForSelector('.note-sheet'); await p.fill('.note-sheet .note-text', 'The second episode was calm, warm and funny.'); await p.click('.note-save'); await sheetGone(p, '.note-sheet');
  await p.waitForFunction(() => /funny/.test(document.querySelector('.note-row .note-body')?.textContent || ''));
  check('edited on the device, still nothing sent', mutations().length === before);

  // ---- the «before sending» sheet; AniList's activity ----
  await p.click('.note-row [data-icon="upload"]'); await p.waitForSelector('.send-sheet');
  check('«only on this device» setting: AniList is off until switched on, Send disabled', await p.$eval('.send-go', (e) => e.disabled));
  await p.click('.send-sheet .send-target >> nth=0 >> .switch-row'); await p.waitForSelector('.send-sheet .send-preview');
  const preview = await p.$eval('.send-sheet .send-target >> nth=0 >> .send-preview', (e) => e.textContent).catch(async () => p.$eval('.send-sheet .send-preview', (e) => e.textContent));
  check('the preview: the show, the episode, the text, the score', /Starlit Cafe/.test(preview) && /funny/.test(preview) && /★/.test(preview), preview);
  check('who will see it is said', (await p.$$('.send-sheet .send-public')).length >= 1);
  check('nothing sent before Send', mutations().length === before);
  await p.waitForTimeout(300); await shot(p, 'send-confirm-phone');
  await p.click('.send-go'); await sheetGone(p, '.send-sheet');
  let mu = mutations().slice(before); check('Send: one SaveTextActivity with exactly the text shown, no id', mu.length === 1 && /SaveTextActivity/.test(mu[0].query) && mu[0].variables.text === preview && mu[0].variables.id == null && mu[0].auth === 'Bearer MADE-UP-TOKEN', mu.map((x) => x.variables));
  await p.waitForFunction(() => !/…/.test(document.querySelector('.note-row .note-status')?.textContent || '…'));
  const firstId = actId;
  // Edited and sent again: the same activity updated.
  await p.click('.note-row [data-icon="pen"]'); await p.waitForSelector('.note-sheet'); await p.fill('.note-sheet .note-text', 'Calm, warm, funny — and a lovely ending.'); await p.click('.note-save'); await sheetGone(p, '.note-sheet');
  await p.waitForSelector('.note-row .note-status'); check('changed since it was sent: said', (await p.$eval('.note-row .note-status', (e) => e.textContent)).split('·').length >= 2);
  await p.click('.note-row [data-icon="upload"]'); await p.waitForSelector('.send-sheet .send-preview'); await p.click('.send-go'); await sheetGone(p, '.send-sheet');
  mu = mutations().slice(before); check('sent again: the same activity updated (its id)', mu.length === 2 && mu[1].variables.id === firstId, mu.map((x) => x.variables));

  // ---- the list entry's notes ----
  await p.click('.note-row [data-icon="upload"]'); await p.waitForSelector('.send-sheet .send-how');
  await p.click('.send-how .chip >> nth=1'); await p.waitForFunction(() => /^\[Ep 2\]/.test(document.querySelector('.send-sheet .send-preview')?.textContent || ''));
  await p.click('.send-go'); await sheetGone(p, '.send-sheet');
  mu = mutations().slice(before); const ln = mu[mu.length - 1];
  check('in the list notes: the user\'s own text kept, the old line kept, this line added', /SaveMediaListEntry/.test(ln.query) && ln.variables.notes === 'My own words about it\n[Ep 1] an older line\n[Ep 2] Calm, warm, funny — and a lovely ending. (8/10)' && ln.variables.status == null, ln.variables);

  // ---- refused, kept, sent again; a rate limit ----
  flags.refuse = 1;
  await p.click('.note-row [data-icon="upload"]'); await p.waitForSelector('.send-sheet .send-how'); await p.click('.send-how .chip >> nth=0'); await p.click('.send-go');
  await p.waitForSelector('.send-status.bad', { timeout: 10000 });
  check('a refused send: said, the sheet and the text kept', /Mock refusal/.test(await p.$eval('.send-status', (e) => e.textContent)) && !!(await p.$('.send-sheet')));
  await p.click('.send-go'); await sheetGone(p, '.send-sheet');
  check('sent again on «Try again»', /SaveTextActivity/.test(mutations().slice(-1)[0].query) && !flags.refuse);
  flags.limit = 2; const t0 = Date.now();
  await p.click('.note-row [data-icon="upload"]'); await p.waitForSelector('.send-sheet .send-how'); await p.click('.send-go');
  await p.waitForSelector('.send-status.bad', { timeout: 20000 });
  const lim = calls.filter((c) => c.at >= t0 && /SaveTextActivity/.test(c.query));
  check('rate limited: Retry-After waited once, then the wait reported, the text kept', lim.length === 2 && lim[1].at - lim[0].at >= 1000 && /1|١/.test(await p.$eval('.send-status', (e) => e.textContent)), lim.map((x) => x.at - t0));
  await p.waitForSelector('.note-row .note-status.bad'); check('the note row says it was not sent', true);
  await p.click('.send-go'); await sheetGone(p, '.send-sheet'); check('sent after the wait', !flags.limit && !(await p.$('.note-row .note-status.bad')));

  // ---- a review ----
  await p.click('.note-review'); await p.waitForSelector('.note-sheet .note-summary');
  check('the review\'s rules shown before writing', /2[,.]?200|٢٬?٢٠٠/.test(await p.$eval('.note-rules', (e) => e.textContent)));
  await p.fill('.note-summary', 'Short'); await p.fill('.note-sheet .note-text', 'Too short a review.');
  check('the counters say what is short', (await p.$$('.note-count.short')).length === 2);
  await p.waitForTimeout(200); await shot(p, 'review-editor-phone');
  const mBefore = mutations().length; await p.click('.note-send'); await p.waitForSelector('.send-sheet .send-problem');
  check('too short: said, Send disabled, nothing sent', await p.$eval('.send-go', (e) => e.disabled) && mutations().length === mBefore);
  await closeSheets(p); await p.waitForSelector('.note-row.is-review');
  await p.click('.note-row.is-review [data-icon="pen"]'); await p.waitForSelector('.note-sheet .note-summary');
  const body = ('A quiet show about a cafe under the stars, where every guest brings a small story. ').repeat(30);
  await p.fill('.note-summary', 'A gentle, warm show worth an evening.'); await p.fill('.note-sheet .note-text', body);
  await p.$eval('.note-sheet input[type=range]', (e) => { e.value = '85'; e.dispatchEvent(new Event('input', { bubbles: true })); });
  check('the counters agree now', (await p.$$('.note-count.short')).length === 0);
  await p.click('.note-send'); await p.waitForSelector('.send-sheet .send-preview');
  check('a review: published under the name, said; no problem', !(await p.$('.send-sheet .send-problem:not(.soft)')) && !(await p.$eval('.send-go', (e) => e.disabled)));
  check('MyAnimeList: no reviews from apps, said', (await p.$$eval('.send-target', (e) => e[1]?.textContent || '')).length > 10);
  await p.click('.send-go'); await sheetGone(p, '.send-sheet');
  const rv = mutations().slice(-1)[0]; check('SaveReview with the body, summary, score 85, public', /SaveReview/.test(rv.query) && rv.variables.mediaId === 101 && rv.variables.body === body.trim() && rv.variables.summary === 'A gentle, warm show worth an evening.' && rv.variables.score === 85 && rv.variables.private === false, rv.variables);

  // ---- MyAnimeList: signing in with one's own client (no secret), then the comments ----
  await p.goto(`${BASE}/#/settings/anime`); await p.waitForSelector('#anime .notes-settings', { state: 'attached' });
  await p.evaluate(() => { const c = document.querySelector('#anime'); if (c?.classList.contains('collapsed')) c.querySelector('h3')?.click(); });
  await p.waitForSelector('.notes-settings .notes-mal'); await p.$eval('.notes-settings', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(300); await shot(p, 'settings-notes-phone');
  await p.click('.notes-mal button'); await p.waitForSelector('.mal-sheet .mal-id');
  await p.waitForTimeout(200); await shot(p, 'mal-account-phone');
  await p.fill('.mal-id', 'made-up-client-7'); await p.click('.mal-signin'); await p.waitForSelector('.mal-sheet .track-user', { timeout: 8000 });
  const auth = new URL(await p.evaluate(() => window.__opened[0])); const tok = mal.find((x) => x.token)?.token;
  check('the sign-in page: code, PKCE plain, the client, the redirect', auth.searchParams.get('response_type') === 'code' && auth.searchParams.get('code_challenge_method') === 'plain' && auth.searchParams.get('client_id') === 'made-up-client-7' && (auth.searchParams.get('code_challenge') || '').length >= 43, auth.search);
  check('the token asked for with the code and the verifier, no secret', tok && tok.grant_type === 'authorization_code' && tok.code === 'MADEUPCODE' && tok.code_verifier === auth.searchParams.get('code_challenge') && tok.client_id === 'made-up-client-7' && !('client_secret' in tok) && !mal.find((x) => x.token).auth, tok);
  check('signed in, named', /mal_tester/.test(await p.$eval('.mal-sheet .track-user', (e) => e.textContent)));
  await closeSheets(p); await p.goto(`${BASE}/#/anime/101`); await p.waitForSelector('.note-row:not(.is-review)');
  await p.click('.note-row:not(.is-review) [data-icon="upload"]'); await p.waitForSelector('.send-sheet');
  await p.waitForFunction(() => document.querySelectorAll('.send-target')[1]?.querySelector('input[type=checkbox]')?.checked === true, null, { timeout: 8000 });
  await p.evaluate(() => { const sw = document.querySelector('.send-target input[type=checkbox]'); if (sw?.checked) sw.click(); });   // (AniList off: only MyAnimeList)
  const mBefore2 = mutations().length; await p.click('.send-go'); await sheetGone(p, '.send-sheet');
  const set = mal.find((x) => x.set); const got = mal.find((x) => x.get);
  check('MyAnimeList: the comments read, this line put under the user\'s own, sent with the token', got && /my_list_status/.test(decodeURIComponent(got.get)) && set && set.method === 'PATCH' && set.set.comments === 'Mine on MAL\n[Ep 2] Calm, warm, funny — and a lovely ending. (8/10)' && set.auth === 'Bearer MAL-ACCESS-1' && mutations().length === mBefore2, { got, set });
  check('the note says it is on MyAnimeList', (await p.$eval('.note-row:not(.is-review) .note-status', (e) => e.textContent)).split('·').length >= 2);

  // ---- deleting: here only, and here and online ----
  await p.click('.note-add-show'); await p.waitForSelector('.note-sheet'); await p.fill('.note-sheet .note-text', 'A note on the whole show.'); await p.click('.note-save'); await sheetGone(p, '.note-sheet');
  await p.waitForFunction(() => document.querySelectorAll('.note-row').length === 3);
  const mDel = mutations().length;
  await p.locator('.note-row', { hasText: 'A note on the whole show.' }).locator('[data-icon="trash"]').click();
  await p.waitForSelector('.sheet .btn.danger'); await p.click('.sheet .btn.danger'); await p.waitForFunction(() => document.querySelectorAll('.note-row').length === 2);
  check('a note never sent: deleted here, nothing sent', mutations().length === mDel);
  await p.click('.note-row:not(.is-review) [data-icon="trash"]'); await p.waitForSelector('.sheet .btn.danger'); await p.click('.sheet .btn.danger');
  await p.waitForFunction(() => document.querySelectorAll('.note-row').length === 1, null, { timeout: 10000 });
  const del = mutations().slice(mDel); const last = mal.filter((x) => x.set).slice(-1)[0];
  check('a sent note deleted here and online: its activity deleted, its MyAnimeList line taken out', del.some((x) => /DeleteActivity/.test(x.query)) && last.set.comments === 'Mine on MAL', { del: del.map((x) => x.query.slice(0, 40)), last });

  // ---- the layout ----
  check(`${lang === 'ar' ? 'right to left' : 'left to right'}, nothing wider than the screen`, (await p.evaluate(() => document.documentElement.dir || getComputedStyle(document.body).direction)) === (lang === 'ar' ? 'rtl' : 'ltr') && (await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)));
  check('no page errors (phone)', !p.errors.length, p.errors);

  // ================= the PC: the same screens at 1280×800, and MyAnimeList's paste on the web =================
  const q = await newPage({ width: 1280, height: 800 }, false);
  await q.goto(`${BASE}/#/anime/101`); await q.waitForSelector('.anime-head .cover-btn img');
  await q.click('.anime-head .cover-btn'); await q.waitForSelector('.cover-sheet'); await q.fill('.cover-url-in', `${BASE}/img/big.png`); await q.click('.cover-use');
  await q.waitForFunction(() => /^blob:/.test(document.querySelector('.cover-preview img')?.getAttribute('src') || '')); await q.waitForTimeout(300); await shot(q, 'cover-chooser-pc');
  await closeSheets(q); await q.waitForSelector('.anime-notes'); await q.waitForTimeout(300); await shot(q, 'show-custom-cover-pc');
  await q.click('.ep-row[data-ep="3"] .ep-title'); await q.waitForFunction(() => document.querySelectorAll('.ep-sheet .dest-row').length >= 4, null, { timeout: 8000 });
  await q.locator('.ep-sheet .dest-row').last().click(); await q.waitForSelector('.note-sheet'); await q.fill('.note-sheet .note-text', 'Episode three: the rain scene.'); await q.click('.note-scores .chip >> nth=7');
  await q.waitForTimeout(200); await shot(q, 'note-editor-pc');
  await q.click('.note-send'); await q.waitForSelector('.send-sheet'); await q.click('.send-sheet .send-target >> nth=0 >> .switch-row'); await q.waitForSelector('.send-sheet .send-preview'); await q.waitForTimeout(300); await shot(q, 'send-confirm-pc');
  await closeSheets(q);
  await q.goto(`${BASE}/#/settings/anime`); await q.waitForSelector('#anime .notes-settings', { state: 'attached' }); await q.evaluate(() => { const c = document.querySelector('#anime'); if (c?.classList.contains('collapsed')) c.querySelector('h3')?.click(); });
  await q.waitForSelector('.notes-settings .notes-mal'); await q.$eval('.notes-settings', (e) => e.scrollIntoView({ block: 'center' })); await q.waitForTimeout(300); await shot(q, 'settings-notes-pc');
  await q.click('.notes-mode .chip >> nth=1'); await q.waitForFunction(() => JSON.parse(localStorage.getItem('kt.settings')).animeNotesMode === 'notes');
  check('the setting kept: «Keep in my list notes»', true);
  await q.click('.notes-mal button'); await q.waitForSelector('.mal-sheet .mal-id'); await q.fill('.mal-id', 'made-up-client-8'); await q.click('.mal-signin');
  await q.waitForSelector('.mal-paste:not([hidden]), .mal-sheet .field:not([hidden]) .mal-paste');
  const opened = await q.evaluate(() => window.__opened[0]); const st = new URL(opened).searchParams.get('state');
  await q.fill('.mal-paste', `http://localhost/kurokawa-mal?code=WEBCODE&state=${st}`); await q.click('.mal-sheet .field .btn.primary'); await q.waitForSelector('.mal-sheet .track-user', { timeout: 8000 });
  check('the web: the sign-in opened in a tab, the address pasted, signed in', mal.some((x) => x.token && x.token.code === 'WEBCODE'));
  check('no page errors (PC)', !q.errors.length, q.errors);

  await br.close(); server.close();
  console.log(fails ? `${fails} FAILED` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
