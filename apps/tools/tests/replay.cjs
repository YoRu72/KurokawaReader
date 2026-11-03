// The way to a download recorded and replayed — the app browser's own scripts (taken from KtBrowserActivity.java),
// run here on a made-up site like itch.io's: a game page whose «Download» opens a dialog on the same page, its «No
// thanks, just take me to the downloads», then a downloads page whose button starts a signed link that changes
// every time. The steps recorded as they are tapped; replayed on a fresh visit — the same buttons found by their
// words, links and places, the dialog's step taken on the same page —, ending at a new signed link.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const java = fs.readFileSync(path.join(__dirname, '..', 'native', 'android', 'KtBrowserActivity.java'), 'utf8');
const unq = (lit) => JSON.parse(lit);   // (Java string literals here use only JSON's escapes)
const TRAIL_JS = unq(/static final String TRAIL_JS = ("(?:[^"\\]|\\.)*");/.exec(java)[1]);
const body = /static String replayJs\(JSONArray steps, int after\) \{([\s\S]*?)\n    \}/.exec(java)[1];
const parts = [...body.matchAll(/"(?:[^"\\]|\\.)*"/g)].map((m) => unq(m[0]));
// (The pieces: …"(" + steps + "," + after + ")": the last three literals are around steps and after.)
const head = parts.slice(0, -2).join(''); const replayJs = (steps, after) => head + JSON.stringify(steps) + ',' + after + ')';
let sig = 0;
const page = (title, inner) => `<!doctype html><html><head><title>${title}</title></head><body>${inner}</body></html>`;
const site = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/game') { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Game', `<h1>Game</h1><a href="/other">Other game</a> <button class="buy" onclick="document.getElementById('m').hidden=false">Download Now</button><div id="m" hidden><p>Support the maker?</p><a class="skip" href="/game/purchase?skip=${Date.now()}">No thanks, just take me to the downloads</a></div>`)); return; }
  if (u === '/game/purchase') { res.writeHead(302, { location: `/game/download/K${Math.random().toString(36).slice(2, 8)}` }); res.end(); return; }
  if (u.startsWith('/game/download/')) { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page('Downloads', `<div class="file"><span>Game-0.bin</span><a class="dl" href="javascript:void 0" onclick="location.href='/file/Game-0.bin?sig='+(${++sig})">Download</a></div><div class="file"><span>Game-mac.zip</span><a class="dl" href="javascript:void 0" onclick="location.href='/file/mac.zip?sig=x'">Download</a></div>`)); return; }
  if (u.startsWith('/file/')) { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('the file'); return; }
  res.writeHead(404); res.end();
}).listen(0);
(async () => {
  const base = `http://127.0.0.1:${site.address().port}`; const errors = [];
  const check = (what, ok) => { console.log(ok ? 'ok  ' : 'FAIL', what); if (!ok) errors.push(what); };
  const br = await chromium.launch();
  // 1. The way recorded while tapping by hand.
  const p = await br.newPage(); const trail = [{ url: `${base}/game`, start: true }]; let fileAt = null;
  await p.exposeFunction('__step', (j) => trail.push(JSON.parse(j)));
  await p.addInitScript(() => { window.KtTrail = { step: (j) => window.__step(j) }; });
  p.on('framenavigated', (f) => { if (f === p.mainFrame() && /\/file\//.test(f.url())) fileAt = f.url(); });
  p.on('load', () => p.evaluate(TRAIL_JS).catch(() => undefined));
  await p.goto(`${base}/game`); await p.evaluate(TRAIL_JS);
  await p.click('button.buy'); await p.click('a.skip'); await p.waitForURL(/download\/K/); await p.evaluate(TRAIL_JS);
  await p.locator('.file', { hasText: 'Game-0.bin' }).locator('a.dl').click(); await p.waitForURL(/\/file\//);
  console.log('recorded:', trail.map((s) => s.start ? 'start' : `${s.tag}:"${s.text}"#${s.n}`).join(' → '));
  check('the way recorded: the button, the dialog\'s link, the file\'s button', trail.length === 4 && trail[1].text === 'Download Now' && /No thanks/.test(trail[2].text) && trail[3].text === 'Download' && trail[3].n === 0);
  const first = fileAt; await p.close();
  // 2. Replayed on a fresh visit (the browser's loop: the script on each page, and again after each step).
  const q = await br.newPage(); let replayAt = 0; let got = null; const seen = [];
  await q.exposeFunction('__replayed', async (i) => { replayAt = Math.max(replayAt, i); seen.push(i); setTimeout(() => q.evaluate(replayJs(trail, replayAt)).catch(() => undefined), 1600); });
  await q.exposeFunction('__missing', (i) => seen.push('missing ' + i));
  await q.addInitScript(() => { window.KtTrail = { step() {}, replayed: (i) => window.__replayed(i), missing: (i) => window.__missing(i) }; });
  q.on('framenavigated', (f) => { if (f === q.mainFrame() && /\/file\//.test(f.url())) got = f.url(); });
  q.on('load', () => { if (!got) q.evaluate(replayJs(trail, replayAt)).catch(() => undefined); });
  await q.goto(trail[0].url);
  for (let k = 0; k < 40 && !got; k++) await q.waitForTimeout(250);
  console.log('replayed steps:', seen.join(','), '→', got, '(first:', first, ')');
  check('replayed to the file: every step, in order', !!got && seen.slice(0, 3).join() === '1,2,3');
  check('a new signed link (not the first one)', !!got && got !== first && /Game-0\.bin\?sig=\d+/.test(got));
  check('the right file among others (by its place)', !!got && !/mac\.zip/.test(got));
  await br.close(); site.close();
  if (errors.length) { console.log('errors', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
