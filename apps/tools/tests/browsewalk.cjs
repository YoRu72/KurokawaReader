// node tests/browsewalk.cjs : the app's browser walked against made-up pages on 127.0.0.1 (nothing reaches a real site:
// every other address is answered here with a made-up page). Two parts:
//  1. the computer's browser window — what browser.rs puts in every page (SENDER_JS, INIT_JS: the bar, the keys, new
//     windows kept, the title sent; the grab) — run in Chromium at 1280x800 by mouse and keys, en and ar: a page of 500
//     links, one that opens pop-ups by itself and by a click, a redirect loop, one that never finishes loading, a 404
//     and a 500, a download link with a right-to-left name, a media page (several qualities, a list that grows after
//     load), a form with a file input, one asking a permission, a 300-character title, a page in Arabic; the address
//     typed (an address, a local address with a port, words), back / forward / reload each twice quickly.
//  2. the page app (phone 360x800 and 412x915 by touch, CDP; computer 1280x800 by mouse; en and ar): the Browse sheet
//     (what Go will do, said before it is done), the browser opened twice quickly, a grab of 500 links with right-to-left
//     names and several qualities, the list changed after load (a second grab), a download with a right-to-left name.
// Targets of 40 px at least, no sideways scroll, no page errors. Screenshots: D5-browser-phone-en/ar.png, D5-browser-pc-en.png.
// Also (part 0): the one address rule in its three copies run on one table — the page's (esbuild), the phone's
// KtWebRules.java (javac, tests/native/WebT.java), the computer's bar's addr().
// Env: WALK_ONLY=rule,pc,app  WALK_SHOTS=<dir>
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const assert = require('node:assert/strict');
const ROOT = path.join(__dirname, '..'); const DIST = path.join(ROOT, 'dist'); const SRC = path.join(ROOT, 'desktop-tauri', 'src-tauri', 'src');
const SHOTS = process.env.WALK_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'kt-browsewalk-'));
const ONLY = process.env.WALK_ONLY ? process.env.WALK_ONLY.split(',') : null; const want = (c) => !ONLY || ONLY.includes(c);
let fails = 0, passes = 0; const faultLog = [];
const ok = (n, c, x) => { if (c) passes++; else { fails++; faultLog.push(n); } console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); };
setTimeout(() => { console.log('FAIL timed out'); process.exit(1); }, 600000).unref();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const RTL = 'حلقة 07 — النهاية.mkv'; const LONG = 'A very long page title '.repeat(13).trim();

