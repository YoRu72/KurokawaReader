// The Tauri shell's in-app browser (stage R4), its page side: the scripts desktop-tauri/src-tauri/src/browser.rs puts
// in a site's page — the channel (SENDER_JS), a request made by the page (FETCH_JS), what the page says of itself
// (STATE_JS), the window's own script (INIT_JS: new windows kept in it; BROWSE_JS: the bar) — taken from browser.rs
// and put together as Rust puts them, run in Chromium on a local test site:
//  - by the command (a stand-in for Tauri's IPC that takes kr_browser_deliver) and by addresses (the navigation to
//    https://kr-lane.invalid/… answered «204 No Content», as the window's handler refuses it, each message
//    acknowledged as Rust acknowledges it), the answers read back as browserlogic.rs reads them (and, when rustc is
//    there, by browserlogic.rs itself);
//  - the site's cookie (HttpOnly) goes with the page's request; binary, POST, a body in many parts; the page's own
//    beforeunload never runs for the channel; a navigation the site starts is not cancelled by the channel;
//  - the state of a page and of a check page; `until` tested by the page; links and window.open kept in the window;
//    the browser's bar there (closed shadow root), the page's title sent.
// node tests/tauribrowser.cjs
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', 'desktop-tauri', 'src-tauri', 'src');
const RS = fs.readFileSync(path.join(SRC, 'browser.rs'), 'utf8');
const raw = (name) => { const m = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(RS); assert.ok(m, `${name} not found in browser.rs`); return m[1]; };
const J = { SENDER: raw('SENDER_JS'), FETCH: raw('FETCH_JS'), STATE: raw('STATE_JS'), INIT: raw('INIT_JS'), BROWSE: raw('BROWSE_JS'), PROBE: raw('PROBE_JS'), CLICK: raw('CLICK_JS') };
const CHUNK = (() => { const m = /pub const CHUNK: usize = (\d+) \* 1024;/.exec(fs.readFileSync(path.join(SRC, 'browserlogic.rs'), 'utf8')); return Number(m[1]) * 1024; })();
const js = (s) => JSON.stringify(s);
// (As browser.rs's sender_call, init_script and the replacements: ours first, the page's words last.)
const sender = (nonce, pref = '') => `${J.SENDER}(${js('__kr' + nonce)},${js(nonce)},${CHUNK},${js(pref)})`;
const initScript = (nonce, browse) => J.INIT.replace('__S__', sender(nonce)).replace('__BROWSE__', browse ? J.BROWSE.replace('__C__', JSON.stringify(browse)) : '');
const fetchScript = (nonce, rid, o) => J.FETCH.replace('__S__', sender(nonce)).replace('__RID__', js(rid)).replace('__O__', JSON.stringify(o));
const stateScript = (nonce, rid, until = '') => J.STATE.replace('__S__', sender(nonce)).replace('__RID__', js(rid)).replace('__UNTIL__', js(until));

