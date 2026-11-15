// Settings → Advanced after the merge of the Rust port's stages M3–M5: every engine row in one design and one order —
// Download engine, Torrent engine, Screen translator engine, File jobs engine, then «Rust core status» — each row a
// name, a one-line hint, the choice and an «in use · handed back» line; each row only when its library is here (the
// core: download, screen, file jobs and the torrent «Director»; the torrent library: the torrent «Rust» choice); NONE
// on a computer. Run over phone and computer, each at phone and computer size, with the core present or absent and the
// torrent library present or absent (the 0.19.0 release: core present, torrent library absent → two torrent choices).
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.png': 'image/png', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const ROWS = ['dl', 'tor', 'screen', 'file'];
(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch(); const errors = []; const pageErrors = [];
  const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok ? '' : JSON.stringify(x ?? '')); if (!ok) errors.push(what); };
  const open = async (o) => {
    const ctx = await br.newContext({ viewport: o.size === 'pc' ? { width: 1366, height: 768 } : { width: 420, height: 860 } }); const p = await ctx.newPage(); p.on('pageerror', (e) => pageErrors.push(e.message));
    await ctx.route(/raw\.githubusercontent\.com|api\.github\.com/, (r) => r.fulfill({ status: 404 }));
    await p.addInitScript((o) => {
      localStorage.setItem('kr.lang', o.lang || 'en'); localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
      const info = async () => ({ abis: ['arm64-v8a'], rustCore: o.core, rustCoreStatus: o.core ? 'Rust core: ' + o.core : 'Rust core: absent', rustTorrent: o.tor, rustShadow: { on: false, calls: 0, mismatches: 0, first: [] },
        dlEngine: 'java', dlEngineChoice: 'java', dlEngineFallbacks: 0, torEngine: 'classic', torEngineChoice: 'classic', torEngineFallbacks: 0, torDirectorPlans: 0, torDirectorFallbacks: 0,
        screenEngine: 'classic', screenEngineChoice: 'classic', screenEngineFallbacks: 0, fileEngine: 'classic', fileEngineChoice: 'classic', fileEngineFallbacks: 0,
        ...(o.full ? { dlEngineFallbacks: 2, torEngine: 'director', torDirectorPlans: 31, torDirectorFallbacks: 1, screenEngine: 'rust', screenEngineCalls: 812, screenCache: { cacheHits: 40, cacheMisses: 9 }, screenChecks: 300, screenMismatches: 0,
          hlsEngine: 'java', hlsEngineChoice: 'java', hlsEngineFallbacks: 0, fileChecks: 7, fileMismatches: 1, fileDisputed: 2, fileJournalResumable: 1, fileJournalUndoable: 3 } : {}) });
      if (o.kind === 'pc') {
        window.kurokawaTools = new Proxy({ platform: 'desktop', available: true, os: 'win32', list: async () => [], onTasks: () => () => {}, deviceInfo: info }, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => undefined) });
        return;
      }
      const api = { addListener: () => ({ remove() {} }), list: async () => ({ tasks: [] }), deviceInfo: info, configure: async () => undefined,
        filesJournals: async () => ({ items: [{ id: 'j1', op: 'move', dest: '/storage/emulated/0/Movies', steps: 9, done: 4, resumable: true }] }) };
      window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) }) }, PluginHeaders: [] };
    }, o);
    await p.goto(base + '#/settings'); await p.waitForSelector('.settings-body > .card'); await p.waitForTimeout(700);
    // (At a computer's size the settings show one section at a time: «Advanced» picked from the list beside them.)
    if (await p.$('.settings-body.pc-one') && await p.$('.settings-nav .chip[data-sec="advanced"]')) { await p.click('.settings-nav .chip[data-sec="advanced"]'); await p.waitForTimeout(200); }
    if (await p.$('#advanced.collapsed')) await p.click('#advanced h3');
    return { p, ctx };
  };
  for (const kind of ['phone', 'pc']) for (const size of ['phone', 'pc']) for (const core of ['0.3.0', null]) for (const tor of ['0.1.0', null]) {
    const tag = `${kind} at ${size} size, core ${core ? 'present' : 'absent'}, torrent library ${tor ? 'present' : 'absent'}`;
    const { p, ctx } = await open({ kind, size, core, tor });
    const rows = await p.$$eval('#advanced .engine', (e) => e.map((x) => [...x.classList].find((c) => c.endsWith('-engine')).replace(/-engine$/, '')));
    const want = kind === 'pc' || (!core && !tor) ? [] : core ? ROWS : ['tor'];
    check(`${tag}: rows ${want.join(', ') || 'none'}`, JSON.stringify(rows) === JSON.stringify(want), rows);
    if (kind === 'pc' || (!core && !tor)) {
      check(`${tag}: no «Advanced» card, no status, nothing in the list of sections`, !(await p.$('#advanced')) && !(await p.$('#rust-status')) && !(await p.$('.settings-nav .chip[data-sec="advanced"]')));
      if (kind === 'pc') { await p.fill('.settings-search', 'engine'); await p.waitForTimeout(200); const body = await p.$eval('.settings-body', (e) => e.textContent); check(`${tag}: a search finds no engine row`, !/Download engine|Torrent engine|Screen translator engine|File jobs engine/.test(body)); }
      await ctx.close(); continue;
    }
    // One design: name + hint + choice in the row, the status line under it; each hint one short line.
    const shape = await p.$$eval('#advanced .engine', (e) => e.map((x) => ({ row: !!x.querySelector(':scope > .row > span > small.src') && !!x.querySelector(':scope > .row > button'), status: !!x.querySelector(':scope > small.src[class*="-engine-status"]'), hint: x.querySelector(':scope > .row > span > small.src')?.textContent ?? '', line: x.querySelector(':scope > small.src')?.textContent ?? '' })));
    check(`${tag}: every row the same shape (name, hint, choice; status under it)`, shape.every((s) => s.row && s.status), shape);
    check(`${tag}: every hint one short line (≤ 120 characters, one sentence)`, shape.every((s) => s.hint.length > 0 && s.hint.length <= 120 && !/\. \S/.test(s.hint)), shape.map((s) => s.hint));
    check(`${tag}: every status line «in use · handed back»`, shape.every((s) => /^in use: .+ · handed back to Classic: \d+$/.test(s.line)), shape.map((s) => s.line));
    check(`${tag}: the status block last`, await p.$eval('#advanced', (e) => e.lastElementChild?.id === 'rust-status'));
    await p.click('#advanced .tor-engine-row button'); await p.waitForTimeout(300);
    const opts = await p.$$eval('label.dest-row', (e) => e.map((x) => x.textContent.trim()));
    const wantOpts = ['Classic', ...(core ? ['Director'] : []), ...(tor ? ['Rust'] : [])];
    check(`${tag}: torrent choices ${wantOpts.join(' / ')}`, JSON.stringify(opts) === JSON.stringify(wantOpts), opts);
    await ctx.close();
  }
  // The release's configuration in Arabic: the four rows in Fusha, the torrent choices الكلاسيكيّ / الموجِّه.
  const { p, ctx } = await open({ kind: 'phone', size: 'phone', core: '0.3.0', tor: null, lang: 'ar' });
  const ar = await p.$eval('#advanced', (e) => e.textContent);
  check('Arabic: the four rows named in Arabic, one word for «Classic»', /محرّك التنزيل/.test(ar) && /محرّك التورنت/.test(ar) && /محرّك مترجم الشاشة/.test(ar) && /محرّك مهامّ الملفّات/.test(ar) && !/التقليديّ/.test(ar) && (ar.match(/ما أُعيد إلى الكلاسيكيّ، العدد/g) || []).length === 4, ar.slice(0, 500));
  await p.click('#advanced .tor-engine-row button'); await p.waitForTimeout(300);
  const aro = await p.$$eval('label.dest-row', (e) => e.map((x) => x.textContent.trim()));
  check('Arabic: torrent choices الكلاسيكيّ / الموجِّه', JSON.stringify(aro) === JSON.stringify(['الكلاسيكيّ', 'الموجِّه']), aro);
  await ctx.close();
  // No two controls touch (8 px apart at least), every button of a kind one height, the warning colour only on counts
  // that are not zero; the status block's actions in one row with a gap; the end of the card above the bottom bar.
  for (const lang of ['en', 'ar']) {
    const { p, ctx } = await open({ kind: 'phone', size: 'phone', core: '0.3.0', tor: null, lang, full: true });
    await p.click('#rust-status .rust-jobs-open'); await p.waitForSelector('#rust-status .rust-job');
    const boxes = await p.$$eval('#advanced button, #advanced .pick-btn, #advanced input, #advanced select', (e) => [...new Set(e)].map((x) => { const r = x.getBoundingClientRect(); return { k: x.className, t: x.textContent.trim().slice(0, 20), l: r.left, r: r.right, t0: r.top, b: r.bottom, h: Math.round(r.height) }; }).filter((x) => x.h > 0));
    const close = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], c = boxes[j]; const dx = Math.max(0, Math.max(a.l, c.l) - Math.min(a.r, c.r)), dy = Math.max(0, Math.max(a.t0, c.t0) - Math.min(a.b, c.b));
      if (Math.max(dx, dy) < 8) close.push(`${a.t} / ${c.t} (${Math.round(Math.max(dx, dy))} px)`);
    }
    check(`${lang}: no two controls in the Advanced card or the status block closer than 8 px (${boxes.length} controls)`, !close.length, close);
    const hs = (sel) => [...new Set(boxes.filter((b) => b.k.split(' ').includes(sel)).map((b) => b.h))];
    check(`${lang}: every button one height, every picker one height`, hs('btn').length === 1 && hs('pick-btn').length === 1, { btn: hs('btn'), pick: hs('pick-btn') });
    const gap = await p.$eval('#rust-status .rust-actions', (e) => { const [a, b] = [...e.children].map((x) => x.getBoundingClientRect()); const prev = e.previousElementSibling.getBoundingClientRect(); return { between: Math.round(Math.max(a.left, b.left) - Math.min(a.right, b.right)), above: Math.round(e.getBoundingClientRect().top - prev.bottom) }; });
    check(`${lang}: the actions 12 px apart, 16 px under the text`, gap.between === 12 && gap.above === 16, gap);
    const warn = await p.$$eval('#rust-status .warn', (e) => e.map((x) => x.textContent));
    check(`${lang}: the warning colour on the counts that are not zero (download fell back 2; file jobs differed 1; the director's 1; skipped 2) and nowhere else`, warn.length === 4 && warn.every((x) => /[1-9١-٩]/.test(x)), warn);
    const pairs = await p.$$eval('#rust-status .rs-piece', (e) => e.every((x) => x.getClientRects().length === 1));
    check(`${lang}: no «label: value» broken over two lines`, pairs);
    await p.evaluate(() => { const b = document.querySelector('.settings-body'); b.scrollTop = b.scrollHeight; }); await p.waitForTimeout(200);
    const r = await p.evaluate(() => ({ nav: document.querySelector('.bottom-nav')?.getBoundingClientRect().top ?? innerHeight, end: document.querySelector('#rust-status').getBoundingClientRect().bottom }));
    check(`${lang}: scrolled to the end, the status block clear of the bottom bar`, r.end <= r.nav, r);
    await ctx.close();
  }
  check('no page errors', !pageErrors.length, pageErrors);
  await br.close(); web.close();
  if (errors.length) { console.log('failed:', errors); process.exit(1); } console.log('all passed');
})().catch((e) => { console.error(e); process.exit(1); });
