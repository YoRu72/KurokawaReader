// node tests/ownerlock.cjs: after the hand-over, ONE of the two programs runs the downloads both sessions name (stage
// P9; desktop/ownerlock.cjs, kt-core's ownerlogic.rs, src-tauri/src/ownerlock.rs, src/ui/ownersheet.ts).
//   - The rule: every row of core/kt-core/src/ownerlock-cases.txt — the table ownerlogic.rs's own tests read — gives the
//     same status, «may take» (unasked and asked) and heartbeat action in JavaScript.
//   - The file: two takers at once (the last rename wins; the other reads back, sees it lost, refuses), a live owner
//     refuses a resume of a handed-over id (others go on), a stale owner (gone, heartbeat old) taken over on the way
//     without asking, a clock moved back (the pid decides), the owner's heartbeat yielding to a «Take them back» (its
//     running ones paused, the page told) and those resumed when taken back again, a release at quit; the record
//     written atomically (no temp file left).
//   - Electron untouched while RUST_SWITCH is off: main.cjs reaches the owner only behind it.
//   - The page (the built app in Chromium, the real desktop-tauri bridges over a pretend IPC, en/ar): held at the start
//     → told, with «Take them back»; the sheet says who and how many; taking asks first; a refused resume opens it and
//     the download is resumed once taken back.
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const L = require('../desktop/ownerlock.cjs');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x).slice(0, 400))); if (!c) fails++; return !!c; };

