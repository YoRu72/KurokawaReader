// Undo and Redo (ui/undo.ts and its callers), in English and Arabic, on a pretend phone and a pretend computer:
// downloads removed from the list are only held — Undo shows every one of them again (a video's too), nothing removed;
// Redo hides them again; left alone, they are removed for real once the Undo is over; the computer's Ctrl+Z /
// Ctrl+Shift+Z do the same, never while a text field is focused, and its key hints show only there. The subtitle
// workshop: a line edited and the times shifted, each one step of Undo and Redo (the header's buttons); closing
// with unsaved work asks Save / Discard / Keep editing (Back too, Back closing the question first); «Save as» over an
// earlier save asks first. The Files text editor asks the same. A settings restore (both kinds of backup): asked
// first, no secret written, and «Undo restore» after the reload puts every value back exactly. Emptying the Files bin
// asks first with the count. Previews (twice the pixels) go to the scratch folder given as UNDO_SHOTS, if any.
// Run: NODE_PATH=$(npm root -g) node tests/undo.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const F = require('./filesphone-fixture.cjs'); const { K } = F;
const DIST = path.join(__dirname, '..', 'dist'); const SHOTS = process.env.UNDO_SHOTS || '';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png' };
const serve = () => new Promise((res) => { const s = http.createServer((q, r) => { let p = decodeURIComponent(q.url.split('?')[0]); if (p === '/') p = '/index.html'; let f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(r); }); s.listen(0, '127.0.0.1', () => res(s)); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };
const shot = async (p, name) => { if (SHOTS) await p.screenshot({ path: path.join(SHOTS, name) }); };
const WINDOW = 7000;   // (ui/undo.ts: how long an Undo is offered)
const S = {
  en: { undo: 'Undo', redo: 'Redo', remove: 'Remove', keep: 'Keep editing', discard: 'Discard', save: 'Save', apply: 'Apply', replace: 'Replace' },
  ar: { undo: 'تراجَع', redo: 'أعِد', remove: 'أزِل', keep: 'تابِع التحرير', discard: 'أهمِلها', save: 'احفظ', apply: 'طبِّق', replace: 'استبدِل' },
};

/** Five downloads of every kind (a video's among them); `remove` takes one off for real and is told. */
function tasksInit({ lang, pc }) {
  if (!sessionStorage.getItem('kt-test-init')) { sessionStorage.setItem('kt-test-init', '1'); localStorage.clear(); localStorage.setItem('kr.lang', lang); if (pc) localStorage.setItem('kt.pc.starter', '1'); }
  const now = 1760000000000; window.__calls = [];
  const mk = (id, name, kind, state, extra = {}) => ({ id, kind, name, source: kind === 'torrent' ? { magnet: 'magnet:?xt=urn:btih:' + id.padEnd(40, '0') } : kind === 'video' ? {} : { url: 'https://example.invalid/' + name }, dir: '/d', state, done: 5, total: 10, downSpeed: 0, upSpeed: 0, peers: 0, seeds: 0, files: [], addedAt: now - id.charCodeAt(0) * 1000, engine: 'native', ...extra });
  window.__tasks = [mk('a', 'Frieren - 05.mkv', 'torrent', 'paused'), mk('b', 'ubuntu.iso', 'http', 'done'), mk('c', 'Song.mp3', 'http', 'paused'), mk('d', 'Lecture.webm', 'video', 'done', { meta: { kind: 'video' } }), mk('e', 'Notes.pdf', 'http', 'failed', { error: 'HTTP 404' })];
  const subs = new Set(); const tell = () => subs.forEach((f) => f(window.__tasks.map((x) => ({ ...x }))));
  const remove = async (id, del) => { window.__calls.push(['remove', id, !!del]); window.__tasks = window.__tasks.filter((x) => x.id !== id); tell(); };
  if (pc) window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => window.__tasks.map((x) => ({ ...x })), onTasks: (cb) => { subs.add(cb); setTimeout(() => cb(window.__tasks.map((x) => ({ ...x }))), 0); return () => subs.delete(cb); }, remove: (id, del) => remove(id, del) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
  else {
    const plugin = new Proxy({ addListener: () => ({ remove() {} }), list: async () => ({ tasks: window.__tasks.map((x) => ({ ...x })) }), remove: async (o) => remove(o.id, o.deleteFiles) }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
    window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
  }
}
const names = (p) => p.$$eval('.task-card .task-name', (e) => e.map((x) => x.textContent).sort());
const ALL = ['Frieren - 05.mkv', 'Lecture.webm', 'Notes.pdf', 'Song.mp3', 'ubuntu.iso'];

async function downloadsPhone(br, base, lang) {
  const L = (s) => `[${lang}-phone downloads] ${s}`; const s = S[lang];
  const p = await br.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, hasTouch: true }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await p.addInitScript(tasksInit, { lang, pc: false }); await p.goto(base); await p.waitForSelector('.task-card');
  await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 5);
  const removeAll = async () => {
    await p.click('.task-card >> nth=0', { button: 'right' }); await p.waitForSelector('.select-bar:not([hidden])');
    await p.click(`.select-bar button[aria-label="${lang === 'ar' ? 'حدِّد الكل' : 'Select all'}"]`);
    await p.click('.select-bar .icon-btn[data-icon="trash"]'); await p.waitForSelector('.sheet .remove-files');
    await p.click('.sheet .btn.primary.danger'); await p.waitForSelector('.toast.undo-snack');
    await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 0);
  };
  await removeAll();
  ok(L('all five gone from the list at once, nothing removed yet'), (await names(p)).length === 0 && (await p.evaluate(() => window.__calls.length)) === 0);
  ok(L('the snackbar says it, with Undo; no key hint on a phone'), (await p.textContent('.undo-snack .toast-act')) === s.undo && !(await p.$('.undo-snack .undo-key')));
  await p.waitForTimeout(400);   // (the snackbar's rise over)
  await shot(p, lang === 'en' ? 'tools-undo-downloads-phone.png' : 'tools-undo-downloads-phone-ar.png');
  const box = await p.$eval('.undo-snack', (e) => { const r = e.getBoundingClientRect(); return { bottom: r.bottom, nav: document.querySelector('.bottom-nav, nav')?.getBoundingClientRect().top ?? innerHeight }; });
  ok(L('the snackbar sits above the bottom bar'), box.bottom <= box.nav + 1, box);
  await p.click('.undo-snack .toast-act'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 5);
  ok(L('Undo: every one back (the video too), none removed'), JSON.stringify(await names(p)) === JSON.stringify(ALL) && (await p.evaluate(() => window.__calls.length)) === 0);
  ok(L('then Redo is offered'), (await p.textContent('.undo-snack .toast-act')) === s.redo);
  await p.click('.undo-snack .toast-act'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 0);
  ok(L('Redo: hidden again'), (await names(p)).length === 0);
  await p.click('.undo-snack .toast-act'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 5);
  // (a plain message while the Undo waits does not take it away)
  await removeAll();
  await p.waitForTimeout(WINDOW + 700);
  const calls = await p.evaluate(() => window.__calls);
  ok(L('left alone: removed for real when the Undo is over — every kind, files kept'), calls.length === 5 && calls.every((c) => c[0] === 'remove' && c[2] === false) && calls.map((c) => c[1]).sort().join('') === 'abcde', calls);
  ok(L('and the snackbar has gone'), !(await p.$('.undo-snack')));
  ok(L('no page errors'), !errs.length, errs); await p.close();
}

