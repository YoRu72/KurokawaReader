// Device battery W3 on a computer: «Your device definitions» and «Teach me this device», with the Tauri bridge faked —
// its methods named and called exactly as desktop-tauri/bridge.js has them (batteryList, batteryRefresh,
// batterySettings, onBattery, batteryDefs, batteryDefImport, batteryDefExport, batteryDefRemove, batteryDefSet,
// batteryTeachList, batteryTeachStart, batteryTeachStop, batteryTeachState, batteryTeachMark, batteryTeachSave,
// batteryTeachClose, saveText). Made-up devices and made-up captures only. Checked: the card (Windows and Linux; none on
// a Mac, none in the Electron build): its title, Teach and Import as equal buttons with a gap, each definition with its
// ids, its switch (batteryDefSet) and its menu — export (saved as a file through saveText), «use mine instead» for a
// built-in reader's product (asked), remove (asked first; Cancel keeps it) —, the count as the language writes it; import
// of a good file, of a bad one (the shell's reason said, nothing added), of one over 16 KB (refused before the shell is
// asked), of one for a built-in reader's product (asked, then sent again with mineFirst); «Teach me»: the collections
// that may be listened to, the refused ones with their reasons (a keyboard, a built-in reader's pad with «Show its
// switch»), listening started explicitly, live rows (changing bytes bright, the rest dimmed), the marks, the level and
// charging proposals with their explanation and preview, the name and kind, Save (batteryTeachSave with the picked
// proposals) — the sheet closed, every captured byte dropped (batteryTeachClose) and no look after it; closing while
// listening stops it too; «Teach me this device» in the menu of a card with no level (that device only); a definition's
// card says it is read by the user's own definition. No sideways overflow; leaving the page lets go of everything.
// Screenshots (PC 1280×800, light and dark) into KT_SHOTS as batW3-*.
// `node tests/batteach.cjs [en|ar]`.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const errors = []; const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok || x === undefined ? '' : JSON.stringify(x).slice(0, 300)); if (!ok) errors.push(what); };
const lang = process.argv[2] || 'en'; const SHOTS = process.env.KT_SHOTS || ''; const AR = lang === 'ar';
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `batW3-${name}-${lang}.png`) }); } };

