// The Files page kept steady on a phone (360×800, touch), in English and Arabic — piece F1 of the owner's report
// («doesn't appear sometimes; the floating undo button does not go and cannot be closed; gestures and buttons»):
//  · the Undo pill: a close button (a 48 px target) on the phone; closing a held action does it exactly once; its time
//    is a deadline on the clock — gone when the page is seen again even if no timer ever ran; swiped aside it goes;
//    another page takes it away (a held action done then, once); it rides above the floating button and the selection
//    bar; the «Unfinished jobs» pill can be closed too (its jobs kept, not offered again in this run);
//  · never a blank page: a listing that does not answer shows «Still reading» with Try again and the storage's top; storages
//    that never answer still let the folder show; odd entries (no name, a broken date, a lone surrogate, a bad size, null)
//    never stop the list; a last folder that is gone opens its storage's top;
//  · gestures, one owner per touch: a swipe along the strip of chips never opens the drawer; a diagonal scroll over a row
//    never asks to delete it; a tap right after a short swipe of a row is not lost; dragging the fast scroller at the top
//    never pulls to refresh; Paste tapped twice in a blink pastes once; the selection bar sits above the bottom bar.
// Shots (F1-*.png) go to the folder given as F1_SHOTS, if any.
// Run: NODE_PATH=$(npm root -g) node tests/filesstable.cjs [en|ar]
const { chromium } = require('playwright'); const path = require('node:path'); const F = require('./filesphone-fixture.cjs'); const { K, P } = F;
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const SHOTS = process.env.F1_SHOTS || '';
// (Leaving Files for another tab keeps its page to come back to: a new page is asked for with a fresh «t» stamp.)
const fresh = (q) => `/files?${q}${q ? '&' : ''}t=${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const S = { en: { discard: 'Discard', root: 'Storage root', still: 'Still reading this folder…' }, ar: { discard: 'تجاهَل', root: 'جذر وحدة التخزين', still: 'ما زلنا نقرأ هذا المجلد…' } };

/** Runs after the pretend phone: a few of its answers steered by the test (shared items, a listing that hangs, odd entries). */
function extra({ P }) {
  const base = window.Capacitor.Plugins.KurokawaTools; const T = 1760000000000;
  window.__shared = []; window.__cleared = 0;
  const over = {
    sharedPending: async () => ({ items: window.__shared.map((x) => ({ ...x })) }),
    sharedClear: async () => { window.__cleared++; window.__shared = []; },
    filesRoots: (o) => (window.__hangRoots ? new Promise(() => undefined) : base.filesRoots(o)),
    filesList: (o) => {
      if (window.__hang && o.path === window.__hang) return new Promise(() => undefined);
      if (o.path === `${P}/Odd`) return Promise.resolve({ exists: true, entries: [{ name: 'ok.txt', path: `${P}/Odd/ok.txt`, dir: false, size: 1, mtime: T, ext: 'txt' }, { path: `${P}/Odd/noname.bin`, dir: false, size: 1, mtime: T }, { name: 'lone\uD800half.txt', path: `${P}/Odd/lone\uD800half.txt`, dir: false, size: 3, mtime: NaN }, { name: 'weird', path: `${P}/Odd/weird`, dir: true, size: 'x', mtime: 'y', count: 'z' }, null, { name: 'no path' }] });
      return base.filesList(o);
    },
  };
  window.Capacitor.Plugins.KurokawaTools = new Proxy(base, { get: (t, k) => (k in over ? over[k] : t[k]) });
}
const rect = (p, sel) => p.$eval(sel, (e) => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; }).catch(() => null);
const overlap = (a, b) => !!a && !!b && a.l < b.r - 0.5 && a.r > b.l + 0.5 && a.t < b.b - 0.5 && a.b > b.t + 0.5;

async function phone(browser, port, z, lang) {
  const L = (s) => `[${lang}-phone 360] ${s}`; const s = S[lang]; const rtl = lang === 'ar';
  const { page: p, errors } = await F.open(browser, { lang, z, many: 150, width: 360, height: 800, dense: true });
  await p.addInitScript(extra, { P }); const cdp = await p.context().newCDPSession(p);
  const touch = async (pts, gap = 0) => { await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: pts[0][0], y: pts[0][1] }] }); for (const [x, y] of pts.slice(1)) { await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] }); if (gap) await new Promise((r) => setTimeout(r, gap)); } await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }); };
  const line = (x0, y0, x1, y1, n = 12) => Array.from({ length: n + 1 }, (_, i) => [x0 + ((x1 - x0) * i) / n, y0 + ((y1 - y0) * i) / n]);
  const tapAt = async (x, y) => touch([[x, y]]);
  const center = async (sel) => { const r = await rect(p, sel); return [r.l + r.w / 2, r.t + r.h / 2]; };
  const go = async (hash) => { await p.evaluate((h) => { location.hash = h; }, hash); };
  const rowSel = (name) => `.files-row:has(.files-name[title="${name}"])`;
  const shot = async (name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `F1-${name}${lang === 'ar' ? '-ar' : ''}.png`) }); };
  await p.goto(`http://localhost:${port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row');

  // ---- the Undo pill
  const offer = async () => {
    await p.evaluate(() => { window.__shared = [{ uri: 'content://x/1', name: 'shared.txt', size: 5, mime: 'text/plain' }]; });
    await go(`/files?save=1&p=${encodeURIComponent(K)}&t=${Date.now()}`);
    await p.waitForSelector(`.sheet .sheet-actions .btn.tonal:has-text("${s.discard}")`); await p.click(`.sheet .sheet-actions .btn.tonal:has-text("${s.discard}")`);
    await p.waitForSelector('.toast.undo-snack:not(.files-unfinished)'); await p.waitForFunction(() => !document.querySelector('.sheet'));
  };
  await offer();
  const x = await rect(p, '.undo-snack .toast-x');
  ok(L('the pill has its close button on the phone, a 48 px target'), !!x && x.w >= 47.5 && x.h >= 47.5, x);
  await p.waitForFunction(() => { const s = document.querySelector('.undo-snack'); return s && !s.getAnimations().some((a) => a.playState === 'running'); });
  const fab = await rect(p, '.files-fab'); const pill = await rect(p, '.undo-snack'); const nav = await rect(p, '.bottom-nav');
  ok(L('the pill covers neither the floating button nor the bottom bar'), !overlap(pill, fab) && !overlap(pill, nav), { pill, fab, nav });
  await p.evaluate(() => { const s = document.querySelector('.undo-snack'); s.style.animation = 'none'; });
  await shot('pill');
  const closeX = async (sel = '.toast.undo-snack:not(.files-unfinished)') => { if (await p.$(`${sel} .toast-x`)) await p.click(`${sel} .toast-x`); await p.waitForFunction((q) => !document.querySelector(q), sel, { timeout: 15000 }); };
  await closeX();
  await p.waitForFunction(() => window.__cleared >= 1); await p.evaluate(() => new Promise((r) => setTimeout(r, 50)));
  ok(L('closed: the held action is done, exactly once'), (await p.evaluate(() => window.__cleared)) === 1);

  // its time on the clock: no timer runs (a background web view), the page seen again → gone, done once
  await offer();
  await p.evaluate(() => { const st = window.setTimeout, si = window.setInterval, now = Date.now; window.__unfreeze = () => { window.setTimeout = st; window.setInterval = si; Date.now = now; }; window.setTimeout = (f, ms, ...a) => (ms > 1000 ? 0 : st(f, ms, ...a)); window.setInterval = () => 0; window.__skew = 0; Date.now = () => now() + window.__skew; });
  await go(`/files?p=${encodeURIComponent(K)}&again=1`).catch(() => undefined);
  await p.evaluate(() => { window.__skew = 0; });
  // (The page moved inside Files — its own place, the same page — so the pill stays; the clock jumps past its time.)
  const stays = !!(await p.$('.toast.undo-snack:not(.files-unfinished)'));
  await p.evaluate(() => { window.__skew = 13000; document.dispatchEvent(new Event('visibilitychange')); });
  await p.waitForFunction(() => !document.querySelector('.toast.undo-snack:not(.files-unfinished)'), null, { timeout: 3000 }).catch(() => undefined);
  const gone = !(await p.$('.toast.undo-snack:not(.files-unfinished)'));
  await p.waitForFunction(() => window.__cleared >= 2, null, { timeout: 3000 }).catch(() => undefined);
  await p.evaluate(() => window.__unfreeze());
  ok(L('a folder changed inside Files: the pill stays'), stays);
  ok(L('no timer ever ran: seen again past its time, the pill is gone and the held action done once'), gone && (await p.evaluate(() => window.__cleared)) === 2, await p.evaluate(() => window.__cleared));

  // swiped aside
  await offer(); { const r = await rect(p, '.undo-snack .grow'); await touch(line(r.l + 20, r.t + r.h / 2, r.l + 240, r.t + r.h / 2, 10), 8); }
  await p.waitForFunction(() => !document.querySelector('.toast.undo-snack:not(.files-unfinished)'), null, { timeout: 3000 }).catch(() => undefined);
  await p.waitForFunction(() => window.__cleared >= 3, null, { timeout: 3000 }).catch(() => undefined);
  ok(L('swiped aside: the pill goes, the held action done once'), !(await p.$('.toast.undo-snack:not(.files-unfinished)')) && (await p.evaluate(() => window.__cleared)) === 3);

  // another page
  await offer(); await go('/search'); await p.waitForFunction(() => !document.querySelector('.toast.undo-snack:not(.files-unfinished)'), null, { timeout: 3000 }).catch(() => undefined);
  await p.waitForFunction(() => window.__cleared >= 4, null, { timeout: 3000 }).catch(() => undefined);
  ok(L('another page: the pill does not follow; the held action done once'), !(await p.$('.toast.undo-snack:not(.files-unfinished)')) && (await p.evaluate(() => window.__cleared)) === 4);
  await p.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  ok(L('…and never a second time'), (await p.evaluate(() => window.__cleared)) === 4);
  // behind a sheet opened after it, the pill's time stands still (the clock may run past it); seen again, it has what
  // was left — 3 s at least — and then the held action is done, once
  await offer(); const c0 = await p.evaluate(() => window.__cleared);
  await p.evaluate(() => { const d = document.createElement('div'); d.className = 'sheet test-sheet'; document.body.append(d); });
  await p.waitForFunction(() => document.querySelector('.undo-snack')?.classList.contains('behind-sheet'));
  await p.evaluate(() => new Promise((r) => setTimeout(r, 400)));
  await p.evaluate(() => { const now = Date.now; window.__realNow = now; Date.now = () => now() + 60000; });
  await p.evaluate(() => new Promise((r) => setTimeout(r, 700)));
  const waits = !!(await p.$('.toast.undo-snack:not(.files-unfinished)')) && (await p.evaluate(() => window.__cleared)) === c0;
  await p.evaluate(() => document.querySelector('.test-sheet').remove());
  await p.evaluate(() => new Promise((r) => setTimeout(r, 900)));
  const back = !!(await p.$('.toast.undo-snack:not(.files-unfinished):not(.behind-sheet)')) && (await p.evaluate(() => window.__cleared)) === c0;
  await p.waitForFunction((c) => window.__cleared > c, c0, { timeout: 8000 }).catch(() => undefined); await p.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const doneOnce = (await p.evaluate(() => window.__cleared)) === c0 + 1 && !(await p.$('.toast.undo-snack:not(.files-unfinished)'));
  await p.evaluate(() => { Date.now = window.__realNow; });
  ok(L('behind a sheet: the pill\'s time stands still, the held action waits'), waits);
  ok(L('…seen again: still offered for a while'), back);
  ok(L('…then done, once'), doneOnce, await p.evaluate(() => window.__cleared));

  // above the selection bar
  await go(`/files?p=${encodeURIComponent(K)}`); await p.waitForSelector(rowSel('Song.mp3')); await offer();
  await p.click(rowSel('Song.mp3'), { button: 'right' }); await p.waitForSelector('.files-selbar:not([hidden])');
  await p.waitForFunction(() => { const a = document.querySelector('.undo-snack')?.getBoundingClientRect(), b = document.querySelector('.files-selbar')?.getBoundingClientRect(); return a && b && a.bottom <= b.top + 0.5; }, null, { timeout: 3000 }).catch(() => undefined);
  ok(L('a selection made while the pill is up: the pill moves above its bar'), !overlap(await rect(p, '.undo-snack'), await rect(p, '.files-selbar')), [await rect(p, '.undo-snack'), await rect(p, '.files-selbar')]);
  ok(L('the selection bar sits above the bottom bar'), !overlap(await rect(p, '.files-selbar'), await rect(p, '.bottom-nav')), [await rect(p, '.files-selbar'), await rect(p, '.bottom-nav')]);
  await closeX(); await p.click('.files-selhead .icon-btn[data-icon="close"]'); await p.waitForFunction(() => window.__cleared >= 5);

  // the «Unfinished jobs» pill
  await p.evaluate((o) => localStorage.setItem('kt.files.queue.unfinished', JSON.stringify([{ op: 'copy', paths: [`${o.K}/Song.mp3`], dest: o.SD }])), { K, SD: F.SD });
  await go(fresh(`p=${encodeURIComponent(K)}`)); await p.waitForSelector('.files-unfinished', { timeout: 5000 }).catch(() => undefined);
  const ux = await rect(p, '.files-unfinished .toast-x');
  ok(L('«Unfinished jobs» has a close button too (48 px)'), !!ux && ux.w >= 47.5, ux);
  if (ux) { await p.click('.files-unfinished .toast-x'); await p.waitForFunction(() => !document.querySelector('.files-unfinished')); }
  await go(fresh(`p=${encodeURIComponent(K)}`)); await p.waitForSelector(rowSel('Song.mp3'));
  ok(L('closed: not offered again in this run, its jobs still kept'), !(await p.$('.files-unfinished')) && !!(await p.evaluate(() => localStorage.getItem('kt.files.queue.unfinished'))));

  // ---- never a blank page
  await p.evaluate((o) => { window.__ktStillMs = 500; window.__put(`${o.P}/Slow`, true); window.__hang = `${o.P}/Slow`; window.__put(`${o.P}/Odd`, true); }, { P });
  await go(`/files?p=${encodeURIComponent(`${P}/Slow`)}`);
  await p.waitForSelector('.files-state[data-state="still"]', { timeout: 5000 }).catch(() => undefined);
  ok(L('a listing that does not answer: «Still reading» with Try again and the storage\'s top'), (await p.$eval('.files-state[data-state="still"] b', (e) => e.textContent).catch(() => '')) === s.still && !!(await p.$('.files-state .files-state-retry')) && !!(await p.$('.files-state .files-state-root')));
  await p.evaluate(() => document.querySelectorAll('.files-state .spinner').forEach((x) => { x.style.animation = 'none'; }));
  if (lang === 'en') await shot('still');
  if (await p.$('.files-state .files-state-root')) { await p.click('.files-state .files-state-root'); await p.waitForSelector(rowSel('Music'), { timeout: 5000 }).catch(() => undefined); }
  ok(L('«Storage root»: the phone\'s top, listed'), !!(await p.$(rowSel('Music'))));
  await go(`/files?p=${encodeURIComponent(`${P}/Odd`)}`); await p.waitForSelector(rowSel('ok.txt'), { timeout: 5000 }).catch(() => undefined);
  ok(L('odd entries (no name, a broken date, a lone surrogate, a bad size, null, no path): the others still drawn'), (await p.$$eval('.files-view .files-row', (r) => r.length)) === 4, await p.$$eval('.files-view .files-row', (r) => r.map((x) => x.textContent)));
  // a remembered folder that is gone: its storage's top
  await go(`/files?p=${encodeURIComponent(K)}`); await p.waitForSelector(rowSel('Sub')); await p.click(`${rowSel('Sub')} .files-main`); await p.waitForSelector(rowSel('Deeper')); await p.click(`${rowSel('Deeper')} .files-main`); await p.waitForSelector(rowSel('deep.txt'));
  await p.evaluate((k) => { for (const x of [...window.__tree.keys()]) if (x.startsWith(`${k}/Sub/Deeper`)) window.__tree.delete(x); }, K);
  await go(fresh(''));
  await p.waitForSelector(rowSel('Song.mp3'), { timeout: 5000 }).catch(() => undefined);
  ok(L('the last folder is gone: Files opens at its storage\'s top'), !!(await p.$(rowSel('Song.mp3'))) && (await p.evaluate(() => decodeURIComponent(location.hash))).endsWith(K), await p.evaluate(() => location.hash));
  // storages that never answer
  await p.evaluate(() => { window.__hangRoots = true; }); await go(fresh(`p=${encodeURIComponent(K)}`));
  await p.waitForSelector(rowSel('Song.mp3'), { timeout: 12000 }).catch(() => undefined);
  ok(L('the storages never answer: the folder still shows'), !!(await p.$(rowSel('Song.mp3'))));
  await p.evaluate(() => { window.__hangRoots = false; window.__hang = ''; });

  // ---- gestures
  await go(fresh(`p=${encodeURIComponent(K)}`)); await p.waitForSelector(rowSel('Song.mp3'));
  { const r = await rect(p, '.files-strip'); const y = r.t + r.h / 2; const x0 = rtl ? 330 : 30, x1 = rtl ? 150 : 210; await touch(line(x0, y, x1, y, 12), 8); }
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250))));
  ok(L('a swipe along the strip of chips never opens the drawer'), !(await p.$('.files-drawer')));
  if (await p.$('.files-drawer')) { await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('.sheet')); }
  { const r = await rect(p, rowSel('Song.mp3')); const y = r.t + r.h / 2; const x0 = rtl ? 60 : 300, x1 = rtl ? 230 : 130; await touch(line(x0, y, x1, y + 110, 12), 8); }
  await p.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 250))));
  ok(L('a diagonal scroll over a row never asks to delete it'), !(await p.$('.sheet')));
  if (await p.$('.sheet')) { await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('.sheet')); }
  await p.evaluate(() => window.scrollTo(0, 0));
  { const r = await rect(p, rowSel('Sub')); const y = r.t + r.h / 2; const x0 = rtl ? 120 : 240, x1 = rtl ? 175 : 185; await touch(line(x0, y, x1, y, 6));
    // (The next tap at once — a finger's pointerdown, then its click —: Chrome's own test touch drops a click that soon after a swipe, so it is sent as the page would get it.)
    await p.evaluate((sel) => { const m = document.querySelector(sel); m.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, isPrimary: true, pointerType: 'touch', pointerId: 9 })); m.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, isPrimary: true, pointerType: 'touch', pointerId: 9 })); m.click(); }, `${rowSel('Sub')} .files-main`); }
  await p.waitForFunction((k) => decodeURIComponent(location.hash).endsWith(`${k}/Sub`), K, { timeout: 3000 }).catch(() => undefined);
  ok(L('a tap right after a short swipe of the same row is not lost'), (await p.evaluate(() => decodeURIComponent(location.hash))).endsWith(`${K}/Sub`), await p.evaluate(() => location.hash));
  // the fast scroller dragged at the top: no pull to refresh
  await go(`/files?p=${encodeURIComponent(`${K}/Many`)}`); await p.waitForSelector('.files-fast-thumb'); await p.evaluate(() => { window.scrollTo(0, 0); document.querySelector('.files-body').scrollTop = 0; window.__ptr = 0; new MutationObserver(() => { if (document.querySelector('.ptr-mark')) window.__ptr++; }).observe(document.body, { childList: true }); });
  { const [cx, cy] = await center('.files-fast-thumb'); await touch(line(cx, cy, cx, cy + 160, 10), 10); }
  await p.evaluate(() => new Promise((r) => setTimeout(r, 150)));
  ok(L('the fast scroller dragged at the top never pulls to refresh'), (await p.evaluate(() => window.__ptr)) === 0);
  // Paste tapped twice in a blink
  await go(`/files?p=${encodeURIComponent(K)}`); await p.waitForSelector(rowSel('Song.mp3'));
  await p.click(rowSel('Song.mp3'), { button: 'right' }); await p.click('.files-selbar [data-icon="copy"]'); await p.waitForSelector('.files-clipbar:not([hidden])');
  await go(`/files?p=${encodeURIComponent(`${K}/Sub`)}`); await p.waitForSelector(rowSel('in.txt'));
  await p.evaluate(() => { window.__calls = []; });
  { const [cx, cy] = await center('.files-clip-paste'); await tapAt(cx, cy); await tapAt(cx, cy); }
  await p.waitForFunction(() => window.__calls.some((c) => c.startsWith('copy:')), null, { timeout: 3000 }).catch(() => undefined); await p.evaluate(() => new Promise((r) => setTimeout(r, 300)));
  const copies = await p.evaluate(() => window.__calls.filter((c) => c.startsWith('copy:')).length);
  ok(L('Paste tapped twice in a blink: pasted once'), copies === 1, copies);

  const errs = errors.filter((e) => !/favicon/.test(e)); ok(L('no page errors'), !errs.length, errs);
  await p.close();
}
(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  for (const lang of process.argv[2] ? [process.argv[2]] : ['en', 'ar']) await phone(browser, port, z, lang);
  await browser.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