// ---- the made-up site
const site = http.createServer((q, r) => {
  const u = new URL(q.url, 'http://x'); const page = (title, body, attrs = '') => { r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.end(`<!doctype html><html${attrs}><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`); };
  switch (u.pathname) {
    case '/': return page('Start', '<h1>Start</h1><a href="/links">links</a> <a href="/media">media</a>');
    case '/links': return page('Five hundred links', Array.from({ length: 500 }, (_, i) => `<a href="/files/f${i}.${i % 3 ? 'zip' : 'mp4'}">file ${i}</a>`).join(' '));
    case '/popups': return page('Pop-ups', '<button id="b" style="position:fixed;top:40px;left:40px;width:200px;height:60px" onclick="window.open(\'/opened\',\'_blank\')">open</button><script>setTimeout(function(){window.open("/ad1");window.open("/ad2","_blank");},300);</script>');
    case '/opened': return page('Opened', '<p>opened by a click</p>');
    case '/ad1': case '/ad2': return page('AD', '<p>an ad</p>');
    case '/loop': r.writeHead(302, { location: '/loop' }); r.end(); return;
    case '/never': r.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); r.write('<!doctype html><html><head><meta charset="utf-8"><title>Never ends</title></head><body><p>loading for ever</p>'); return; // (never ended)
    case '/404': r.writeHead(404, { 'content-type': 'text/html' }); r.end('<!doctype html><title>Not found</title><h1>404</h1>'); return;
    case '/500': r.writeHead(500, { 'content-type': 'text/html' }); r.end('<!doctype html><title>Server error</title><h1>500</h1>'); return;
    case '/dl': return page('A download', `<a id="rtl" download href="/get/${encodeURIComponent(RTL)}">${RTL}</a>`);
    case '/media': return page('A clip', '<video id="v" controls><source src="/v/clip-360.mp4"><source src="/v/clip-720.mp4"><source src="/v/clip-1080.mp4"></video><a href="/v/clip-480.webm">480</a><script>setTimeout(function(){var s=document.createElement("source");s.src="/v/clip-2160.mp4";document.getElementById("v").appendChild(s);},500);</script>');
    case '/form': return page('Upload', '<form><input id="f" type="file" multiple><button>Send</button></form>');
    case '/perm': return page('Asks', '<script>try{Notification.requestPermission();}catch(e){}try{navigator.geolocation.getCurrentPosition(function(){},function(){});}catch(e){}</script><p>asks</p>');
    case '/long': return page(LONG + ' end', '<p>long</p>');
    case '/ar': return page('صفحة عربية', '<p>مرحبًا بك</p>', ' dir="rtl" lang="ar"');
    default:
      if (u.pathname.startsWith('/get/')) { r.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(RTL)}` }); r.end('x'); return; }
      r.writeHead(404); r.end();
  }
});

// ---- part 0: one address rule, three copies (the page's, the phone's Java, the computer's bar), on one table
const TABLE = [['', ''], ['https://a.example/x', 'https://a.example/x'], ['HTTP://A.EXAMPLE', 'HTTP://A.EXAMPLE'], ['magnet:?xt=urn:btih:abc', 'magnet:?xt=urn:btih:abc'],
  ['example.org', 'https://example.org'], ['example.org:8443/p?q=1', 'https://example.org:8443/p?q=1'], ['sub.example.co.uk/a b', 'S:sub.example.co.uk%2Fa%20b'], ['مثال.مصر/صفحة', 'https://مثال.مصر/صفحة'],
  ['localhost', 'http://localhost'], ['localhost:3000/x', 'http://localhost:3000/x'], ['127.0.0.1:8080/page', 'http://127.0.0.1:8080/page'], ['192.168.1.5', 'http://192.168.1.5'], ['[::1]:8080', 'http://[::1]:8080'],
  ['two words', 'S:two%20words'], ['hello', 'S:hello'], ['1.5', 'S:1.5'], ['a.b', 'S:a.b'], ['كلمة', 'S:%D9%83%D9%84%D9%85%D8%A9'], ['report.v2', 'https://report.v2']];
async function rulePart() {
  const esbuild = require(path.join(ROOT, 'node_modules', 'esbuild'));
  const out = esbuild.buildSync({ entryPoints: [path.join(ROOT, 'src', 'browser.ts')], bundle: true, format: 'cjs', platform: 'node', write: false, external: ['./native', './downloads/*', './ui/*', './i18n'] });
  const m = { exports: {} }; try { new Function('module', 'exports', 'require', out.outputFiles[0].text)(m, m.exports, () => ({})); } catch (e) { ok('[rule] the page\'s rule loads', false, String(e)); return; }
  const ts = (x) => m.exports.addressOf ? m.exports.addressOf(x, 'S:').url : `(no addressOf)`;
  const src = raw('INIT_JS'); const a = src.indexOf('function addr(v){'); const b = src.indexOf('\nvar FX='); const js = a >= 0 && b > a ? new Function(`${src.slice(a, b)}; return addr;`)() : null;
  const bar = (x) => (js ? (js(x) ?? '').replace(/^https:\/\/duckduckgo\.com\/\?q=/, 'S:') : '(no addr)');
  let java = null; try { const { execFileSync } = require('node:child_process'); const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-webrules-'));
    execFileSync('javac', ['-nowarn', '-encoding', 'UTF-8', '-d', d, path.join(ROOT, 'native', 'android', 'KtWebRules.java'), path.join(__dirname, 'native', 'WebT.java')], { stdio: 'pipe' });
    java = execFileSync('java', ['-Dfile.encoding=UTF-8', '-cp', d, 'app.kurokawa.tools.WebT'], { input: TABLE.map((r) => r[0]).join('\n') + '\n', encoding: 'utf8' }).split('\n'); } catch (e) { console.log('skip the phone\'s rule (no javac): ' + String(e.message).slice(0, 120)); }
  for (const [i, [text, want]] of TABLE.entries()) {
    const norm = (u) => (u.startsWith('S:') ? 'S:' + decodeURIComponent(u.slice(2)) : u);
    ok(`[rule] «${text}» → ${want || '(nothing)'}: page`, norm(ts(text)) === norm(want), ts(text));
    if (text) ok(`[rule] «${text}»: the computer's bar the same`, norm(bar(text)) === norm(want), bar(text));
    if (java) ok(`[rule] «${text}»: the phone's the same`, norm(java[i] ?? '') === norm(want), java[i]);
  }
}

