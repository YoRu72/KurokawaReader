// node tests/readingdict.cjs [en|ar]: the dictionaries behind furigana (Japanese) and pinyin (Chinese) — their notice over a
// book, their rows in Settings and in the reader's text options (src/readingdict.ts, src/ui/readingdict.ts):
//  1. the notice offers a Download button with the size (never an error-coloured block, one at a time);
//  2. the download shows progress, and the readings appear in the open book without reopening it;
//  3. a failure says why (offline, a server error, a damaged file) and offers Try again; what was finished is kept, not asked
//     for again, and a damaged file is never kept;
//  4. once downloaded the book reads with no network at all;
//  5. Settings and the text options show the state (not downloaded / downloading % / downloaded + size) with Download /
//     Cancel / Remove; Remove takes it off the device;
//  6. a closed notice stays closed (for that book, whatever else is changed) until the option is turned on again;
//  7. pinyin does the same; the offer in the selection's popover; a device copy that will not build (loader error, no answer, offline) falls back to the CDN way once, or says so with Try again / Remove and download again; 8. nothing is left listening once a panel or a book is gone; a download cancelled leaves no half file.
// Nothing reaches a real site: every request outside this machine is answered here (made-up files) or refused.
// Pictures (phone 360 px, PC 1280x800) go to $KR_SHOTS (default: the temp folder).
const { chromium } = require('playwright'); const esbuild = require('esbuild'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const lang = process.argv[2] || 'en';
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const SHOTS = process.env.KR_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kr-readingdict-shots-')); fs.mkdirSync(SHOTS, { recursive: true });
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.png': 'image/png', '.ttf': 'font/ttf', '.webmanifest': 'application/manifest+json' };
const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 700))); if (!c) fails++; };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-readingdict-'));
const EN = lang === 'en';

// The books (made here): Japanese (kana present), Chinese (Han only).
const JA = ['第一話　帰り道', ...Array.from({ length: 30 }, (_, i) => `港町の灯台守は毎日同じ道を歩く。${i + 1}番目の朝、海が静かに光っていた。`)].join('\n\n');
const ZH = ['第一章', ...Array.from({ length: 30 }, (_, i) => `这是关于灯塔和大海的故事，第${i + 1}天的早晨很安静。`)].join('\n\n');
fs.writeFileSync(path.join(TMP, 'nihongo.txt'), JA); fs.writeFileSync(path.join(TMP, 'zhongwen.txt'), ZH);

// What the CDN "serves": the files' real sizes, made-up contents. kuromoji's script is a stand-in giving each kanji a reading.
const GZ = { base: 3956825, check: 3111633, tid: 1605820, tid_pos: 5916009, tid_map: 1485576, cc: 1692067, unk: 10512, unk_pos: 10540, unk_map: 1190, unk_char: 306, unk_compat: 338, unk_invoke: 1140 };
const gzBody = (n) => { const b = Buffer.alloc(n); b[0] = 0x1f; b[1] = 0x8b; return b; };
// The stand-in behaves like kuromoji 0.1.2's browser loader: for each of the 12 files an XMLHttpRequest GET (responseType
// 'arraybuffer'), the folder and name joined by path.join — which turns «https://» into «https:/» —, onload with status 200,
// then each file gunzipped (here: a check of the gzip bytes, the files being made up), and the tokenizer once all are in.
// window.__krStub: 'throw' / 'hang' make it fail / never answer when its files came from the device (a blob: address).
const KUROMOJI = `(function () {
  const FILES = ['base', 'check', 'tid', 'tid_pos', 'tid_map', 'cc', 'unk', 'unk_pos', 'unk_map', 'unk_char', 'unk_compat', 'unk_invoke'];
  const join = (a, b) => (a + '/' + b).replace(/\\/{2,}/g, '/');
  window.kuromoji = { builder: (o) => ({ build: (cb) => {
    let left = FILES.length, done = false, fromBlob = false; const fail = (e) => { if (!done) { done = true; cb(e); } };
    FILES.forEach((n) => { const x = new XMLHttpRequest(); x.open('GET', join(o.dicPath, n + '.dat.gz'), true); x.responseType = 'arraybuffer';
      x.onload = () => {
        if (x.status !== 200) return fail(new Error('status ' + x.status));
        const b = new Uint8Array(x.response); if (b[0] !== 0x1f || b[1] !== 0x8b) return fail(new Error('gunzip'));
        if (String(x.responseURL).startsWith('blob:')) fromBlob = true;
        if (--left === 0) {
          const mode = window.__krStub || ''; if (fromBlob && mode === 'throw') return fail(new Error('gunzip failed')); if (fromBlob && mode === 'hang') return;
          window.__dictFromBlob = fromBlob; done = true;
          cb(null, { tokenize: (t) => t === '日本語' ? [{ surface_form: t, word_type: 'KNOWN', reading: 'ニホンゴ' }] : [...t].map((c) => ({ surface_form: c, word_type: 'KNOWN', reading: /[㐀-鿿]/.test(c) ? 'ア' : undefined })) });
        }
      };
      x.onerror = () => fail(new Error('xhr')); x.send(); });
  } }) };
})();`;
const PINYIN = `window.pinyinPro = { pinyin: (t) => [...t].filter((c) => /[㐀-鿿]/.test(c)).map((c) => (c === '中' ? 'zhōng' : 'mā')) };`;
const cdn = { mode: 'ok', reqs: [], slowMs: 0 };
async function routeCdn(ctx) {
  await ctx.route((u) => !/^(127\.0\.0\.1|localhost)$/.test(u.hostname), async (route) => {
    const u = new URL(route.request().url()); cdn.reqs.push(u.hostname + u.pathname);
    if (u.hostname !== 'cdn.jsdelivr.net') return route.abort();
    const name = u.pathname.split('/').pop();
    if (cdn.mode === 'down') return route.abort('connectionrefused');
    if (cdn.mode === 'http500' && name === 'kuromoji.js') return route.fulfill({ status: 500, contentType: 'text/plain', body: 'oops' });
    if (cdn.mode === 'corrupt' && name === 'check.dat.gz') return route.fulfill({ status: 200, contentType: 'text/html', body: '<html>captive portal</html>' });
    if (cdn.mode === 'http500' && name === 'index.js') return route.fulfill({ status: 503, contentType: 'text/plain', body: 'later' });
    if (name === 'kuromoji.js') return route.fulfill({ contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: KUROMOJI });
    if (name === 'index.js') return route.fulfill({ contentType: 'application/javascript', headers: { 'access-control-allow-origin': '*' }, body: PINYIN });
    const m = /^(.+)\.dat\.gz$/.exec(name);
    if (m && GZ[m[1]]) { if (cdn.slowMs && m[1] === 'tid_pos') await new Promise((r) => setTimeout(r, cdn.slowMs)); return route.fulfill({ contentType: 'application/gzip', headers: { 'access-control-allow-origin': '*' }, body: gzBody(GZ[m[1]]) }); }
    return route.fulfill({ status: 404, body: 'no' });
  });
}

