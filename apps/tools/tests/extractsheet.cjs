// The extraction sheet's safety parts in a browser (Tools 0.21 P5), the desktop bridge faked with reports the real
// rules make (desktop/archsafe.cjs): the pre-flight report (all clear; problems grouped with counts, first names and
// what to do), the fit bar for both ways with the one recommended, in place switched off with its reason, the
// conflict sheet with «for the rest», Undo after a job, and Files' «Unfinished extractions» card — in English and
// Arabic at 360 px and on a computer's width. Screenshots go to KT_SHOTS (default: the test folder).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const S = require('../desktop/archsafe.cjs');
const DIST = path.join(__dirname, '..', 'dist'); const SHOTS = process.env.KT_SHOTS || __dirname;
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 300))); if (!c) fails++; };
const GB = 1024 ** 3;
const shot = async (p, o) => { await p.waitForTimeout(700); await p.screenshot(o); };   // (after the sheet's opening motion)
const word = (lang, key) => new RegExp(`${key}: (['"])(.*?)\\1`).exec(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', `${lang}.ts`), 'utf8'))[2];
const OPEN = { en: word('en', 'openArchive'), ar: word('ar', 'openArchive') };
const base = { format: 'zip', platform: 'windows', supported: [0, 8], password: 'none', archiveWritable: true, destWritable: true, sameVolume: true, inPlaceFormat: true, blockSize: 4096 };
const ents = (n, size) => Array.from({ length: n }, (_, i) => ({ path: `Season 1/Episode ${i + 1}.mkv`, usize: size, csize: size * 0.98, method: 8, offset: i * size }));
const REPORTS = {
  ok: S.preflight({ ...base, entries: ents(6, 0.4 * GB), free: 40 * GB }, { margin: 2 * GB }),
  stale: S.preflight({ ...base, entries: ents(6, 0.4 * GB), free: 40 * GB, oldJob: true, staleJob: { journal: '/home/u/Downloads/Show.zip.kurokawa-unzip', why: 'archiveChanged' } }, { margin: 2 * GB }),
  problems: S.preflight({ ...base, entries: [...ents(3, 0.2 * GB), { path: 'notes/meeting 10:30.txt', usize: 900, csize: 400, method: 8 }, { path: 'CON.txt', usize: 10, csize: 10, method: 0 }, { path: 'C:/Windows/evil.dll', usize: 10, csize: 10, method: 0 }, { path: 'extras/bonus.zst', usize: 5 * GB, csize: 4 * 1024 ** 2, method: 93 }], existing: ['Season 1/Episode 1.mkv', 'Season 1/Episode 2.mkv'], free: 400 * GB }, { margin: 2 * GB }),
  fit: S.preflight({ ...base, entries: ents(8, 1.5 * GB), free: 9 * GB }, { margin: 2 * GB }),
  conflicts: S.preflight({ ...base, entries: ents(4, 0.1 * GB), existing: ['Season 1/Episode 1.mkv', 'Season 1/Episode 2.mkv', 'Season 1/Episode 3.mkv'], free: 40 * GB }, { margin: 2 * GB }),
};
ok('the reports made by the real rules', REPORTS.ok.recommend === 'normal' && REPORTS.fit.recommend === 'inPlace' && !REPORTS.problems.normal.ok && REPORTS.problems.problems.some((p) => p.kind === 'rewrite'), [REPORTS.ok.recommend, REPORTS.fit.recommend]);
const PREVIEW = process.env.KT_PREVIEW_DIR || require('node:os').tmpdir();
const SHELF = [{ journal: '/home/u/Downloads/Show.zip.kurokawa-unzip', id: 'a1', archive: '/home/u/Downloads/Show.zip', dest: '/home/u/Downloads/Show', mode: 'inplace', state: 'paused', why: 'noSpace', done: 12, total: 40, can: ['finish', 'restore', 'leave'] }, { journal: '/home/u/Downloads/old.zip.kurokawa-unzip', id: 'b2', archive: '/home/u/Downloads/old.zip', dest: '', mode: 'inplace', state: 'blocked', why: 'archiveChanged', done: 0, total: 0, can: ['forget', 'leave'] }];

(async () => {
  const web = serve().listen(0); const url = `http://127.0.0.1:${web.address().port}/`; const br = await chromium.launch();
  const page = async (lang, kind, which, extra = {}) => {
    const ctx = await br.newContext(kind === 'phone' ? { viewport: { width: 360, height: 780 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true } : { viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1 });
    await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.setDefaultTimeout(8000); const errs = []; p.on('pageerror', (e) => errs.push(e.message)); p.errs = errs;
    const report = REPORTS[which]; const entries = (which === 'problems' ? [...report.problems] : []).length >= 0 ? null : null; void entries;
    await p.addInitScript(([l, rep, shelf, ex, stale]) => {
      localStorage.setItem('kr.lang', l); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.settings', JSON.stringify({ addons: ['files', 'archives'] }));
      const calls = []; window.__calls = calls; window.__stale = stale;
      const t = { platform: 'desktop', available: true, os: 'linux', list: async () => [], onTasks: () => () => {}, homeDir: async () => '/home/u', listDir: async () => ({ entries: [{ name: 'Show.zip', path: '/home/u/Downloads/Show.zip', dir: false, size: 3e9, mtime: 0 }], exists: true }), openPath: async () => undefined, pickDir: async () => '/mnt/other',
        archiveList: async () => ({ format: 'zip', entries: [{ path: 'Season 1/', size: 0, dir: true }, ...Array.from({ length: 6 }, (_, i) => ({ path: `Season 1/Episode ${i + 1}.mkv`, size: 4e8, compressed: 3.9e8, dir: false }))], total: 2.4e9, encrypted: false, inPlaceOk: true, platform: 'windows' }),
        pickFile: async () => ['/home/u/Downloads/Show.zip'], pathInfo: async () => ({ exists: true }), archiveTest: async () => ({ ok: true, files: 6, bad: [] }),
        archivePreflight: async () => ({ report: rep, facts: window.__stale ? { staleJob: { journal: '/home/u/Downloads/Show.zip.kurokawa-unzip', why: 'archiveChanged' } } : {} }), archiveFree: async () => ({ free: rep.space.free }), archiveExisting: async () => ({ existing: ex }),
        archiveExtract: async (o) => { calls.push(o); if (window.__askOnce) { window.__askOnce = false; throw new Error('askBeside /home/u/Elsewhere/out'); } return { files: 6, dest: o.dest, job: '/x/job.kurokawa-unzip' }; }, archiveJob: async (o) => { calls.push(o); return { identical: true }; }, archiveShelf: async () => shelf, onArchiveProgress: () => () => {}, archiveCancel: async () => {} };
      window.kurokawaTools = new Proxy(t, { get: (o, k) => (k in o ? o[k] : k === 'then' || ['filesJob', 'onFilesJob', 'titleBar', 'filesRoots', 'filesStat', 'filesMkdir', 'filesRename'].includes(k) ? undefined : async () => undefined) });
    }, [lang, report, extra.shelf ?? [], extra.existing ?? (which === 'conflicts' || which === 'problems' ? ['Season 1/Episode 1.mkv', 'Season 1/Episode 2.mkv', 'Season 1/Episode 3.mkv'].slice(0, which === 'problems' ? 2 : 3) : []), which === 'stale']);
    return { p, ctx };
  };
  const openSheet = async (p) => { await p.goto(url + '#/'); await p.waitForSelector('.fab'); await p.evaluate(() => import(document.querySelector('script[type=module]')?.src ?? '/assets/app.js')); await p.evaluate(async () => { const mods = [...document.querySelectorAll('link[rel=modulepreload]')]; void mods; }); };
  void openSheet;
  // (The sheet opened the way Files opens an archive: the extract module's own entry, reached through the app's router hook.)
  const sheet = async (p) => { await p.goto(url + '#/files?p=/home/u/Downloads'); await p.waitForSelector('.files-view'); await p.evaluate(() => { window.location.hash = '#/files?p=/home/u/Downloads'; }); await p.click('.kt-file:has-text("Show.zip")', { timeout: 6000 }).catch(() => {}); };
  void sheet;
  const viaImport = async (p) => { await p.goto(url + '#/files?p=/home/u/Downloads'); await p.waitForSelector('.files-view'); const src = await p.evaluate(() => [...document.scripts].map((s) => s.src).find((s) => /app[-.\w]*\.js/.test(s))); void src; };
  void viaImport;
  for (const lang of ['en', 'ar']) for (const kind of ['phone', 'pc']) {
    for (const which of ['ok', 'problems', 'fit', 'conflicts', 'stale']) {
      if (kind === 'pc' && which !== 'problems') continue;
      const { p, ctx } = await page(lang, kind, which);
      // (Opened as the user does: + → Open an archive → the archive's contents → Extract.)
      if (kind === 'pc') await p.setViewportSize({ width: 412, height: 860 });   // (the + button is the phone's; the sheet then shown at the computer's width)
      await p.goto(url + '#/'); await p.waitForSelector('.fab'); await p.click('.fab'); await p.click('.fab-item >> nth=0'); await p.waitForSelector('.sheet');
      await p.locator('.sheet button', { hasText: OPEN[lang] }).first().click(); await p.waitForSelector('.archive-browse .sheet-actions .btn.tonal'); await p.click('.archive-browse .sheet-actions .btn.tonal');
      const got = await p.waitForSelector('.extract-sheet .pf-report', { timeout: 8000 }).then(() => true).catch(() => false);
      if (kind === 'pc') { await p.setViewportSize({ width: 1366, height: 860 }); await p.waitForTimeout(300); }
      ok(`${lang} ${kind} ${which}: the sheet shows the pre-flight report`, got, p.errs);
      if (!got) { await ctx.close(); continue; }
      await p.waitForSelector('.extract-sheet .fit');
      const txt = await p.$eval('.extract-sheet', (e) => e.innerText);
      ok(`${lang} ${kind} ${which}: no key shown instead of words`, !/\b(pf_|fix[A-Z]|fitWhy_|shelfWhy_|cf[A-Z]\w+\b)/.test(txt), txt.slice(0, 200));
      const overflow = await p.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1 || [...document.querySelectorAll('.extract-sheet *')].some((e) => e.getBoundingClientRect().right > window.innerWidth + 1 && getComputedStyle(e).position !== 'fixed'));
      ok(`${lang} ${kind} ${which}: nothing runs off the screen`, !overflow);
      if (which === 'ok') { ok(`${lang} ok: «ready», normal recommended`, (await p.$('.pf-head.good')) && (await p.$$('.fit-row')).length === 2 && (await p.$('.fit-row:first-child .fit-rec'))); if (lang === 'en' && kind === 'phone') await shot(p, { path: path.join(SHOTS, 'extract-preflight-ok.png') }); }
      // (Round four: an unfinished job beside the archive that this app did not start — the sheet says where its files go; Finish / Restore / Leave;
      //  Finish sends the job again with the user's confirmation.)
      if (which === 'ok' && kind === 'phone') {
        await p.evaluate(() => { window.__askOnce = true; }); await p.click('.extract-sheet .sheet-actions .btn.primary');
        await p.waitForSelector('.extract-sheet .pf-report .src'); const at = await p.$eval('.extract-sheet .pf-report', (e) => e.innerText); const btns = await p.$$eval('.extract-sheet .sheet-actions .btn', (b) => b.length);
        ok(`${lang} beside: asked first, the destination shown, three choices`, at.includes('/home/u/Elsewhere/out') && at.length > 40 && btns === 3 && !/\bbesideAsk\b|shelf[A-Z]/.test(at), at);
        await p.click('.extract-sheet .sheet-actions .btn.primary'); await p.waitForFunction(() => window.__calls.some((c) => c.finishBeside === true));
        ok(`${lang} beside: Finish sends the job with the confirmation`, (await p.evaluate(() => window.__calls.filter((c) => c.path).length)) === 2);
      }
      if (which === 'problems') {
        const groups = await p.$$eval('.pf-group', (g) => g.map((x) => x.className.split(' ')[1] + ':' + x.querySelector('.pf-title b').textContent));
        ok(`${lang} ${kind} problems: grouped by kind, blocking first in colour`, groups.length >= 3 && groups[0].startsWith("block") && groups.some((g) => g.startsWith('block')), groups);
        ok(`${lang} ${kind} problems: the rewrite shown from → to`, (await p.$$eval('.pf-name', (e) => e.map((x) => x.textContent))).some((x) => x.includes('meeting 10:30.txt→') || x.includes('→meeting 10_30.txt') || /10:30\.txt.*10_30\.txt/.test(x)));
        ok(`${lang} ${kind} problems: Extract held back while something blocks`, await p.$eval('.extract-sheet .sheet-actions .btn.primary', (b) => b.disabled));
        ok(`${lang} ${kind} problems: in place off with its reason`, await p.$eval('.inplace-why', (e) => e.textContent.length > 5));
        if (lang === 'ar') ok('ar counts read «العدد: …»', (await p.$$eval('.pf-count', (e) => e.map((x) => x.textContent))).some((x) => x.startsWith('العدد:')));
        await shot(p, { path: path.join(SHOTS, kind === 'pc' ? (lang === 'en' ? 'extract-sheet-pc.png' : 'extract-sheet-pc-ar.png') : (lang === 'en' ? 'extract-preflight-problems.png' : 'extract-preflight-problems-ar.png')), fullPage: false });
        if (kind === 'phone') { await p.$eval('.extract-sheet .sheet-body', (b) => { b.scrollTop = b.scrollHeight; }); await shot(p, { path: path.join(SHOTS, lang === 'en' ? 'extract-preflight-problems-end.png' : 'extract-preflight-problems-end-ar.png') }); }
      }
      if (which === 'fit') {
        ok(`${lang} fit: in place recommended and switched on`, (await p.$('.fit-row:nth-child(2) .fit-rec')) && await p.$eval('.extract-sheet .switch-row input', (i) => i.checked));
        ok(`${lang} fit: the normal bar says it does not fit`, await p.$eval('.fit-row:first-child', (e) => e.classList.contains('short')));
        ok(`${lang} fit: «verify first» shown and on`, await p.$$eval('.extract-sheet .switch-row', (r) => r.length >= 2 && !r[1].hidden && r[1].querySelector('input').checked));
        if (kind === 'phone') await shot(p, { path: path.join(SHOTS, lang === 'en' ? 'extract-fit-bar.png' : 'extract-fit-bar-ar.png') });
        await (await p.$$('.extract-sheet .switch-row input'))[1].click();
        ok(`${lang} fit: turning «verify first» off shows a plain warning`, await p.$eval('.pf-warn', (e) => !e.hidden));
        if (kind === 'phone') { await p.$eval('.pf-warn', (e) => e.scrollIntoView({ block: 'center' })); await shot(p, { path: path.join(SHOTS, lang === 'en' ? 'extract-verify-off.png' : 'extract-verify-off-ar.png') }); }
      }
      if (which === 'stale') {
        // (Round six: a stopped job beside the archive that cannot be used for it — said on the sheet with its reason, Forget offered there, the
        //  confirmation stacked above the sheet.)
        const st = await p.waitForSelector('.extract-sheet .pf-stale', { timeout: 6000 }).then(() => true).catch(() => false); const txt = st ? await p.$eval('.extract-sheet .pf-stale', (e) => e.innerText) : '';
        ok(`${lang} ${kind} stale: the job beside said unusable, with its reason`, st && txt.length > 30 && !/shelfWhy_|besideStale/.test(txt), txt);
        if (st) { await p.click('.extract-sheet .pf-stale .btn'); await p.waitForSelector('.forget-sheet'); if (lang === 'ar') await shot(p, { path: path.join(PREVIEW, 'forget-from-sheet-ar.png') });
          await p.click('.forget-sheet .sheet-actions .btn.danger'); await p.waitForFunction(() => window.__calls.some((c) => c.act === 'forget' && /Show\.zip\.kurokawa-unzip$/.test(c.journal)));
          ok(`${lang} ${kind} stale: Forget from the sheet sends it, the sheet stays`, !!(await p.$('.extract-sheet'))); }
      }
      if (which === 'conflicts') {
        await p.click('.extract-sheet .sheet-actions .btn.primary'); await p.waitForSelector('.cf-sheet');
        const t1 = await p.$eval('.cf-sheet', (e) => e.innerText); ok(`${lang} conflict: asked for the first, «1 of 3»`, /Episode 1\.mkv/.test(t1));
        if (kind === 'phone') await shot(p, { path: path.join(SHOTS, lang === 'en' ? 'extract-conflict.png' : 'extract-conflict-ar.png') });
        const last = await p.evaluate(() => { const s = [...document.querySelectorAll('.sheet')].pop(); const a = s.querySelector('.sheet-actions').getBoundingClientRect(); const rows = [...s.querySelectorAll('.switch-row')]; const r = rows[rows.length - 1].getBoundingClientRect(); return r.bottom <= a.top + 1; });
        ok(`${lang} conflict: the sticky footer never covers the last row`, last);
        await p.click('.cf-sheet + * .btn.primary, .sheet:last-of-type .sheet-actions .btn.primary').catch(() => {});
        const rows = await p.$$('.sheet .cf-sheet .switch-row input'); if (rows.length) { await rows[1].click(); }
        await p.locator('.sheet').last().locator('.sheet-actions .btn.tonal').nth(1).click();   // «Keep both» for the rest of the files
        await p.waitForFunction(() => window.__calls.length > 0);
        const call = await p.evaluate(() => window.__calls[0]); ok(`${lang} conflict: the answers go with the job (one replace, the rest of the files «both»)`, call.answers && call.answers.per['Season 1/Episode 1.mkv'] === 'replace' && call.answers.files === 'both', call.answers);
        await p.waitForSelector('.undo-hint'); ok(`${lang} done: Undo offered`, await p.$eval('.extract-sheet .sheet-actions', (a) => a.children.length >= 2));
        if (kind === 'phone') await shot(p, { path: path.join(SHOTS, lang === 'en' ? 'extract-undo.png' : 'extract-undo-ar.png') });
        await p.locator('.extract-sheet .sheet-actions .btn.tonal').first().click(); await p.waitForFunction(() => window.__calls.some((c) => c.act === 'undo'));
        ok(`${lang} Undo: the job is undone`, true);
      }
      ok(`${lang} ${kind} ${which}: no page errors`, p.errs.length === 0, p.errs);
      await ctx.close();
    }
    // Files: the shelf card
    const { p, ctx } = await page(lang, kind, 'ok', { shelf: SHELF });
    await p.goto(url + '#/files?p=/home/u/Downloads'); const got = await p.waitForSelector('.files-shelf .shelf-card', { timeout: 8000 }).then(() => true).catch(() => false);
    ok(`${lang} ${kind}: Files shows «Unfinished extractions»`, got, p.errs);
    if (got) {
      const jobs = await p.$$eval('.shelf-job', (j) => j.map((x) => x.querySelectorAll('.shelf-actions .btn').length)); ok(`${lang} ${kind}: Finish / Restore / Leave for one, Forget / Leave for the blocked one`, jobs.join() === '3,2', jobs);
      // (Round five: «Forget this job» asks first — what stays and what is lost said plainly —, the two choices the same width, then sends it.)
      await p.locator('.shelf-job.blocked .btn.tonal').first().click(); await p.waitForSelector('.forget-sheet');
      const fs_ = await p.$eval('.forget-sheet', (e) => { const b = [...e.querySelectorAll('.sheet-actions .btn')].map((x) => x.getBoundingClientRect()); const ps = [...e.querySelectorAll('.sheet-body p')].map((x) => x.getBoundingClientRect()); return { text: e.innerText, n: b.length, same: b.length === 2 && Math.abs(b[0].width - b[1].width) < 2, gap: ps.length >= 2 && ps[1].top - ps[0].bottom >= 8 }; });
      ok(`${lang} ${kind}: Forget asks first (equal buttons, spaced words, no key shown)`, fs_.n === 2 && fs_.same && fs_.gap && fs_.text.length > 60 && !/shelfForget|\bshelf[A-Z]/.test(fs_.text), fs_);
      if (kind === 'phone') await shot(p, { path: path.join(PREVIEW, lang === 'en' ? 'forget-sheet.png' : 'forget-sheet-ar.png') });
      await p.locator('.forget-sheet .sheet-actions .btn.danger').click(); await p.waitForFunction(() => window.__calls.some((c) => c.act === 'forget')); ok(`${lang} ${kind}: Forget sent`, true);
      if (kind === 'phone') await shot(p, { path: path.join(SHOTS, lang === 'en' ? 'extract-shelf.png' : 'extract-shelf-ar.png') });
      await p.locator('.shelf-job').first().locator('.btn.primary').click(); await p.waitForFunction(() => window.__calls.some((c) => c.act === 'finish')); ok(`${lang} ${kind}: Finish sent`, true);
    }
    await ctx.close();
  }
  console.log(fails ? 'errors' : 'all passed'); await br.close(); web.close(); process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
