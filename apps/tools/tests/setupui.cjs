// Kurokawa Tools Setup's page (Tools' stage P9: the Reader's tests/setupui.cjs over Tools' copy of the setup program) (desktop-tauri/setup/ui — the designed Windows setup program), in Chromium against the
// FAKE implementation of its page ⇄ Rust contract (the top of setup/ui/setup.js), at the program's window size,
// 720 × 480:
//  - every state — welcome (options closed and open), installing, done, failure, an earlier copy found — in English and
//    Arabic, light and dark: the right words, right to left for Arabic (the hero at the right, the window's buttons at
//    the left, the switches' handles moving the other way), no text running out of its box, nothing outside the window
//    and no scrolling, at 100 % and 125 % display scale;
//  - the options change what install() receives (folder through the folder dialog, desktop shortcut, opening books,
//    opening when done); an update of this build keeps its folder; the Electron build is replaced (a new folder);
//  - update wording when an earlier copy is found («Update», «Your library is kept»);
//  - a failure says what failed, «Try again» installs again, «Use the classic installer» asks for it;
//  - the keyboard: Enter installs, Esc closes (asks while installing; Esc again keeps it), the language menu with the
//    arrows, a full tab order, every control named for a screen reader;
//  - the progress only goes forward, through the four steps, and is told to a screen reader.
// With --shots <dir>: REAL renders of the page at 2× (welcome, welcome-options, installing, done, update-found,
// failure — each in ar-dark, ar-light, en-dark, en-light); with --only-welcome, only the four welcome pictures.
//   node tests/setupui.cjs [--shots <dir>] [--only-welcome]
'use strict';
const { chromium } = require('playwright');
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const assert = require('node:assert/strict');

const UI = path.join(__dirname, '..', 'desktop-tauri', 'setup', 'ui');
const SHOTS = (() => { const i = process.argv.indexOf('--shots'); return i > 0 ? path.resolve(process.argv[i + 1]) : null; })();
const ONLY_WELCOME = process.argv.includes('--only-welcome');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html';
  const f = path.join(UI, p);
  if (!f.startsWith(UI) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
});
const WORDS = (() => { const window = {}; eval(fs.readFileSync(path.join(UI, 'words.js'), 'utf8')); return window.SETUP_WORDS; })();

let browser, base;
let checks = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); checks++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); checks++; };