const allBooks = (p) => p.evaluate(() => new Promise((res) => { const r = indexedDB.open('kurokawa-reader'); r.onsuccess = () => { const q = r.result.transaction('books').objectStore('books').getAll(); q.onsuccess = () => res(q.result); }; }));
async function importFile(p, file, re) {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(600);
  await p.setInputFiles('.library-view input[type=file]', [file]);
  for (let i = 0; i < 160; i++) {
    const b = (await allBooks(p)).find((x) => new RegExp(re).test(x.title) || new RegExp(re).test(x.fileName ?? '')); if (b) return b;
    await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); s?.querySelector('.sheet-actions button, button.btn')?.click(); });
    await p.waitForTimeout(250);
  }
  throw new Error('not imported: ' + file);
}
const openBook = async (p, id) => {
  await p.evaluate(() => { location.hash = '#/'; }); await p.waitForSelector('.library-view'); await p.waitForTimeout(200);
  await p.evaluate((id) => { location.hash = `#/read/${id}`; }, id);
  await p.waitForFunction(() => [...document.querySelectorAll('.reader-flow .kr-content')].some((e) => e.offsetParent !== null), null, { timeout: 30000 }); await p.waitForTimeout(900);
};
const notice = (p) => p.evaluate(() => { const all = [...document.querySelectorAll('.kr-notice')]; const el = all[0]; if (!el) return { n: 0 }; const r = el.getBoundingClientRect(); return { n: all.length, kind: el.dataset.kind, phase: el.dataset.phase, text: el.querySelector('.kr-notice-msg')?.textContent ?? '', acts: [...el.querySelectorAll('button[data-act]')].map((b) => b.dataset.act), closeBtn: !!el.querySelector('.kr-notice-x'), err: el.classList.contains('error'), bar: el.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? null, rect: { l: r.left, r: r.right, t: r.top, b: r.bottom }, vw: innerWidth, vh: innerHeight }; });
const rubies = (p) => p.evaluate(() => document.querySelectorAll('.reader-flow ruby').length);
const click = (p, sel) => p.evaluate((s) => document.querySelector(s)?.click(), sel);
const shot = (p, name) => p.screenshot({ path: path.join(SHOTS, `${name}-${lang}.png`) });
const rows = (p, root = 'body') => p.evaluate((root) => [...document.querySelectorAll(`${root} .kr-dict-row`)].map((r) => ({ kind: r.dataset.kind, phase: r.dataset.phase, state: r.querySelector('.kr-dict-state')?.textContent ?? '', fail: r.querySelector('.kr-dict-fail')?.textContent ?? '', acts: [...r.querySelectorAll('button[data-act]')].map((b) => b.dataset.act), bar: r.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow') ?? null })), root);
const waitFor = (p, fn, arg, ms = 20000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true).catch(() => false);
const cacheHas = (p) => p.evaluate(async () => { const c = await caches.open('kurokawa-ext'); return (await c.keys()).map((r) => new URL(r.url).pathname.split('/').pop()); });
const newCtx = async (br, o = {}) => { const ctx = await br.newContext({ serviceWorkers: 'block', locale: lang === 'ar' ? 'ar' : 'en', ...o }); await routeCdn(ctx);
  await ctx.addInitScript(() => { try { window.__krStub = localStorage.getItem('__stub') || ''; const m = Number(localStorage.getItem('__ms')); if (m) window.__krDictLoadMs = m; } catch { /* */ } }); return ctx; };
const prep = async (p, base) => { await p.goto(base); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kr.update.lastCheck', String(Date.now())); localStorage.setItem('kr.visual', JSON.stringify({ readingMode: 'continuous', furigana: true })); }, lang); await p.reload(); await p.waitForSelector('.library-view'); };
// The start edge of each row's buttons against the start edge of its text: the same side (left in English, right in Arabic).
const startEdges = (p, root) => p.evaluate((root) => [...document.querySelectorAll(`${root} .kr-dict-row`)].map((row) => {
  const rtl = getComputedStyle(row).direction === 'rtl'; const name = row.querySelector('.kr-dict-name'); const r = document.createRange(); r.selectNodeContents(name); const t = r.getBoundingClientRect();
  const bs = [...row.querySelectorAll('.kr-dict-actions .btn')].map((b) => b.getBoundingClientRect());
  const edge = (x) => (rtl ? x.right : x.left); return { rtl, text: Math.round(edge(t)), buttons: bs.map((b) => Math.round(edge(b))) };
}), root);
const startsAlign = (e) => e.length > 0 && e.every((r) => r.buttons.length > 0 && r.buttons.every((b) => Math.abs(b - r.text) <= 2));
const until = async (fn, ms = 20000) => { const t0 = Date.now(); while (!fn() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100)); };
const openSettings = async (p) => {
  await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-body .card', { timeout: 15000 });
  // (The reader's options sit in a card that starts folded on a phone; on a computer it is picked in the side list.)
  await p.evaluate(() => { const card = document.querySelector('.settings-body [data-dicts]').closest('.card'); if (document.documentElement.classList.contains('pc')) document.querySelector(`.settings-nav [data-sec="${card.id}"]`)?.click(); else if (card.classList.contains('collapsed')) card.querySelector(':scope > h3').click(); });
  await p.waitForSelector('.settings-body [data-dicts]', { state: 'visible', timeout: 15000 });
  await p.evaluate(() => document.querySelector('.settings-body [data-dicts]')?.scrollIntoView({ block: 'center' })); await p.waitForFunction(() => !document.querySelector('.toast'), null, { timeout: 8000 }).catch(() => {}); await p.waitForTimeout(500);
};
const toggleOpt = (p, key) => p.evaluate((k) => document.querySelector(`.panel.open label.row:has(.label[data-key="${k}"]) input`)?.click(), key);
const openOptions = async (p) => { await p.evaluate(() => document.dispatchEvent(new CustomEvent('kr:command', { detail: 'options' }))); await p.waitForSelector('.panel.open [data-dicts]', { timeout: 10000 }).catch(() => {}); await p.waitForTimeout(300); };

const closeOptions = async (p) => { await p.keyboard.press('Escape'); if (!(await p.waitForFunction(() => !document.querySelector('.panel.open'), null, { timeout: 2500 }).then(() => true, () => false))) await p.evaluate(() => (document.querySelector('.sheet-scrim') || document.querySelector('.panel.open .panel-head button'))?.click()); await p.waitForFunction(() => !document.querySelector('.panel.open'), null, { timeout: 5000 }).catch(() => {}); await p.waitForTimeout(300); };

(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const br = await chromium.launch(); const errors = [];

  // ---- 0. the code on its own: states, cancel, what is kept, what listens
  {
    const ctx = await newCtx(br); const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.route(base + 'blank', (r) => r.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' }));
    await p.goto(base + 'blank');
    const entry = `export * from './src/readingdict'; export * from './src/ui/readingdict';`;
    const code = esbuild.buildSync({ stdin: { contents: entry, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'RD', write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
    await p.addScriptTag({ content: code });
    cdn.mode = 'ok'; cdn.slowMs = 0;
    const r0 = await p.evaluate(async () => { const s = await RD.refreshDictState('zh'); return { phase: s.phase, size: RD.dictSize('ja'), sizeZh: RD.dictSize('zh') }; });
    ok('nothing on the device: «none» (never started by itself)', r0.phase === 'none' && cdn.reqs.length === 0, r0);
    ok('the sizes shown are what the files come to (≈17 MB Japanese, ≈0.3 MB Chinese)', r0.size > 17.5e6 && r0.size < 18.5e6 && r0.sizeZh > 3e5 && r0.sizeZh < 4e5, r0);
    // cancel half way: no half file is kept as a dictionary; nothing left listening
    cdn.slowMs = 3000;
    const c1 = await p.evaluate(async () => {
      const base = RD.dictListenerCount(); const seen = [];
      const off = RD.onDictChange((k, s) => seen.push(s.phase));
      const job = RD.downloadDict('ja'); await new Promise((r) => setTimeout(r, 900));
      const mid = RD.getDictState('ja'); RD.cancelDict('ja'); const done = await job; off();
      return { mid: mid.phase, done, after: RD.getDictState('ja').phase, listeners: RD.dictListenerCount() - base, seen };
    });
    ok('a download cancelled: ends «none», reports false, no listener left', c1.mid === 'downloading' && c1.done === false && c1.after === 'none' && c1.listeners === 0, c1);
    const kept = await cacheHas(p);
    ok('… what was finished is kept (not used): the files before the slow one', kept.includes('kuromoji.js') && kept.includes('base.dat.gz') && !kept.includes('tid_pos.dat.gz'), kept);
    ok('… and it is not "ready" with a part: a fresh look still says none', await p.evaluate(async () => (await RD.refreshDictState('ja', true)).phase) === 'none');
    // the rest goes on from there (the finished files are not fetched again)
    cdn.slowMs = 0; const before = cdn.reqs.length;
    const c2 = await p.evaluate(async () => { const ok = await RD.downloadDict('ja'); return { ok, st: RD.getDictState('ja') }; });
    const again = cdn.reqs.slice(before).filter((x) => /base\.dat\.gz|kuromoji\.js/.test(x));
    ok('download again: goes on from the kept files, and the dictionary is complete', c2.ok && c2.st.phase === 'ready' && c2.st.bytes > 17.5e6 && again.length === 0, { c2, again });
    const rm = await p.evaluate(async () => { await RD.removeDict('ja'); return { st: RD.getDictState('ja').phase, ls: localStorage.getItem('kr.readingdict.ja') }; });
    ok('removed: nothing on the device, nothing remembered', rm.st === 'none' && rm.ls === null && (await cacheHas(p)).length === 0, rm);
    // a damaged file is refused and never kept
    cdn.mode = 'corrupt';
    const bad = await p.evaluate(async () => { const ok = await RD.downloadDict('ja'); const s = RD.getDictState('ja'); return { ok, phase: s.phase, fail: s.fail }; });
    ok('a damaged file (not gzip): refused with the reason «corrupt», never kept', !bad.ok && bad.phase === 'error' && bad.fail === 'corrupt' && !(await cacheHas(p)).includes('check.dat.gz'), bad);
    await p.evaluate(() => RD.removeDict('ja')); cdn.mode = 'ok';
    // panels and notices that are gone do not go on listening
    const lk = await p.evaluate(async () => {
      const base = RD.dictListenerCount();
      const panels = []; for (let i = 0; i < 30; i++) { const el = RD.dictPanel(); document.body.append(el); panels.push(el); }
      const during = RD.dictListenerCount() - base; panels.forEach((x) => x.remove());
      await new Promise((r) => setTimeout(r, 3300)); // (a panel not on the page within a few seconds is let go of)
      RD.markDictFailed('zh', 'network'); // any change tells the listeners; the gone ones let go
      const live = RD.dictPanel(); document.body.append(live); RD.markDictFailed('zh', 'offline');
      const after = RD.dictListenerCount() - base; live.remove();
      let attached = 0, disposed = 0;
      const aid = RD.readingAid('zh', () => { attached++; return Object.assign(() => { disposed++; }, { refresh() {} }); });
      const b2 = RD.dictListenerCount(); aid.start(); await new Promise((r) => setTimeout(r, 300));
      const shown = document.querySelectorAll('.kr-notice').length; aid.dispose();
      return { during, after, shown, attached, disposed, leftAfterAid: RD.dictListenerCount() - base, noticeLeft: document.querySelectorAll('.kr-notice').length, b2: b2 - base };
    });
    ok('panels drawn and dropped 30 times: the listeners of the dropped ones are let go', lk.during === 60 && lk.after <= 4, lk);
    ok('a notice and its watcher end with the book: no notice and no listener left, readings not attached without a dictionary', lk.shown === 1 && lk.noticeLeft === 0 && lk.attached === 0 && lk.leftAfterAid <= lk.after, lk);
    await ctx.close();
  }

  // ---- phone: the notice, download, failures, offline, Settings, dismissal
  const ctx = await newCtx(br, { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
  await prep(p, base);
  const bj = await importFile(p, path.join(TMP, 'nihongo.txt'), 'nihongo'); const bz = await importFile(p, path.join(TMP, 'zhongwen.txt'), 'zhongwen');
  cdn.reqs.length = 0; cdn.mode = 'ok';

  await openBook(p, bj.id);
  await waitFor(p, () => document.querySelector('.kr-notice'));
  let n = await notice(p);
  ok('Japanese book, no dictionary: ONE notice offering «Download» (and a way to close it)', n.n === 1 && n.kind === 'ja' && n.phase === 'none' && n.acts.join() === 'download' && n.closeBtn, n);
  ok('… with the size in its words, not error-coloured', /1[67]|17/.test(n.text) || !EN, n.text);
  ok('… the notice is not the red error block (no .error), sits inside the screen above the bottom edge', !n.err && n.rect.l >= 0 && n.rect.r <= n.vw && n.rect.b < n.vh - 40, n);
  ok('… nothing was downloaded by itself (no request to the CDN)', cdn.reqs.length === 0, cdn.reqs);
  ok('… and no readings yet', (await rubies(p)) === 0);
  await shot(p, 'phone-notice');
  // offline: the reason, Try again
  await ctx.setOffline(true); cdn.mode = 'down';
  await click(p, '.kr-notice [data-act=download]');
  ok('offline: the notice says so and offers Try again', await waitFor(p, () => document.querySelector('.kr-notice')?.dataset.phase === 'error'), await notice(p));
  n = await notice(p);
  ok('… «offline» in words, Try again, nothing else asked of the reader', n.acts.join() === 'retry' && (!EN || /offline/i.test(n.text)) && n.n === 1, n);
  await shot(p, 'phone-offline');
  await ctx.setOffline(false);
  // a server error
  cdn.mode = 'http500'; await click(p, '.kr-notice [data-act=retry]');
  ok('a server error: the code in the reason, Try again', await waitFor(p, () => /5\d\d/.test(document.querySelector('.kr-notice .kr-notice-msg')?.textContent ?? '') || document.querySelector('.kr-notice')?.dataset.phase === 'error'), await notice(p));
  n = await notice(p); ok('… reason names the error (500), still one notice, Try again', n.n === 1 && n.acts.join() === 'retry' && /500|٥٠٠/.test(n.text), n);
  // a damaged file: refused and not kept
  cdn.mode = 'corrupt'; await click(p, '.kr-notice [data-act=retry]');
  ok('a damaged file: refused («damaged»), Try again', await waitFor(p, () => { const e = document.querySelector('.kr-notice'); return e?.dataset.phase === 'error' && !/500/.test(e.textContent); }), await notice(p));
  const keptNow = await cacheHas(p); ok('… the damaged file is not kept; the finished ones are', !keptNow.includes('check.dat.gz') && keptNow.includes('base.dat.gz'), keptNow);
  ok('… the page is still without readings', (await rubies(p)) === 0);
  // the real download, slowly: progress
  cdn.mode = 'ok'; cdn.slowMs = 4500; cdn.reqs.length = 0; await click(p, '.kr-notice [data-act=retry]');
  ok('download: progress shows (a bar with a percentage) and Cancel', await waitFor(p, () => { const e = document.querySelector('.kr-notice'); return e?.dataset.phase === 'downloading' && Number(e.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) > 0; }, null, 15000), await notice(p));
  n = await notice(p); ok('… the words carry the percentage, Cancel is offered', n.phase === 'downloading' && n.acts.join() === 'cancel' && /[\d٠-٩]/.test(n.text), n);
  await shot(p, 'phone-progress');
  ok('… the files already kept are not fetched again', !cdn.reqs.some((x) => /base\.dat\.gz|kuromoji\.js/.test(x)), cdn.reqs);
  ok('… furigana appear in the OPEN book when it is done, with no reopening; the notice is gone', await waitFor(p, () => document.querySelectorAll('.reader-flow ruby').length > 0 && !document.querySelector('.kr-notice'), null, 30000), { r: await rubies(p), n: await notice(p) });
  ok('… the analyser was built from the copy on the device (all 12 dictionary requests answered locally)', (await p.evaluate(() => window.__dictFromBlob)) === true, await p.evaluate(() => window.__dictFromBlob));
  cdn.slowMs = 0;
  // read with no network at all
  await ctx.setOffline(true); cdn.mode = 'down'; cdn.reqs.length = 0;
  await openBook(p, bj.id);
  ok('downloaded: the book opens OFFLINE with furigana and no notice', await waitFor(p, () => document.querySelectorAll('.reader-flow ruby').length > 0, null, 15000) && (await notice(p)).n === 0, { r: await rubies(p), n: await notice(p) });
  ok('… without asking the CDN for anything', cdn.reqs.length === 0, cdn.reqs);
  await ctx.setOffline(false); cdn.mode = 'ok';

  // Settings: the state of each, Remove
  await openSettings(p);
  let rs = await rows(p, '.settings-body');
  const ja = rs.find((r) => r.kind === 'ja'), zh = rs.find((r) => r.kind === 'zh');
  ok('Settings: Japanese «downloaded» with its size and Remove; Chinese «not downloaded» with Download', ja?.phase === 'ready' && ja.acts.join() === 'remove' && /1[67]|١[٦٧]/.test(ja.state) && zh?.phase === 'none' && zh.acts.join() === 'download', rs);
  const se = await startEdges(p, '.settings-body'); ok('Settings (phone): each row\'s buttons start where its text starts (left in English, right in Arabic)', startsAlign(se) && se.every((r) => r.rtl === !EN), se);
  await shot(p, 'phone-settings');
  await click(p, '.settings-body .kr-dict-row[data-kind=ja] [data-act=remove]'); await p.waitForTimeout(500);
  rs = await rows(p, '.settings-body');
  ok('Remove: Japanese is «not downloaded» again, with Download; its files are off the device', rs.find((r) => r.kind === 'ja')?.phase === 'none' && rs.find((r) => r.kind === 'ja').acts.join() === 'download' && (await cacheHas(p)).length === 0, { rs, kept: await cacheHas(p) });
  // Settings: download there, with progress in its row
  cdn.slowMs = 3500; await click(p, '.settings-body .kr-dict-row[data-kind=ja] [data-act=download]');
  ok('Settings: Downloading with a percentage and Cancel in its row', await waitFor(p, () => { const r = document.querySelector('.settings-body .kr-dict-row[data-kind=ja]'); return r?.dataset.phase === 'downloading' && Number(r.querySelector('[role=progressbar]')?.getAttribute('aria-valuenow')) > 0; }, null, 15000), await rows(p, '.settings-body'));
  rs = await rows(p, '.settings-body'); ok('… its buttons: Cancel only', rs[0].acts.join() === 'cancel', rs);
  await shot(p, 'phone-settings-progress');
  await click(p, '.settings-body .kr-dict-row[data-kind=ja] [data-act=cancel]'); await p.waitForTimeout(400);
  rs = await rows(p, '.settings-body'); ok('Cancel: back to «not downloaded» with Download, no half dictionary used', rs[0].phase === 'none' && rs[0].acts.join() === 'download', rs);
  cdn.slowMs = 0;

  // Dismissal: closed stays closed, until the option is turned on again
  await openBook(p, bj.id);
  await waitFor(p, () => document.querySelector('.kr-notice'));
  ok('the book opens again with the notice (the dictionary was removed)', (await notice(p)).n === 1 && (await rubies(p)) === 0, await notice(p));
  await click(p, '.kr-notice .kr-notice-x'); await p.waitForTimeout(300);
  ok('closed with its ✕: gone', (await notice(p)).n === 0);
  await openOptions(p);
  rs = await rows(p, '.panel.open');
  ok('the reader\'s text options carry the same panel: both dictionaries, state and buttons', rs.length === 2 && rs[0].kind === 'ja' && rs[0].acts.join() === 'download' && rs[1].acts.join() === 'download', rs);
  await toggleOpt(p, 'autoReadings'); await p.waitForTimeout(500); await toggleOpt(p, 'autoReadings'); await p.waitForTimeout(500);
  ok('another reading option changed: the closed notice does not come back', (await notice(p)).n === 0, await notice(p));
  await p.evaluate(() => document.querySelector('.panel.open [data-dicts]')?.scrollIntoView({ block: 'center' })); await p.waitForTimeout(400);
  await shot(p, 'phone-options');
  await toggleOpt(p, 'furigana'); await p.waitForTimeout(400); await toggleOpt(p, 'furigana');
  ok('… the options still open: no floating notice over them', (await notice(p)).n === 0, await notice(p));
  await closeOptions(p);
  ok('readings turned off and on again: the notice comes back (once)', await waitFor(p, () => document.querySelectorAll('.kr-notice').length === 1), await notice(p));
  await click(p, '.kr-notice .kr-notice-x'); await p.waitForTimeout(300);
  await openOptions(p); await p.waitForTimeout(600); await closeOptions(p); await p.waitForTimeout(600);
  ok('closed by the reader, the options opened and closed again: the notice stays gone', (await notice(p)).n === 0, await notice(p));
  await openOptions(p);
  // Download from the text options with the notice closed: the readings reach the open book
  await click(p, '.panel.open .kr-dict-row[data-kind=ja] [data-act=download]');
  ok('downloaded from the text options: «downloaded» there, and furigana in the open book, no reopening', await waitFor(p, () => document.querySelector('.panel.open .kr-dict-row[data-kind=ja]')?.dataset.phase === 'ready' && document.querySelectorAll('.reader-flow ruby').length > 0, null, 30000), { rs: await rows(p, '.panel.open'), r: await rubies(p) });
  ok('… and no notice came up while it did', (await notice(p)).n === 0);

  // Pinyin: the same
  await openBook(p, bz.id);
  await waitFor(p, () => document.querySelector('.kr-notice'));
  n = await notice(p);
  ok('Chinese book: the notice offers the Chinese dictionary (pinyin) with Download', n.n === 1 && n.kind === 'zh' && n.acts.join() === 'download' && (!EN || /pinyin/i.test(n.text)), n);
  await ctx.setOffline(true); cdn.mode = 'down'; await click(p, '.kr-notice [data-act=download]');
  await waitFor(p, () => document.querySelector('.kr-notice')?.dataset.phase === 'error');
  n = await notice(p); ok('… offline: says so, Try again', n.acts.join() === 'retry' && (!EN || /offline/i.test(n.text)), n);
  await ctx.setOffline(false); cdn.mode = 'http500'; await click(p, '.kr-notice [data-act=retry]'); await waitFor(p, () => /5\d\d|٥٠٠/.test(document.querySelector('.kr-notice .kr-notice-msg')?.textContent ?? ''));
  n = await notice(p); ok('… a server error: its code, Try again', /503|٥٠٣/.test(n.text) && n.acts.join() === 'retry', n);
  cdn.mode = 'ok'; await click(p, '.kr-notice [data-act=retry]');
  ok('… downloaded: pinyin in the open book without reopening, notice gone', await waitFor(p, () => document.querySelectorAll('.reader-flow ruby rt').length > 0 && !document.querySelector('.kr-notice'), null, 20000), { r: await rubies(p), n: await notice(p) });
  await openSettings(p);
  rs = await rows(p, '.settings-body');
  ok('Settings: Chinese «downloaded» (small), Japanese downloaded', rs.find((r) => r.kind === 'zh')?.phase === 'ready' && rs.find((r) => r.kind === 'zh').acts.join() === 'remove' && rs.find((r) => r.kind === 'ja')?.phase === 'ready', rs);
  ok('the page never asked a real site for anything but the CDN\'s dictionary files', cdn.reqs.every((x) => x.startsWith('cdn.jsdelivr.net/npm/kuromoji@0.1.2/') || x.startsWith('cdn.jsdelivr.net/npm/pinyin-pro@3.26.0/') || !x.startsWith('cdn.')), cdn.reqs.filter((x) => !x.startsWith('cdn.jsdelivr.net')));
  await ctx.close();


  // ---- the safety net: the copy on the device will not build; and the offer in the selection's popover
  {
    const c3 = await newCtx(br, { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); const q = await c3.newPage(); q.on('pageerror', (e) => errors.push(e.message));
    await prep(q, base); const b3 = await importFile(q, path.join(TMP, 'nihongo.txt'), 'nihongo'); cdn.mode = 'ok'; cdn.slowMs = 0;
    const setStub = async (stub, ms = 0) => { await q.evaluate(([a, m]) => { location.hash = '#/'; localStorage.setItem('__stub', a); localStorage.setItem('__ms', String(m)); }, [stub, ms]); await q.reload(); await q.waitForTimeout(800); };
    // 2. the automatic readings' popover offers the download (selection kept), and shows the readings once it is there
    await q.evaluate(() => { const s = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); s.autoReadings = true; s.furigana = false; localStorage.setItem('kr.visual', JSON.stringify(s)); });
    await q.reload(); await q.waitForSelector('.library-view'); await openBook(q, b3.id);
    await q.evaluate(() => { const p = [...document.querySelectorAll('.reader-flow p')].find((x) => x.textContent.includes('港町')); const r = document.createRange(); r.selectNodeContents(p); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); });
    ok('selected Japanese text, automatic readings on, no dictionary: the popover offers Download (not nothing)', await waitFor(q, () => document.querySelector('.readings-pop.dict-offer [data-act=download]'), null, 8000), await q.evaluate(() => document.querySelector('.readings-pop')?.outerHTML.slice(0, 300)));
    await q.waitForTimeout(700); await shot(q, 'phone-popover');
    await click(q, '.readings-pop.dict-offer [data-act=download]');
    ok('… Download there: the readings appear in the same popover', await waitFor(q, () => document.querySelector('.readings-pop ruby rt') && !document.querySelector('.readings-pop.dict-offer'), null, 30000), await q.evaluate(() => document.querySelector('.readings-pop')?.outerHTML.slice(0, 300)));
    await q.evaluate(() => { const s = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); s.autoReadings = false; s.furigana = true; localStorage.setItem('kr.visual', JSON.stringify(s)); });
    // 1a. the copy on the device throws while building: the old way (CDN) is used and the furigana appear
    await setStub('throw'); cdn.reqs.length = 0; await openBook(q, b3.id);
    await until(() => cdn.reqs.some((x) => /dict\/base\.dat\.gz/.test(x)));
    ok('device copy fails to build (loader error): the CDN way is used once, furigana appear, no notice', await waitFor(q, () => document.querySelectorAll('.reader-flow ruby').length > 0, null, 20000) && (await notice(q)).n === 0 && cdn.reqs.some((x) => /dict\/base\.dat\.gz/.test(x)), { r: await rubies(q), reqs: cdn.reqs.length });
    // 1b. the loader never answers: a time limit, then the same
    await setStub('hang', 8000); cdn.reqs.length = 0; await openBook(q, b3.id); await until(() => cdn.reqs.some((x) => /dict\/base\.dat\.gz/.test(x)), 40000);
    ok('device copy never answers: after the time limit the CDN way is used, furigana appear', await waitFor(q, () => document.querySelectorAll('.reader-flow ruby').length > 0, null, 40000) && cdn.reqs.some((x) => /dict\/base\.dat\.gz/.test(x)), { r: await rubies(q), reqs: cdn.reqs.length });
    // 1c. offline and the device copy broken: a clear error with both actions
    // (The views are loaded first, while online, with the furigana off; the option is turned on once offline.)
    await q.evaluate(() => { const s = JSON.parse(localStorage.getItem('kr.visual') ?? '{}'); s.furigana = false; localStorage.setItem('kr.visual', JSON.stringify(s)); });
    await setStub('throw'); await openSettings(q); await openBook(q, b3.id); await openOptions(q);
    await c3.setOffline(true); cdn.mode = 'down'; cdn.reqs.length = 0; await toggleOpt(q, 'furigana');
    // The options are open: no notice floats over them; their own row carries the error. Once they are closed the notice is there.
    ok('offline + device copy broken, the text options open: the row in them shows the error with both actions, NO floating notice over the sheet', await waitFor(q, () => document.querySelector('.panel.open .kr-dict-row[data-kind=ja]')?.dataset.phase === 'error', null, 15000) && (await notice(q)).n === 0, { rs: await rows(q, '.panel.open'), n: await notice(q) });
    await shot(q, 'phone-options-loadfail');
    await closeOptions(q);
    ok('… the panel closed: the notice comes back with the reason and the two actions (Try again, Remove and download again), no furigana', await waitFor(q, () => document.querySelector('.kr-notice')?.dataset.phase === 'error', null, 15000) && (await rubies(q)) === 0, await notice(q));
    n = await notice(q); ok('… the words say it could not be loaded', n.acts.join() === 'retry,redownload' && (!EN || /could not be loaded/.test(n.text)), n);
    const alpha = (v) => { const m = /rgba?\(([^)]+)\)/.exec(v); const x = m ? m[1].split(',').map((y) => parseFloat(y)) : []; return x.length > 3 ? x[3] : 1; };
    const al = await q.evaluate(() => { const el = document.querySelector('.kr-notice'); const out = {}; const html = document.documentElement; const was = html.getAttribute('style') || '';
      const read = () => getComputedStyle(el).backgroundColor;
      out.classic = read(); html.dataset.glass = 'on'; html.style.setProperty('--md-surface-container-highest', 'rgba(20,20,20,.4)'); html.style.setProperty('--th-solid-highest', '#202020'); out.glass = read(); out.noBackdrop = getComputedStyle(el).backdropFilter;
      for (const th of ['light', 'dark', 'sepia']) { html.dataset.theme = th; out[th] = read(); }
      delete html.dataset.glass; html.style.removeProperty('--md-surface-container-highest'); html.style.removeProperty('--th-solid-highest'); html.setAttribute('style', was); return out; });
    ok('the notice is fully opaque: classic, with the glass look on (translucent surface tokens), light, dark and sepia', [al.classic, al.glass, al.light, al.dark, al.sepia].every((c) => alpha(c) === 1) && /none/.test(al.noBackdrop || 'none'), al);
    await shot(q, 'phone-loadfail');
    await openSettings(q); rs = await rows(q, '.settings-body');
    ok('… Settings shows the same error in the row, with both actions', rs[0].phase === 'error' && rs[0].acts.join() === 'retry,redownload' && rs[0].fail.length > 10, rs);
    const geo = await q.evaluate(() => { const row = document.querySelector('.settings-body .kr-dict-row[data-kind=ja]'); const r = row.getBoundingClientRect(); const bs = [...row.querySelectorAll('.kr-dict-actions .btn')].map((b) => b.getBoundingClientRect()); return { inside: bs.every((b) => b.left >= r.left - 0.5 && b.right <= r.right + 0.5), heights: bs.map((b) => Math.round(b.height)), gap: bs.length > 1 ? Math.round(Math.min(...bs.slice(1).map((b, i) => Math.max(bs[i].left - b.right, b.left - bs[i].right, bs[i].top - b.bottom, b.top - bs[i].bottom)))) : 99 }; });
    ok('… the two buttons stay inside the row, one height each, a real gap between them', geo.inside && geo.heights.every((x) => x >= 36) && geo.gap >= 6, geo);
    const se2 = await startEdges(q, '.settings-body'); ok('… the stacked buttons of the error row start where its text starts', startsAlign(se2), se2);
    await shot(q, 'phone-settings-loadfail');
    // 1d. Remove and download again, back online, the stub mended: complete again, furigana in the book
    await c3.setOffline(false); cdn.mode = 'ok'; await q.evaluate(() => { window.__krStub = ''; }); cdn.reqs.length = 0;
    await click(q, '.settings-body .kr-dict-row[data-kind=ja] [data-act=redownload]');
    ok('Remove and download again: fetched afresh, «downloaded» in the row', await waitFor(q, () => document.querySelector('.settings-body .kr-dict-row[data-kind=ja]')?.dataset.phase === 'ready', null, 40000) && cdn.reqs.some((x) => /base\.dat\.gz/.test(x)), { rs: await rows(q, '.settings-body'), reqs: cdn.reqs.length });
    await openBook(q, b3.id);
    ok('… and the book has furigana, built from the new copy', await waitFor(q, () => document.querySelectorAll('.reader-flow ruby').length > 0, null, 20000) && (await q.evaluate(() => window.__dictFromBlob)) === true, await q.evaluate(() => window.__dictFromBlob));
    await c3.close();
  }

  // ---- PC: pictures of the notice, progress, the Settings row
  {
    const c2 = await newCtx(br, { viewport: { width: 1280, height: 800 } }); const q = await c2.newPage(); q.on('pageerror', (e) => errors.push(e.message));
    await prep(q, base);
    const b2 = await importFile(q, path.join(TMP, 'nihongo.txt'), 'nihongo'); cdn.mode = 'ok';
    await openBook(q, b2.id); await waitFor(q, () => document.querySelector('.kr-notice'));
    n = await notice(q); ok('PC: the notice is inside the window, offers Download', n.n === 1 && n.acts.join() === 'download' && n.rect.l >= 0 && n.rect.r <= n.vw && n.rect.b <= n.vh, n);
    await shot(q, 'pc-notice');
    cdn.slowMs = 6000; await click(q, '.kr-notice [data-act=download]');
    await waitFor(q, () => Number(document.querySelector('.kr-notice [role=progressbar]')?.getAttribute('aria-valuenow')) > 0, null, 15000);
    await shot(q, 'pc-progress');
    await waitFor(q, () => document.querySelectorAll('.reader-flow ruby').length > 0, null, 30000);
    await openSettings(q);
    await shot(q, 'pc-settings');
    await c2.close(); cdn.slowMs = 0;
  }

  ok('no page errors', errors.length === 0, errors);
  console.log(fails ? `${fails} FAILED` : 'all passed'); console.log('pictures: ' + SHOTS);
  await br.close(); server.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
