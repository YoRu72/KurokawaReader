// Device battery, piece P1 (Linux and macOS) on a computer, with the Tauri bridge faked as desktop-tauri/bridge.js has
// it (batteryList, batteryRefresh, batterySettings, onBattery, btList, btScan, btAct, btOpenSettings, onBt) and the
// bridge's os 'linux' or 'macos'. Made-up devices only. Checked: on Linux, a raw HID node closed to the user — the card
// says «not allowed yet» and points below, «Allow reading on Linux» shows where the rule was saved and the two commands
// (left to right, each with a Copy button that copies exactly it), how to undo, and says Tools never runs them; the card
// is absent when nothing is closed; the rule not saved said calmly; the connect panel's words name the desktop's
// Bluetooth settings, never Windows; the empty state names what Linux reads. On a Mac: the note (what macOS reports, the
// family readers not yet, connecting in the system's settings — its button calls btOpenSettings), no controller or mice
// switches, the empty state names what macOS reports and never Windows. PC 1280×800 and a narrow 360 px window: no
// sideways overflow, no touching controls in the card. Screenshots into KT_SHOTS when set.
// `node tests/batplat.cjs [en|ar]`.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const errors = []; const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok || x === undefined ? '' : JSON.stringify(x).slice(0, 300)); if (!ok) errors.push(what); };
const lang = process.argv[2] || 'en'; const SHOTS = process.env.KT_SHOTS || '';
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `batP1-${name}-${lang}.png`), fullPage: true }); } };