// The Rust side's reading of the channel (browserlogic.rs's parse_reply and Assembly).
function b64urlDecode(t) { return Buffer.from(String(t).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function parseReply(url, nonce) {
  const m = /^https?:\/\/kr-lane\.invalid(\/[^?#]*)(?:\?([^#]*))?/i.exec(url); if (!m) return null;
  const seg = m[1].replace(/^\//, '').split('/');
  if (seg.length !== 4 || seg[0] !== nonce || !/^[A-Za-z0-9]{1,24}$/.test(seg[1])) return 'refused';
  const part = Number(seg[2]); const total = Number(seg[3]);
  if (!(total > 0 && part < total)) return 'refused';
  return { rid: seg[1], part, total, data: b64urlDecode(m[2] || '') };
}

// The test site.
const BIG = Buffer.from(Array.from({ length: 300 * 1024 + 17 }, (_, i) => (i * 31 + 7) & 255));
const BIN = Buffer.from([...Array(256).keys()]);
function site() {
  return http.createServer((req, res) => {
    const u = req.url.split('?')[0]; const cookie = req.headers.cookie || '';
    const page = (title, body = '', extra = {}) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...extra }); res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`); };
    if (u === '/site/') return page('KR test site', '<a id="pop" href="/site/popup" target="_blank">p</a><a id="dl" href="/site/file.epub">f</a><script>window.__unloads=0;window.addEventListener("beforeunload",function(){window.__unloads++;});</script>', { 'set-cookie': ['kr_site=signed-in; Path=/; HttpOnly', 'kr_seen=1; Path=/'] });
    if (u === '/site/private') { if (/(^|;\s*)kr_site=signed-in(;|$)/.test(cookie)) { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }); res.end('signed-in;ua=' + req.headers['user-agent']); } else { res.writeHead(401); res.end('signed out'); } return; }
    if (u === '/site/popup') return page('KR popup');
    if (u === '/site/check') return page('Just a moment...', '<div id="challenge-running"></div>');
    if (u === '/site/slow') { setTimeout(() => page('KR slow'), 1500); return; }
    if (u === '/site/landing') return page('KR landing');
    if (u === '/bin') { res.writeHead(200, { 'content-type': 'application/octet-stream' }); res.end(BIN); return; }
    if (u === '/big') { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG.length }); res.end(BIG); return; }
    if (u === '/echo') { const parts = []; req.on('data', (c) => parts.push(c)); req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'x-kr': 'a' }); res.end(req.method + ':' + Buffer.concat(parts).toString()); }); return; }
    res.writeHead(404); res.end('not found');
  });
}

// (Polled rather than waited for as a navigation: the channel's own refused navigations — «204» here — would end a
// Playwright navigation wait with ERR_ABORTED.)
async function reach(p, pathname, ms = 10000) {
  const until = Date.now() + ms;
  for (;;) {
    let at = ''; try { at = new URL(p.url()).pathname; } catch { /* between pages */ }
    if (at === pathname) { await p.waitForLoadState('load').catch(() => {}); return; }
    if (Date.now() > until) throw new Error(`not at ${pathname} (at ${at})`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const { chromium } = require('playwright');
  const srv = site().listen(0); const base = `http://127.0.0.1:${srv.address().port}`;
  const br = await chromium.launch();
  const nonce = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const recorded = [];
  try {
    // A browser window: the page with INIT_JS before its own scripts, the channel's addresses refused (204) and
    // acknowledged; `ipc` stands for Tauri's __TAURI_INTERNALS__ (kr_browser_deliver) when given.
    async function windowOn(url, { ipc = null, browse = null } = {}) {
      const ctx = await br.newContext(); const p = await ctx.newPage(); p.setDefaultTimeout(15000);
      const errors = []; p.on('pageerror', (e) => errors.push(e.message));
      const inbox = new Map(); const done = new Map(); const navs = []; let delivered = 0;
      if (ipc) {
        await p.exposeFunction('__deliver', (d) => { delivered++; if (d.n !== nonce) return false; done.set(d.r, { meta: d.m, body: d.b ? Buffer.from(d.b, 'base64') : Buffer.alloc(0), via: 'ipc' }); return true; });
        await p.addInitScript((mode) => { window.__TAURI_INTERNALS__ = { invoke: (cmd, args) => (mode === 'refuse' ? Promise.reject('kr_browser_deliver may not be called from this window') : cmd === 'kr_browser_deliver' ? window.__deliver(args.d) : Promise.reject('no')) }; }, ipc);
      }
      await p.addInitScript({ content: initScript(nonce, browse) });
      await p.route('https://kr-lane.invalid/**', async (route) => {
        const u = route.request().url(); navs.push(u); recorded.push(u);
        const m = parseReply(u, nonce);
        await route.fulfill({ status: 204, body: '' });
        if (!m || m === 'refused') return;
        const a = inbox.get(m.rid) || { parts: new Array(m.total), got: 0 };
        if (!a.parts[m.part]) { a.parts[m.part] = m.data; a.got++; }
        inbox.set(m.rid, a);
        if (a.got === m.total) { inbox.delete(m.rid); done.set(m.rid, { meta: JSON.parse(a.parts[0].toString()), body: Buffer.concat(a.parts.slice(1)), via: 'nav' }); }
        await p.evaluate(([k, id]) => { const a = window[k]; if (a) a.ack(id); }, ['__kr' + nonce, m.rid + '/' + m.part]).catch(() => {});
      });
      await p.goto(url);
      async function ask(script, rid, ms = 15000) { await p.evaluate(script); const until = Date.now() + ms; while (Date.now() < until) { if (done.has(rid)) { const a = done.get(rid); done.delete(rid); return a; } await new Promise((r) => setTimeout(r, 20)); } throw new Error('no answer for ' + rid); }
      return { p, ctx, ask, navs, errors, done, delivered: () => delivered };
    }

    for (const mode of ['nav', 'ipc']) {
      const w = await windowOn(base + '/site/', mode === 'ipc' ? { ipc: 'ok' } : { ipc: 'refuse' });
      // The state of the site's page.
      const st = await w.ask(stateScript(nonce, 'r1'), 'r1');
      assert.equal(st.via, mode, 'channel');
      assert.deepEqual({ ...st.meta, href: undefined }, { ready: 'complete', origin: base, check: false, blocked: false, title: 'KR test site', href: undefined, hit: '' });
      // A request of the page: the HttpOnly cookie goes, the page's user agent; headers a browser sets itself left out.
      const r2 = await w.ask(fetchScript(nonce, 'r2', { url: base + '/site/private', method: 'GET', headers: { 'User-Agent': 'X', 'x-a': '1' }, body: null, bodyBase64: false, timeout: 9000 }), 'r2');
      assert.equal(r2.meta.status, 200); assert.match(r2.body.toString(), /^signed-in;ua=Mozilla\/5\.0 /);
      const r3 = await w.ask(fetchScript(nonce, 'r3', { url: base + '/bin', method: 'GET', headers: {}, body: null, bodyBase64: false, timeout: 9000 }), 'r3');
      assert.ok(r3.body.equals(BIN), 'binary');
      const r4 = await w.ask(fetchScript(nonce, 'r4', { url: base + '/echo', method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: 'نص ✓', bodyBase64: false, timeout: 9000 }), 'r4');
      assert.equal(r4.body.toString(), 'POST:نص ✓'); assert.equal(r4.meta.headers['x-kr'], 'a');
      const r5 = await w.ask(fetchScript(nonce, 'r5', { url: base + '/echo', method: 'POST', headers: {}, body: 'eHl6', bodyBase64: true, timeout: 9000 }), 'r5');
      assert.equal(r5.body.toString(), 'POST:xyz');
      const r6 = await w.ask(fetchScript(nonce, 'r6', { url: base + '/big', method: 'GET', headers: {}, body: null, bodyBase64: false, timeout: 9000 }), 'r6', 30000);
      assert.ok(r6.body.equals(BIG), 'a body in parts');
      if (mode === 'nav') assert.ok(w.navs.length >= 1 + Math.ceil(BIG.length / CHUNK), 'messages ' + w.navs.length);
      // (R4b, a Mac: a GET answer over `big` sends its head alone — `large`, its length — and no body; a POST's
      // body still comes whole.)
      const r6b = await w.ask(fetchScript(nonce, 'r6b', { url: base + '/big', method: 'GET', headers: {}, body: null, bodyBase64: false, timeout: 9000, big: 100 * 1024 }), 'r6b');
      assert.equal(r6b.meta.status, 200); assert.equal(r6b.meta.large, BIG.length); assert.equal(r6b.body.length, 0, 'no body with large');
      const r6c = await w.ask(fetchScript(nonce, 'r6c', { url: base + '/bin', method: 'GET', headers: {}, body: null, bodyBase64: false, timeout: 9000, big: 100 * 1024 }), 'r6c');
      assert.ok(r6c.body.equals(BIN) && r6c.meta.large === undefined, 'a small answer under big comes whole');
      const r6d = await w.ask(fetchScript(nonce, 'r6d', { url: base + '/echo', method: 'POST', headers: {}, body: 'x'.repeat(200 * 1024), bodyBase64: false, timeout: 9000, big: 100 * 1024 }), 'r6d', 30000);
      assert.equal(r6d.body.length, 5 + 200 * 1024, 'a POST answer over big comes whole'); assert.equal(r6d.meta.large, undefined);
      const r7 = await w.ask(fetchScript(nonce, 'r7', { url: 'http://127.0.0.1:1/x', method: 'GET', headers: {}, body: null, bodyBase64: false, timeout: 9000 }), 'r7');
      assert.ok(typeof r7.meta.error === 'string' && r7.meta.error.length > 0, 'a failed request answers its error');
      // (The page is where it was; its own beforeunload never ran for the channel.)
      assert.equal(await w.p.evaluate(() => [location.pathname, window.__unloads].join(' ')), '/site/ 0');
      // `until` tested by the page.
      const r8 = await w.ask(stateScript(nonce, 'r8', '\\/site\\/$'), 'r8'); assert.equal(r8.meta.hit, base + '/site/');
      // Several at once: each answered.
      const many = await Promise.all(['m1', 'm2', 'm3'].map((rid) => w.ask(fetchScript(nonce, rid, { url: base + '/echo', method: 'POST', headers: {}, body: rid, bodyBase64: false, timeout: 9000 }), rid)));
      assert.deepEqual(many.map((a) => a.body.toString()), ['POST:m1', 'POST:m2', 'POST:m3']);
      // A link aimed at a new window, and window.open: in this window.
      await w.p.click('#pop'); await reach(w.p, '/site/popup');
      assert.equal(await w.p.title(), 'KR popup');
      await w.p.evaluate(() => { window.open('/site/landing', '_blank'); }); await reach(w.p, '/site/landing');
      assert.equal(w.p.context().pages().length, 1, 'no new window');
      // A navigation the site starts is not cancelled by the channel (a state asked while it is under way).
      await w.p.goto(base + '/site/');
      await w.p.evaluate(() => { setTimeout(() => { location.href = '/site/slow'; }, 0); });
      await new Promise((r) => setTimeout(r, 100));
      await w.p.evaluate(stateScript(nonce, 'r9')).catch(() => {});
      await reach(w.p, '/site/slow', 8000);
      assert.equal(await w.p.title(), 'KR slow', 'the site\'s own navigation went through');
      // A check page.
      await w.p.goto(base + '/site/check');
      const c = await w.ask(stateScript(nonce, 'r10'), 'r10');
      assert.equal(c.meta.check, true); assert.equal(c.meta.title, 'Just a moment...');
      assert.deepEqual(w.errors, [], 'page errors');
      if (mode === 'ipc') assert.ok(w.delivered() >= 10, 'answers by the command'); else assert.ok(w.navs.length > 10);
      await w.ctx.close();
      console.log(`tauribrowser: ${mode === 'ipc' ? 'by the command' : 'by addresses'} — state, the signed-in page (HttpOnly cookie), binary, POST, ${BIG.length} bytes in parts, an error, until, three at once, new windows kept, the site's navigation kept, a check page`);
    }

    // The browser as a browser: its bar (a closed shadow root), the page's title sent, Alt+← back.
    {
      const w = await windowOn(base + '/site/', { ipc: 'ok', browse: { back: 'Back', forward: 'Forward', reload: 'Reload', placeholder: 'Address', rtl: true } });
      await w.p.waitForSelector('kr-browser-bar', { state: 'attached' });
      const bar = await w.p.evaluate(() => { const h = document.querySelector('kr-browser-bar'); const r = h.getBoundingClientRect(); return { shadow: h.shadowRoot, w: r.width, h: r.height, right: Math.round(innerWidth - r.right), fixed: getComputedStyle(h).position }; });
      assert.equal(bar.shadow, null, 'closed shadow root'); assert.ok(bar.w > 150 && bar.h >= 40, 'bar size ' + JSON.stringify(bar)); assert.equal(bar.right, 12, 'right-to-left: on the right'); assert.equal(bar.fixed, 'fixed');
      const until = Date.now() + 5000; let title = null;
      while (Date.now() < until && !title) { for (const [k, v] of w.done) if (/^t/.test(k)) title = v.meta.title; await new Promise((r) => setTimeout(r, 50)); }
      assert.equal(title, 'KR test site', 'the title sent');
      await w.p.click('#pop'); await reach(w.p, '/site/popup');
      await w.p.keyboard.press('Alt+ArrowLeft'); await reach(w.p, '/site/');
      assert.deepEqual(w.errors, []);
      await w.ctx.close();
      console.log('tauribrowser: the browser\'s bar (closed shadow root, right-to-left), the title sent, Alt+← back');
    }
  } finally { await br.close(); srv.close(); }

  // The addresses as browserlogic.rs reads them: the same messages (when rustc is there).
  let rustc = null; try { rustc = execFileSync('rustc', ['--version']).toString().trim(); } catch { /* none */ }
  if (rustc) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-tauribrowser-'));
    try {
      const prog = `#[allow(dead_code)] #[path = ${JSON.stringify(path.join(SRC, 'browserlogic.rs'))}] mod browserlogic;
fn main() { let nonce = std::env::args().nth(1).unwrap(); let text = std::fs::read_to_string(std::env::args().nth(2).unwrap()).unwrap();
  for l in text.lines() { match browserlogic::parse_reply(l, &nonce) { browserlogic::Reply::Message(m) => println!("{} {} {} {}", m.rid, m.part, m.total, m.data.len()), browserlogic::Reply::Refused => println!("refused"), browserlogic::Reply::Other => println!("other") } } }`;
      fs.writeFileSync(path.join(dir, 'p.rs'), prog); fs.writeFileSync(path.join(dir, 'urls.txt'), recorded.join('\n'));
      execFileSync('rustc', ['--edition', '2021', '-o', path.join(dir, 'p'), path.join(dir, 'p.rs')], { stdio: 'pipe' });
      const out = execFileSync(path.join(dir, 'p'), [nonce, path.join(dir, 'urls.txt')], { maxBuffer: 1 << 26 }).toString().trim().split('\n');
      const want = recorded.map((u) => { const m = parseReply(u, nonce); return m === 'refused' ? 'refused' : `${m.rid} ${m.part} ${m.total} ${m.data.length}`; });
      assert.deepEqual(out, want, 'browserlogic.rs reads the addresses as the test does');
      console.log(`tauribrowser: browserlogic.rs read the ${recorded.length} addresses the same way`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