// (Run in the page. mode: 'win' | 'linux' | 'mac' | 'electron'.)
function fake({ lang, mode }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.pc.starter', '1');
  const NOW = 1_800_000_000_000;
  const rd = (level, charging = 'unknown') => ({ level, charging, asleep: false, takenAt: NOW, note: '', parts: [] });
  const dev = (o) => ({ name: '', kind: 'other', brand: '', connection: 'usb', source: 'hid', vid: 0, pid: 0, merged: [], status: 'ok', reading: null, lastGood: null, checkedAt: NOW, ...o });
  const devices = [
    dev({ key: 'hid:1234:5678:c:x', name: 'Made Up Pad', kind: 'controller', vid: 0x1234, pid: 0x5678, reading: rd({ kind: 'unknown' }) }),
    dev({ key: 'hid:2222:0001:c:y', name: 'Desk Headset', kind: 'headset', source: 'defined', driver: 'defined', proven: 'yours', way: 'passive', vid: 0x2222, pid: 0x0001, reading: rd({ kind: 'exact', value: 64 }, 'yes') }),
  ];
  const settings = { intervalMin: 1, low: 15, names: {}, hidden: [], noQuery: [], links: [], background: false, startup: false, notifyLow: true, notifyFull: false, thresholds: {}, padQueries: [], mkAsk: [], mkMute: [] };
  const system = { autostart: 'yes', tray: true, os: mode === 'mac' ? 'macos' : mode === 'linux' ? 'linux' : 'windows', ...(mode === 'linux' ? { access: { needed: false } } : {}) };
  const entry = (o) => ({ id: 'd1', on: true, mineFirst: false, name: 'Desk Headset', kind: 'headset', note: '', vid: '2222', pid: '0001', usagePage: 'FF00', usage: '0001', interface: 3, productName: '', builtin: null, level: { report: 7, byte: 2, mask: 255, shift: 0, how: 'scale' }, charging: true, ...o });
  let defs = [entry({}), entry({ id: 'd2', name: 'Field Pad', kind: 'controller', vid: '054C', pid: '0CE6', builtin: 'playstation', mineFirst: true, level: { report: 1, byte: 31, mask: 15, shift: 0, how: 'steps' }, charging: false })];
  let n = 3;
  window.__calls = []; window.__subs = 0; window.__saved = null; let cb = null;
  const C = (name, o) => window.__calls.push([name, o === undefined ? null : JSON.parse(JSON.stringify(o))]);
  const copy = (x) => JSON.parse(JSON.stringify(x));
  // (The made-up capture: report 4 carries the level in byte 3 and charging in byte 4's top bit; report 1 moves.)
  let tick = 0; let level = 100; let charging = true; let listening = false; let marks = []; let open = false;
  const st = (extra) => {
    const rows = !listening && !marks.length && !tick ? [] : [
      { id: 1, count: 40 + tick * 20, rate10: 200, bytes: [1, (tick * 37) & 255, (tick * 11) & 255, 0], changing: [false, true, true, false] },
      { id: 4, count: 10 + tick * 5, rate10: 50, bytes: [4, 0xA5, 0, level, charging ? 0x81 : 0x01, tick & 255], changing: [false, false, false, marks.length > 0, marks.length > 0, true] },
    ];
    const kinds = new Set(marks.map((m) => m.kind));
    const lv = ['full', 'half', 'low'].filter((k) => kinds.has(k));
    const values = marks.filter((m) => lv.includes(m.kind)).map((m) => ({ mark: m.kind, value: m.value }));
    const lvl = lv.length ? [
      { i: 0, report: 4, byte: 3, mask: 255, shift: 0, fit: 'percent', scale: { min: 0, max: 100, steps: false }, values, falling: false, weak: lv.length < 2, score: lv.length < 2 ? 25 : 240, preview: { kind: 'exact', value: level } },
      { i: 1, report: 4, byte: 3, mask: 255, shift: 0 + 0, fit: 'range', scale: { min: 0, max: 255, steps: false }, values, falling: false, weak: lv.length < 2, score: 10, preview: { kind: 'exact', value: Math.round(level * 100 / 255) } },
    ] : [];
    lvl[1] && (lvl[1].mask = 127);
    const ch = kinds.has('charging') && kinds.has('notCharging') ? [{ i: 0, report: 4, byte: 4, bit: 7, on: true, score: 100, now: charging ? 'yes' : 'no' }] : [];
    return { open, id: 'hid:1234:5678:c:x|FF00:0001:1', name: 'Made Up Pad', vid: '1234', pid: '5678', listening, gone: false, until: NOW + 600000, now: NOW + tick * 1000, rows, marks: marks.map((m) => ({ kind: m.kind, at: m.at })), level: lvl, charging: ch, ...extra };
  };
  window.__setLevel = (v, c) => { level = v; charging = c; };
  if (mode === 'electron') { window.kurokawaTools = undefined; return; }
  window.kurokawaTools = {
    platform: 'desktop', available: true, reason: '', os: mode === 'mac' ? 'macos' : mode === 'linux' ? 'linux' : 'windows', ready: async () => ({}), list: async () => [], onTasks: () => () => {}, onBrowser: () => () => {}, onUpdateProgress: () => () => {}, onPackProgress: () => () => {}, packStatus: async () => ({}), defaultDir: async () => '/home/user/Downloads',
    batteryList: function () { C('list'); return Promise.resolve({ available: true, now: NOW, devices: copy(devices), settings, system, pads: [{ family: 'playstation', brand: 'PlayStation', proven: 'untested', ask: false, listen: true, models: [], on: false }], mice: [] }); },
    batteryRefresh: function (o) { C('refresh', o); return Promise.resolve(true); },
    batterySettings: function (o) { C('settings', o); return Promise.resolve(settings); },
    onBattery: function (f) { cb = f; window.__subs++; return function () { if (cb === f) cb = null; window.__subs--; }; },
    saveText: function (o) { C('saveText', o); window.__saved = o; return Promise.resolve({ path: '/home/user/' + o.name }); },
    // (Linux: the shell set a damaged file aside — told once, on the first answer.)
    batteryDefs: function () { C('defs'); const aside = mode === 'linux' && !window.__asideTold; window.__asideTold = true; return Promise.resolve({ list: copy(defs), max: 50, teach: mode !== 'mac', aside }); },
    batteryDefImport: function (o) {
      C('import', o);
      let j; try { j = JSON.parse(o.text); } catch { return Promise.resolve({ ok: false, error: { code: 'notJson', field: '' } }); }
      if ('send' in j) return Promise.resolve({ ok: false, error: { code: 'unknown', field: 'send' } });
      const vid = String(j.match?.vendor || '').replace(/^0x/, '').toUpperCase();
      if (vid === '054C' && !o.mineFirst) return Promise.resolve({ ok: false, error: { code: 'builtin', field: 'playstation' } });
      const id = 'd' + n++; defs.push(entry({ id, name: j.name, kind: j.kind || 'other', vid, pid: String(j.match?.product || '').replace(/^0x/, '').toUpperCase(), mineFirst: !!o.mineFirst, builtin: vid === '054C' ? 'playstation' : null }));
      return Promise.resolve({ ok: true, id, list: copy(defs) });
    },
    batteryDefExport: function (o) { C('export', o); const e = defs.find((x) => x.id === o.id); return Promise.resolve({ name: e.name + '.ktdevice.json', text: '{\n  "kurokawaDevice": 1,\n  "name": "' + e.name + '"\n}\n' }); },
    batteryDefRemove: function (o) { C('remove', o); defs = defs.filter((x) => x.id !== o.id); return Promise.resolve({ list: copy(defs) }); },
    batteryDefSet: function (o) { C('set', o); defs = defs.map((x) => (x.id === o.id ? { ...x, ...('on' in o ? { on: o.on } : {}), ...('mineFirst' in o ? { mineFirst: o.mineFirst } : {}) } : x)); return Promise.resolve({ list: copy(defs) }); },
    batteryTeachList: function () {
      C('teachList');
      return Promise.resolve({ available: true, devices: [
        { id: 'hid:1234:5678:c:x|FF00:0001:1', unit: 'hid:1234:5678:c:x', name: 'Made Up Pad', vid: '1234', pid: '5678', usagePage: 'FF00', usage: '0001', interface: 1, verdict: 'allowed', family: null },
        { id: 'hid:1234:5678:c:x|0001:0005:0', unit: 'hid:1234:5678:c:x', name: 'Made Up Pad', vid: '1234', pid: '5678', usagePage: '0001', usage: '0005', interface: 0, verdict: 'allowed', family: null },
        { id: 'hid:1111:2222:c:k|0001:0006:0', unit: 'hid:1111:2222:c:k', name: 'Made Up Keyboard', vid: '1111', pid: '2222', usagePage: '0001', usage: '0006', interface: 0, verdict: 'keyboard', family: null },
        { id: 'hid:054C:0CE6:c:p|0001:0005:-1', unit: 'hid:054C:0CE6:c:p', name: 'Field Pad', vid: '054C', pid: '0CE6', usagePage: '0001', usage: '0005', interface: -1, verdict: 'builtin', family: 'playstation' },
      ] });
    },
    // (window.__holdStart: the answer kept back until window.__releaseStart() — a start still on the way.)
    batteryTeachStart: function (o) {
      C('teachStart', o);
      const go = () => { open = true; listening = true; tick = 1; return st(); };
      if (window.__holdStart) return new Promise((ok) => { window.__releaseStart = () => ok(go()); });
      return Promise.resolve(go());
    },
    batteryTeachStop: function () { C('teachStop'); listening = false; return Promise.resolve(st()); },
    batteryTeachState: function () { C('teachState'); if (listening) tick++; return Promise.resolve(st()); },
    batteryTeachMark: function (o) {
      C('teachMark', o);
      if (o.undo) { marks.pop(); return Promise.resolve(st()); }
      if (!listening) return Promise.resolve({ error: 'quiet' });
      marks.push({ kind: o.mark, at: NOW + tick * 1000, value: level }); return Promise.resolve(st());
    },
    batteryTeachSave: function (o) { C('teachSave', o); const id = 'd' + n++; defs.push(entry({ id, name: o.name, kind: o.kind, vid: '1234', pid: '5678' })); return Promise.resolve({ ok: true, id, list: copy(defs) }); },
    batteryTeachClose: function (o) { C('teachClose', o); open = false; listening = false; marks = []; tick = 0; return Promise.resolve(true); },
  };
}

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batteach-'));
  const open = async (mode, viewport = { width: 1280, height: 800 }) => {
    const ctx = await br.newContext({ viewport }); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
    await p.addInitScript(fake, { lang, mode }); await p.goto(base + '#/battery'); return { ctx, p };
  };
  const calls = (p, name) => p.evaluate((n) => window.__calls.filter((c) => c[0] === n).map((c) => c[1]), name);
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const toastText = (p) => p.evaluate(() => document.querySelector('.toast')?.textContent ?? '');
  // (Controls never touch: every pair apart, or on different lines.)
  const touching = (p, sel) => p.$$eval(sel, (els) => {
    const r = els.filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect()); let k = 0;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i]; const b = r[j]; const gx = Math.max(b.left - a.right, a.left - b.right); const gy = Math.max(b.top - a.bottom, a.top - b.bottom); if (gx < 4 && gy < 4) k++; }
    return k;
  });
  const dark = async (p, on) => { await p.emulateMedia({ colorScheme: on ? 'dark' : 'light' }); await p.waitForFunction((d) => (document.documentElement.dataset.ui !== 'light') === d, on); };
  const file = (name, text) => { const f = path.join(tmp, name); fs.writeFileSync(f, text); return f; };

  {
    const { ctx, p } = await open('win');
    await p.waitForSelector('.bat-defs');
    const card = await p.$eval('.bat-defs', (e) => ({ title: e.querySelector('h3').textContent, rows: [...e.querySelectorAll('.bat-def')].map((r) => ({ id: r.dataset.id, name: r.querySelector('.bat-def-name').textContent, sub: r.querySelector('.bat-def-sub').textContent, on: r.querySelector('input[role=switch]').checked })), count: e.querySelector('.bat-def-count')?.textContent ?? '',
      btns: [...e.querySelectorAll('.bat-eq-row > .btn')].map((b) => Math.round(b.getBoundingClientRect().width)) }));
    check('the card: its title, the two definitions with their ids and switches', card.title === (AR ? 'تعريفات أجهزتك' : 'Your device definitions') && card.rows.length === 2 && card.rows[0].sub.includes('2222:0001') && card.rows.every((r) => r.on), card);
    check('Teach and Import: equal widths', card.btns.length === 2 && Math.abs(card.btns[0] - card.btns[1]) <= 1, card.btns);
    check('the count as the language writes it', card.count === (AR ? 'العدد: 2' : 'Definitions: 2'), card.count);
    check('a built-in reader\'s product used instead says so', (await p.textContent('.bat-def[data-id="d2"]')).includes('PlayStation'));
    check('no touching controls in the card', (await touching(p, '.bat-defs button, .bat-defs input')) === 0);
    check('a file read whole: no «set aside» line', !(await p.$('.bat-defs [data-state="aside"]')));
    check('no sideways overflow', (await overflow(p)) <= 1);
    await p.$eval('.bat-defs', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(150);
    await shot(p, 'card'); if (SHOTS) { await dark(p, true); await shot(p, 'card-dark'); await dark(p, false); }

    // The switch.
    await p.click('.bat-def[data-id="d1"] input[role=switch]');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'set'));
    check('the switch: batteryDefSet({ id, on: false })', JSON.stringify((await calls(p, 'set'))[0]) === JSON.stringify({ id: 'd1', on: false }), await calls(p, 'set'));
    await p.waitForSelector('.bat-def[data-id="d1"].off');
    // Export through the menu.
    await p.click('.bat-def[data-id="d1"] .icon-btn[data-icon="more"]');
    await p.click('.sheet .dest-row[data-act="export"]');
    await p.waitForFunction(() => window.__saved);
    const saved = await p.evaluate(() => window.__saved);
    check('export: saved as a file through saveText', saved.name === 'Desk Headset.ktdevice.json' && saved.text.includes('"kurokawaDevice": 1'), saved);
    // Remove: asked first; Cancel keeps it.
    await p.click('.bat-def[data-id="d1"] .icon-btn[data-icon="more"]'); await p.click('.sheet .dest-row[data-act="remove"]');
    await p.waitForSelector('.sheet [data-act="cancel"]');
    const ask = await p.$$eval('.sheet .sheet-actions .btn', (bs) => bs.map((b) => Math.round(b.getBoundingClientRect().width)));
    check('remove asks first, its two buttons equal', ask.length === 2 && Math.abs(ask[0] - ask[1]) <= 1, ask);
    await p.waitForTimeout(400); await shot(p, 'remove-ask');
    await p.click('.sheet [data-act="cancel"]');
    check('Cancel keeps it', (await calls(p, 'remove')).length === 0 && !!(await p.$('.bat-def[data-id="d1"]')));
    await p.click('.bat-def[data-id="d1"] .icon-btn[data-icon="more"]'); await p.click('.sheet .dest-row[data-act="remove"]'); await p.click('.sheet [data-act="remove"]');
    await p.waitForFunction(() => !document.querySelector('.bat-def[data-id="d1"]'));
    check('removed through batteryDefRemove', JSON.stringify(await calls(p, 'remove')) === JSON.stringify([{ id: 'd1' }]));
    // «Use the built-in again» for a product a built-in reader handles.
    await p.click('.bat-def[data-id="d2"] .icon-btn[data-icon="more"]');
    check('a built-in reader\'s product: «use the PlayStation reader again» in its menu', !!(await p.$('.sheet .dest-row[data-act="builtin"]')));
    await p.keyboard.press('Escape');

    // Import: a good file, a bad one, one too large, one for a built-in reader's product.
    const good = JSON.stringify({ kurokawaDevice: 1, name: 'Shared Mouse', kind: 'mouse', match: { vendor: '0x3333', product: '0x0042' }, level: { report: 2, byte: 4, scale: { min: 0, max: 100 } } });
    const pick = async (f) => { const [fc] = await Promise.all([p.waitForEvent('filechooser'), p.click('.bat-defs [data-act="import"]')]); await fc.setFiles(f); };
    await pick(file('good.json', good));
    await p.waitForSelector('.bat-def:has-text("Shared Mouse")');
    check('a good file: imported (its text sent as is) and listed', (await calls(p, 'import'))[0].text === good && (await toastText(p)).includes('Shared Mouse'), await toastText(p));
    await pick(file('bad.json', '{"kurokawaDevice":1,"send":[1,2]}'));
    await p.waitForFunction(() => window.__calls.filter((c) => c[0] === 'import').length === 2);
    await p.waitForFunction(() => document.querySelector('.toast.error'));
    const bad = await toastText(p);
    check('a bad file: the shell\'s reason said, nothing added', bad.includes('send') && bad.includes(AR ? 'مجهول' : 'Unknown field') && (await p.$$('.bat-def')).length === 2, bad);
    await pick(file('big.json', '{"name":"' + 'x'.repeat(17000) + '"}'));
    await p.waitForFunction(() => document.querySelector('.toast.error')?.textContent.includes('16'));
    check('a file over 16 KB: refused before the shell is asked', (await calls(p, 'import')).length === 2);
    const pad = JSON.stringify({ kurokawaDevice: 1, name: 'My Pad', match: { vendor: '0x054C', product: '0x09CC' }, level: { report: 1, byte: 31, scale: { min: 0, max: 10, steps: true } } });
    await pick(file('pad.json', pad));
    await p.waitForSelector('.sheet [data-ask="mine"]');
    const askT = await p.textContent('.sheet');
    check('a built-in reader\'s product: asked first, naming the reader', askT.includes('PlayStation'), askT);
    await p.waitForTimeout(400); await shot(p, 'use-mine');
    await p.click('.sheet [data-act="useMine"]');
    await p.waitForSelector('.bat-def:has-text("My Pad")');
    const imps = await calls(p, 'import');
    check('…then sent again with mineFirst', imps.length === 4 && imps[3].mineFirst === true && imps[2].mineFirst === false, imps.map((x) => x.mineFirst));

    // A definition's card says so; a card with no level offers «Teach me this device».
    await p.click('.bat-card[data-key="hid:2222:0001:c:y"] .bat-more');
    check('a definition\'s card: read by the user\'s own definition', !!(await p.$('.sheet .bat-reader[data-proven="yours"]')));
    await p.keyboard.press('Escape');
    await p.click('.bat-card[data-key="hid:1234:5678:c:x"] .bat-more');
    await p.click('.sheet .dest-row[data-act="teach"]');
    await p.waitForSelector('.bat-teach .dest-row[data-id]');
    const listed = await p.$$eval('.bat-teach .dest-row[data-id]', (els) => els.map((e) => e.dataset.id));
    const refused = await p.$$eval('.bat-teach .bat-t-ref', (els) => els.map((e) => e.dataset.verdict));
    check('from a card: that device only', listed.length === 2 && listed.every((x) => x.startsWith('hid:1234:5678')) && refused.length === 0, { listed, refused });
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'teachClose'));
    check('closing the sheet drops the session (batteryTeachClose)', true);

    // The whole «Teach me» flow from the card.
    await p.evaluate(() => { window.__calls = []; });
    await p.click('.bat-defs [data-act="teach"]');
    await p.waitForSelector('.bat-teach .bat-t-ref');
    const why = await p.$$eval('.bat-teach .bat-t-ref', (els) => els.map((e) => ({ v: e.dataset.verdict, t: e.textContent, sw: !!e.querySelector('[data-act="showFamily"]') })));
    check('refused: the keyboard (never read) and the pad a built-in reader reads (its switch offered)', why.length === 2 && why[0].v === 'keyboard' && why[0].t.includes(AR ? 'لا يُقرأ ما تكتبه' : 'what you type is never read') && why[1].v === 'builtin' && why[1].sw, why);
    check('the pick step: no touching controls (the list\'s rows are one list)', (await touching(p, '.bat-teach .dest-list, .bat-teach .bat-t-ref')) === 0);
    await p.waitForTimeout(400);
    await shot(p, 'teach-pick'); if (SHOTS) { await dark(p, true); await shot(p, 'teach-pick-dark'); await dark(p, false); }
    await p.click('.bat-teach .dest-row[data-id="hid:1234:5678:c:x|FF00:0001:1"]');
    await p.waitForSelector('.bat-teach .bat-t-status [data-act="start"]');
    check('listening only once asked: nothing started yet', (await calls(p, 'teachStart')).length === 0 && (await p.$$eval('.bat-t-marks .btn', (bs) => bs.every((b) => b.disabled))));
    await p.click('.bat-t-status [data-act="start"]');
    await p.waitForSelector('.bat-t-row[data-report="4"]');
    const started = (await calls(p, 'teachStart'))[0];
    check('started: batteryTeachStart({ id, o }) with the sheet\'s own token', started.id === 'hid:1234:5678:c:x|FF00:0001:1' && /^s[a-z0-9]{6,}$/.test(started.o) && Object.keys(started).length === 2, started);
    const bytes = await p.$$eval('.bat-t-row[data-report="1"] .bat-t-bytes > span', (els) => els.map((e) => e.className));
    check('live rows: changing bytes bright, the rest dimmed', JSON.stringify(bytes) === JSON.stringify(['still', 'moving', 'moving', 'still']), bytes);
    await p.$eval('.sheet .sheet-body', (e) => { e.scrollTop = 0; }); await p.waitForTimeout(150);
    await shot(p, 'teach-listening'); if (SHOTS) { await dark(p, true); await shot(p, 'teach-listening-dark'); await dark(p, false); }
    await p.waitForFunction(() => window.__calls.filter((c) => c[0] === 'teachState').length >= 2);
    check('a look every second while listening', true);
    await p.click('.bat-t-marks [data-mark="full"]'); await p.click('.bat-t-marks [data-mark="charging"]');
    await p.waitForSelector('.bat-t-cand[data-weak="true"]');
    check('one level mark: proposals marked as not yet sure', (await p.textContent('.bat-t-cands')).includes(AR ? 'مستوًى واحدًا' : 'Only one level'));
    await p.evaluate(() => window.__setLevel(52, false));
    await p.click('.bat-t-marks [data-mark="half"]'); await p.click('.bat-t-marks [data-mark="notCharging"]');
    await p.evaluate(() => window.__setLevel(14, false));
    await p.click('.bat-t-marks [data-mark="low"]');
    await p.waitForSelector('.bat-t-cand[aria-checked="true"][data-key="4:3:255"]');
    const cand = await p.$eval('.bat-t-cand[data-key="4:3:255"]', (e) => e.textContent);
    check('the best proposal chosen, explained, with its preview', cand.includes(AR ? 'التقرير 4، البايت 3' : 'Report 4, byte 3') && cand.includes('100') && cand.includes('52') && cand.includes('14') && cand.includes(AR ? 'من 0 إلى 100' : '0 to 100') && cand.includes(AR ? '14٪' : '14%'), cand);
    const charge = await p.$$eval('.bat-t-cands', (els) => [...els[1].querySelectorAll('.bat-t-cand')].map((e) => e.textContent));
    check('the charging proposal and «no charging bit»', charge.length === 2 && charge[0].includes(AR ? 'البِتّ 7' : 'bit 7'), charge);
    await p.click('.bat-t-cand[data-key="4:4:7"]');
    check('the marks listed', (await p.textContent('.bat-t-marked')).includes(AR ? 'منخفضة' : 'Low'));
    check('the listening step: no touching controls', (await touching(p, '.bat-teach button, .bat-teach input')) === 0);
    check('no sideways overflow in the sheet', (await p.$eval('.sheet .sheet-body', (e) => e.scrollWidth - e.clientWidth)) <= 1);
    await p.$eval('.bat-t-cands', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(150);
    await shot(p, 'teach-proposals'); if (SHOTS) { await dark(p, true); await shot(p, 'teach-proposals-dark'); await dark(p, false); }
    await p.$eval('.bat-t-rows', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(150);
    await shot(p, 'teach-rows'); if (SHOTS) { await dark(p, true); await shot(p, 'teach-rows-dark'); await dark(p, false); }
    // Name, kind, save.
    await p.fill('.bat-t-save input', '');
    check('Save waits for a name', await p.$eval('.sheet [data-act="save"]', (b) => b.disabled));
    await p.fill('.bat-t-save input', 'Couch Pad');
    await p.click('.bat-t-save .pick-btn'); await p.click(`.sheet.stacked .dest-row:has-text("${AR ? 'يد تحكم' : 'Controller'}")`).catch(async () => { await p.click('.sheet.stacked .dest-row:nth-child(1)'); });
    await p.click('.sheet [data-act="save"]');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'teachSave'));
    const sv = (await calls(p, 'teachSave'))[0];
    check('Save: batteryTeachSave with the picked proposals, the name and the kind', sv.level === 0 && sv.charging === 0 && sv.name === 'Couch Pad' && sv.kind === 'controller', sv);
    await p.waitForFunction(() => !document.querySelector('.bat-teach'));
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'teachClose'));
    const after = (await calls(p, 'teachState')).length; await p.waitForTimeout(1300);
    check('saved: the sheet closed, the bytes dropped, no look after it', (await calls(p, 'teachState')).length === after && !!(await p.$('.bat-def:has-text("Couch Pad")')));

    // Closing while listening stops it too.
    await p.evaluate(() => { window.__calls = []; });
    await p.click('.bat-defs [data-act="teach"]'); await p.click('.bat-teach .dest-row[data-id="hid:1234:5678:c:x|FF00:0001:1"]');
    await p.click('.bat-t-status [data-act="start"]'); await p.waitForSelector('.bat-t-status [data-act="stop"]');
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'teachClose'));
    const n1 = (await calls(p, 'teachState')).length; await p.waitForTimeout(1300);
    check('closed while listening: dropped, no look after it', (await calls(p, 'teachState')).length === n1);
    const tok = (await calls(p, 'teachStart'))[0].o;
    check('… the close names the same sheet (batteryTeachClose({ o }))', JSON.stringify((await calls(p, 'teachClose'))[0]) === JSON.stringify({ o: tok }), await calls(p, 'teachClose'));
    // Closed while the start is still on the way: when its answer comes, closed again — and never polled.
    await p.evaluate(() => { window.__calls = []; window.__holdStart = true; });
    await p.click('.bat-defs [data-act="teach"]'); await p.click('.bat-teach .dest-row[data-id="hid:1234:5678:c:x|FF00:0001:1"]');
    await p.click('.bat-t-status [data-act="start"]');
    await p.waitForFunction(() => typeof window.__releaseStart === 'function' && window.__calls.some((c) => c[0] === 'teachStart'));
    await p.keyboard.press('Escape');
    await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'teachClose'));
    const tok2 = (await calls(p, 'teachStart'))[0].o;
    await p.evaluate(() => { window.__holdStart = false; window.__releaseStart(); });
    await p.waitForFunction(() => window.__calls.filter((c) => c[0] === 'teachClose').length >= 2);
    const closes = await calls(p, 'teachClose');
    check('closed during start: the late start closed again, by the same sheet token', closes.length >= 2 && closes.every((c) => c && c.o === tok2) && tok2 !== tok, { closes, tok2 });
    await p.waitForTimeout(1300);
    check('… and no look after it', (await calls(p, 'teachState')).length === 0);
    // «Show its switch» for a built-in reader's device.
    await p.click('.bat-defs [data-act="teach"]'); await p.waitForSelector('.bat-t-ref [data-act="showFamily"]');
    await p.click('.bat-t-ref [data-act="showFamily"]');
    await p.waitForFunction(() => !document.querySelector('.bat-teach'));
    check('«Show its switch» closes the sheet', true);

    // Leaving the page lets go of everything.
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForFunction(() => window.__subs === 0);
    check('leaving lets go of the subscription', true);
    await ctx.close();
  }
  {
    const { ctx, p } = await open('linux');
    await p.waitForSelector('.bat-defs');
    check('Linux: the card is there', true);
    const aside = await p.textContent('.bat-defs [data-state="aside"]').catch(() => '');
    check('a damaged definitions file set aside: said calmly in the card', aside.includes('battery-defs.json.bad') && aside.includes(AR ? 'نُحّي جانبًا' : 'kept aside'), aside);
    await ctx.close();
  }
  {
    const { ctx, p } = await open('mac');
    await p.waitForSelector('.bat-card'); await p.waitForTimeout(300);
    check('a Mac: no definitions card, no «Teach me»', !(await p.$('.bat-defs')));
    await ctx.close();
  }
  {
    const { ctx, p } = await open('electron');
    await p.waitForSelector('.bat-empty[data-state="mainBuild"]');
    check('the Electron build: no card', !(await p.$('.bat-defs')));
    await ctx.close();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  await br.close(); web.close();
  console.log(errors.length ? `FAILED: ${errors.length}` : 'all passed');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