// (Run in the page. mode: 'linux' | 'linuxOpen' | 'linuxUnsaved' | 'linuxEmpty' | 'mac' | 'macEmpty'.)
function fake({ lang, mode }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.pc.starter', '1');
  const NOW = 1_800_000_000_000;
  const linux = mode.startsWith('linux');
  const rd = (level, at, charging = 'unknown', note = '') => ({ level, charging, asleep: false, takenAt: at, note, parts: [] });
  const dev = (o) => ({ name: '', kind: 'other', brand: '', connection: 'usb', source: 'system', vid: 0, pid: 0, merged: [], status: 'ok', reading: null, lastGood: null, checkedAt: NOW, ...o });
  const devices = mode.endsWith('Empty') ? [] : linux ? [
    dev({ key: 'ps:n:ps-controller-battery-aa:bb:cc:dd:ee:07', name: 'Field Pad', kind: 'controller', brand: 'PlayStation', connection: 'bluetooth', reading: rd({ kind: 'exact', value: 60 }, NOW, 'yes') }),
    dev({ key: 'hid:2DC8:6001:c:usb-0000:00:14.0-3', name: '8BitDo SN30 Pro', kind: 'controller', brand: '8BitDo', source: 'pad', picture: 'retro', driver: '8bitdo', family: 'eightbitdo', proven: 'untested', way: 'passive', reading: rd({ kind: 'unknown' }, NOW, 'unknown', 'noAccess') }),
    dev({ key: 'bt:AA:BB:CC:DD:EE:01', name: 'Test Headset', kind: 'headset', connection: 'bluetooth', reading: rd({ kind: 'exact', value: 70 }, NOW) }),
  ] : [
    dev({ key: 'bt:AA:BB:CC:DD:EE:0A', name: 'Made Up Keyboard', kind: 'keyboard', brand: 'Apple', connection: 'bluetooth', reading: rd({ kind: 'exact', value: 67 }, NOW) }),
    dev({ key: 'bt:AA:BB:CC:DD:EE:01', name: 'Test Buds', kind: 'earbuds', connection: 'bluetooth', reading: Object.assign(rd({ kind: 'exact', value: 75 }, NOW), { parts: [{ part: 'left', level: { kind: 'exact', value: 80 }, charging: 'unknown', inUse: true }, { part: 'right', level: { kind: 'exact', value: 75 }, charging: 'unknown', inUse: true }, { part: 'case', level: { kind: 'exact', value: 40 }, charging: 'unknown', inUse: false }] }) }),
  ];
  const settings = { intervalMin: 1, low: 15, names: {}, hidden: [], noQuery: [], links: [], background: false, startup: false, notifyLow: true, notifyFull: false, thresholds: {}, padQueries: [], mkAsk: [], mkMute: [] };
  const file = '/home/user/.local/share/app.kurokawa.tools/70-kurokawa-tools-battery.rules';
  const access = mode === 'linuxOpen' ? { needed: false } : mode === 'linuxUnsaved' ? { needed: true, saved: false, file: null, steps: [] }
    : { needed: true, saved: true, file, steps: [`sudo install -m 0644 '${file}' /etc/udev/rules.d/70-kurokawa-tools-battery.rules`, 'sudo udevadm control --reload-rules && sudo udevadm trigger --subsystem-match=hidraw'] };
  const system = linux ? { autostart: 'yes', tray: true, os: 'linux', access } : { autostart: 'yes', tray: true, os: 'macos' };
  const padRows = linux ? [{ family: 'playstation', brand: 'PlayStation', proven: 'untested', ask: false, listen: true, models: [], on: false }, { family: 'eightbitdo', brand: '8BitDo', proven: 'untested', ask: true, listen: true, models: ['8BitDo Ultimate 2'], on: false }] : [];
  const bt = { available: linux, radio: linux ? 'off' : 'missing', stale: false, now: NOW, scanUntil: null, found: [], busy: [], devices: [] };
  window.__calls = []; window.__subs = 0; window.__btSubs = 0; let cb = null; let btCb = null;
  window.kurokawaTools = {
    platform: 'desktop', available: true, reason: '', os: linux ? 'linux' : 'macos', ready: async () => ({}), list: async () => [], onTasks: () => () => {}, onBrowser: () => () => {}, onUpdateProgress: () => () => {}, onPackProgress: () => () => {}, packStatus: async () => ({}), defaultDir: async () => '/home/user/Downloads',
    batteryList: function () { window.__calls.push(['list']); return Promise.resolve({ available: true, now: NOW, devices: JSON.parse(JSON.stringify(devices)), settings, system, pads: padRows, mice: [] }); },
    batteryRefresh: function (o) { window.__calls.push(['refresh', o]); return Promise.resolve(true); },
    batterySettings: function (o) { window.__calls.push(['settings', o]); return Promise.resolve(settings); },
    onBattery: function (f) { cb = f; window.__subs++; return function () { if (cb === f) cb = null; window.__subs--; }; },
    btList: function () { window.__calls.push(['btList']); return Promise.resolve(JSON.parse(JSON.stringify(bt))); },
    btScan: function () { return Promise.resolve(JSON.parse(JSON.stringify(bt))); },
    btAct: function () { return Promise.resolve({ result: 'settings', code: 0 }); },
    btOpenSettings: function () { window.__calls.push(['btOpenSettings']); return Promise.resolve(); },
    onBt: function (f) { btCb = f; window.__btSubs++; return function () { if (btCb === f) btCb = null; window.__btSubs--; }; },
  };
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: (s) => { window.__copied = s; return Promise.resolve(); } }, configurable: true });
}

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  const open = async (mode, viewport = { width: 1280, height: 800 }) => {
    const ctx = await br.newContext({ viewport }); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
    await p.addInitScript(fake, { lang, mode }); await p.goto(base + '#/battery'); return { ctx, p };
  };
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const AR = lang === 'ar';
  const noWindows = (s) => !/Windows|ويندوز/.test(s);
  // (Controls in the card never touch: every pair of buttons and code blocks apart, or on different lines.)
  const touching = (p) => p.$$eval('.bat-plat code, .bat-plat button', (els) => {
    const r = els.map((e) => e.getBoundingClientRect()); let n = 0;
    for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) { const a = r[i]; const b = r[j]; const gapX = Math.max(b.left - a.right, a.left - b.right); const gapY = Math.max(b.top - a.bottom, a.top - b.bottom); if (gapX < 4 && gapY < 4) n++; }
    return n;
  });

  for (const vp of [{ width: 1280, height: 800, tag: 'pc' }, { width: 360, height: 780, tag: 'narrow' }]) {
    const { ctx, p } = await open('linux', vp);
    await p.waitForSelector('.bat-plat[data-plat="linuxAccess"]');
    const note = await p.textContent('.bat-card[data-key^="hid:2DC8"] .bat-note');
    check(`${vp.tag}: a closed node says so on its card and points below`, note.includes(AR ? 'السماح بالقراءة على لينكس' : 'Allow reading on Linux'), note);
    const card = await p.$eval('.bat-plat', (e) => ({ title: e.querySelector('h3').textContent, codes: [...e.querySelectorAll('code')].map((c) => ({ t: c.textContent, dir: c.getAttribute('dir') })), copies: e.querySelectorAll('.bat-cmd button').length, text: e.textContent }));
    check(`${vp.tag}: the access card: title, the saved file and the two commands, left to right, each with Copy`, card.title === (AR ? 'السماح بالقراءة على لينكس' : 'Allow reading on Linux') && card.codes.length === 3 && card.copies === 3 && card.codes.every((c) => c.dir === 'ltr') && card.codes[1].t.startsWith('sudo install -m 0644') && card.codes[2].t.includes('udevadm trigger'), card);
    check(`${vp.tag}: it says Tools never runs them, and how to undo`, card.text.includes('/etc/udev/rules.d') && card.text.includes(AR ? 'لا تُنفِّذ' : 'never runs'), card.text.slice(-200));
    check(`${vp.tag}: no sideways overflow`, (await overflow(p)) <= 1);
    check(`${vp.tag}: no touching controls in the card`, (await touching(p)) === 0);
    if (vp.tag === 'pc') {
      await p.click('.bat-plat .bat-cmd:nth-of-type(1) button');
      const copied = await p.evaluate(() => window.__copied);
      check('Copy copies exactly the command', copied === card.codes[0].t, copied);
      // (The connect panel's words on Linux: the desktop's settings, never Windows.)
      await p.waitForSelector('.bt-state[data-radio="off"]');
      const off = await p.textContent('.bt-state');
      check('Bluetooth off: the desktop\'s settings, never Windows', noWindows(off) && off.includes(AR ? 'سطح مكتبك' : 'desktop'), off);
    }
    await p.$eval('.bat-plat', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(100);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `batP1-linux-access-${vp.tag}-${lang}.png`) }); }
    // (Leaving the page lets go of its subscriptions.)
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForFunction(() => window.__subs === 0 && window.__btSubs === 0);
    check(`${vp.tag}: leaving lets go of the subscriptions`, true);
    await ctx.close();
  }
  {
    const { ctx, p } = await open('linuxOpen');
    await p.waitForSelector('.bat-card');
    check('Linux, nothing closed: no access card', !(await p.$('.bat-plat')));
    await ctx.close();
  }
  {
    const { ctx, p } = await open('linuxUnsaved');
    await p.waitForSelector('.bat-plat');
    check('the rule not saved: said calmly, no commands', !!(await p.$('.bat-plat [data-saved="no"]')) && (await p.$$('.bat-plat code')).length === 0);
    await ctx.close();
  }
  {
    const { ctx, p } = await open('linuxEmpty');
    await p.waitForSelector('.bat-empty[data-state="empty"]');
    const t = await p.textContent('.bat-empty');
    check('Linux empty state: BlueZ and the kernel, never Windows', noWindows(t) && t.includes('BlueZ'), t);
    await shot(p, 'linux-empty');
    await ctx.close();
  }
  for (const vp of [{ width: 1280, height: 800, tag: 'pc' }, { width: 360, height: 780, tag: 'narrow' }]) {
    const { ctx, p } = await open('mac', vp);
    await p.waitForSelector('.bat-plat[data-plat="mac"]');
    const t = await p.textContent('.bat-plat');
    check(`${vp.tag}: the Mac note: what macOS reports, the readers not yet`, t.includes('macOS') && t.includes(AR ? 'لم تصل إلى ماك بعدُ' : 'not on macOS yet'), t);
    check(`${vp.tag}: a Mac has no controller or mice switches`, !(await p.$('.bat-pads')) && !(await p.$('.bat-fams')));
    check(`${vp.tag}: no sideways overflow`, (await overflow(p)) <= 1);
    if (vp.tag === 'pc') {
      await p.click('.bat-plat [data-act="btSettings"]');
      await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'btOpenSettings'));
      check('its button opens the system\'s Bluetooth settings', true);
      const parts = await p.$$eval('.bat-card[data-key="bt:AA:BB:CC:DD:EE:01"] .bat-part', (els) => els.length);
      check('earbuds from the Bluetooth report: their parts', parts === 3, parts);
    }
    await p.$eval('.bat-plat', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(100);
    if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `batP1-mac-${vp.tag}-${lang}.png`) }); }
    await ctx.close();
  }
  {
    const { ctx, p } = await open('macEmpty');
    await p.waitForSelector('.bat-empty[data-state="empty"]');
    const t = await p.textContent('.bat-empty');
    check('Mac empty state: what macOS reports, never Windows', noWindows(t) && t.includes('macOS'), t);
    await shot(p, 'mac-empty');
    await ctx.close();
  }
  await br.close(); web.close();
  console.log(errors.length ? `FAILED: ${errors.length}` : 'all passed');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