// ---- part 1: the computer's browser page scripts
const RS = fs.readFileSync(path.join(SRC, 'browser.rs'), 'utf8');
const raw = (name) => { const m = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(RS); assert.ok(m, name); return m[1]; };
const GRAB = fs.readFileSync(path.join(SRC, 'grab.js'), 'utf8').trim();
const N = 'n0nce'; const CMD = 'cmdtok'; const K = '__kt' + N;
const WORDS = { en: { back: 'Back', forward: 'Forward', reload: 'Reload', address: 'Address or search', grab: 'Grab links', copy: 'Copy address', external: 'Open in the system\'s browser', rtl: false }, ar: { back: 'رجوع', forward: 'تقدّم', reload: 'إعادة التحميل', address: 'عنوان أو بحث', grab: 'التقاط الروابط', copy: 'نسخ العنوان', external: 'فتح في متصفّح النظام', rtl: true } };
// (The bar's shadow root opened for the test alone, to reach its buttons; tauribrowsertools.cjs checks it is closed.)
const initFor = (lang) => raw('INIT_JS').replace('__S__', `${raw('SENDER_JS')}(${JSON.stringify(K)},${JSON.stringify(N)},1500)`).replace('__CMD__', JSON.stringify(CMD)).replace('__C__', JSON.stringify(WORDS[lang])).replace("attachShadow({mode:'closed'})", "attachShadow({mode:'open'})");

