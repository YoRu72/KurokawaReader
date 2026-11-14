// Stage P7: the in-app browser's page scripts (desktop-tauri/src-tauri/src/browser.rs — SENDER_JS, INIT_JS, the grab
// wrapper, grab.js) run in Chromium on a local site, the channel's addresses answered as browser.rs answers them
// (refused: 204, the page stays; read as kurokawa_shell::browserlogic reads them; each acknowledged): the title sent
// with the user agent; the bar there (closed shadow root, right-to-left when asked) and its keys (Ctrl+G → a command
// carrying the bar's own token, Ctrl+L); the grab's answer in several pieces, whole, with main.cjs's shape; a command a
// site forges with the wrong token is the only kind it can send and is told apart; window.open and target=_blank kept
// in the same window. Plain node + Playwright.
'use strict';
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const assert = require('node:assert/strict');
const SRC = path.join(__dirname, '..', 'desktop-tauri', 'src-tauri', 'src');
const RS = fs.readFileSync(path.join(SRC, 'browser.rs'), 'utf8');
const raw = (name) => { const m = new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`).exec(RS); assert.ok(m, name); return m[1]; };
const SENDER = raw('SENDER_JS'); const INIT = raw('INIT_JS'); const GRAB = fs.readFileSync(path.join(SRC, 'grab.js'), 'utf8').trim();
// (The grab wrapper as browser.rs's command() writes it: the format string's text, its {{ }} made single.)
const wrapFmt = /let js = format!\(\s*"(\(function\(\)\{\{var S=window\[\{\}\];[^"]*)",/.exec(RS); assert.ok(wrapFmt, 'grab wrapper');
const N = 'n0nce'; const CMD = 'cmdtok'; const K = '__kt' + N; const CH = 1500;
const words = { back: 'رجوع', forward: 'تقدّم', reload: 'إعادة', address: 'عنوان', grab: 'التقاط', copy: 'نسخ', external: 'خارجي', rtl: true };
const init = INIT.replace('__S__', `${SENDER}(${JSON.stringify(K)},${JSON.stringify(N)},${CH})`).replace('__CMD__', JSON.stringify(CMD)).replace('__C__', JSON.stringify(words));
const grabCall = (rid) => { let i = 0; const args = [JSON.stringify(K), GRAB, JSON.stringify(rid)]; return wrapFmt[1].replace(/\{\{/g, '\u0001').replace(/\}\}/g, '\u0002').replace(/\{\}/g, () => args[i++]).replace(/\u0001/g, '{').replace(/\u0002/g, '}'); };

const links = Array.from({ length: 120 }, (_, i) => `<a href="/files/f${i}.mkv">file ${i}</a>`).join(' ');
const site = http.createServer((req, res) => {
  const page = (title, body) => { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`); };
  if (req.url === '/') return page('KT site', `<h1>KT site</h1><video src="/v/movie.mp4"></video><a id="pop" href="/popup" target="_blank">pop</a> ${links}`);
  if (req.url === '/popup') return page('KT popup', '<p>popup</p>');
  if (req.url === '/opened') return page('KT opened', '<p>opened</p>');
  res.writeHead(404); res.end();
}).listen(0, async () => {
  const base = `http://127.0.0.1:${site.address().port}`;
  const br = await chromium.launch(); const ctx = await br.newContext({ viewport: { width: 900, height: 700 } }); const p = await ctx.newPage();
  const errors = []; p.on('pageerror', (e) => errors.push(e.message));
  await p.addInitScript(init);
  // (browser.rs's on_nav: parse_reply, Assembly, handle, the ack.)
  const parts = {}; const got = []; const pending = new Set();
  const b64u = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  await p.route('https://kr-lane.invalid/**', async (route) => {
    const u = new URL(route.request().url()); const seg = u.pathname.slice(1).split('/');
    await route.fulfill({ status: 204, body: '' });
    if (seg.length !== 4 || seg[0] !== N || !/^[a-z0-9]{1,24}$/i.test(seg[1])) return;
    const [rid, part, total] = [seg[1], +seg[2], +seg[3]];
    const wanted = /^[tc]/.test(rid) ? total === 1 : rid[0] === 'g' && pending.has(rid);
    if (wanted) {
      const a = (parts[rid] = parts[rid] || { n: total, got: {} }); a.got[part] = b64u(u.search.slice(1));
      if (Object.keys(a.got).length === a.n) { delete parts[rid]; const head = JSON.parse(a.got[0].toString('utf8')); const body = Buffer.concat(Array.from({ length: a.n - 1 }, (_, i) => a.got[i + 1])); got.push({ rid, head, body, n: a.n }); if (rid[0] === 'g') pending.delete(rid); }
    }
    await p.evaluate(([k, id]) => { const a = window[k]; if (a) a.ack(id); }, [K, `${rid}/${part}`]).catch(() => undefined);
  });
  const until = async (f, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = f(); if (v) return v; await p.waitForTimeout(50); } throw new Error('timed out'); };
  await p.goto(base + '/', { waitUntil: 'commit' });
  const t1 = await until(() => got.find((m) => m.rid[0] === 't' && m.head.title === 'KT site'));
  assert.ok(/Chrome|Mozilla/.test(t1.head.ua), 'the title carries the user agent');
  assert.equal(await p.evaluate(() => !!document.getElementById('kt-browser-bar') && getComputedStyle(document.getElementById('kt-browser-bar')).right === '12px'), true, 'the bar, on the right for a right-to-left page');
  assert.equal(await p.evaluate(() => document.getElementById('kt-browser-bar').shadowRoot), null, 'closed shadow root');
  await p.keyboard.press('Control+g');
  const c = await until(() => got.find((m) => m.rid[0] === 'c'));
  assert.deepEqual(c.head, { act: 'grab', k: CMD });
  await p.keyboard.press('Control+l');
  await until(() => got.find((m) => m.rid[0] === 'c' && m.head.act === 'copy'));
  // (A site's own script can find the channel, but not the bar's token.)
  await p.evaluate((k) => { for (const n of Object.getOwnPropertyNames(window)) if (n.startsWith('__kt') && window[n] && window[n].send) window[n].send('cforged', { act: 'external', k: 'guess' }, null, 'c'); }, K);
  const forged = await until(() => got.find((m) => m.rid === 'cforged'));
  assert.notEqual(forged.head.k, CMD, 'a forged command does not carry the bar\'s token');
  // (The grab, as browser.rs's command() asks it: in several pieces, whole, main.cjs's shape.)
  pending.add('g1'); await p.evaluate(grabCall('g1'));
  const g = await until(() => got.find((m) => m.rid === 'g1'), 15000);
  const page = JSON.parse(g.body.toString('utf8'));
  assert.ok(g.n > 3, 'the grab came in pieces: ' + g.n);
  assert.equal(page.url, base + '/'); assert.equal(page.title, 'KT site'); assert.ok(/Chrome|Mozilla/.test(page.ua));
  assert.ok(page.links.some((l) => l.href === base + '/v/movie.mp4' && l.kind === 'video'), 'the video');
  assert.ok(page.links.some((l) => l.href === base + '/files/f119.mkv' && l.kind === 'video'), 'the last link');
  // (An answer not asked for is not taken.)
  const before = got.length; await p.evaluate(grabCall('g9')); await p.waitForTimeout(1500); assert.equal(got.length, before, 'an unasked grab taken');
  // (New windows kept in this one.)
  await p.click('#pop'); await p.waitForURL(base + '/popup', { waitUntil: 'commit' }); assert.equal(ctx.pages().length, 1, 'target=_blank opened a window');
  await p.evaluate(() => window.open('/opened', '_blank')); await p.waitForURL(base + '/opened', { waitUntil: 'commit' }); assert.equal(ctx.pages().length, 1, 'window.open opened a window');
  await until(() => got.find((m) => m.rid[0] === 't' && m.head.title === 'KT opened'));
  assert.equal(await p.evaluate(() => document.readyState), 'complete', 'the site\'s own load finished');
  assert.deepEqual(errors, []);
  console.log(`tauribrowsertools: ok — title + user agent, the bar (closed, right-to-left), Ctrl+G / Ctrl+L, a forged command told apart, the grab in ${g.n} pieces (${page.links.length} links), an unasked answer refused, new windows kept`);
  await br.close(); site.close();
});
