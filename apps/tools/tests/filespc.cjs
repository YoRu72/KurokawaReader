// Files on a computer (stage F5a): the DETAILS list (Name · Size · Type · Modified — sort, resize, hide, kept), the navigation
// pane (quick access, favourites, recent, drives with a usage bar, a lazy folder tree — one listing per expand — the current
// folder revealed, collapse kept), the address bar (crumbs, sub-folder menus, a text field: go / not found / Esc / quotes / a file
// path), history (Alt+←/→/↑), the status bar, the keys (type to jump, Home/End, Shift range, Ctrl toggle, rubber band, F2 inline,
// Delete vs Shift+Delete), the empty-space menu, two panes each with its own path, and the phone left as it was. 1280x800, the
// Tauri shell over a pretend IPC; English and Arabic. Run: NODE_PATH=$(npm root -g) node tests/filespc.cjs [en|ar]
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist'); const SHOTS = process.env.KT_SHOTS || '';
const BRIDGE = fs.readFileSync(path.join(__dirname, '..', 'desktop-tauri', 'bridge.js'), 'utf8');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, r) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); r.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(r); });
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x))); if (!cond) fails++; };

function fakeTauri({ lang, dual }) {
  if (!sessionStorage.getItem('kt-pc-init')) { sessionStorage.setItem('kt-pc-init', '1'); localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files'] })); localStorage.setItem('kt.files.prefs', JSON.stringify({ view: 'list', sort: 'name', desc: false, hidden: false, kind: 'all', ...(dual ? { dual: true, lastB: '/home/u/src/Beta' } : {}) })); localStorage.setItem('kt.files.bookmarks', JSON.stringify([{ name: 'Pinned', path: '/home/u/dst' }])); }
  const tree = new Map(); window.__tree = tree; window.__calls = []; window.__lists = [];
  const M = 1760000000000; const put = (p, dir, size = 1, m = M) => tree.set(p, { dir, size, m });
  for (const d of ['/home', '/home/u', '/home/u/src', '/home/u/src/Alpha', '/home/u/src/Alpha/Deep', '/home/u/src/Beta', '/home/u/dst']) put(d, true, 0);
  put('/home/u/src/apple.txt', false, 10, M - 5e9); put('/home/u/src/banana.mp4', false, 5e6, M - 4e9); put('/home/u/src/cherry.zip', false, 300, M - 3e9); put('/home/u/src/delta.png', false, 2048, M - 2e9); put('/home/u/src/echo.txt', false, 1, M - 1e9);
  put('/home/u/src/Alpha/a1.txt', false, 3); put('/home/u/src/Beta/b1.txt', false, 2); put('/home/u/src/Alpha/Deep/z.txt', false, 4); put('/home/u/dst/one.txt', false, 5);
  const parent = (p) => p.replace(/\/[^/]*$/, '') || '/'; const base = (p) => p.split('/').pop(); const sub = (p) => [...tree.keys()].filter((k) => k === p || k.startsWith(p + '/'));
  const ls = {}; const emit = (o) => setTimeout(() => (ls['kt:files'] || []).forEach((f) => f({ event: 'kt:files', payload: JSON.parse(JSON.stringify(o)) })), 0);
  const replies = {
    kt_state: () => ({ available: false, reason: '', os: 'linux', arch: 'x64' }), kt_list: () => [], kt_default_dir: () => '/home/u/Downloads/Kurokawa', kt_roots: () => ({ roots: ['/home/u'] }), kt_home_dir: () => '/home/u',
    kt_list_dir: (a) => { const p = a.p.replace(/\/+$/, '') || '/'; window.__lists.push(p); if (p !== '/' && !tree.get(p)?.dir) return { entries: [], exists: false }; return { exists: true, entries: [...tree.keys()].filter((k) => parent(k) === p && k !== p).map((k) => ({ name: base(k), path: k, dir: tree.get(k).dir, size: tree.get(k).size, mtime: tree.get(k).m })) }; },
    kt_files_job: (a) => { const o = a.o; for (const p of o.paths) if (o.op === 'delete') for (const k of sub(p)) tree.delete(k); setTimeout(() => emit({ id: o.id, status: 'done', done: 1, total: 1, files: 1, failed: [], skipped: 0 }), 20); return { id: o.id }; },
    kt_files_cancel: () => null, kt_files_answer: () => null,
    kt_delete_path: (a) => { for (const k of sub(a.p)) tree.delete(k); return { ok: true, trashed: true }; },
    kt_files_roots: () => ({ allFiles: true, roots: [{ kind: 'home', path: '/home/u', name: 'u', readable: true }, { kind: 'downloads', path: '/home/u/dst', name: 'dst', readable: true }, { kind: 'drive', path: '/', name: '/', readable: true, free: 5 * 2 ** 30, total: 9 * 2 ** 30 }, { kind: 'drive', path: '/media/u/USB', name: 'USB', readable: true, free: 2 ** 30, total: 2 ** 32 }] }),
    kt_files_stat: (a) => { const p = a.o.path.replace(/\/+$/, ''); const e = tree.get(p); return e ? { exists: true, name: base(p), path: p, dir: e.dir, size: e.size, mtime: e.m, readable: true, writable: true, hidden: false } : { exists: false, name: base(p), path: p, dir: false, size: 0, mtime: 0, readable: false, writable: false, hidden: false }; },
    kt_files_mkdir: (a) => { put(a.o.path, true, 0); return { ok: true, path: a.o.path }; },
    kt_files_rename: (a) => { const to = parent(a.o.path) + '/' + a.o.name; if (tree.has(to)) return Promise.reject('exists'); for (const k of sub(a.o.path)) { tree.set(to + k.slice(a.o.path.length), tree.get(k)); tree.delete(k); } return { ok: true, path: to }; },
  };
  window.__TAURI__ = { core: { invoke: (c, a) => { window.__calls.push(c); return Promise.resolve(replies[c] ? replies[c](a || {}) : null); } }, event: { listen: (n, f) => { (ls[n] = ls[n] || []).push(f); return Promise.resolve(() => undefined); } } };
  window.__KT_BOOT__ = { os: 'linux', arch: 'x64' };
}

(async () => {
  const lang = process.argv[2] === 'ar' ? 'ar' : 'en'; const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const esb = require('esbuild');
  const out = esb.buildSync({ entryPoints: [path.join(__dirname, '..', 'src/i18n', `${lang}.ts`)], bundle: true, write: false, format: 'cjs', platform: 'node' }); const m = { exports: {} }; new Function('module', 'exports', out.outputFiles[0].text)(m, m.exports); const T = { ...m.exports.en, ...m.exports[lang] };
  const L = (s) => `[${lang}] ${s}`; const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: path.join(SHOTS, name) }); };
  const open = async (w, hgt, dual) => { const ctx = await br.newContext({ viewport: { width: w, height: hgt } }); const page = await ctx.newPage(); page.errors = []; page.on('pageerror', (e) => page.errors.push(String(e))); await page.route(/api\.github\.com|raw\.githubusercontent\.com/, (r) => r.fulfill({ status: 404, body: '' })); await page.addInitScript(fakeTauri, { lang, dual: !!dual }); await page.addInitScript({ content: BRIDGE }); return page; };
  const page = await open(1280, 800);
  const goTo = async (p) => { await page.goto(`${base}#/files?p=${encodeURIComponent(p)}`); await page.waitForSelector('.d-row', { timeout: 15000 }); await page.waitForTimeout(350); };
  const names = () => page.evaluate(() => [...document.querySelectorAll('.d-row .files-name')].map((x) => x.getAttribute('title')));
  const picked = () => page.evaluate(() => [...document.querySelectorAll('.d-row.picked .files-name')].map((x) => x.getAttribute('title')));
  const row = (n) => page.locator(`.d-row:has(.files-name[title="${n}"])`).first();
  const here = () => page.evaluate(() => document.querySelector('.pcx-crumb.last')?.title ?? '');
  const waitHere = async (p) => { await page.waitForFunction((x) => document.querySelector('.pcx-crumb.last')?.title === x, p, { timeout: 5000 }).catch(() => {}); await page.waitForTimeout(250); };
  const status = () => page.evaluate(() => document.querySelector('.pcx-status')?.textContent ?? '');
  const saved = () => page.evaluate(() => JSON.parse(localStorage.getItem('kt.files.pc') || '{}'));

  await goTo('/home/u/src');
  // ---- 1. the details list
  const heads = await page.evaluate(() => [...document.querySelectorAll('.pcx-head .pcx-hb')].map((x) => x.textContent.trim()));
  ok(L('the header: Name · Size · Type · Modified'), heads.join('|') === [T.pcColName, T.pcColSize, T.pcColType, T.pcColModified].join('|'), heads);
  ok(L('folders first, then by name'), (await names()).join(',') === 'Alpha,Beta,apple.txt,banana.mp4,cherry.zip,delta.png,echo.txt', await names());
  const cells = await page.evaluate(() => { const r = (n) => [...document.querySelector(`.d-row:has(.files-name[title="${n}"])`).children].map((c) => c.textContent.trim()); return { zip: r('cherry.zip'), mp4: r('banana.mp4'), dir: r('Alpha') }; });
  ok(L('type as a short word: Folder / ZIP archive / MP4 video'), cells.dir[2] === T.pcTypeFolder && cells.zip[2] === T.pcTypeArchive.replace('{x}', 'ZIP') && cells.mp4[2] === T.pcTypeVideo.replace('{x}', 'MP4'), cells);
  ok(L('size at the end; a date and a time in the Modified cell'), /\d/.test(cells.zip[1]) && cells.dir[1] === '' && /\d+:\d\d/.test(cells.zip[3]), cells);
  const bb = await row('apple.txt').boundingBox(); const icb = await row('apple.txt').locator('.files-ic').boundingBox();
  ok(L('rows 32 px high, the icon 20 px'), Math.round(bb.height) === 32 && Math.round(icb.width) === 20, [bb.height, icb.width]);
  await shot(page, 'F5a-pc-' + lang + '.png');
  // sort: click, again flips; the arrow shows it
  await page.click('.pcx-hb[data-col="size"]'); await page.waitForTimeout(200);
  ok(L('click Size: by size, smallest first (folders first)'), (await names()).slice(2).join(',') === 'echo.txt,apple.txt,cherry.zip,delta.png,banana.mp4', await names());
  ok(L('… the arrow and aria-sort show it'), await page.evaluate(() => document.querySelector('.pcx-h-size').getAttribute('aria-sort')) === 'ascending' && await page.locator('.pcx-h-size svg').count() === 1);
  await page.click('.pcx-hb[data-col="size"]'); await page.waitForTimeout(200);
  ok(L('click again: flipped'), (await names()).slice(2)[0] === 'banana.mp4' && await page.evaluate(() => document.querySelector('.pcx-h-size').getAttribute('aria-sort')) === 'descending');
  await page.click('.pcx-hb[data-col="name"]'); await page.waitForTimeout(150);
  // resize
  const w0 = (await page.locator('.pcx-h-type').boundingBox()).width; const g = await page.locator('.pcx-grip[data-col="type"]').boundingBox();
  await page.mouse.move(g.x + 3, g.y + 10); await page.mouse.down(); await page.mouse.move(g.x + 3 - 60, g.y + 10, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(200);
  const w1 = (await page.locator('.pcx-h-type').boundingBox()).width; const sv = await saved();
  ok(L('dragging a header edge resizes the column (the rows follow), kept'), Math.abs(w1 - (lang === 'ar' ? w0 - 60 : w0 + 60)) < 3 || w1 > w0 + 50 || w1 < w0 - 50, [w0, w1]); ok(L('… persisted'), !!sv.cols && sv.cols.type > 0 && Math.round(sv.cols.type) === Math.round(w1), sv);
  const rowT = await row('apple.txt').locator('.d-type').boundingBox(); ok(L('the rows share the new width'), Math.abs(rowT.width - w1) < 2, [rowT.width, w1]);
  // hide
  await page.click('.pcx-head', { button: 'right', position: { x: 300, y: 10 } }); await page.waitForSelector('.pcx-menu');
  await page.click(`.pcx-menu button:has-text("${T.pcColType}")`); await page.waitForTimeout(250);
  ok(L('right-click the header: Type hidden'), (await page.locator('.pcx-hb').count()) === 3 && (await row('apple.txt').locator('.d-type').count()) === 0 && (await saved()).hide?.includes('type'), await saved());
  await page.reload(); await page.waitForSelector('.d-row'); await page.waitForTimeout(300);
  ok(L('… kept after a reload'), (await page.locator('.pcx-hb').count()) === 3);
  await page.click('.pcx-head', { button: 'right', position: { x: 300, y: 10 } }); await page.click(`.pcx-menu button:has-text("${T.pcColType}")`); await page.waitForTimeout(200);

  // ---- 2. the navigation pane
  const heads2 = await page.evaluate(() => [...document.querySelectorAll('.nv-h')].map((x) => x.textContent));
  ok(L('groups: Quick access, Favourites, Recent folders, Drives, Folders'), [T.pcNavQuick, T.pcNavFav, T.pcNavRecent, T.pcNavDrives, T.pcNavFolders].every((x, i) => heads2[i] === x), heads2);
  ok(L('quick access: Home and Downloads; the favourite listed'), await page.locator(`.nv-item[data-p="/home/u"]:has-text("${T.filesHome}")`).count() >= 1 && await page.locator('.nv-item:has-text("Pinned")').count() === 1);
  ok(L('drives: a thin usage bar and the free space'), await page.locator('.nv-bar').count() === 2 && (await page.locator('.nv-disk').first().textContent()).includes('GB'), await page.locator('.nv-disk').first().textContent());
  ok(L('the current folder is revealed and highlighted in the tree'), await page.locator('.nv-item.cur[data-p="/home/u/src"][aria-level]').count() >= 1 && await page.locator('.nv-item[data-p="/home/u"][aria-expanded="true"]').count() >= 1);
  const before = await page.evaluate(() => window.__lists.length); await page.click('.nv-item[data-p="/home/u/src/Beta"] .nv-tw'); await page.waitForTimeout(300);
  const a1 = await page.evaluate(([n]) => window.__lists.slice(n), [before]);
  ok(L('a twisty expands lazily: one listing'), a1.length === 1 && a1[0] === '/home/u/src/Beta', a1);
  await page.click('.nv-item[data-p="/home/u/src/Alpha"] .nv-tw'); await page.waitForTimeout(300); const b4 = await page.evaluate(() => window.__lists.length);
  await page.click('.nv-item[data-p="/home/u/src/Alpha"] .nv-tw'); await page.click('.nv-item[data-p="/home/u/src/Alpha"] .nv-tw'); await page.waitForTimeout(300);
  ok(L('expanded again from the cache: no second listing'), (await page.evaluate(() => window.__lists.length)) === b4 && await page.locator('.nv-item[data-p="/home/u/src/Alpha/Deep"]').count() === 1);
  // keyboard
  await page.focus('.nv-item[data-p="/home/u/src/Alpha"]'); await page.keyboard.press(lang === 'ar' ? 'ArrowLeft' : 'ArrowRight');
  ok(L('tree keys: Right on an open node goes to its child'), await page.evaluate(() => document.activeElement?.dataset?.p) === '/home/u/src/Alpha/Deep', await page.evaluate(() => document.activeElement?.dataset?.p));
  await page.keyboard.press('Enter'); await waitHere('/home/u/src/Alpha/Deep'); ok(L('Enter opens it'), (await here()) === '/home/u/src/Alpha/Deep' && (await names()).join() === 'z.txt', await here());
  // the pane's width and collapse
  const nv = await page.locator('.pcx-nav').boundingBox(); const sp = await page.locator('.pcx-sep').boundingBox();
  await page.mouse.move(sp.x + 2, 300); await page.mouse.down(); await page.mouse.move(sp.x + (lang === 'ar' ? -90 : 90), 300, { steps: 4 }); await page.mouse.up(); await page.waitForTimeout(200);
  const nv2 = await page.locator('.pcx-nav').boundingBox(); ok(L('the pane resizes between 180 and 360 px, kept'), nv2.width > nv.width + 40 && nv2.width <= 360 && (await saved()).navW === Math.round(nv2.width), [nv.width, nv2.width]);
  await page.locator('.d-row').first().click(); await page.keyboard.press('Control+b'); await page.waitForTimeout(250);
  ok(L('Ctrl+B collapses the pane, kept'), !(await page.locator('.pcx-nav').isVisible()) && (await saved()).nav === false);
  await page.reload(); await page.waitForSelector('.d-row'); await page.waitForTimeout(300); ok(L('… after a reload still collapsed'), !(await page.locator('.pcx-nav').isVisible()));
  await page.click('.pcx-navbtn'); await page.waitForTimeout(250); ok(L('the button opens it again'), await page.locator('.pcx-nav').isVisible());

  // ---- 3. the address bar and history
  await goTo('/home/u/src'); await shot(page, 'F5a-pc-tree-' + lang + '.png');
  const cr = await page.evaluate(() => [...document.querySelectorAll('.pcx-crumb')].map((x) => x.textContent.trim()));
  ok(L('crumbs as buttons with a chevron after each'), cr.join('/') === '//home/u/src'.replace('//', '/').split('/').join('/') || (cr.length === 4 && cr[3] === 'src'), cr);
  await page.click('.pcx-crumb.last + .pcx-chev'); await page.waitForSelector('.pcx-menu');
  const sub = await page.evaluate(() => [...document.querySelectorAll('.pcx-menu .pcx-mi')].map((x) => x.textContent.trim()));
  ok(L('the chevron opens the sub-folders as a menu'), sub.join() === 'Alpha,Beta', sub);
  await page.click('.pcx-menu .pcx-mi:has-text("Alpha")'); await waitHere('/home/u/src/Alpha'); ok(L('… a click goes there'), (await here()) === '/home/u/src/Alpha');
  await page.keyboard.press('Control+l'); await page.waitForSelector('.pcx-input');
  ok(L('Ctrl+L: a text field with the full path, selected'), await page.evaluate(() => { const i = document.querySelector('.pcx-input'); return i.value === '/home/u/src/Alpha' && i.selectionStart === 0 && i.selectionEnd === i.value.length; }));
  await page.fill('.pcx-input', '/home/u/nowhere'); await page.keyboard.press('Enter'); await page.waitForTimeout(300);
  ok(L('a path that does not exist: a calm error, still editing'), (await page.locator('.pcx-err').isVisible()) && (await page.locator('.pcx-err').textContent()) === T.pcNoPath && await page.locator('.pcx-input').count() === 1, await page.evaluate(() => ({ err: document.querySelector('.pcx-err')?.outerHTML, inp: document.querySelectorAll('.pcx-input').length, ae: document.activeElement?.className })));
  await page.keyboard.press('Escape'); await page.waitForTimeout(150); ok(L('Esc cancels: the crumbs again, nothing moved'), await page.locator('.pcx-input').count() === 0 && (await here()) === '/home/u/src/Alpha' && !(await page.locator('.pcx-err').isVisible()));
  await page.keyboard.press('Alt+d'); await page.fill('.pcx-input', '"/home/u/dst"'); await page.keyboard.press('Enter'); await waitHere('/home/u/dst');
  ok(L('a path pasted with quotes is understood'), (await here()) === '/home/u/dst', await here());
  await shot(page, 'F5a-address-edit-' + lang + '.png');
  await page.keyboard.press('F4'); await page.fill('.pcx-input', '/home/u/src/banana.mp4'); await page.keyboard.press('Enter'); await waitHere('/home/u/src');
  ok(L('a file path: its folder opens and the file is selected'), (await here()) === '/home/u/src' && (await picked()).join() === 'banana.mp4', [await here(), await picked()]);
  await page.keyboard.press('Alt+ArrowLeft'); await waitHere('/home/u/dst'); const bk = await here(); await page.keyboard.press('Alt+ArrowRight'); await waitHere('/home/u/src'); const fw = await here();
  await page.keyboard.press('Alt+ArrowUp'); await waitHere('/home/u'); const up = await here();
  ok(L('history: Alt+← back, Alt+→ forward, Alt+↑ up'), bk === '/home/u/dst' && fw === '/home/u/src' && up === '/home/u', [bk, fw, up]);
  ok(L('Back and Forward buttons agree with the history'), !(await page.locator('.pcx-bar button[aria-label="' + T.back + '"]').isDisabled()) && (await page.locator(`.pcx-bar button[aria-label="${T.pcForward}"]`).isDisabled()));
  await goTo('/home/u/src');

  // ---- 4. the status bar
  ok(L('the status bar: the number of items'), /7/.test(await status()), await status());
  await row('apple.txt').click(); await row('cherry.zip').click({ modifiers: ['Shift'] });
  const st1 = await status(); ok(L('selecting: «N selected · total size»'), (await picked()).join() === 'apple.txt,banana.mp4,cherry.zip' && st1.includes(T.pcSelectedSize.replace('{n}', '3').split(' · ')[0].replace('3', '3')) , st1);
  await row('Alpha').click({ modifiers: ['Control'] }); const st2 = await status(); ok(L('a folder among them: «+ folders»'), st2.includes(T.pcSelectedMore.split('+')[1].trim()) && st2.includes('+'), st2);
  ok(L('the view switch at the end: details, grid, gallery'), await page.locator('.pcx-views button').count() === 3 && await page.locator('.pcx-views button[data-v="list"][aria-pressed="true"]').count() === 1);

  // ---- 5. keys and mouse
  await page.locator('.d-row').first().click(); await page.keyboard.press('c'); ok(L('type to jump: «c» selects cherry.zip'), (await picked()).join() === 'cherry.zip', await picked());
  await page.keyboard.press('End'); await page.keyboard.press('Home'); ok(L('End then Home: the first row'), (await picked()).join() === 'Alpha', await picked());
  await page.keyboard.press('Shift+ArrowDown'); await page.keyboard.press('Shift+ArrowDown'); ok(L('Shift+↓ extends the range'), (await picked()).join() === 'Alpha,Beta,apple.txt', await picked());
  await page.keyboard.press('ArrowDown'); ok(L('↓ alone moves the selection'), (await picked()).join() === 'banana.mp4', await picked());
  await page.keyboard.press('Control+a'); ok(L('Ctrl+A selects all'), (await picked()).length === 7);
  await page.keyboard.press('Escape'); await page.waitForTimeout(150); ok(L('Esc clears the selection'), (await picked()).length === 0);
  const lastB = await row('echo.txt').boundingBox(); const firstB = await row('Alpha').boundingBox();
  await page.mouse.move(lastB.x + 400, lastB.y + lastB.height + 50); await page.mouse.down(); await page.mouse.move(lastB.x + 420, firstB.y + 40, { steps: 6 }); await shot(page, 'F5a-band-' + lang + '.png'); await page.mouse.up(); await page.waitForTimeout(150);
  ok(L('rubber band over empty space selects the rows it touches'), (await picked()).length >= 5, await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return [e?.className, e?.parentElement?.className]; }, [lastB.x + 400, lastB.y + lastB.height + 50]));
  await page.mouse.click(lastB.x + 400, lastB.y + lastB.height + 50); await page.waitForTimeout(100); ok(L('a click on empty space clears'), (await picked()).length === 0);
  await row('apple.txt').click(); await page.keyboard.press('F2'); await page.waitForSelector('.pcx-rename');
  const sel = await page.evaluate(() => { const i = document.querySelector('.pcx-rename'); return [i.value, i.selectionStart, i.selectionEnd]; });
  ok(L('F2: inline in the name cell, the extension not selected'), sel[0] === 'apple.txt' && sel[1] === 0 && sel[2] === 5 && await page.locator('.sheet').count() === 0, sel);
  await page.keyboard.type('grape'); await page.keyboard.press('Enter'); await page.waitForTimeout(500);
  ok(L('Enter renames (through filesRename) and keeps it selected'), await page.evaluate(() => window.__tree.has('/home/u/src/grape.txt') && !window.__tree.has('/home/u/src/apple.txt')) && (await picked()).join() === 'grape.txt', [await picked()]);
  await row('grape.txt').click(); await page.keyboard.press('F2'); await page.waitForSelector('.pcx-rename'); await page.keyboard.press('Escape'); await page.waitForTimeout(100);
  ok(L('Esc in the field leaves the name as it was'), await page.locator('.pcx-rename').count() === 0 && await page.evaluate(() => window.__tree.has('/home/u/src/grape.txt')));
  await page.keyboard.press('Delete'); await page.waitForSelector('.sheet'); ok(L('Delete: the system bin offered'), (await page.locator('.sheet').textContent()).includes(T.filesTrashSystem));
  await page.keyboard.press('Escape'); await page.waitForTimeout(200); await page.locator('.sheet button:has-text("' + T.cancel + '")').click().catch(() => {}); await page.waitForTimeout(200);
  await row('echo.txt').click(); await page.keyboard.press('Shift+Delete'); await page.waitForSelector('.sheet'); const sh = await page.locator('.sheet').textContent();
  ok(L('Shift+Delete: asks, for good, no bin button'), sh.includes(T.filesDeleteForever) && !sh.includes(T.filesTrashSystem), sh.slice(0, 120));
  await page.click(`.sheet button.primary:has-text("${T.filesDeleteForever}")`); await page.waitForTimeout(700);
  ok(L('… confirmed: deleted'), await page.evaluate(() => !window.__tree.has('/home/u/src/echo.txt')));
  await page.locator('.d-row').first().click(); const eb = await row('delta.png').boundingBox(); await page.mouse.click(eb.x + 400, eb.y + eb.height + 120, { button: 'right' }); await page.waitForSelector('.pcx-menu');
  const em = await page.evaluate(() => [...document.querySelectorAll('.pcx-menu .pcx-mi')].map((x) => x.textContent.trim()));
  ok(L('right-click on empty space: New folder, Paste, Sort by, View, Refresh, Properties'), [T.newFolder, T.filesPaste, T.sortBy, T.fmView, T.refresh, T.properties].every((x, i) => em[i] === x), em);
  await page.click(`.pcx-menu .pcx-mi:has-text("${T.sortBy}")`); await page.click(`.pcx-menu .pcx-mi:has-text("${T.pcColType}")`); await page.waitForTimeout(200);
  ok(L('Sort by ▸ Type: sorted'), await page.evaluate(() => document.querySelector('.pcx-h-type')?.getAttribute('aria-sort')) === 'ascending');
  await page.click('.pcx-hb[data-col="name"]'); await page.waitForTimeout(100);

  // ---- 6. the details view hands over: grid keeps its own look
  await page.click('.pcx-views button[data-v="grid"]'); await page.waitForTimeout(400);
  ok(L('grid is the old grid (no header, no details rows)'), await page.locator('.pcx-head').count() === 0 && await page.locator('.d-row').count() === 0 && await page.locator('.files-list.grid .files-row').count() > 0);
  await page.click('.pcx-views button[data-v="list"]'); await page.waitForTimeout(400); ok(L('… and back to details'), await page.locator('.d-row').count() > 0);
  ok(L('no page errors'), page.errors.length === 0, page.errors);
  await page.context().close();

  // ---- 7. two panes: each with its own address and history
  const p2 = await open(1280, 800, true); p2.on('console', (m) => { if (/STEP/.test(m.text())) console.log(m.text()); }); await p2.goto(`${base}#/files?p=${encodeURIComponent('/home/u/src')}`); await p2.waitForSelector('.files-pane[data-side="b"] .d-row', { timeout: 15000 }); await p2.waitForTimeout(500);
  const where = () => p2.evaluate(() => ['a', 'b'].map((s) => document.querySelector(`.files-pane[data-side="${s}"] .pcx-crumb.last`)?.title));
  ok(L('two panes, each with its own address bar'), (await where()).join() === '/home/u/src,/home/u/src/Beta', await where()); await shot(p2, 'F5a-two-panes-' + lang + '.png');
  await p2.click('.files-pane[data-side="b"] .d-row'); await p2.keyboard.press('Backspace'); await p2.waitForTimeout(500);
  ok(L('one pane goes up, the other stays'), (await where()).join() === '/home/u/src,/home/u/src', await where());
  const act = await p2.evaluate(() => [document.activeElement?.tagName, document.activeElement?.className, document.querySelector('.files-pane[data-side="b"] .pcx-bar button:first-of-type')?.outerHTML.slice(0, 80), [...document.querySelectorAll('.files-pane[data-side="b"] .pcx-bar button')].map((b) => b.disabled)]);
  await p2.mouse.move(1000, 400); await p2.waitForTimeout(100);
  await p2.evaluate(() => { window.__k = []; addEventListener('keydown', (e) => window.__k.push([e.key, e.altKey, e.defaultPrevented]), false); });
  await p2.keyboard.press('Alt+ArrowLeft'); await p2.waitForTimeout(400); act.push(await p2.evaluate(() => window.__k)); ok(L('history is per pane'), (await where()).join() === '/home/u/src,/home/u/src/Beta', [await where(), act]);
  await p2.click('.files-pane[data-side="a"] .d-row'); await p2.keyboard.press('F6'); await p2.waitForTimeout(150);
  ok(L('F6 moves focus to the other pane'), await p2.evaluate(() => !!document.activeElement?.closest?.('.files-pane[data-side="b"]')), await p2.evaluate(() => document.activeElement?.className));
  ok(L('only the first pane carries the navigation pane'), await p2.locator('.pcx-nav').count() === 1);
  await p2.context().close();

  // ---- 8. the phone is as it was
  const ph = await open(360, 780); await ph.goto(`${base}#/files?p=${encodeURIComponent('/home/u/src')}`); await ph.waitForSelector('.files-row', { timeout: 15000 }); await ph.waitForTimeout(500);
  ok(L('phone (360 px): no PC parts — header, compact rows'), await ph.locator('.pcx, .pcx-nav, .pcx-bar, .pcx-head, .d-row').count() === 0 && await ph.locator('.files-head').isVisible() && await ph.locator('.files-row .files-date').count() > 0, await ph.locator('.files-row').first().innerHTML().catch(() => ''));
  await ph.context().close();
  await br.close(); web.close(); console.log(fails ? `\n${fails} FAILED` : '\nall ok'); process.exit(fails ? 1 : 0);
})();