/* ---------- the shared table ---------- */
const rows = fs.readFileSync(path.join(ROOT, 'core', 'kt-core', 'src', 'ownerlock-cases.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
let bad = [];
for (const l of rows) {
  const f = l.split('|').map((x) => x.trim());
  const p = f[2] === '-' ? null : f[2].split(',');
  const rec = p && { owner: p[0], pid: Number(p[1]), startedAt: Number(p[2]), heartbeat: Number(p[3]), released: p[4] === 'released' };
  const m = f[3].split(','); const me = { owner: m[0], pid: Number(m[1]), startedAt: Number(m[2]) };
  const st = L.status(Number(f[1]), rec, me, f[4] === 'yes');
  const got = [st, L.mayTake(st, false) ? 'yes' : 'no', L.mayTake(st, true) ? 'yes' : 'no', L.tick(st)].join(',');
  if (got !== [f[5], f[6], f[7], f[8]].join(',')) bad.push(`${f[0]}: ${got}`);
}
ok(`the shared table: ${rows.length} rows alike in JavaScript and Rust`, rows.length >= 15 && !bad.length, bad);
ok('the constants are ownerlogic.rs\'s', (() => { const rs = fs.readFileSync(path.join(ROOT, 'core', 'kt-core', 'src', 'ownerlogic.rs'), 'utf8'); return ['HEARTBEAT_MS', 'STALE_MS', 'PID_REUSE_MS', 'SKEW_MS', 'SETTLE_MS'].every((k) => new RegExp(`pub const ${k}: i64 = ${String(L[k]).replace(/\B(?=(\d{3})+(?!\d))/g, '_')};`).test(rs)) && rs.includes(`pub const FILE: &str = "${L.FILE}";`); })());

/* ---------- the file ---------- */
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kt-owner-'));
  let now = 1_000_000; const alive = new Set();
  const opts = (pid) => ({ now: () => now, alive: (p) => alive.has(p), sleep: async () => { now += L.SETTLE_MS; } });
  // The Rust build's record, as ownerlock.rs writes it.
  const rust = (o) => fs.writeFileSync(path.join(dir, L.FILE), JSON.stringify({ app: L.APP, kind: L.KIND, format: 1, owner: 'tauri', pid: 4242, startedAt: 7, heartbeat: now, released: false, handover: 'h-1', ids: ['g1', 'v2'], ...o }));
  const paused = []; const resumed = []; const told = [];
  const hooks = { pause: async (ids) => { paused.push(...ids.filter((i) => i !== 'g9')); return ids.filter((i) => i === 'g1'); }, resume: async (ids) => { resumed.push(...ids); }, told: (i) => told.push(i) };
  const mk = (pid) => { const o = new L.OwnerLock(dir, hooks, opts(pid)); o.me.pid = pid; o.me.startedAt = 100 + pid; return o; };
  const a = mk(500);
  ok('no record: nothing to say, everything resumes', a.info() === null && (await a.allowResume('g1')));
  rust(); alive.add(4242);
  ok('the new app holds them: told (held, by tauri, 2)', (() => { const i = a.info(); return i && i.held && i.by === 'tauri' && i.count === 2; })(), a.info());
  ok('a handed-over id is refused while it lives; another id goes on', !(await a.allowResume('g1')) && !(await a.allowResume('v2')) && (await a.allowResume('zz')));
  ok('at the engine\'s start: the running handed-over ones paused here, the page told', (await a.atStart()) === 'held' && paused.join() === 'g1,v2' && told.length === 1);
  ok('unasked, it is not taken', !(await a.take(false)));
  // Two takers at once: A (asked) writes, B writes after it; A reads back after settling and has lost.
  const b = mk(600);
  const origWrite = a.write.bind(a);
  a.write = (o) => { origWrite(o); b.write({ ids: ['g1', 'v2'], handover: 'h-1' }); };
  const gotA = await a.take(true); a.write = origWrite; alive.add(600);
  ok('two takers at once: the last rename wins, the other sees it and keeps nothing', !gotA && b.status() === 'mine' && a.status() === 'held', { a: a.status(), b: b.status() });
  ok('nothing resumed by the one that lost', resumed.length === 0);
  // The winner dies; its heartbeat ages past the stale limit: taken over on the way, without asking.
  alive.delete(600); now += L.STALE_MS + 1;
  ok('a stale owner (gone, heartbeat old): the resume goes on and the record is taken', (await a.allowResume('g1')) && a.status() === 'mine');
  a.stop();
  // The clock moved back an hour: B's fresh-looking record from the future; B gone → stale; B alive → held.
  b.write({ ids: ['g1'], handover: 'h-1' }); now -= 3_600_000;
  ok('the clock moved back: the pid decides (gone → stale)', a.status() === 'stale');
  alive.add(600); ok('the clock moved back: the pid decides (alive → held)', a.status() === 'held');
  // A owns, then the other takes them back («Take them back» there): A's heartbeat yields, pauses, tells.
  alive.delete(600); now += 3_600_000 + L.STALE_MS + 10;
  paused.length = 0; told.length = 0; a.paused = [];
  ok('taken again', await a.take(false));
  await a.beat(); const rec1 = JSON.parse(fs.readFileSync(path.join(dir, L.FILE), 'utf8'));
  ok('its heartbeat renews its own record', rec1.owner === 'electron' && rec1.pid === 500 && rec1.heartbeat === now);
  rust({ heartbeat: now }); alive.add(4242);
  await a.beat();
  ok('taken back by the other: it yields — its running ones paused, the page told, no more heartbeat', paused.join() === 'g1,v2' && told.length === 1 && told[0].held && a.timer === null);
  ok('remembered what it paused for the other', a.paused.join() === 'g1');
  const asked = await a.take(true);
  ok('«Take them back» (asked): its own again, the ones it paused resumed', asked && resumed.join() === 'g1' && a.paused.length === 0);
  a.release(); const rec2 = JSON.parse(fs.readFileSync(path.join(dir, L.FILE), 'utf8'));
  ok('at quit: released — free for the other at once', rec2.released === true && L.status(now, L.parse(JSON.stringify(rec2)), { owner: 'tauri', pid: 4242, startedAt: 7 }, true) === 'free');
  ok('written atomically: no temp file left', fs.readdirSync(dir).join() === L.FILE, fs.readdirSync(dir));
  ok('a file that is not a record is no record', L.parse('{"app":"x"}') === null && L.parse('not json') === null);
  fs.rmSync(dir, { recursive: true, force: true });

  /* ---------- Electron untouched while the switch is off ---------- */
  const main = fs.readFileSync(path.join(ROOT, 'desktop', 'main.cjs'), 'utf8');
  ok('main.cjs: RUST_SWITCH still false', /\nconst RUST_SWITCH = false;\n/.test(main));
  ok('main.cjs: the owner reached only behind RUST_SWITCH (start, resume, quit, the page\'s two asks)',
    main.includes("if (RUST_SWITCH) ownerAtStart(userData);") && main.includes("(RUST_SWITCH ? ownerResume(id) : isVideoId(id) ? videos.resume(id) : E().resume(id))") && main.includes('if (RUST_SWITCH) owner?.release();')
    && main.includes("ipcMain.handle('kt:downloadsOwner', () => (RUST_SWITCH && owner ? owner.info() : null));") && /kt:downloadsTake', async \(\) => \{ if \(!RUST_SWITCH \|\| !owner\) return null;/.test(main)
    && (main.match(/ownerAtStart\(|ownerResume\(/g) || []).length === 4);

  ok('main.cjs: at the switch its own start-at-log-in entry is taken away after the hand-over, put back if nothing is installed',
    /if \(!h \|\| h\.ok !== true\)[^\n]*\n(?:\s*\/\/[^\n]*\n)*\s*const loginWas = loginOffForSwitch\(\);/.test(main) && main.includes('if (!opened) { await handoverCh.resume(); loginBack(loginWas); }') && (main.match(/loginOffForSwitch\(|loginBack\(/g) || []).length === 4);
  const nsh = fs.readFileSync(path.join(ROOT, "desktop-tauri", "src-tauri", "installer", "hooks.nsh"), "utf8");
  const repl = nsh.slice(nsh.indexOf('${AndIf} $KrOld == "replace"'));
  ok('installer: the old program\'s Run values removed only when it is replaced (and only where they name it)', repl.includes('!insertmacro KR_OLD_RUN_GONE "app.kurokawa.tools"') && !nsh.slice(0, nsh.indexOf('${AndIf} $KrOld == "replace"')).includes('!insertmacro KR_OLD_RUN_GONE "') && /!macro KR_OLD_RUN_GONE NAME[\s\S]*?KR_NAMES_OLD[\s\S]*?DeleteRegValue/.test(nsh));

  /* ---------- the page ---------- */
  let chromium; try { ({ chromium } = require('playwright')); } catch { console.log('skip: no playwright'); return; }
  const DIST = path.join(ROOT, 'dist'); if (!fs.existsSync(path.join(DIST, 'index.html'))) { ok('dist/ built (node scripts/build.mjs)', false); return; }
  const http = require('node:http');
  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
  const server = http.createServer((req, res) => { let f = path.join(DIST, decodeURIComponent(req.url.split('?')[0])); if (!f.startsWith(DIST) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(DIST, 'index.html'); res.setHeader('Content-Type', MIME[path.extname(f)] || 'application/octet-stream'); fs.createReadStream(f).pipe(res); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${server.address().port}/`;
  const BRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'bridge.js'), 'utf8'); const HBRIDGE = fs.readFileSync(path.join(ROOT, 'desktop-tauri', 'handover-bridge.js'), 'utf8');
  const br = await chromium.launch(); const errors = [];
  try {
  for (const lang of ['en', 'ar']) {
    const ctx = await br.newContext({ viewport: { width: 1100, height: 760 } }); const p = await ctx.newPage(); p.setDefaultTimeout(15000);
    p.on('pageerror', (e) => errors.push(`${lang}: ${e.message}`));
    await p.addInitScript((lng) => {
      try { localStorage.setItem('kt.pc.starter', '1'); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kr.lang', lng); } catch { /* first load */ }
      window.__calls = []; window.__held = true;
      const task = { id: 'g1', kind: 'http', name: 'big.bin', source: { url: 'http://127.0.0.1:9/big.bin' }, dir: '/d', state: 'paused', done: 10, total: 100, downSpeed: 0, upSpeed: 0 };
      const replies = { kt_state: () => ({ available: true, reason: '', os: 'win32', arch: 'x64' }), kt_list: () => [task], kt_open_take: () => [], kt_roots: () => ({ roots: [] }), kt_default_dir: () => 'C:\\d', kt_files_roots: () => ({ roots: [] }), kt_app_icon: () => null, kt_handover_find: () => ({ found: false, state: null }),
        kt_downloads_owner: () => (window.__held ? { held: true, status: 'held', by: 'electron', since: 1, count: 3 } : { held: false, status: 'mine', by: 'tauri', count: 3 }),
        kt_downloads_take: () => { window.__held = false; return { ok: true, held: false, status: 'mine', by: 'tauri', count: 3 }; },
        kt_resume: () => (window.__held ? Promise.reject('kt-owner:held') : true) };
      window.__TAURI__ = { core: { invoke: (cmd, args) => { window.__calls.push(cmd); try { return Promise.resolve(replies[cmd] ? replies[cmd](args || {}) : null); } catch (e) { return Promise.reject(e); } } }, event: { listen: () => Promise.resolve(() => {}) } };
    }, lang);
    await p.addInitScript({ content: `window.__KT_BOOT__ = ${JSON.stringify({ os: 'win32', arch: 'x64' })};\n${BRIDGE}\n${HBRIDGE}` });
    await p.goto(base);
    await p.waitForSelector('.toast.with-action');
    const words = await p.textContent('.toast');
    ok(`${lang}: held at the start: told, with «Take them back»`, lang === 'en' ? /other Kurokawa Tools is running/.test(words) && /Take them back/.test(words) : /Kurokawa Tools الآخر/.test(words) && /استرجِعها/.test(words), words);
    await p.click('.toast-act');
    await p.waitForSelector('.sheet[data-owner="held"]');
    const sheet = await p.textContent('.sheet[data-owner="held"]');
    ok(`${lang}: the sheet says who runs them and how many`, lang === 'en' ? /The previous Kurokawa Tools is running/.test(sheet) && /\(3\)/.test(sheet) : /Kurokawa Tools السابق/.test(sheet) && /العدد: [3٣]/.test(sheet), sheet);
    await p.click('[data-act="owner-take"]');
    await p.waitForSelector('.sheet[data-owner="ask"]');
    ok(`${lang}: taking asks first (nothing taken yet)`, !(await p.evaluate(() => window.__calls.includes('kt_downloads_take'))));
    await p.click('.sheet[data-owner="ask"] .sheet-head button'); // cancel
    ok(`${lang}: cancelled → nothing taken`, !(await p.evaluate(() => window.__calls.includes('kt_downloads_take'))));
    await p.evaluate(() => document.querySelectorAll('.sheet').forEach((s) => s.__close && s.__close()));
    // A refused resume opens the sheet; taken back → the download resumed.
    await p.evaluate(() => window.kurokawaTools.resume('g1').catch((e) => { window.__refused = String(e && e.message || e); }));
    ok(`${lang}: the shell refuses the resume while held («kt-owner:held»)`, /kt-owner:held/.test(await p.evaluate(() => window.__refused || '')));
    // (The page's own engine path: the downloads list's resume button.)
    await p.evaluate(() => { location.hash = '#/downloads'; });
    const btn = lang === 'en' ? await p.waitForSelector('button[aria-label="Resume"]', { timeout: 8000 }).catch(() => null) : null;
    if (btn) {
      await btn.click();
      await p.waitForSelector('.sheet[data-owner="held"]');
      ok(`${lang}: a refused resume in the list opens the sheet`, true);
      await p.click('[data-act="owner-take"]'); await p.waitForSelector('.sheet[data-owner="ask"]'); await p.click('[data-act="owner-take-yes"]');
      await p.waitForFunction(() => window.__calls.includes('kt_downloads_take') && window.__calls.filter((c) => c === 'kt_resume').length >= 3);
      ok(`${lang}: taken back (asked) → the download resumed`, true);
    } else if (lang === 'en') ok(`${lang}: the list's resume button`, false, 'not found');
    await ctx.close();
  }
  } finally { await br.close(); server.close(); }
  ok('no page errors', !errors.length, errors);
})().catch((e) => { console.error(e); fails++; }).finally(() => { console.log(fails ? `${fails} FAILED` : 'all passed'); process.exitCode = fails ? 1 : 0; });