async function open(fake, o = {}) {
  const ctx = await browser.newContext({ viewport: { width: 720, height: 480 }, deviceScaleFactor: o.scale || 1, colorScheme: fake.dark === '1' ? 'dark' : 'light', reducedMotion: o.motion ? 'no-preference' : 'reduce' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.addInitScript((c) => { window.__SETUP_FAKE__ = c; try { localStorage.clear(); } catch { /* none */ } }, fake);
  await page.goto(base);
  await page.waitForFunction(() => !!document.querySelector('[data-view]') && document.getElementById('path').textContent.length > 0);
  await page.evaluate(() => document.fonts.ready);
  await page.mouse.move(400, 470);
  page.errors = errors;
  return { page, ctx };
}
const view = (page) => page.evaluate(() => document.getElementById('app').getAttribute('data-view'));
const log = (page) => page.evaluate(() => window.__setupLog);
const text = (page, sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? e.textContent : null; }, sel);
const settle = (page, ms = 120) => page.waitForTimeout(ms);

/** Nothing outside the window, no scrolling, no text cut off (except where an ellipsis is meant: paths). */
async function layoutOk(page, label) {
  const r = await page.evaluate(() => {
    const out = [];
    const se = document.scrollingElement;
    if (se.scrollWidth > se.clientWidth || se.scrollHeight > se.clientHeight) out.push(`page scrolls ${se.scrollWidth}×${se.scrollHeight}`);
    const W = innerWidth, H = innerHeight;
    const visible = (e) => { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0 && !e.closest('[hidden]'); };
    for (const e of document.querySelectorAll('.win *')) {
      if (!visible(e)) continue;
      // (Within a collapsing block that is shut: not shown.)
      if (e.closest('.opts:not(.shown)') || (e.closest('.collapse') && document.getElementById('app').classList.contains('opts-open'))) continue;
      const b = e.getBoundingClientRect();
      if (b.left < -0.5 || b.top < -0.5 || b.right > W + 0.5 || b.bottom > H + 0.5) {
        if (!e.closest('.hero') || e.matches('.name, .tag, .chip, .badge')) out.push(`${e.tagName.toLowerCase()}.${e.className} outside the window (${Math.round(b.left)},${Math.round(b.top)},${Math.round(b.right)},${Math.round(b.bottom)})`);
      }
      const own = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      if (!own) continue;
      if (e.matches('.path, .sum-path')) continue;
      if (e.scrollWidth > e.clientWidth + 1 && getComputedStyle(e).display !== 'inline') out.push(`text cut: «${e.textContent.trim().slice(0, 40)}» ${e.scrollWidth} > ${e.clientWidth}`);
      if (e.scrollHeight > e.clientHeight + 2 && getComputedStyle(e).overflow !== 'visible' && getComputedStyle(e).display !== 'inline') out.push(`text cut (height): «${e.textContent.trim().slice(0, 40)}»`);
      // (Inside its panel or the hero.)
      const box = e.closest('.panel, .hero, .bar, .confirm');
      if (box) { const p = box.getBoundingClientRect(); if (b.right > p.right + 1 || b.left < p.left - 1) out.push(`«${e.textContent.trim().slice(0, 30)}» runs out of ${box.className}`); }
    }
    return out;
  });
  eq(r, [], `${label}: layout`);
}

/** Right to left mirrored: the hero at the right, the window's buttons at the left, the switch's handle moves left. */
async function mirrorOk(page, lang, label) {
  const r = await page.evaluate(() => {
    const b = (s) => document.querySelector(s).getBoundingClientRect();
    return { dir: document.documentElement.dir, lang: document.documentElement.lang, hero: b('.hero').left, panel: b('.panel').left, close: b('.wb-close').left, langBtn: b('.lang-btn').left, title: b('.bar-title').left, go: b('#go').left, opt: b('#opt-btn').left };
  });
  if (lang === 'ar') {
    eq([r.dir, r.lang], ['rtl', 'ar'], `${label}: right to left`);
    ok(r.hero > r.panel, `${label}: hero at the right`);
    ok(r.close < r.langBtn && r.langBtn < r.title, `${label}: close at the far left, the title at the right`);
    ok(r.go < r.opt, `${label}: the big button at the left end, Options at the right`);
  } else {
    eq([r.dir, r.lang], ['ltr', lang], `${label}: left to right`);
    ok(r.hero < r.panel && r.close > r.langBtn && r.langBtn > r.title && r.go > r.opt, `${label}: laid out left to right`);
  }
}

async function shot(page, name) {
  if (!SHOTS) return;
  await page.mouse.move(400, 470);
  await settle(page, 60);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

const COMBOS = [['ar', 'dark'], ['ar', 'light'], ['en', 'dark'], ['en', 'light']];

async function everyState(lang, theme, scale) {
  const L = WORDS[lang];
  const tag = `${lang}-${theme}${scale > 1 ? `@${scale}` : ''}`;
  const dark = theme === 'dark' ? '1' : '0';
  // Welcome, options closed.
  let { page, ctx } = await open({ lang, dark }, { scale });
  eq(await view(page), 'welcome', `${tag}: starts at welcome`);
  eq(await page.evaluate(() => document.documentElement.getAttribute('data-theme')), theme, `${tag}: theme`);
  eq((await text(page, '#title-welcome')).trim(), L.readyInstall, `${tag}: title`);
  eq((await text(page, '#go')).trim(), L.install, `${tag}: Install`);
  eq(await page.evaluate(() => document.querySelector('.tile').hidden), true, `${tag}: no earlier copy, no update tile`);
  await layoutOk(page, `${tag} welcome`);
  await mirrorOk(page, lang, `${tag} welcome`);
  if (scale === 2) await shot(page, `welcome-${lang}-${theme}`);
  if (ONLY_WELCOME) { await ctx.close(); return; }
  // Options open.
  await page.click('#opt-btn'); await settle(page, 80);
  eq(await page.getAttribute('#opt-btn', 'aria-expanded'), 'true', `${tag}: options expanded`);
  // (The options open with a short motion; on a slow machine 80 ms is not always enough.)
  await page.waitForSelector('#opt-desktop', { state: 'visible', timeout: 5000 }).catch(() => {});
  ok(await page.isVisible('#opt-desktop'), `${tag}: options shown`);
  await layoutOk(page, `${tag} options`);
  if (lang === 'ar') {
    // (The switch's handle sits at the right when off and moves left when on.)
    const x = await page.evaluate(() => { const i = document.querySelector('#opt-desktop + i'); const tr = getComputedStyle(i, '::after').transform; return tr; });
    ok(/matrix\(1, 0, 0, 1, -20, 0\)/.test(x), `${tag}: an on switch's handle moves left (${x})`);
  }
  if (scale === 2) await shot(page, `welcome-options-${lang}-${theme}`);
  await ctx.close();

  // Installing (held at 46 %), then done.
  ({ page, ctx } = await open({ lang, dark, hold: 'install:46' }, { scale }));
  await page.click('#go');
  await page.waitForFunction(() => document.querySelector('.wave').getAttribute('aria-valuenow') === '46');
  eq(await view(page), 'installing', `${tag}: installing`);
  eq((await text(page, '#title-installing')).trim(), L.installing, `${tag}: installing title`);
  eq((await text(page, '.now')).trim(), L.nowInstall, `${tag}: the step in words`);
  eq(await page.evaluate(() => [...document.querySelectorAll('.steps li')].map((li) => li.className)), ['past', 'now-step', '', ''], `${tag}: step 2 of 4`);
  ok(/46/.test(await page.getAttribute('.wave', 'aria-valuetext')) || /٤٦/.test(await page.getAttribute('.wave', 'aria-valuetext')), `${tag}: progress told`);
  await layoutOk(page, `${tag} installing`);
  if (scale === 2) await shot(page, `installing-${lang}-${theme}`);
  await ctx.close();

  ({ page, ctx } = await open({ lang, dark, speed: 8 }, { scale }));
  await page.click('#opt-btn'); await page.click('label[for="opt-run"]'); // (not opened when done: the done state stays)
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'done', null, { timeout: 8000 });
  eq((await text(page, '#title-done')).trim(), L.doneTitle, `${tag}: done title`);
  eq((await text(page, '#open')).trim(), L.open, `${tag}: Open button`);
  await layoutOk(page, `${tag} done`);
  if (scale === 2) await shot(page, `done-${lang}-${theme}`);
  await ctx.close();

  // An earlier copy of this build found: update.
  ({ page, ctx } = await open({ lang, dark, existing: 'rust' }, { scale }));
  eq((await text(page, '#title-welcome')).trim(), L.readyUpdate, `${tag}: update title`);
  eq((await text(page, '#go')).trim(), L.update, `${tag}: Update`);
  eq((await text(page, '.tile b')).trim(), L.kept, `${tag}: library kept`);
  ok((await text(page, '.tile-line')).includes('0.71.0') && (await text(page, '.tile-line')).includes('0.72.0'), `${tag}: from → to`);
  await layoutOk(page, `${tag} update-found`);
  await mirrorOk(page, lang, `${tag} update-found`);
  if (scale === 2) await shot(page, `update-found-${lang}-${theme}`);
  await ctx.close();

  // Failure.
  ({ page, ctx } = await open({ lang, dark, fail: 'aborted', speed: 8 }, { scale }));
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'failed', null, { timeout: 8000 });
  eq((await text(page, '#title-failed')).trim(), L.failTitle, `${tag}: failure title`);
  eq((await text(page, '.reason')).trim(), L.whyAborted, `${tag}: what failed, plainly`);
  eq((await text(page, '#retry')).trim(), L.retry, `${tag}: Try again`);
  eq((await text(page, '#classic')).trim(), L.classic, `${tag}: classic installer`);
  await layoutOk(page, `${tag} failure`);
  if (scale === 2) await shot(page, `failure-${lang}-${theme}`);
  ok(page.errors.length === 0, `${tag}: no page errors (${page.errors.join(' / ')})`);
  await ctx.close();
}

