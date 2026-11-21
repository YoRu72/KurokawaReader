// node tests/readingdictreal.cjs: the reading dictionary loaded the way the PHONE loads it — a page on an https origin
// (https://localhost, as Capacitor serves the app), where kuromoji's «https:/host/…» (one slash, left by its path.join) is read
// as a path on the page's own host. The analyser here is a faithful stand-in for kuromoji 0.1.2's browser loader (the package
// is not installed on this box): XMLHttpRequest GET, responseType 'arraybuffer', each file gunzipped for real
// (DecompressionStream: a body that is not gzip fails, as zlibjs does), the tokenizer built only when all twelve are good.
// The dictionary files are made here and gzipped for real; nothing reaches the internet (the CDN is answered locally).
// Cases: the one-slash address; a cached body that is not gzip; a missing file; remove and download again; a copy that
// downloads but will not load (the self-check says so, with a reason, and nothing is called ready).
const { chromium } = require('playwright'); const esbuild = require('esbuild'); const zlib = require('zlib'); const path = require('path');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 600))); if (!c) fails++; };
const NAMES = ['base', 'check', 'tid', 'tid_pos', 'tid_map', 'cc', 'unk', 'unk_pos', 'unk_map', 'unk_char', 'unk_compat', 'unk_invoke'];
const SIZES = { base: 3956825, check: 3111633, tid: 1605820, tid_pos: 5916009, tid_map: 1485576, cc: 1692067, unk: 10512, unk_pos: 10540, unk_map: 1190, unk_char: 306, unk_compat: 338, unk_invoke: 1140 };
// Real gzip, the length the app expects (it only checks gzip magic and that something arrived).
const plain = (n) => Buffer.from('dict:' + n + ':' + 'x'.repeat(40));
const gz = (n) => zlib.gzipSync(plain(n));
const KUROMOJI = `(function () {
  const FILES = ${JSON.stringify(NAMES)};
  const join = (a, b) => (a + '/' + b).replace(/\\/{2,}/g, '/');            // what path.join does: https:// -> https:/
  const gunzip = async (buf) => new Uint8Array(await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  window.kuromoji = { builder: (o) => ({ build: (cb) => {
    let left = FILES.length, done = false, blob = 0; const fail = (e) => { if (!done) { done = true; cb(e); } };
    FILES.forEach((n) => { const x = new XMLHttpRequest(); const url = join(o.dicPath, n + '.dat.gz'); (window.__krUrls ||= []).push(url);
      x.open('GET', url, true); x.responseType = 'arraybuffer';
      x.onload = async () => {
        if (x.status > 0 && x.status !== 200) return fail(new Error('status ' + x.status));
        try { const raw = await gunzip(x.response); if (!new TextDecoder().decode(raw).startsWith('dict:' + n)) throw new Error('wrong file'); } catch (e) { return fail(new Error('gunzip failed: ' + (e.message || e))); }
        if (String(x.responseURL).startsWith('blob:')) blob++;
        if (--left === 0) { done = true; window.__dictFromBlob = blob; cb(null, { tokenize: (t) => [{ surface_form: t, word_type: 'KNOWN', reading: window.__wrongReading ? 'ア' : t === '日本語' ? 'ニホンゴ' : undefined }] }); }
      };
      x.onerror = () => fail(new Error('xhr failed')); x.send(); });
  } }) };
})();`;
const PINYIN = `window.pinyinPro = { pinyin: (t) => [...t].map((c) => (c === '中' ? 'zhōng' : 'mā')) };`;
const cdn = { reqs: [], plainBodies: false };
(async () => {
  const br = await chromium.launch();
  const ctx = await br.newContext({ serviceWorkers: 'block' }); const p = await ctx.newPage(); const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const own = []; // requests to the page's own origin other than the page itself: a lookup that missed
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === 'localhost') { if (u.pathname !== '/blank') own.push(u.pathname); return route.fulfill({ contentType: 'text/html', body: u.pathname === '/blank' ? '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>' : '<html>the app\'s own page</html>' }); }
    if (u.hostname !== 'cdn.jsdelivr.net') return route.abort();
    const name = u.pathname.split('/').pop(); cdn.reqs.push(name);
    const cors = { 'access-control-allow-origin': '*' };
    if (name === 'kuromoji.js') return route.fulfill({ contentType: 'application/javascript', headers: cors, body: KUROMOJI });
    if (name === 'index.js') return route.fulfill({ contentType: 'application/javascript', headers: cors, body: PINYIN });
    const m = /^(.+)\.dat\.gz$/.exec(name);
    if (m && SIZES[m[1]]) return route.fulfill({ contentType: 'application/gzip', headers: cors, body: cdn.plainBodies ? plain(m[1]) : gz(m[1]) });
    return route.fulfill({ status: 404, body: 'no' });
  });
  await p.goto('https://localhost/blank');
  const code = esbuild.buildSync({ stdin: { contents: `export * from './src/readingdict'; export * as F from './src/furigana'; export * as R from './src/readings';`, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'RD', write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
  await p.addScriptTag({ content: code });
  const state = () => p.evaluate(() => { const s = RD.getDictState('ja'); return { phase: s.phase, fail: s.fail, detail: s.detail }; });
  const cached = () => p.evaluate(async () => (await (await caches.open('kurokawa-ext')).keys()).map((r) => new URL(r.url).pathname.split('/').pop()));

  // 1. the address logic itself, on an https base
  const u = await p.evaluate(() => ({
    asRead: new URL('https:/cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/base.dat.gz', location.href).href,
    fixed: RD.normaliseDictAddress('https:/cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/base.dat.gz'), fixedHttp: RD.normaliseDictAddress('HTTP:/h/dict/cc.dat.gz'), whole: RD.normaliseDictAddress('https://h/x'),
    name: RD.dictFileName('https:/cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/tid_pos.dat.gz'), blobName: RD.dictFileName('blob:https://localhost/1234'),
  }));
  ok('the bug: on an https page a one-slash address is read as a path on the page host', u.asRead === 'https://localhost/cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/base.dat.gz', u);
  ok('normalised: one slash made whole, a whole address left alone', u.fixed === 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/base.dat.gz' && u.fixedHttp === 'http://h/dict/cc.dat.gz' && u.whole === 'https://h/x', u);
  ok('the file is found by its name', u.name === 'tid_pos.dat.gz' && u.blobName === null, u);

  // 2. download: real load check before «ready», files read from the device through the one-slash address
  const d1 = await p.evaluate(() => RD.downloadDict('ja')); const s1 = await state();
   ok('download ends ready only after the self-check (日本語 → にほんご)', d1 === true && s1.phase === 'ready', s1);
  const f1 = await p.evaluate(async () => { const tk = await RD.F.ensureTokenizer(); return { r: tk.tokenize('日本語')[0].reading, blob: window.__dictFromBlob, urls: window.__krUrls.slice(0, 2) }; });
  ok('the analyser answers, all 12 files came from the device (blob), none went to the app\'s own host', f1.r === 'ニホンゴ' && f1.blob === 12 && own.length === 0 && f1.urls[0].startsWith('https:/cdn.jsdelivr.net/') && !f1.urls[0].startsWith('https://'), { f1, own });

  // 3. a cached body that is not gzip (the WebView/CDN un-gzipped it): handed to the analyser gzipped
  await p.evaluate(async () => { const c = await caches.open('kurokawa-ext'); const k = (await c.keys()).find((r) => r.url.endsWith('/dict/tid.dat.gz')); const b = new Uint8Array(await (await c.match(k)).arrayBuffer()); const raw = new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()); await c.put(k, new Response(raw, { headers: { 'content-length': String(raw.length) } })); });
  // (a fresh analyser: forget what was built, keep the files)
  await p.evaluate(() => { window.__krUrls = []; window.__dictFromBlob = 0; });
  const f3 = await p.evaluate(async () => { try { await RD.withLocalKuromoji(() => new Promise((res, rej) => kuromoji.builder({ dicPath: RD.KUROMOJI_DICT }).build((e, tk) => (e ? rej(e) : res(tk))))); return { ok: true, blob: window.__dictFromBlob }; } catch (e) { return { ok: false, e: String(e.message || e) }; } });
  ok('a cached body that is not gzip still loads', f3.ok && f3.blob === 12, f3);

  // 4. one file missing from the cache: «missing», state none, the download offered again
  await p.evaluate(async () => { const c = await caches.open('kurokawa-ext'); const k = (await c.keys()).find((r) => r.url.endsWith('/dict/cc.dat.gz')); await c.delete(k); });
  const f4 = await p.evaluate(async () => { try { await RD.withLocalKuromoji(async () => 1); return 'no error'; } catch (e) { return e.message; } });
  const s4 = await state();
  ok('a missing file: dict-missing and the state goes back to «none»', f4 === 'dict-missing' && s4.phase === 'none', { f4, s4 });

  // 5. remove, then download again: everything fetched again and loads; and the one that was un-gzipped on the way
  await p.evaluate(() => RD.removeDict('ja')); const c5 = await cached(); cdn.reqs.length = 0; cdn.plainBodies = true;
  const d5 = await p.evaluate(() => RD.downloadDict('ja')); const s5 = await state(); cdn.plainBodies = false;
  ok('remove takes every file off the device', c5.filter((n) => n.endsWith('.gz')).length === 0, c5);
  ok('download again (the CDN handing un-gzipped bodies) is kept gzipped, passes the self-check, is ready', d5 === true && s5.phase === 'ready' && cdn.reqs.length === 13, { s5, n: cdn.reqs.length });
  const f5 = await p.evaluate(async () => { window.__dictFromBlob = 0; const tk = await RD.F.ensureTokenizer(); return tk.tokenize('日本語')[0].reading; });
  ok('and the readings work from it', f5 === 'ニホンゴ', f5);

  // 6. downloads fine, will not load: not «ready», the reason is kept, files removed so a new try starts clean
  await p.evaluate(() => RD.removeDict('ja')); await p.evaluate(() => { window.__wrongReading = true; });
  const d6 = await p.evaluate(() => RD.downloadDict('ja')); const s6 = await state(); const c6 = await cached();
  ok('a copy that does not load is not called ready: error «load» with its reason', d6 === false && s6.phase === 'error' && s6.fail === 'load' && /self-check/.test(s6.detail || ''), s6);
  ok('and it is taken off the device', c6.filter((n) => n.endsWith('.gz')).length === 0, c6);
  await p.evaluate(() => { window.__wrongReading = false; });
  const d6b = await p.evaluate(() => RD.downloadDict('ja')); ok('Download again then works', d6b === true && (await state()).phase === 'ready');

  // 7. Chinese: self-check on the stored script
  const d7 = await p.evaluate(() => RD.downloadDict('zh')); const z = await p.evaluate(async () => { const py = await RD.R.ensurePinyin(); return py.pinyin('中')[0]; });
  ok('pinyin: downloaded after its self-check, reads 中 → zhōng', d7 === true && z === 'zhōng', { d7, z });
  ok('no page errors', errors.length === 0, errors);
  await br.close(); console.log(fails ? `FAILED: ${fails}` : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
