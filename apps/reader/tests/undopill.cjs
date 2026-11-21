// node tests/undopill.cjs [outdir]: the floating Undo behaves as Tools' pill (src/ui/pill.ts, src/ui/dom.ts toast):
//  - a close button (48 px on a phone) ends it at once and what it held is done (onEnd(false));
//  - a swipe aside ends it the same way; a short drag does not;
//  - its time stands still while a finger is on it, and while a sheet lies over it (hidden then, back after);
//  - one at a time: a new one ends the one before (committed); Undo (acted) is told true;
//  - it rides above the reading bars (never over the PDF bar / a selection bar), and is gone after its time.
// Pictures (phone 412x915, dark; English and Arabic) go to the outdir.
const { chromium } = require('playwright'); const esbuild = require('esbuild'); const http = require('http'); const fs = require('fs'); const path = require('path'); const os = require('os');
const DIST = process.env.KR_DIST ? path.resolve(process.env.KR_DIST) : path.resolve(__dirname, '../dist');
const OUT = path.resolve(process.argv[2] || os.tmpdir()); fs.mkdirSync(OUT, { recursive: true });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 500))); if (!c) fails++; };
const server = http.createServer((req, res) => { const u = req.url.split('?')[0];
  if (u === '/blank') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/assets/app.css"></head><body><div class="pdf-bar" style="display:none;left:50%;width:300px;height:48px;bottom:18px"></div></body></html>'); return; }
  const f = path.join(DIST, decodeURIComponent(u)); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; res.end(); return; }
  res.setHeader('Content-Type', u.endsWith('.css') ? 'text/css' : 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
const wait = async (p, fn, arg, ms = 12000) => p.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);
(async () => {
  await new Promise((r) => server.listen(0, r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const code = esbuild.buildSync({ stdin: { contents: `export { toast, openSheet } from './src/ui/dom'; export { setLang, t } from './src/i18n';`, resolveDir: path.resolve(__dirname, '..'), loader: 'ts' }, bundle: true, format: 'iife', globalName: 'K', write: false, platform: 'browser', logLevel: 'error' }).outputFiles[0].text;
  const br = await chromium.launch(); const errors = [];
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2, colorScheme: 'dark', serviceWorkers: 'block' });
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(base + 'blank'); await p.evaluate((l) => { localStorage.setItem('kr.lang', l); document.documentElement.dataset.theme = 'dark'; document.documentElement.classList.add('dark'); }, lang);
    await p.addScriptTag({ content: code }); await p.evaluate((l) => { K.setLang(l); window.__ends = []; window.__ran = 0; }, lang);
    const offer = (name, ms) => p.evaluate(([name, ms]) => K.toast(name, 'info', { ms, action: { label: K.t('undo'), run: () => { window.__ran++; } }, onEnd: (a) => window.__ends.push(name + ':' + a) }), [name, ms]);
    const ends = () => p.evaluate(() => window.__ends.slice());
    const tag = `[${lang}] `;
    // 1. close button: ends, committed, 48 px
    await offer('one', 20000); await p.waitForSelector('.toast .toast-x');
    const bx = await p.$eval('.toast .toast-x', (b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
    ok(tag + 'a close button, a 48 px target', bx[0] >= 48 && bx[1] >= 48, bx);
    await p.screenshot({ path: path.join(OUT, `R1-undo-pill-${lang}.png`) });
    await p.tap('.toast .toast-x'); ok(tag + '× ends it at once and what it held is done', !(await p.$('.toast')) && (await ends()).join() === 'one:false', await ends());
    // 2. one at a time: a new one ends the one before
    await offer('two', 20000); await offer('three', 20000);
    ok(tag + 'one at a time: the new pill ends the old (committed)', (await p.$$('.toast')).length === 1 && (await ends()).join() === 'one:false,two:false', await ends());
    // 3. a short drag does not close; a swipe aside does
    const box = await (await p.$('.toast')).boundingBox(); const cy = box.y + box.height / 2;
    // (Pointer events of a finger, made here: the browser's own touch handling is not what is tested.)
    const drag = (dx) => p.evaluate(async (dx) => { const el = document.querySelector('.toast'); const r = el.getBoundingClientRect(); const x0 = r.left + r.width / 2, y = r.top + r.height / 2;
      const ev = (type, x) => el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
      ev('pointerdown', x0); for (let i = 1; i <= 10; i++) { ev('pointermove', x0 + (dx * i) / 10); await new Promise((r) => setTimeout(r, 16)); } ev('pointerup', x0 + dx); }, dx);
    await drag(30); await p.waitForTimeout(300);
    ok(tag + 'a short drag leaves it', !!(await p.$('.toast')) && (await ends()).length === 2);
    await drag(-box.width); const gone = await wait(p, () => !document.querySelector('.toast'), null, 4000);
    ok(tag + 'a swipe aside ends it, committed', gone && (await ends()).join() === 'one:false,two:false,three:false', await ends());
    // 4. its time stands still while a finger is on it
    await offer('four', 1500); const b4 = await (await p.$('.toast')).boundingBox();
    const cdp = await ctx.newCDPSession(p); await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: b4.x + 20, y: b4.y + b4.height / 2 }] });
    await p.waitForTimeout(2600); const still = !!(await p.$('.toast'));
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); await cdp.detach();
    const after = await wait(p, () => !document.querySelector('.toast'), null, 5000);
    ok(tag + 'its time stands still while touched, then runs out', still && after && (await ends()).pop() === 'four:false');
    // 5. a sheet over it: hidden, time still; closed: back
    await offer('five', 1500); await p.evaluate(() => { window.__sh = K.openSheet('Sheet', 'Close'); });
    await wait(p, () => document.querySelector('.toast')?.classList.contains('behind-sheet'), null, 3000);
    const hid = await p.$eval('.toast', (x) => getComputedStyle(x).visibility); await p.waitForTimeout(2200); const kept = !!(await p.$('.toast'));
    ok(tag + 'hidden while a sheet is open, its time standing still', hid === 'hidden' && kept);
    await p.evaluate(() => window.__sh.close()); await wait(p, () => !document.querySelector('.toast.behind-sheet'), null, 3000);
    const vis = await p.$eval('.toast', (x) => getComputedStyle(x).visibility).catch(() => 'gone');
    ok(tag + 'back when the sheet closes, then ends by its time', vis === 'visible' && (await wait(p, () => !document.querySelector('.toast'), null, 8000)));
    // 6. above a bar along the bottom
    await p.evaluate(() => { document.querySelector('.pdf-bar').style.cssText = 'display:flex;position:fixed;left:50%;transform:translateX(-50%);width:300px;height:48px;bottom:18px;z-index:31'; });
    await offer('six', 20000); await p.waitForTimeout(400);
    const geo = await p.evaluate(() => { const a = document.querySelector('.toast').getBoundingClientRect(), b = document.querySelector('.pdf-bar').getBoundingClientRect(); return { toastBottom: Math.round(a.bottom), barTop: Math.round(b.top) }; });
    ok(tag + 'rides above the bar, never over it', geo.toastBottom <= geo.barTop, geo);
    // 7. Undo (acted) tells true, runs the action
    await p.tap('.toast .toast-action'); ok(tag + 'Undo: acted, its action run', (await ends()).pop() === 'six:true' && (await p.evaluate(() => window.__ran)) === 1);
    await ctx.close();
  }
  ok('no page errors', errors.length === 0, errors);
  await br.close(); server.close(); console.log(fails ? `FAILED: ${fails}` : 'ALL OK'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