async function behaviour() {
  // Options change what install() receives.
  let { page, ctx } = await open({ lang: 'en', dark: '1', speed: 8 });
  await page.click('#summary'); await settle(page);
  eq(await page.getAttribute('#opt-btn', 'aria-expanded'), 'true', 'the summary opens the options');
  await page.click('.browse'); await settle(page);
  eq((await text(page, '#path')).replace(/\u200b/g, ''), 'D:\\Apps\\Kurokawa Tools', 'the folder chosen in the dialog is shown');
  await page.click('label[for="opt-desktop"]'); await page.click('label[for="opt-assoc"]'); await page.click('label[for="opt-run"]');
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'done', null, { timeout: 8000 });
  let l = await log(page);
  eq(l.find((c) => c[0] === 'browseFolder'), ['browseFolder', 'C:\\Users\\Hana\\AppData\\Local\\Kurokawa Tools'], 'the folder dialog starts at the folder shown');
  eq(l.find((c) => c[0] === 'install')[1], { dir: 'D:\\Apps\\Kurokawa Tools', desktop: false, assoc: false, runAfter: false, update: false }, 'install() receives the options as chosen');
  ok(!l.some((c) => c[0] === 'openApp'), 'not opened when «Open when done» is off');
  await page.click('#open'); await settle(page);
  l = await log(page);
  ok(l.some((c) => c[0] === 'openApp') && l.some((c) => c[0] === 'close'), '«Open Kurokawa Tools» opens it and closes the setup');
  await ctx.close();

  // Defaults; open when done: opened by itself, then the setup closes.
  ({ page, ctx } = await open({ lang: 'en', dark: '0', speed: 8 }));
  await page.click('#go');
  await page.waitForFunction(() => (window.__setupLog || []).some((c) => c[0] === 'close'), null, { timeout: 8000 });
  l = await log(page);
  eq(l.find((c) => c[0] === 'install')[1], { dir: 'C:\\Users\\Hana\\AppData\\Local\\Kurokawa Tools', desktop: true, assoc: true, runAfter: true, update: false }, 'the defaults of a first install');
  ok(l.findIndex((c) => c[0] === 'openApp') < l.findIndex((c) => c[0] === 'close'), 'opened when done, then closed');
  // (The progress only went forward through the four steps.)
  await ctx.close();

  // This build found: updated in its folder (no folder dialog), shortcut as it is; the Electron build: replaced.
  ({ page, ctx } = await open({ lang: 'ar', dark: '1', existing: 'rust', desktop: '0', speed: 8 }));
  await page.click('#opt-btn'); await settle(page);
  eq(await page.isVisible('.browse'), false, 'an update of this build keeps its folder: no Browse');
  ok(await page.isVisible('.inplace'), '… and says so');
  eq(await page.isChecked('#opt-desktop'), false, 'no desktop shortcut now: none chosen');
  await page.keyboard.press('Enter'); // (focus on the Options button: Enter is its own, not Install)
  await settle(page);
  eq(await view(page), 'welcome', 'Enter on Options toggles them, it does not install');
  await page.click('#go');
  await page.waitForFunction(() => (window.__setupLog || []).some((c) => c[0] === 'install'));
  l = await log(page);
  eq(l.find((c) => c[0] === 'install')[1], { dir: 'C:\\Users\\Hana\\AppData\\Local\\Kurokawa Tools', desktop: false, assoc: true, runAfter: true, update: true }, 'an update: its folder, update: true');
  eq((await text(page, '#title-installing')).trim(), WORDS.ar.updating, 'updating, in words');
  await ctx.close();

  ({ page, ctx } = await open({ lang: 'en', dark: '1', existing: 'electron' }));
  eq((await text(page, '#go')).trim(), 'Update', 'the Electron build found: Update');
  ok((await text(page, '.tile-line')).startsWith(WORDS.en.electronLine), 'replaces the earlier Kurokawa Tools');
  eq((await text(page, '.tile b')).trim(), WORDS.en.kept, 'data kept');
  ok(await page.isEnabled('.browse'), 'a new folder can be chosen (the Electron folder is removed)');
  await ctx.close();

  // The Electron build found, its library NOT handed over (no hand-over on the disk): it is kept beside the new one, the
  // page says so, and the done screen says what to do with a button that opens it.
  ({ page, ctx } = await open({ lang: 'en', dark: '0', existing: 'electron', old: 'keep', speed: 8, runAfter: false }));
  eq((await text(page, '#go')).trim(), 'Install', 'kept beside it: a new install, not an update');
  ok((await text(page, '.tile-line')).startsWith(WORDS.en.electronKeepLine), 'says the earlier one stays until it carried the library over');
  await page.evaluate(() => { const r = document.getElementById('opt-run'); if (r && r.checked) r.click(); });
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'done', null, { timeout: 8000 });
  eq((await text(page, '#old-note')).trim(), WORDS.en.oldKeepDone, 'the done screen: open the previous Kurokawa Tools once');
  ok(await page.isVisible('#open-old'), '… with its button');
  await page.click('#open-old');
  await page.waitForFunction(() => (window.__setupLog || []).some((c) => c[0] === 'openOld'));
  ok(true, 'the button opens the previous Kurokawa Tools');
  await ctx.close();
  // (With «Open Kurokawa Tools when done»: the new app opened, and the window stays for the note.)
  ({ page, ctx } = await open({ lang: 'en', dark: '0', existing: 'electron', old: 'keep', speed: 8 }));
  await page.click('#go');
  await page.waitForFunction(() => (window.__setupLog || []).some((c) => c[0] === 'openApp'), null, { timeout: 8000 });
  await page.waitForTimeout(2200);
  ok(!(await log(page)).some((c) => c[0] === 'close') && await page.isVisible('#open-old'), 'opened when done, the window kept with the note');
  await ctx.close();
  ({ page, ctx } = await open({ lang: 'ar', dark: '1', existing: 'electron', old: 'keep' }));
  ok((await text(page, '.tile-line')).startsWith(WORDS.ar.electronKeepLine), 'the same in Arabic');
  await ctx.close();

  // Same version: reinstall; fake detect with no language → the browser's.
  ({ page, ctx } = await open({ dark: '1', existing: 'rust', from: '0.72.0' }));
  eq((await text(page, '#go')).trim(), 'Reinstall', 'the same version: Reinstall');
  await ctx.close();

  // Failure, then Try again; the classic installer.
  ({ page, ctx } = await open({ lang: 'en', dark: '0', fail: 'code', speed: 8 }));
  await page.click('#go');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'failed', null, { timeout: 8000 });
  eq((await text(page, '.reason')).trim(), 'The installer stopped with code 5.', 'the exit code in words');
  await page.click('#classic');
  l = await log(page); ok(l.some((c) => c[0] === 'classic'), '«Use the classic installer» asks for it');
  await page.click('#retry');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') !== 'failed');
  await page.waitForFunction(() => (window.__setupLog || []).filter((c) => c[0] === 'install').length === 2, null, { timeout: 8000 });
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'done' || (window.__setupLog || []).some((c) => c[0] === 'close'), null, { timeout: 8000 });
  ok(true, 'Try again installs again, and this time it finishes');
  await ctx.close();

  // Each failure reason in words.
  for (const [fail, key] of [['cancelled', 'whyCancelled'], ['extract', 'whyExtract'], ['missing', 'whyMissing'], ['folder', 'whyFolder']]) {
    ({ page, ctx } = await open({ lang: 'ar', dark: '1', fail, speed: 8 }));
    await page.click('#go');
    await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'failed', null, { timeout: 8000 });
    eq((await text(page, '.reason')).trim(), WORDS.ar[key].replace('{why}', 'disk full'), `failure «${fail}» in Arabic`);
    await ctx.close();
  }

  // Keyboard: Enter installs; Esc while installing asks; Esc again keeps it; the question's buttons; Esc closes.
  ({ page, ctx } = await open({ lang: 'en', dark: '1', hold: 'install:34' }));
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('app').getAttribute('data-view') === 'installing');
  ok(true, 'Enter installs');
  await page.keyboard.press('Escape'); await settle(page);
  ok(await page.isVisible('.confirm'), 'Esc while installing asks');
  eq(await page.evaluate(() => document.activeElement.id), 'stay', '… with «Keep watching» focused');
  await page.keyboard.press('Tab'); eq(await page.evaluate(() => document.activeElement.id), 'leave', 'Tab stays inside the question');
  await page.keyboard.press('Tab'); eq(await page.evaluate(() => document.activeElement.id), 'stay', '… and wraps');
  await page.keyboard.press('Escape'); await settle(page);
  ok(!(await page.isVisible('.confirm')), 'Esc again: keeps installing');
  l = await log(page); ok(!l.some((c) => c[0] === 'close'), '… nothing closed');
  await page.click('.wb-close'); await settle(page);
  ok(await page.isVisible('.confirm'), 'the close button asks too');
  if (SHOTS && !ONLY_WELCOME) { /* (the question: not one of the asked pictures) */ }
  await page.click('#leave'); await settle(page);
  l = await log(page); ok(l.some((c) => c[0] === 'close'), '«Close window» closes (the install finishes in the background)');
  await ctx.close();

  ({ page, ctx } = await open({ lang: 'en', dark: '1' }));
  await page.keyboard.press('Escape'); await settle(page);
  l = await log(page); ok(l.some((c) => c[0] === 'close'), 'Esc closes at welcome');
  await ctx.close();

  // The full tab order, every control named.
  ({ page, ctx } = await open({ lang: 'en', dark: '1' }));
  const order = [];
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Tab'); order.push(await page.evaluate(() => { const a = document.activeElement; return a.id || a.className; })); }
  eq(order, ['lang-btn', 'wb wb-min', 'wb wb-close', 'summary', 'opt-btn', 'go'], 'tab order, options closed');
  await page.click('#opt-btn'); await settle(page);
  await page.focus('#lang-btn');
  const order2 = ['lang-btn'];
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); order2.push(await page.evaluate(() => { const a = document.activeElement; return a.id || a.className; })); }
  eq(order2, ['lang-btn', 'wb wb-min', 'wb wb-close', 'browse', 'opt-desktop', 'opt-assoc', 'opt-run', 'opt-btn', 'go'], 'tab order, options open');
  // (A switch answers Enter and Space.)
  await page.focus('#opt-assoc'); await page.keyboard.press('Enter'); eq(await page.isChecked('#opt-assoc'), false, 'Enter flips a switch');
  await page.keyboard.press('Space'); eq(await page.isChecked('#opt-assoc'), true, 'Space flips it back');
  const names = await page.evaluate(() => [...document.querySelectorAll('button, input')].filter((e) => e.offsetParent).map((e) => {
    const lab = e.getAttribute('aria-label') || (e.labels && e.labels[0] && e.labels[0].textContent) || e.textContent; return [e.id || e.className, (lab || '').trim()];
  }));
  for (const [id, n] of names) ok(n.length > 0, `${id} has a name for a screen reader`);
  ok((await page.evaluate(() => getComputedStyle(document.querySelector('#go')).outlineStyle)) !== undefined, 'focus ring style present');
  // Focus ring visible by keyboard.
  await page.focus('#go'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
  eq(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid', 'a focus ring on the keyboard\'s focus');
  await ctx.close();

  // The language menu, by keyboard: Arabic chosen → right to left, the words Arabic, kept for next time.
  ({ page, ctx } = await open({ lang: 'en', dark: '0' }));
  await page.focus('#lang-btn'); await page.keyboard.press('Enter'); await settle(page);
  ok(await page.isVisible('#lang-menu'), 'Enter opens the language menu');
  eq(await page.evaluate(() => document.activeElement.id), 'lang-menu', '… focused');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter'); await settle(page);
  eq(await page.evaluate(() => [document.documentElement.lang, document.documentElement.dir]), ['ar', 'rtl'], 'Arabic chosen: right to left');
  eq((await text(page, '#go')).trim(), 'تثبيت', '… «تثبيت»');
  eq(await page.evaluate(() => document.activeElement.id), 'lang-btn', 'focus back on the language button');
  eq(await page.evaluate(() => localStorage.getItem('kr.setup.lang')), 'ar', 'the choice kept');
  for (const l2 of ['ja', 'ko', 'zh']) {
    await page.click('#lang-btn'); await page.click(`#lang-${l2}`); await settle(page);
    eq((await text(page, '#go')).trim(), WORDS[l2].install, `${l2}: the words`);
    await layoutOk(page, `${l2} welcome`);
    await page.click('#opt-btn'); await settle(page); await layoutOk(page, `${l2} options`); await page.click('#opt-btn');
  }
  await page.mouse.move(100, 20); await page.mouse.down(); await page.mouse.up();
  l = await log(page); ok(l.some((c) => c[0] === 'drag'), 'a press on the title bar drags the window');
  await page.click('.wb-min'); l = await log(page); ok(l.some((c) => c[0] === 'minimize'), 'minimise');
  ok(l.some((c) => c[0] === 'ready'), 'the page tells the program it has painted');
  await ctx.close();

  // The language from the system (detect's lang), when nothing was chosen.
  ({ page, ctx } = await open({ lang: 'ar', dark: '1' }));
  eq(await page.evaluate(() => document.documentElement.lang), 'ar', 'the system\'s language by default');
  await ctx.close();

  // Every word in every language (the same keys as English, none empty).
  for (const l2 of Object.keys(WORDS)) {
    eq(Object.keys(WORDS[l2]).sort(), Object.keys(WORDS.en).sort(), `${l2}: the same words as English`);
    for (const [k, v] of Object.entries(WORDS[l2])) ok(typeof v === 'string' && v.trim().length > 0, `${l2}.${k} not empty`);
  }
}

(async () => {
  const srv = serve(); await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/`;
  browser = await chromium.launch();
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  try {
    // (The pictures first, at 2×; then the same at 100 % and 125 %.)
    if (SHOTS) for (const [lang, theme] of COMBOS) await everyState(lang, theme, 2);
    if (!ONLY_WELCOME) {
      for (const [lang, theme] of COMBOS) { await everyState(lang, theme, 1); await everyState(lang, theme, 1.25); }
      await behaviour();
    }
    console.log(`setupui: ${checks} checks passed${SHOTS ? ` — pictures in ${SHOTS}` : ''}`);
  } catch (e) {
    console.error(e); process.exitCode = 1;
  } finally {
    await browser.close(); srv.close();
  }
})();