async function pcPart(br, base, lang) {
  const L0 = `[pc ${lang}]`;
  const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } }); const p = await ctx.newPage(); p.setDefaultTimeout(8000);
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  const cdp = await ctx.newCDPSession(p); const ackCdp = (js) => cdp.send('Runtime.evaluate', { expression: js, userGesture: false }).catch(() => undefined);
  const got = []; const parts = {};
  await ctx.route('https://kr-lane.invalid/**', async (route) => {
    const u = new URL(route.request().url()); const seg = u.pathname.slice(1).split('/'); await route.fulfill({ status: 204, body: '' });
    if (seg.length !== 4 || seg[0] !== N) return; const [rid, part, total] = [seg[1], +seg[2], +seg[3]];
    const a = (parts[rid] = parts[rid] || { n: total, got: {} }); a.got[part] = Buffer.from(u.search.slice(1).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (Object.keys(a.got).length === a.n) { delete parts[rid]; got.push({ rid, head: JSON.parse(a.got[0].toString('utf8')), body: Buffer.concat(Array.from({ length: a.n - 1 }, (_, i) => a.got[i + 1])) }); }
    // (Acknowledged as browser.rs does — an eval that is no gesture: Playwright's evaluate would count as one, and let a page's own pop-up through.)
    await ackCdp(`(function(){var a=window[${JSON.stringify(K)}];if(a)a.ack(${JSON.stringify(`${rid}/${part}`)});})()`);
  });
  // (Nothing leaves this machine: any other address is a made-up page.)
  const outside = [];
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/]|kr-lane\.invalid\/)/, (route) => { outside.push(route.request().url()); return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Elsewhere</title><p>made-up</p>' }); });
  await ctx.addInitScript(initFor(lang));
  const bar = () => p.evaluate(() => { const host = document.getElementById('kt-browser-bar'); if (!host || !host.shadowRoot) return null; const r = host.getBoundingClientRect(); return { r: [r.x, r.y, r.width, r.height], btns: [...host.shadowRoot.querySelectorAll('button')].map((b) => { const x = b.getBoundingClientRect(); return { t: b.title, txt: b.textContent, x: x.x + x.width / 2, y: x.y + x.height / 2, w: x.width, h: x.height, dis: b.disabled }; }), input: (() => { const i = host.shadowRoot.querySelector('input'); const x = i.getBoundingClientRect(); return { x: x.x + x.width / 2, y: x.y + x.height / 2, v: i.value, h: x.height }; })() }; });
  const clickBtn = async (title) => { const b = (await bar()).btns.find((x) => x.t === title); await p.mouse.click(b.x, b.y); };
  const waitUrl = async (re, ms = 6000) => { const t = Date.now(); while (Date.now() - t < ms) { if (re.test(p.url())) return true; await sleep(50); } return false; };
  const W = WORDS[lang];
  const go = async (pg) => { await p.goto(base + pg, { waitUntil: 'commit' }); await p.waitForFunction(() => document.readyState === 'complete' && !!document.getElementById('kt-browser-bar'), null, { timeout: 8000 }).catch(() => undefined); };
  // every page shows the bar, of 40 px targets
  for (const pg of ['/', '/links', '/404', '/500', '/form', '/perm', '/long', '/ar', '/dl', '/media']) {
    await p.goto(base + pg, { waitUntil: 'commit' }); await p.waitForFunction(() => !!document.getElementById('kt-browser-bar'), null, { timeout: 5000 }).catch(() => undefined);
    const b = await bar(); ok(`${L0} ${pg}: the bar is there`, !!b);
    if (b && pg === '/') { const small = b.btns.filter((x) => x.w < 40 || x.h < 40).map((x) => [x.t, Math.round(x.w), Math.round(x.h)]); ok(`${L0} the bar's buttons are 40 px at least`, !small.length, small); ok(`${L0} the bar inside the window`, b.r[0] >= 0 && b.r[0] + b.r[2] <= 1280 && b.r[1] + b.r[3] <= 800, b.r); }
    if (pg === '/media' && lang === 'en') { await sleep(800); await p.screenshot({ path: path.join(SHOTS, 'D5-browser-pc-en.png') }); }
  }
  // the page that never finishes loading: the bar all the same (without it the window has no way back)
  await p.goto(base + '/never', { waitUntil: 'commit' }); const nb = await p.waitForFunction(() => !!document.getElementById('kt-browser-bar'), null, { timeout: 5000 }).then(() => true).catch(() => false);
  ok(`${L0} a page that never finishes loading: the bar is there`, nb);
  // the redirect loop: the engine's own error; the bar's way out is the address
  await p.goto(base + '/loop', { waitUntil: 'commit' }).catch(() => undefined); await sleep(500); ok(`${L0} a redirect loop: no page errors from the bar`, !errors.length, errors);
  // titles sent: long cut to 200, Arabic as it is
  got.length = 0; await p.goto(base + '/long', { waitUntil: 'commit' }); await sleep(1500);
  const tl = got.filter((m) => m.rid[0] === 't').map((m) => m.head.title); ok(`${L0} a 300-character title sent cut to 200`, tl.some((x) => x.length === 200 && x.startsWith('A very long')), tl.map((x) => x.length));
  got.length = 0; await p.goto(base + '/ar', { waitUntil: 'commit' }); await sleep(1500);
  ok(`${L0} an Arabic title sent as it is`, got.some((m) => m.rid[0] === 't' && m.head.title === 'صفحة عربية'));
  // pop-ups: opened by the page itself → not followed; by a click → in this window
  // (in a fresh tab of the test's own,
  // (and nothing evaluated in it before the pop-ups fire: Playwright's evaluate counts as a gesture)
  { const q = await ctx.newPage(); await q.goto(base + '/popups', { waitUntil: 'commit' }); await sleep(1500);
    ok(`${L0} pop-ups a page opens by itself do not take the window away`, /\/popups$/.test(q.url()), q.url());
    await q.mouse.click(140, 70); const t = Date.now(); while (Date.now() - t < 6000 && !/\/opened$/.test(q.url())) await sleep(50);
    ok(`${L0} a pop-up opened by a click: in this window`, /\/opened$/.test(q.url()), q.url());
    ok(`${L0} still one window each`, ctx.pages().length === 2, ctx.pages().length); await q.close(); }
  // the address typed: a local address with a port, words, a name
  const type = async (text) => { const b = await bar(); await p.mouse.click(b.input.x, b.input.y); await sleep(80); await p.keyboard.press('Control+a'); await p.keyboard.type(text); await p.keyboard.press('Enter'); };
  const hostPort = base.replace(/^http:\/\//, '');
  await type(`${hostPort}/media`); ok(`${L0} «${hostPort}/media» typed: that page, plain http`, await waitUrl(new RegExp(`^http://${hostPort.replace(/\./g, '\\.')}/media$`)), p.url());
  await type('two words'); ok(`${L0} words typed: a web search`, await waitUrl(/[?&]q=two(\+|%20)words/), p.url());
  await go('/');
  await type('localhost:9/x'); ok(`${L0} «localhost:9/x» typed: plain http`, await waitUrl(/^http:\/\/localhost:9\/x/), p.url());
  // back / forward / reload, each twice quickly, by the bar and by the keys
  await go('/'); await go('/links'); await go('/media'); await p.waitForFunction(() => !!document.getElementById('kt-browser-bar'));
  await clickBtn(W.back); await sleep(60); await clickBtn(W.back).catch(() => undefined); await sleep(1200);
  ok(`${L0} Back twice quickly: two pages back`, /\/$/.test(p.url()), p.url());
  await p.waitForFunction(() => !!document.getElementById('kt-browser-bar')); await clickBtn(W.forward); await sleep(60); await clickBtn(W.forward).catch(() => undefined); await sleep(1200);
  ok(`${L0} Forward twice quickly: two pages on`, /\/media$/.test(p.url()), p.url());
  await p.waitForFunction(() => !!document.getElementById('kt-browser-bar')); await clickBtn(W.reload); await sleep(60); await clickBtn(W.reload).catch(() => undefined); await sleep(1000);
  ok(`${L0} Reload twice quickly: still the page, no errors`, /\/media$/.test(p.url()) && !errors.length, [p.url(), errors]);
  await p.waitForFunction(() => !!document.getElementById('kt-browser-bar')); await p.keyboard.press('Alt+ArrowLeft'); await sleep(40); await p.keyboard.press('Alt+ArrowLeft'); await sleep(1200);
  ok(`${L0} Alt+← twice: two pages back`, /\/$/.test(p.url()), p.url());
  // the grab: 500 links; the media page's qualities, the one added after load; the right-to-left name
  const grab = async () => { const before = got.length; await p.evaluate(`(function(){var S=window[${JSON.stringify(K)}];var r=${GRAB};S.send('g'+Date.now(),{kind:'grab'},new TextEncoder().encode(JSON.stringify(r)));})()`); const t = Date.now(); while (Date.now() - t < 8000) { const m = got.slice(before).find((x) => x.rid[0] === 'g'); if (m) return JSON.parse(m.body.toString('utf8')); await sleep(50); } return null; };
  await go('/links'); const g1 = await grab();
  ok(`${L0} grab on 500 links: all 500`, g1 && g1.links.filter((l) => /\/files\/f\d+\./.test(l.href)).length === 500, g1 && g1.links.length);
  await go('/media'); await sleep(900); const g2 = await grab(); const vids = (g2?.links ?? []).filter((l) => l.kind === 'video').map((l) => l.href.replace(/^.*\/v\//, ''));
  ok(`${L0} grab on the media page: every quality, the one added after load too`, ['clip-360.mp4', 'clip-720.mp4', 'clip-1080.mp4', 'clip-2160.mp4', 'clip-480.webm'].every((x) => vids.includes(x)), vids);
  // (improvement: the bar says how many files the page offers, before Grab is pressed)
  let gb = null; for (let i = 0; i < 30; i++) { gb = (await bar()).btns.find((x) => x.t === W.grab || x.t.startsWith(W.grab)); if (gb && /5/.test(gb.txt)) break; await sleep(100); }
  ok(`${L0} the bar's Grab says how many files this page offers`, !!gb && /\d/.test(gb.txt) && /5/.test(gb.txt), gb && gb.txt);
  if (lang === 'en') await p.screenshot({ path: path.join(SHOTS, 'D5-imp-5.png'), clip: { x: 0, y: 600, width: 900, height: 200 } });
  await go('/dl'); const g3 = await grab();
  ok(`${L0} grab of a link with a right-to-left name: its name kept`, g3 && g3.links.some((l) => l.text === RTL && decodeURIComponent(l.href).endsWith(RTL)), g3 && g3.links.map((l) => l.text));
  ok(`${L0} nothing reached outside 127.0.0.1 but the made-up stand-ins`, outside.every((u) => !/127\.0\.0\.1/.test(u)), outside);
  ok(`${L0} no page errors`, !errors.length, errors);
  await ctx.close();
}

// ---- part 2: the page app
const serveApp = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
async function tapAt(p, loc) { const box = await loc.boundingBox({ timeout: 5000 }); const cdp = await p.context().newCDPSession(p); const x = box.x + box.width / 2, y = box.y + box.height / 2; await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] }); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach(); }
async function appPart(br, port, lang, w, hgt, pc) {
  const L0 = `[app ${pc ? 'pc' : 'phone ' + w} ${lang}]`;
  const ctx = await br.newContext({ viewport: { width: w, height: hgt }, deviceScaleFactor: 2, hasTouch: !pc }); const p = await ctx.newPage(); p.setDefaultTimeout(8000);
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await ctx.route(/^https?:\/\/(?!127\.0\.0\.1[:/])/, (r) => r.fulfill({ status: 404, body: '' }));
  await p.addInitScript(({ lang, pc }) => {
    localStorage.setItem('kr.lang', lang); window.__calls = []; const L = {}; window.__emit = (ev, d) => (L[ev] || []).forEach((f) => f(d));
    const task = (o) => ({ id: 'n' + window.__calls.length, kind: 'http', name: 'x', state: 'queued', files: [], done: 0, total: 0, downSpeed: 0, upSpeed: 0, addedAt: Date.now(), source: o.source });
    if (pc) {
      const tasks = [];
      window.kurokawaTools = { platform: 'desktop', available: true, os: 'linux', ready: async () => ({}), list: async () => tasks, add: async (o) => { window.__calls.push(['add', o]); return task(o); }, pause: async () => {}, resume: async () => {}, remove: async () => {}, setFiles: async () => {}, setLimits: async () => {}, configure: async () => {}, torrentInfo: async () => null, open: async () => {}, defaultDir: async () => '/d', pickDir: async () => '/x', onTasks: (cb) => { cb(tasks); return () => {}; },
        browse: async (o) => { window.__calls.push(['browse', o]); return true; }, onBrowser: (cb) => { L.browser = [cb]; return () => {}; } };
    } else {
      const plugin = new Proxy({ addListener: (ev, fn) => { (L[ev] = L[ev] || []).push(fn); return { remove() {} }; }, list: async () => ({ tasks: [] }), add: async (o) => { window.__calls.push(['add', o]); return { task: task(o) }; } },
        { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async (a) => { window.__calls.push([k, a]); return {}; }) });
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
    }
  }, { lang, pc });
  await p.goto(`http://127.0.0.1:${port}/#/`); await p.waitForSelector('.fab, .rail-fab', { timeout: 15000 }); await sleep(700);
  const tap = (loc) => (pc ? loc.click() : tapAt(p, loc));
  const calls = (k) => p.evaluate((k) => window.__calls.filter((c) => c[0] === k).map((c) => c[1]), k);
  const layout = async (what) => {
    const lay = await p.evaluate(() => { const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
      const small = [...document.querySelectorAll('.sheet button, .sheet .grab-row, .sheet input[type=text], .sheet input[type=url]')].filter(vis).map((e) => { const r = e.getBoundingClientRect(); return [(e.className || e.tagName) + ':' + (e.textContent || '').slice(0, 14), Math.round(r.width), Math.round(r.height)]; }).filter(([, a, b]) => a < 40 || b < 40);
      return { small, over: document.documentElement.scrollWidth - window.innerWidth }; });
    // (Targets by touch: the phone's; a computer's sheets keep their own, pointer-sized density, as uihunt.cjs holds them.)
    if (!pc) ok(`${L0} ${what}: targets ≥ 40 px`, !lay.small.length, lay.small.slice(0, 6)); ok(`${L0} ${what}: no sideways scroll`, lay.over <= 1, lay.over);
  };
  // the browser opened twice quickly (the Downloads bar's globe): opened once
  const globe = p.locator('.browse-btn').first();
  if (await globe.count()) { await tap(globe); await tap(globe).catch(() => undefined); await sleep(400); const b = await calls('browse'); ok(`${L0} the browser button tapped twice quickly: opened once`, b.length === 1, b); }
  // the Browse sheet: what Go will do, said first; an address with a port, a non-Latin name, words
  const openSheet = async () => { await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove())); await tap(p.locator(pc ? '.rail-fab' : '.fab').first()); await p.waitForSelector('.fab-item'); await tap(p.locator('.fab-item[data-act="globe"]').first()); await p.waitForSelector('.sheet .search-input'); };
  const cases = [['127.0.0.1:8080/page', /^http:\/\/127\.0\.0\.1:8080\/page$/], ['مثال.مصر/صفحة', /^https:\/\/مثال\.مصر\/صفحة$/], ['example.org:8443', /^https:\/\/example\.org:8443$/], ['two words', /[?&]q=two%20words$/]];
  for (const [text, re] of cases) {
    await openSheet(); await p.fill('.sheet .search-input', text); await sleep(150);
    const hint = await p.$eval('.sheet .browse-will', (e) => e.textContent).catch(() => '');
    ok(`${L0} «${text}»: the sheet says what Go will do`, !!hint && (/q=/.test(String(re)) ? (lang === 'ar' ? /بحث|ابحث/.test(hint) : /[Ss]earch/.test(hint)) : hint.includes(text.split('/')[0])), hint);
    if (text === 'two words' && !pc && w === 412) await p.screenshot({ path: path.join(SHOTS, `D5-imp-4${lang === 'ar' ? '-ar' : ''}.png`) });
    await p.evaluate(() => { window.__calls = []; }); await p.press('.sheet .search-input', 'Enter'); await sleep(300);
    const b = await calls('browse'); ok(`${L0} «${text}» → ${re}`, b.length === 1 && (re.test(b[0].url) || re.test(decodeURIComponent(b[0].url))), b);
  }
  await openSheet(); await layout('the Browse sheet'); await p.keyboard.press('Escape').catch(() => undefined);
  // a grab of 500 links with right-to-left names and several qualities
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  const pageUrl = 'http://127.0.0.1:9/post/1';
  const links = [...Array.from({ length: 500 }, (_, i) => ({ href: `http://127.0.0.1:9/files/${i % 2 ? encodeURIComponent('ملف ' + i + ' — نسخة.zip') : 'file-' + i + '.zip'}`, text: '' })),
    ...['360', '720', '1080'].map((q) => ({ href: `http://127.0.0.1:9/v/clip-${q}.mp4`, text: '', kind: 'video', size: Number(q) * 1e6, type: 'video/mp4' }))];
  await p.evaluate(([u, ls]) => window.__emit('browser', { kind: 'links', url: u, title: 'منشور فيه ملفات', ua: 'Mozilla/5.0 made-up', links: ls }), [pageUrl, links]);
  await p.waitForSelector('.grab-row'); await sleep(300);
  const chips = await p.$$eval('.sheet .chip-row.wrap:not(.grab-projects) .chip', (c) => c.map((x) => x.textContent));
  ok(`${L0} grab: the kinds with their counts (videos 3, archives 500)`, chips.some((x) => /3/.test(x)) && chips.some((x) => /500/.test(x)), chips);
  // (right-to-left names: isolated in their line, the line's other parts left where they belong — the archives shown)
  await tap(p.locator('.sheet .chip-row.wrap:not(.grab-projects) .chip', { hasText: '500' }).first()); await sleep(300);
  const iso = await p.$$eval('.grab-row small.src', (r) => r.slice(0, 40).map((x) => [x.textContent, !!x.querySelector('bdi'), x.getAttribute('dir')]));
  const arRows = iso.filter((x) => /[\u0600-\u06ff]/.test(x[0]));
  ok(`${L0} grab: a right-to-left name in a row's line is isolated`, !arRows.length || arRows.every((x) => x[1]), arRows.slice(0, 2));
  await layout('the grab sheet');
  if (!pc && w === 412) await p.screenshot({ path: path.join(SHOTS, `D5-browser-phone-${lang}.png`) });
  // the list changed after load: a second grab replaces the first, one sheet
  await p.evaluate(([u, ls]) => window.__emit('browser', { kind: 'links', url: u, title: 'again', links: ls }), [pageUrl, [...links.slice(500), { href: 'http://127.0.0.1:9/v/clip-2160.mp4', text: '', kind: 'video' }]]);
  await sleep(500); ok(`${L0} a second grab: one sheet, the new list`, (await p.$$('.sheet')).length === 1 && /2160/.test(await p.$eval('.sheet', (e) => e.textContent)), (await p.$$('.sheet')).length);
  // Add twice quickly: one batch
  await p.evaluate(() => { window.__calls = []; }); const add = p.locator('.sheet .sheet-actions .btn.primary').first(); await tap(add); await tap(add).catch(() => undefined); await sleep(800);
  const adds = await calls('add'); ok(`${L0} grab Add twice quickly: each picked link added once`, adds.length > 0 && new Set(adds.map((a) => a.source.url)).size === adds.length, adds.length);
  // a download with a right-to-left name → the Add sheet with that name
  await p.evaluate(() => document.querySelectorAll('.sheet, .sheet-scrim, .scrim').forEach((e) => e.remove()));
  await p.evaluate((n) => window.__emit('browser', { kind: 'download', url: 'http://127.0.0.1:9/get/x', name: n, referer: 'http://127.0.0.1:9/dl', ua: 'Mozilla/5.0 made-up' }), RTL);
  await p.waitForSelector('.sheet textarea', { timeout: 6000 }).catch(() => undefined); await sleep(400);
  const nm = await p.evaluate(() => (document.querySelector('.sheet .save-as input.grow')?.value ?? '') + '.' + (document.querySelector('.sheet .ext-in')?.value ?? ''));
  ok(`${L0} a download with a right-to-left name: the Add sheet keeps it`, nm === RTL, nm);
  ok(`${L0} no page errors`, !errors.length, errors);
  await ctx.close();
}

(async () => {
  const t0 = Date.now(); const br = await chromium.launch();
  const app = serveApp().listen(0); const appPort = app.address().port;
  await new Promise((res) => site.listen(0, '127.0.0.1', res)); const base = `http://127.0.0.1:${site.address().port}`;
  if (want('rule')) await rulePart();
  if (want('pc')) for (const lang of ['en', 'ar']) await pcPart(br, base, lang);
  if (want('app')) for (const [lang, w, h, pc] of [['en', 360, 800, false], ['ar', 360, 800, false], ['en', 412, 915, false], ['ar', 412, 915, false], ['en', 1280, 800, true], ['ar', 1280, 800, true]]) await appPart(br, appPort, lang, w, h, pc);
  await br.close(); app.close(); site.close();
  console.log(`browsewalk: ${passes} ok, ${fails} failed, ${Math.round((Date.now() - t0) / 1000)} s; shots in ${SHOTS}`);
  if (fails) console.log('faults:\n  ' + faultLog.join('\n  '));
  console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