async function downloadsPc(br, base, lang) {
  const L = (s) => `[${lang}-pc downloads] ${s}`;
  const p = await br.newPage({ viewport: { width: 1366, height: 800 }, deviceScaleFactor: 2 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await ctxRoutes(p); await p.addInitScript(tasksInit, { lang, pc: true }); await p.goto(base); await p.waitForSelector('.task-card');
  await p.waitForFunction(() => document.documentElement.classList.contains('pc') && document.querySelectorAll('.task-card').length === 5);
  await p.keyboard.press('Control+a'); await p.waitForSelector('.select-bar:not([hidden])'); await p.keyboard.press('Delete'); await p.waitForSelector('.toast.undo-snack');
  await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 0);
  ok(L('Delete: the selected held, with Undo and its key shown'), (await p.textContent('.undo-snack .undo-key')) === 'Ctrl+Z' && /Ctrl\+Z/.test(await p.getAttribute('.undo-snack .toast-act', 'title')));
  await shot(p, lang === 'en' ? 'tools-undo-pc.png' : 'tools-undo-pc-ar.png');
  await p.keyboard.press('Control+z'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 5);
  ok(L('Ctrl+Z: all back, none removed'), JSON.stringify(await names(p)) === JSON.stringify(ALL) && (await p.evaluate(() => window.__calls.length)) === 0);
  await p.keyboard.press('Control+Shift+z'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 0);
  ok(L('Ctrl+Shift+Z: hidden again'), (await names(p)).length === 0);
  await p.keyboard.press('Control+y').catch(() => undefined);
  await p.keyboard.press('Control+z'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 5);
  ok(L('Ctrl+Z again: back'), (await names(p)).length === 5);
  // a text field focused: its own undo, not the app's
  await p.keyboard.press('Control+Shift+z'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 0);
  await p.keyboard.press('Control+f'); await p.waitForSelector('.dl-search input'); await p.focus('.dl-search input');
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  ok(L('Ctrl+Z while typing in the search: the list untouched'), (await names(p)).length === 0);
  await p.keyboard.press('Escape'); await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.keyboard.press('Control+z'); await p.waitForFunction(() => document.querySelectorAll('.task-card').length === 5);
  ok(L('out of the field: Ctrl+Z works'), (await names(p)).length === 5);
  ok(L('no page errors'), !errs.length, errs); await p.close();
}
async function ctxRoutes(p) { await p.route(/github|githubusercontent/, (r) => r.fulfill({ status: 404 })); }

/** The Files phone with a subtitle and a text file, a store of what is written, and their contents served. */
function filesExtra() {
  const SRT = '1\n00:00:01,000 --> 00:00:02,000\nHello there\n\n2\n00:00:03,000 --> 00:00:04,500\nSecond line\n';
  const K = '/storage/emulated/0/Download/Kurokawa'; window.__files = { [`${K}/Movie.srt`]: SRT, [`${K}/notes.txt`]: 'first draft' }; window.__writes = [];
  const t0 = 1760000000000; const wait = setInterval(() => { if (!window.__tree) return; clearInterval(wait); window.__tree.set(`${K}/Movie.srt`, { dir: false, size: SRT.length, mtime: t0 }); window.__tree.set(`${K}/notes.txt`, { dir: false, size: 11, mtime: t0 }); }, 0);
  const base = window.Capacitor.Plugins.KurokawaTools;
  const extra = {
    localUrl: async ({ path }) => { if (!(path in window.__files)) throw new Error('not found'); return { url: 'data:text/plain;base64,' + btoa(unescape(encodeURIComponent(window.__files[path]))) }; },
    filesWrite: async ({ path, text }) => { window.__writes.push(path); window.__files[path] = text; if (!window.__tree.has(path)) window.__tree.set(path, { dir: false, size: text.length, mtime: t0 }); return { size: text.length }; },
    filesHead: async ({ path }) => { if (!(path in window.__files)) throw new Error('not found'); return { text: window.__files[path], size: window.__files[path].length }; },
    filesTrashList: async () => ({ items: [{ slot: 's1', name: 'old.txt', from: `${K}/old.txt`, at: t0, dir: false, size: 3, path: '/x', exists: true }, { slot: 's2', name: 'older.txt', from: `${K}/older.txt`, at: t0, dir: false, size: 3, path: '/y', exists: true }] }),
    filesTrashEmpty: async (o) => { window.__writes.push('empty:' + JSON.stringify(o)); return { n: 2 }; },
  };
  window.Capacitor.Plugins.KurokawaTools = new Proxy({}, { get: (t, k) => (k in extra ? extra[k] : base[k]) });
}
async function workshop(br, lang, z) {
  const L = (s) => `[${lang}-phone workshop] ${s}`; const s = S[lang];
  const { page: p, errors } = await F.open(br, { lang, pc: false, z }); await p.addInitScript(filesExtra); const srv = await F.serve();
  await p.goto(`http://localhost:${srv.address().port}/#/files?p=${encodeURIComponent(K)}`); await p.waitForSelector('.files-row:has(.files-name[title="Movie.srt"])');
  const openIt = async () => { await p.click('.files-row:has(.files-name[title="Movie.srt"]) .files-main'); await p.waitForSelector('.subs-workshop .ws-cue'); };
  const cues = () => p.$$eval('.subs-workshop .ws-cue', (e) => e.map((c) => `${c.querySelector('small').textContent}|${c.querySelector('.ws-text').innerText}`));
  await openIt(); const c0 = await cues();
  ok(L('Undo and Redo in the header, both off at first; no shortcut in their names on a phone'), (await p.$eval('.subs-workshop .ws-undo', (b) => b.disabled && !/Ctrl/.test(b.title))) && (await p.$eval('.subs-workshop .ws-redo', (b) => b.disabled)));
  await p.click('.subs-workshop .ws-text >> nth=0'); await p.keyboard.press('Control+a'); await p.keyboard.type('Edited line'); await p.click('.subs-workshop .sheet-body > .hint');
  await p.fill('.subs-workshop .ws-tools input >> nth=0', '1.5'); await p.click('.subs-workshop .ws-tools .btn.tonal.small >> nth=0');
  const c2 = await cues();
  ok(L('a line edited and the times shifted'), /Edited line/.test(c2[0]) && /00:00:02,500/.test(c2[0]) && c2.length === 2, c2);
  await p.waitForFunction(() => !document.querySelector('.toast:not(.undo-snack)'));
  await shot(p, lang === 'en' ? 'tools-undo-workshop-phone.png' : 'tools-undo-workshop-phone-ar.png');
  await p.click('.subs-workshop .ws-undo'); const c1 = await cues();
  ok(L('Undo: the shift taken back, the edit kept'), /Edited line/.test(c1[0]) && /00:00:01,000/.test(c1[0]), c1);
  await p.click('.subs-workshop .ws-undo');
  ok(L('Undo again: the file as it was opened'), JSON.stringify(await cues()) === JSON.stringify(c0) && (await p.$eval('.subs-workshop .ws-undo', (b) => b.disabled)));
  await p.click('.subs-workshop .ws-redo'); await p.click('.subs-workshop .ws-redo');
  ok(L('Redo twice: both back, Redo off'), JSON.stringify(await cues()) === JSON.stringify(c2) && (await p.$eval('.subs-workshop .ws-redo', (b) => b.disabled)));
  // closing with unsaved work
  await p.click('.subs-workshop .sheet-head > .icon-btn'); await p.waitForSelector('.unsaved-sheet');
  ok(L('closing asks: Save, Discard, Keep editing'), (await p.$$eval('.unsaved-sheet .sheet-actions .btn', (b) => b.map((x) => x.dataset.answer))).join() === 'keep,discard,save');
  await p.waitForFunction(() => !document.querySelector('.toast:not(.undo-snack)')); await p.waitForTimeout(450);   // (the sheet's rise over, the step's message gone)
  await shot(p, lang === 'en' ? 'tools-undo-dirty-phone.png' : 'tools-undo-dirty-phone-ar.png');
  await p.click('.unsaved-sheet [data-answer="keep"]'); await p.waitForSelector('.unsaved-sheet', { state: 'detached' });
  ok(L('Keep editing: the workshop still open, the work kept'), JSON.stringify(await cues()) === JSON.stringify(c2));
  await p.evaluate(() => window.__back()); await p.waitForSelector('.unsaved-sheet');
  ok(L('Back asks too'), !!(await p.$('.subs-workshop')));
  await p.evaluate(() => window.__back()); await p.waitForSelector('.unsaved-sheet', { state: 'detached' });
  ok(L('Back again closes the question first, the workshop stays'), !!(await p.$('.subs-workshop')));
  await p.evaluate(() => window.__back()); await p.waitForSelector('.unsaved-sheet'); await p.click('.unsaved-sheet [data-answer="save"]');
  await p.waitForSelector('.subs-workshop', { state: 'detached' });
  const saved = await p.evaluate((k) => window.__files[`${k}/Movie.kurokawa.srt`], K);
  ok(L('Save: written beside it, and closed'), /Edited line/.test(saved || '') && /00:00:02,500/.test(saved || ''), saved);
  // Save as over that earlier save: asked first
  await openIt(); await p.click(`.subs-workshop .sheet-actions .btn.primary`); await p.waitForSelector('.confirm-sheet');
  ok(L('«Save as» over an existing file asks first'), (await p.textContent('.confirm-sheet .btn.primary')).includes(s.replace));
  await p.click('.confirm-sheet .btn.tonal'); await p.waitForSelector('.confirm-sheet', { state: 'detached' });
  ok(L('…and Cancel leaves it as it was'), /Edited line/.test(await p.evaluate((k) => window.__files[`${k}/Movie.kurokawa.srt`], K)));
  await p.click('.subs-workshop .sheet-head > .icon-btn'); await p.waitForSelector('.subs-workshop', { state: 'detached' });
  ok(L('nothing unsaved: closes without asking'), !(await p.$('.unsaved-sheet')));
  // the text editor
  await p.click('.files-row:has(.files-name[title="notes.txt"]) .files-main'); await p.waitForSelector('.files-editor .files-ta');
  await p.fill('.files-editor .files-ta', 'second draft'); await p.evaluate(() => window.__back()); await p.waitForSelector('.unsaved-sheet');
  ok(L('the text editor: Back with unsaved text asks'), !!(await p.$('.files-editor')));
  await p.click('.unsaved-sheet [data-answer="discard"]'); await p.waitForSelector('.files-editor', { state: 'detached' });
  ok(L('Discard: closed, the file untouched'), (await p.evaluate((k) => window.__files[`${k}/notes.txt`], K)) === 'first draft');
  ok(L('no page errors'), !errors.filter((e) => !/favicon/.test(e)).length, errors);
  await p.close(); srv.close();
}

/** Settings restored from either kind of backup, then «Undo restore». */
function restoreInit(lang) {
  if (sessionStorage.getItem('kt-test-init')) return; sessionStorage.setItem('kt-test-init', '1');
  localStorage.clear(); localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.test.a', 'OLD'); localStorage.setItem('kt.anilist.token', 'MINE'); localStorage.setItem('kr.test', 'oldkr');
}
async function restore(br, base, lang, kind) {
  const L = (s) => `[${lang} restore ${kind}] ${s}`;
  const p = await br.newPage({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2 }); const errs = []; p.on('pageerror', (e) => errs.push(e.message));
  await ctxRoutes(p); await p.addInitScript(restoreInit, lang); await p.goto(base + '#/settings'); await p.waitForSelector('.settings-body');
  const file = kind === 'settings' ? { app: 'kurokawa-tools', kind: 'settings', version: 1, data: { 'kt.test.a': 'NEW', 'kt.test.b': 'B', 'kt.anilist.token': 'STOLEN' } }
    : { kurokawa: 'tools-backup', data: { 'kt.test.a': 'NEW', 'kt.test.b': 'B', 'kr.test': 'newkr', 'kt.debrid.key': 'STOLEN', 'kt.anilist.token': 'STOLEN' } };
  const label = kind === 'settings' ? (lang === 'ar' ? 'استعِد الإعدادات' : 'Restore the settings') : null;
  const fc = p.waitForEvent('filechooser');
  await p.evaluate(({ label, kind }) => { const bs = [...document.querySelectorAll('.settings-body button')]; const b = kind === 'settings' ? bs.find((x) => x.textContent.trim() === label) : bs.find((x) => x.querySelector('[data-icon], svg') && x.closest('#backup') && /upload/.test(x.innerHTML) && x !== bs.find((y) => y.textContent.trim() === label)); (b || bs.find((x) => x.closest('#backup') && x.matches(':last-child'))).click(); }, { label, kind });
  const chooser = await fc; await chooser.setFiles({ name: 'b.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(file)) });
  await p.waitForSelector('.confirm-sheet');
  const ask = await p.textContent('.confirm-sheet .sheet-body');
  ok(L('asked first, with what it writes and what differs'), /[23٢٣]/.test(ask) && (await p.evaluate(() => localStorage.getItem('kt.test.a'))) === 'OLD', ask);
  await Promise.all([p.waitForEvent('load'), p.click('.confirm-sheet .btn.primary')]);
  await p.waitForSelector('.toast.undo-snack');
  const st = await p.evaluate(() => ({ a: localStorage.getItem('kt.test.a'), b: localStorage.getItem('kt.test.b'), tok: localStorage.getItem('kt.anilist.token'), key: localStorage.getItem('kt.debrid.key'), kr: localStorage.getItem('kr.test') }));
  ok(L('restored after the reload; no secret written'), st.a === 'NEW' && st.b === 'B' && st.tok === 'MINE' && st.key === null && st.kr === (kind === 'settings' ? 'oldkr' : 'newkr'), st);
  ok(L('«Undo restore» waits until dismissed (no timer)'), !!(await p.$('.undo-snack .toast-x')));
  await shot(p, `tools-undo-restore-${lang}-${kind}.png`);
  await Promise.all([p.waitForEvent('load'), p.click('.undo-snack .toast-act')]);
  await p.waitForSelector('.settings-body');
  const back = await p.evaluate(() => ({ a: localStorage.getItem('kt.test.a'), b: localStorage.getItem('kt.test.b'), tok: localStorage.getItem('kt.anilist.token'), kr: localStorage.getItem('kr.test'), snap: localStorage.getItem('kt.tmp.restoreUndo') }));
  ok(L('Undo restore: every value exactly as before, the added one gone, the snapshot let go'), back.a === 'OLD' && back.b === null && back.tok === 'MINE' && back.kr === 'oldkr' && back.snap === null, back);
  ok(L('no page errors'), !errs.length, errs); await p.close();
}

(async () => {
  const srv = await serve(); const base = `http://127.0.0.1:${srv.address().port}/`; const br = await chromium.launch(); const z = await F.zipListing();
  for (const lang of process.argv[2] ? [process.argv[2]] : ['en', 'ar']) {
    await downloadsPhone(br, base, lang); await downloadsPc(br, base, lang); await workshop(br, lang, z);
    await restore(br, base, lang, 'settings'); await restore(br, base, lang, 'full');
  }
  await br.close(); srv.close(); console.log(fails ? `${fails} failed` : 'all passed'); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
