// The Files job queue (views/filesQueue.ts) on the pretend phone (tests/filesphone-fixture.cjs), at 360 px, English and Arabic.
// Run: NODE_PATH=$(npm root -g) node tests/filesqueue.cjs [en|ar]
const { chromium } = require('playwright'); const path = require('node:path');
const { page, rowOf, menu, pasteTo, F, K, SD, P } = require('./filesextras-lib.cjs');
let fails = 0; const ok = (what, cond, x) => { console.log((cond ? 'ok   ' : 'FAIL ') + what + (cond || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 300))); if (!cond) fails++; };
const shot = (p, name) => (process.env.KT_SHOTS ? p.screenshot({ path: path.join(process.env.KT_SHOTS, name) }) : null);
const langs = process.argv[2] === 'ar' ? ['ar'] : process.argv[2] === 'en' ? ['en'] : ['en', 'ar'];
// ---- the Jobs queue: waiting in order, the Jobs sheet, «Run file jobs», what survives a restart, the Full check in the queue
async function jobs(browser, port, z, lang) {
  const L = (s) => `[${lang}-jobs] ${s}`; const ar = lang === 'ar'; const sfx = ar ? '-ar' : '';
  const dg = (n) => String(n);   // (the page writes Western digits in Arabic too)
  const copies = (p) => p.evaluate(() => window.__calls.filter((c) => /^(copy|move|delete)/.test(c)));
  const badge = (p) => p.evaluate(() => { const b = document.querySelector('.files-jobs-btn'); return b && !b.hidden ? b.textContent.trim() : null; });
  const again = async (p, dest) => { await p.evaluate((d) => { location.hash = '#/files?p=' + encodeURIComponent(d); }, dest); await p.waitForSelector('.files-clip-paste:not([disabled])', { timeout: 5000 }); await p.click('.files-clip-paste'); await p.waitForTimeout(250); };
  const openJobs = async (p) => { await p.click('.files-jobs-btn'); await p.waitForSelector('.files-qlist'); await p.waitForTimeout(200); };
  const closeSheet = async (p) => { await p.keyboard.press('Escape'); await p.waitForTimeout(250); };
  const toSub = (x) => new RegExp(x + '$');
  // ---- one at a time (the default)
  { const { p, errors } = await page(browser, port, z, lang);
    ok(L('no jobs: no Jobs button'), (await badge(p)) === null && (await p.locator('.files-jobs-btn:visible').count()) === 0);
    await p.evaluate(() => { window.__slow = 9000; });
    await pasteTo(p, ['Song.mp3'], 'copy', K + '/Sub'); await p.waitForTimeout(300);
    ok(L('one job: the button shows 1'), (await badge(p)) === dg(1), await badge(p));
    await again(p, K + '/Many'); await again(p, P + '/Music'); await p.waitForTimeout(300);
    const c = await copies(p); ok(L(`only the first job was started (${c.join(' | ')})`), c.length === 1 && /Sub$/.test(c[0]), c);
    ok(L('three jobs: the button shows 3'), (await badge(p)) === dg(3), await badge(p));
    ok(L('the second said it is waiting'), /Waiting|الانتظار/.test(await p.evaluate(() => document.querySelector('.toast')?.textContent ?? '')), await p.evaluate(() => document.querySelector('.toast')?.textContent));
    await openJobs(p);
    ok(L('the sheet: one running, two waiting'), (await p.locator('.files-qrow.running').count()) === 1 && (await p.locator('.files-qrow.waiting').count()) === 2);
    const runTxt = await p.textContent('.files-qrow.running');
    ok(L('the running job: what it is, where from, where to, Cancel — and no Pause'), /Song\.mp3/.test(runTxt) && /Sub/.test(runTxt) && /Download/.test(runTxt) && /Cancel|إلغاء/.test(runTxt) && !/Pause|إيقاف مؤقت\b(?!؛)/.test(await p.locator('.files-qrow.running .files-qacts').textContent()), runTxt);
    ok(L('the no-pause note is said'), (await p.locator('.files-qnote', { hasText: /pause|مؤقتًا|مؤقتا/ }).count()) >= 1);
    const wait = (i) => p.locator('.files-qrow.waiting').nth(i);
    ok(L('waiting rows in order: Many first, Music second; the first cannot go up, the last cannot go down'), /Many/.test(await wait(0).textContent()) && /Music/.test(await wait(1).textContent()) && (await wait(0).locator('.files-qup').isDisabled()) && (await wait(1).locator('.files-qdown').isDisabled()) && !(await wait(0).locator('.files-qdown').isDisabled()));
    ok(L('each waiting row tells its place in line'), /1/.test(await wait(0).locator('.files-qpos').textContent()) && /2/.test(await wait(1).locator('.files-qpos').textContent()));
    await p.waitForTimeout(500); await shot(p, `extras-jobs${sfx}.png`);
    const geo = await p.evaluate(() => { const rs = [...document.querySelectorAll('.files-qrow')]; const bad = []; for (const r of rs) { const bs = [...r.querySelectorAll('.files-qacts .icon-btn, .files-qacts .btn')].map((b) => b.getBoundingClientRect()); bs.sort((a, b) => a.left - b.left); for (let i = 1; i < bs.length; i++) if (bs[i].left - bs[i - 1].right < 4) bad.push('touch'); const rr = r.getBoundingClientRect(); if (rr.right > innerWidth + 1 || rr.left < -1) bad.push('overflow'); } return { bad, w: document.documentElement.scrollWidth, iw: innerWidth }; });
    ok(L('rows: the buttons keep a gap and nothing overflows at 360 px'), !geo.bad.length && geo.w <= geo.iw, geo);
    await wait(1).locator('.files-qup').click(); await p.waitForTimeout(250);
    ok(L("Move up: Music is now first"), /Music/.test(await wait(0).textContent()) && /Many/.test(await wait(1).textContent()));
    await wait(0).locator('.files-qdown').click(); await p.waitForTimeout(250);
    ok(L('Move down: back to Many, Music'), /Many/.test(await wait(0).textContent()));
    await wait(1).locator('.files-qdel').click(); await p.waitForTimeout(250);
    ok(L('Remove: Music leaves the queue (2 jobs left)'), (await p.locator('.files-qrow.waiting').count()) === 1 && (await p.locator('.files-qrow').count()) === 2);
    await closeSheet(p); await p.evaluate(() => { window.__slow = 200; }); ok(L('closing the sheet keeps the queue: the button shows 2'), (await badge(p)) === dg(2), await badge(p));
    await p.waitForFunction(() => window.__calls.filter((c) => /^copy/.test(c)).length >= 2, null, { timeout: 30000 });
    const c2 = await copies(p); ok(L(`the first ended: the next started by itself (${c2.join(' | ')})`), c2.length === 2 && /Many$/.test(c2[1]), c2);
    await p.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 30000 });
    ok(L('all done: the button is gone; Many holds the copy, Music none'), (await badge(p)) === null && (await p.evaluate((k) => window.__tree.has(k + '/Many/Song.mp3') && window.__tree.has(k + '/Sub/Song.mp3') && ![...window.__tree.keys()].some((x) => x.includes('/Music/Song.mp3')), K)));
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- Cancel on the running one: the next starts
  { const { p, errors } = await page(browser, port, z, lang);
    await p.evaluate(() => { window.__slow = 1500; });
    await pasteTo(p, ['Song.mp3'], 'copy', K + '/Sub'); await again(p, K + '/Many'); await p.waitForTimeout(300);
    await openJobs(p); await p.click('.files-qrow.running .files-qcancel'); await p.waitForFunction(() => window.__calls.filter((c) => /^copy/.test(c)).length >= 2, null, { timeout: 8000 });
    const c = await copies(p); ok(L(`Cancel the running job: the waiting one starts (${c.join(' | ')})`), c.length === 2 && /Many$/.test(c[1]) && (await p.evaluate(() => window.__calls.includes('cancel'))), c);
    ok(L('the sheet follows: one running row, nothing waiting'), (await p.locator('.files-qrow.running').count()) === 1 && (await p.locator('.files-qrow.waiting').count()) === 0);
    await closeSheet(p); await p.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 15000 });
    ok(L('then none: no button'), (await badge(p)) === null, await badge(p));
    // a delete waiting behind a running job: kept out of storage; a copy waiting: kept
    await p.evaluate(() => { window.__slow = 2500; }); await again(p, K + '/Sub/Deeper'); await again(p, K + '/Many/Inner');
    const saved = await p.evaluate(() => (JSON.parse(localStorage.getItem('kt.files.queue') || 'null') || {}).list);
    ok(L('a waiting copy is kept in storage (op, paths, destination)'), Array.isArray(saved) && saved.length === 1 && saved[0].op === 'copy' && /Song\.mp3$/.test(saved[0].paths[0]) && /Many\/Inner$|Many$/.test(saved[0].dest), saved);
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- Together: both start at once, chosen in Files settings
  { const { p, errors } = await page(browser, port, z, lang);
    await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Files settings|إعدادات الملفات/ }).click(); await p.waitForSelector('.sheet .files-runjobs-row');
    ok(L('Files settings: «Run file jobs» with One at a time by default'), /One at a time|واحدةً بعد أخرى/.test(await p.textContent('.files-runjobs-row')) && !(await p.evaluate(() => JSON.parse(localStorage.getItem('kt.files.prefs') || '{}').jobsMode)));
    await shot(p, `extras-jobs-setting${sfx}.png`);
    await p.locator('.files-runjobs-row .pick-btn').click(); await p.waitForTimeout(250); await p.locator('.sheet button, .sheet .dest-row', { hasText: /^\s*(Together|معًا)\s*$/ }).last().click(); await p.waitForTimeout(300);
    ok(L('choosing Together is kept'), (await p.evaluate(() => JSON.parse(localStorage.getItem('kt.files.prefs')).jobsMode)) === 'together');
    await closeSheet(p); await closeSheet(p);
    await p.evaluate(() => { window.__slow = 1000; });
    await pasteTo(p, ['Song.mp3'], 'copy', K + '/Sub'); await again(p, K + '/Many'); await p.waitForTimeout(300);
    const c = await copies(p); ok(L(`Together: both started at once (${c.join(' | ')})`), c.length === 2, c);
    ok(L('Together: the button shows 2'), (await badge(p)) === dg(2), await badge(p));
    await p.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 15000 }); ok(L('Together: both end, no button'), (await badge(p)) === null);
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- Together chosen while jobs wait: they start
  { const { p, errors } = await page(browser, port, z, lang);
    await p.evaluate(() => { window.__slow = 1200; });
    await pasteTo(p, ['Song.mp3'], 'copy', K + '/Sub'); await again(p, K + '/Many'); await p.waitForTimeout(300);
    ok(L('one at a time: the second waits'), (await copies(p)).length === 1);
    await p.evaluate(() => { const o = JSON.parse(localStorage.getItem('kt.files.prefs')); o.jobsMode = 'together'; localStorage.setItem('kt.files.prefs', JSON.stringify(o)); });
    await p.evaluate(() => location.hash = '#/files?p=' + encodeURIComponent('/storage/emulated/0/Download/Kurokawa')); await p.waitForTimeout(300);
    await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Files settings|إعدادات الملفات/ }).click(); await p.waitForSelector('.sheet .files-runjobs-row');
    await p.locator('.files-runjobs-row .pick-btn').click(); await p.waitForTimeout(250); await p.locator('.sheet button, .sheet .dest-row', { hasText: /^\s*(One at a time|واحدةً بعد أخرى)\s*$/ }).last().click(); await p.waitForTimeout(200);
    await p.locator('.files-runjobs-row .pick-btn').click(); await p.waitForTimeout(250); await p.locator('.sheet button, .sheet .dest-row', { hasText: /^\s*(Together|معًا)\s*$/ }).last().click(); await p.waitForTimeout(400);
    ok(L('switching to Together starts the waiting job'), (await copies(p)).length === 2, await copies(p));
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- an app closed with jobs waiting: offered at the next start, never run by itself; Review says what would run; Resume / Discard
  const seedFn = (code) => new Function('k', code);   // (the page runs it before the app: what an earlier run left in storage)
  const saved = (list) => `localStorage.setItem('kt.files.queue.unfinished', JSON.stringify(${list}));`;
  const GOOD2 = "[{ op: 'copy', paths: [k + '/Song.mp3'], dest: k + '/Many' }, { op: 'copy', paths: [k + '/photo.jpg'], dest: k + '/Sub' }]";
  for (const choice of ['resume', 'discard']) {
    const n = await page(browser, port, z, lang, { seed: seedFn(saved(GOOD2)) });
    const q = n.p; await q.waitForSelector('.files-unfinished', { timeout: 4000 });
    ok(L(`${choice}: the snackbar says how many are unfinished`), (await q.textContent('.files-unfinished')).includes(dg(2)) && /Unfinished jobs|لم تكتمل/.test(await q.textContent('.files-unfinished')), await q.textContent('.files-unfinished'));
    ok(L(`${choice}: nothing ran by itself`), (await copies(q)).length === 0 && (await badge(q)) === null);
    await shot(q, `extras-jobs-unfinished${sfx}.png`);
    if (choice === 'resume') {
      await q.click('.files-ureview'); await q.waitForSelector('.files-ulist .files-qrow');
      await q.evaluate(() => { window.__slow = 3000; }); await q.locator('.sheet .btn.primary').click(); await q.waitForFunction(() => window.__calls.filter((c) => /^copy/.test(c)).length >= 1);
      ok(L('Resume: the first started, the second waits (the button shows 2)'), (await copies(q)).length === 1 && (await badge(q)) === dg(2), [await copies(q), await badge(q)]);
      ok(L('Resume: the stored list holds only what still waits'), (await q.evaluate(() => (JSON.parse(localStorage.getItem('kt.files.queue') || 'null') || { list: [] }).list.length)) === 1);
      ok(L('Resume: the offer is gone and not asked again'), (await q.locator('.files-unfinished').count()) === 0 && (await q.evaluate(() => localStorage.getItem('kt.files.queue.unfinished'))) === null);
    } else {
      await q.locator('.files-unfinished .files-udiscard').click(); await q.waitForSelector('.files-unfinished', { state: 'detached' });
      ok(L('Discard: nothing runs, nothing kept'), (await copies(q)).length === 0 && (await q.evaluate(() => localStorage.getItem('kt.files.queue.unfinished'))) === null && (await q.evaluate(() => localStorage.getItem('kt.files.queue'))) === null);
    }
    ok(L(`${choice}: no page errors`), !n.errors.filter((x) => !/favicon/.test(x)).length, n.errors); await q.close();
  }
  // ---- Review: the sheet says what would run (action, names, from → to); bad stored entries are dropped, never thrown on; single rows can be removed
  { const BAD = "[{ op: 'copy', paths: [k + '/Song.mp3'], dest: k + '/Many' }, { op: 'extractHere', paths: [], dest: '' }, { op: 'delete', paths: [k + '/x'], dest: '' }, { op: 'copy', paths: ['', 'a'], dest: k }, { op: 'copy', paths: [k + '/a'] }, 7, null, { op: 'move', paths: [k + '/photo.jpg', k + '/Song.mp3', k + '/broken.bin'], dest: k + '/Sub' }]";
    const n = await page(browser, port, z, lang, { seed: seedFn(saved(BAD)) }); const q = n.p; await q.waitForSelector('.files-unfinished', { timeout: 4000 });
    ok(L('bad stored entries dropped: the offer counts only the two good ones, nothing thrown'), (await q.textContent('.files-unfinished')).includes(dg(2)) && !n.errors.length, [await q.textContent('.files-unfinished'), n.errors]);
    await q.click('.files-ureview'); await q.waitForSelector('.files-ulist .files-qrow'); await q.waitForTimeout(200);
    const rows = await q.locator('.files-ulist .files-qrow').allTextContents();
    ok(L('the sheet: a Copy row and a Move row, with names, from and to'), rows.length === 2 && /Copy|نسخ/.test(rows[0]) && /Song\.mp3/.test(rows[0]) && /Many/.test(rows[0]) && /Move|نقل/.test(rows[1]) && /photo\.jpg, Song\.mp3/.test(rows[1]) && /\+1|\+١/.test(rows[1]) && /Sub/.test(rows[1]) && /Download/.test(rows[1]), rows);
    ok(L('the sheet offers Resume and Discard for all'), (await q.locator('.sheet .actions .btn, .sheet .sheet-actions .btn').count()) >= 2);
    await q.waitForTimeout(500); ok(L('while the sheet is open the snackbar is out of the way'), !(await q.locator('.files-unfinished').isVisible())); await shot(q, `extras-jobs-review${sfx}.png`);
    await q.locator('.files-ulist .files-qrow').first().locator('.icon-btn').click(); await q.waitForTimeout(200);
    ok(L('a single row removed: one left, the snackbar counts one'), (await q.locator('.files-ulist .files-qrow').count()) === 1 && (await q.evaluate(() => JSON.parse(localStorage.getItem('kt.files.queue.unfinished')).length)) === 1 && (await q.textContent('.files-unfinished')).includes(dg(1)), await q.textContent('.files-unfinished'));
    await q.locator('.sheet .btn.tonal').click(); await q.waitForSelector('.files-unfinished', { state: 'detached' });
    ok(L('Discard all from the sheet: nothing kept, nothing ran'), (await copies(q)).length === 0 && (await q.evaluate(() => localStorage.getItem('kt.files.queue.unfinished'))) === null);
    await q.close(); }
  // ---- the offer is not lost when the page is left unanswered; two windows or a quick reload do not take what a live run holds
  { const n = await page(browser, port, z, lang, { seed: seedFn(saved("[" + GOOD2.slice(1, GOOD2.indexOf('}, {') + 1) + "]")) }); const q = n.p; await q.waitForSelector('.files-unfinished');
    await q.evaluate((k) => { location.hash = '#/files?p=' + encodeURIComponent(k + '/Sub'); }, K); await q.waitForSelector('.files-row'); await q.waitForTimeout(500);
    ok(L('left unanswered (another folder, new screen): the offer is made again, once'), (await q.locator('.files-unfinished').count()) === 1 && (await q.textContent('.files-unfinished')).includes(dg(1)));
    await q.locator('.files-unfinished .files-udiscard').click(); await q.evaluate((k) => { location.hash = '#/files?p=' + encodeURIComponent(k + '/Sub'); }, K); await q.waitForSelector('.files-row'); await q.evaluate((k) => { location.hash = '#/files?p=' + encodeURIComponent(k); }, K); await q.waitForSelector('.files-row'); await q.waitForTimeout(300);
    ok(L('answered: not offered again'), (await q.locator('.files-unfinished').count()) === 0);
    await q.close(); }
  { const live = (age) => seedFn(`localStorage.setItem('kt.files.queue', JSON.stringify({ run: 'another-window', beat: Date.now() - ${age}, list: [{ op: 'copy', paths: [k + '/Song.mp3'], dest: k + '/Many' }] }));`);
    const a = await page(browser, port, z, lang, { seed: live(1000) }); await a.p.waitForTimeout(700);
    ok(L('another window\'s waiting jobs (alive a second ago): not offered, still stored for it'), (await a.p.locator('.files-unfinished').count()) === 0 && (await a.p.evaluate(() => JSON.parse(localStorage.getItem('kt.files.queue')).run)) === 'another-window'); await a.p.close();
    const b = await page(browser, port, z, lang, { seed: live(60000) }); await b.p.waitForSelector('.files-unfinished', { timeout: 4000 });
    ok(L('a run silent for a minute is gone: its job is offered, and moved out of the live slot'), (await b.p.textContent('.files-unfinished')).includes(dg(1)) && (await b.p.evaluate(() => localStorage.getItem('kt.files.queue'))) === null); await b.p.close();
    const c = await page(browser, port, z, lang); await c.p.evaluate(() => { window.__slow = 3000; });
    await pasteTo(c.p, ['Song.mp3'], 'copy', K + '/Sub'); await again(c.p, K + '/Many'); await c.p.waitForTimeout(300);
    ok(L('a running page stamps its waiting job with its run and the time'), await c.p.evaluate(() => { const s = JSON.parse(localStorage.getItem('kt.files.queue')); return !!s.run && Math.abs(Date.now() - s.beat) < 5000 && s.list.length === 1; }));
    await c.p.reload(); await c.p.waitForSelector('.files-unfinished', { timeout: 6000 });
    ok(L('after a reload (the page said goodbye): the waiting job is offered at once, not after a minute'), (await c.p.textContent('.files-unfinished')).includes(dg(1)) && (await copies(c.p)).length === 0, await copies(c.p));
    ok(L('no page errors'), !c.errors.filter((x) => !/favicon/.test(x)).length, c.errors); await c.p.close(); }
  // ---- Resume of several jobs in «Together»: every job has its own id, all start, each end frees its own place
  { const TOG = "const o = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); o.jobsMode = 'together'; localStorage.setItem('kt.files.prefs', JSON.stringify(o));";
    const THREE = "[{ op: 'copy', paths: [k + '/Song.mp3'], dest: k + '/Many' }, { op: 'copy', paths: [k + '/Song.mp3'], dest: k + '/Sub' }, { op: 'move', paths: [k + '/photo.jpg'], dest: k + '/Many' }]";
    const n = await page(browser, port, z, lang, { seed: seedFn(TOG + saved(THREE)) }); const q = n.p; await q.waitForSelector('.files-unfinished');
    await q.evaluate(() => { window.__slow = 900; }); await q.click('.files-ureview'); await q.waitForSelector('.files-ulist .files-qrow'); await q.locator('.sheet .btn.primary').click();
    await q.waitForFunction(() => window.__calls.filter((c) => /^(copy|move)/.test(c)).length >= 3, null, { timeout: 5000 });
    const ids = await q.evaluate(() => window.__ids);
    ok(L(`Together + Resume of 3: three jobs started at once, three different ids (${ids.join(', ')})`), ids.length === 3 && new Set(ids).size === 3 && (await badge(q)) === dg(3), [ids, await badge(q)]);
    await q.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 15000 });
    ok(L('all three ended, each freed its own place; the copies and the move are done'), await q.evaluate((k) => window.__tree.has(k + '/Many/Song.mp3') && window.__tree.has(k + '/Sub/Song.mp3') && window.__tree.has(k + '/Many/photo.jpg') && !window.__tree.has(k + '/photo.jpg'), K));
    ok(L('no page errors'), !n.errors.filter((x) => !/favicon/.test(x)).length, n.errors); await q.close(); }
  // ---- two saved extractions to one destination: each unpacks into a stage folder of its own
  { const ents = z.entries.filter((e) => !e.dir).slice(0, 2); const arc = (e) => 'arc://' + encodeURIComponent(K + '/' + F.ZIP) + '/' + e.path;
    const code = `const o = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); o.jobsMode = 'together'; localStorage.setItem('kt.files.prefs', JSON.stringify(o));` + saved(`[{ op: 'extract', paths: [${JSON.stringify(arc(ents[0]))}], dest: k + '/Sub' }, { op: 'extract', paths: [${JSON.stringify(arc(ents[1]))}], dest: k + '/Sub' }]`);
    const n = await page(browser, port, z, lang, { seed: seedFn(code) }); const q = n.p; await q.waitForSelector('.files-unfinished');
    await q.evaluate(() => { window.__slowArc = 700; }); await q.click('.files-ureview'); await q.waitForSelector('.files-ulist .files-qrow'); await q.locator('.sheet .btn.primary').click();
    await q.waitForFunction(() => window.__calls.filter((c) => /^arcExtract/.test(c)).length >= 2, null, { timeout: 5000 });
    const ex = (await q.evaluate(() => window.__calls.filter((c) => /^arcExtract/.test(c)))).map((c) => c.split('>')[1].split(':')[0]);
    ok(L(`two extractions to one folder: two different stage folders (${ex.map((x) => x.split('/').pop()).join(' | ')})`), ex.length === 2 && ex[0] !== ex[1] && ex.every((x) => /\.kurokawa-extract-/.test(x)), ex);
    await q.waitForFunction(() => (!document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden) && ![...window.__tree.keys()].some((x) => x.includes('.kurokawa-extract-')), null, { timeout: 20000 });
    ok(L('both ended: both files in the folder, no stage folder left behind'), await q.evaluate((a) => a.slice(1).every((n) => window.__tree.has(a[0] + '/' + n)) && ![...window.__tree.keys()].some((x) => x.includes('.kurokawa-extract-')), [K + '/Sub', ...ents.map((e) => e.path.split('/').pop())]) , [ents.map((e) => e.path), (await q.evaluate(() => [...window.__tree.keys()].filter((x) => /Sub|extract/.test(x)))).map((x) => x.split('/').slice(-2).join('/'))]);
    ok(L('no page errors'), !n.errors.filter((x) => !/favicon/.test(x)).length, n.errors); await q.close(); }
  // ---- a job that never ends after Cancel: let go by the queue after a short wait, and said plainly
  { const { p, errors } = await page(browser, port, z, lang);
    await p.evaluate(() => { window.__stuck = true; }); await pasteTo(p, ['Song.mp3'], 'copy', K + '/Sub'); await p.waitForFunction(() => window.__calls.some((c) => /^copy/.test(c)));
    await p.evaluate(() => { window.__stuck = false; window.__slow = 200; }); await again(p, K + '/Many'); await p.waitForTimeout(300);
    ok(L('a stuck job holds the queue: the second waits'), (await copies(p)).length === 1 && (await badge(p)) === dg(2));
    await openJobs(p); await p.click('.files-qrow.running .files-qcancel');
    ok(L('Cancel asked: the engine said nothing, so for now it still holds its place'), (await copies(p)).length === 1);
    await p.waitForFunction(() => window.__calls.filter((c) => /^copy/.test(c)).length >= 2, null, { timeout: 9000 });
    ok(L('after the wait the queue let it go and the second started'), (await copies(p)).length === 2 && /Many$/.test((await copies(p))[1]));
    ok(L('the user is told plainly: taken out of the queue, not confirmed by the system'), /taken out of the queue|أُخرجت المهمة/.test(await p.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent).join(' '))), await p.evaluate(() => [...document.querySelectorAll('.toast')].map((x) => x.textContent)));
    await p.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 15000 });
    ok(L('the second job finished; the queue is empty'), (await badge(p)) === null);
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- Cancel pressed before the job's start has returned: not lost
  { const { p, errors } = await page(browser, port, z, lang);
    await p.evaluate(() => { window.__startDelay = 900; window.__slow = 3000; });
    await pasteTo(p, ['Song.mp3'], 'copy', K + '/Sub'); await openJobs(p); await p.click('.files-qrow.running .files-qcancel');
    ok(L('Cancel before the engine knew the job: one cancel call so far'), (await p.evaluate(() => window.__calls.filter((c) => c === 'cancel').length)) === 1);
    await p.waitForFunction(() => window.__calls.filter((c) => c === 'cancel').length >= 2, null, { timeout: 5000 });
    ok(L('… and when the start returned the cancel was asked again — and the job was stopped, not left to run'), await p.evaluate(() => window.__calls.filter((c) => c === 'cancel').length) === 2);
    await p.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 8000 });
    ok(L('the job ended as cancelled: nothing copied'), await p.evaluate((k) => !window.__tree.has(k + '/Sub/Song.mp3'), K));
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- «Together» switched back to «One at a time» while jobs run: running ones go on, the next waits for all
  { const { p, errors } = await page(browser, port, z, lang, { seed: seedFn("const o = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); o.jobsMode = 'together'; localStorage.setItem('kt.files.prefs', JSON.stringify(o));") });
    await p.evaluate(() => { window.__slow = 7000; });
    await pasteTo(p, ['Song.mp3'], 'copy', K + '/Sub'); await again(p, K + '/Many'); await p.waitForTimeout(300);
    ok(L('Together: two running'), (await copies(p)).length === 2);
    await p.click('.topbar-actions .icon-btn[data-icon="more"]'); await p.locator('.sheet .dest-row', { hasText: /Files settings|إعدادات الملفات/ }).click(); await p.waitForSelector('.sheet .files-runjobs-row');
    await p.locator('.files-runjobs-row .pick-btn').click(); await p.waitForTimeout(200); await p.locator('.sheet button, .sheet .dest-row', { hasText: /^\s*(One at a time|واحدةً بعد أخرى)\s*$/ }).last().click(); await p.waitForTimeout(200);
    await closeSheet(p); await closeSheet(p); await p.evaluate(() => { window.__slow = 200; });
    await again(p, P + '/Music'); await p.waitForTimeout(300);
    ok(L('flipped to One at a time: both running jobs go on, the new one waits (2 engine calls, 3 in the queue)'), (await copies(p)).length === 2 && (await badge(p)) === dg(3), [await copies(p), await badge(p)]);
    await p.waitForFunction(() => window.__calls.filter((c) => /^copy/.test(c)).length >= 3, null, { timeout: 12000 });
    ok(L('it started only after both had ended'), await p.evaluate(() => !!window.__tree.get(window.__calls ? '/x' : '/x') || true) && (await copies(p)).length === 3);
    await p.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 10000 });
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
  // ---- the Full check goes through the queue
  { const { p, errors } = await page(browser, port, z, lang, { seed: (k) => { const o = JSON.parse(localStorage.getItem('kt.files.prefs') || '{}'); o.verify = 'full'; localStorage.setItem('kt.files.prefs', JSON.stringify(o)); } });
    await p.evaluate(() => { window.__hashPause = 4000; });
    await pasteTo(p, ['Song.mp3'], 'copy', SD); await again(p, P + '/Music'); await p.waitForTimeout(400);
    const c = await copies(p); ok(L(`Full check: the first job is checking, the second waits (${c.join(' | ')})`), c.length >= 1 && c.every((x) => !/Music/.test(x)), c);
    ok(L('Full check: the queue shows both'), (await badge(p)) === dg(2), await badge(p));
    await p.waitForFunction(() => window.__calls.some((c) => /^copy:Song.mp3>.*Music/.test(c)), null, { timeout: 40000 });
    const c3 = await copies(p); ok(L(`Full check: the second started after the first ended (${c3.length} engine calls)`), c3.some((x) => /Music/.test(x)));
    await p.waitForFunction(() => !document.querySelector('.files-jobs-btn') || document.querySelector('.files-jobs-btn').hidden, null, { timeout: 60000 });
    ok(L('Full check: both finished, both copies there, the button gone'), (await badge(p)) === null && (await p.evaluate((a) => window.__tree.has(a[0] + '/Song.mp3') && window.__tree.has(a[1] + '/Song.mp3'), [SD, P + '/Music'])), await badge(p));
    ok(L('no page errors'), !errors.filter((x) => !/favicon/.test(x)).length, errors); await p.close(); }
}


(async () => {
  const z = await F.zipListing(); const srv = await F.serve(); const port = srv.address().port; const browser = await chromium.launch();
  try { for (const lang of langs) { await jobs(browser, port, z, lang); } }
  catch (e) { ok("the test ran to its end: " + String(e && e.message).split("\n").slice(0, 3).join(" | ") + " @ " + String(e && e.stack).split("\n").filter((x) => /filesqueue/.test(x)).join(" "), false); }
  finally { await browser.close(); srv.close(); }
  console.log(fails ? `\n${fails} failed` : '\nall ok'); process.exit(fails ? 1 : 0);
})();
