// Piece S1, «System on the taskbar» on the Battery page (the computer's Tauri build), with the Tauri bridge faked — its
// methods named and called exactly as desktop-tauri/bridge.js has them: batteryList(), batteryRefresh(o),
// batterySettings(o), onBattery(cb), sysmonProbe(). Made-up figures only. Checked: the card comes after «Taskbar», every
// value off by default (switches, no native checkbox look, no spinner), waiting for «Keep running in the background»
// and saying so; with it, a value turned on is kept as sysOn (in the order shown), moved up and down as sysOrder (the
// rows follow); the one look at this computer said per value («Now: 12%»), the graphics card named, a value Windows
// does not give said calmly (the CPU temperature without a driver, no graphics card at all); the reading interval
// (1/2/5 s), Celsius or Fahrenheit (the marks follow the unit), what a click does (Task Manager / Tools / nothing),
// before or after the devices, the warm and hot marks kept in °C; the look asked once; nothing touches, the pickers and
// the move buttons share their widths, no sideways overflow, no yellow, amber or orange; on Linux «Windows only for
// now» and nothing else; leaving lets go of the subscription. Screenshots sysS1-card-<lang>-<light|dark> (PC 1280×800)
// into KT_SHOTS when set.
// `node tests/sysmon.cjs [en|ar]`.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const errors = []; const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok || x === undefined ? '' : JSON.stringify(x).slice(0, 300)); if (!ok) errors.push(what); };
const lang = process.argv[2] || 'en'; const SHOTS = process.env.KT_SHOTS || '';
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `sysS1-${name}-${lang}.png`) }); } };

// (Run in the page: the fake bridge. mode: 'win' | 'bare' (no CPU temperature, no graphics card) | 'linux' | 'unknown' (the shell names no OS).)
function fake({ lang, mode }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.pc.starter', '1');
  const NOW = 1_800_000_000_000;
  const devices = [{ key: 'hid:1111:2222:s:A1', name: 'Shape Mouse One', kind: 'mouse', brand: 'Acme', connection: 'usb', source: 'hid', vid: 0, pid: 0, merged: [], status: 'ok', reading: { level: { kind: 'exact', value: 64 }, charging: 'no', asleep: false, takenAt: NOW }, lastGood: null, checkedAt: NOW }];
  // (As battery.rs clean() gives them: the system's settings with their defaults.)
  let settings = { intervalMin: 1, intervalSec: 60, low: 15, names: {}, hidden: [], noQuery: [], links: [], background: false, startup: false, notifyLow: true, notifyFull: false, thresholds: {},
    sysOn: [], sysOrder: ['cpu', 'cpuTemp', 'ram', 'gpu', 'gpuTemp', 'vram', 'drive'], sysUnit: 'c', sysEvery: 2, sysClick: 'taskmgr', sysSide: 'before', sysCpuWarm: 80, sysCpuHot: 90, sysGpuWarm: 80, sysGpuHot: 90, sysDriveWarm: 65, sysDriveHot: 75 };
  const system = { autostart: 'yes', tray: true };
  window.__calls = []; window.__subs = 0; let cb = null;
  const probe = mode === 'bare' ? { available: true, os: 'windows', values: { cpu: 7, cpuTemp: null, ram: 48.4, gpu: null, gpuTemp: null, vram: null, drive: null }, gpu: '' }
    : { available: true, os: 'windows', values: { cpu: 12.3, cpuTemp: 54.2, ram: 61, gpu: 4, gpuTemp: 44.5, vram: 6.2, drive: 38 }, gpu: 'Made-up Graphics 7700' };
  const base = { platform: 'desktop', available: true, reason: '', os: mode === 'linux' ? 'linux' : mode === 'unknown' ? '' : 'windows', ready: async () => ({}), list: async () => [], onTasks: () => () => {}, onBrowser: () => () => {}, onUpdateProgress: () => () => {}, onPackProgress: () => () => {}, packStatus: async () => ({}), defaultDir: async () => 'C:\\Downloads' };
  window.kurokawaTools = Object.assign(base, {
    // (Exactly bridge.js's signatures.)
    batteryList: function () { window.__calls.push(['list']); return Promise.resolve({ available: true, now: NOW, devices: JSON.parse(JSON.stringify(devices)), settings, system, pads: [], mice: [] }); },
    batteryRefresh: function (o) { window.__calls.push(['refresh', o]); return Promise.resolve(true); },
    batterySettings: function (o) { window.__calls.push(['settings', o]); if (o && o.set) settings = Object.assign({}, settings, o.set); return Promise.resolve(settings); },
    // (W2: bridge.js's batteryHistory(o) and batteryHistoryClear(o) — no readings here.)
    batteryHistory: function (o) { window.__calls.push(['history', o]); return Promise.resolve({ key: o.key, on: true, days: 30, now: Date.now(), since: Date.now() - 7 * 864e5, gap: 72e5, points: [], stats: { count: 0, lowest: null, highest: null, first: null, last: null }, estimate: { state: 'none', why: 'collecting' } }); },
    batteryHistoryClear: function (o) { window.__calls.push(['historyClear', o]); return Promise.resolve(false); },
    onBattery: function (f) { cb = f; window.__subs++; return function () { if (cb === f) cb = null; window.__subs--; }; },
    sysmonProbe: function () { window.__calls.push(['probe', arguments.length]); return new Promise((ok) => setTimeout(() => ok(mode === 'linux' || mode === 'unknown' ? { available: false, os: mode === 'linux' ? 'linux' : '', values: {}, gpu: '' } : JSON.parse(JSON.stringify(probe))), 80)); },
  });
}

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  const open = async (mode, scheme = 'light') => {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: scheme }); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
    await p.addInitScript(fake, { lang, mode }); await p.goto(base + '#/battery'); return { ctx, p };
  };
  const calls = (p) => p.evaluate(() => window.__calls);
  const last = async (p) => (await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set;
  const AR = lang === 'ar';
  const rows = (p) => p.$$eval('.bat-sys .bat-sys-row', (r) => r.map((e) => ({ id: e.dataset.metric, on: e.querySelector('input').checked, dis: e.querySelector('input').disabled, role: e.querySelector('input').getAttribute('role'), hint: e.querySelector('small').textContent, up: e.querySelector('[data-act="up"]').disabled, down: e.querySelector('[data-act="down"]').disabled })));

  {
    const { ctx, p } = await open('win');
    await p.waitForSelector('.bat-sys[data-group="system"]');
    check('page in the right direction', (await p.evaluate(() => document.documentElement.dir)) === (AR ? 'rtl' : 'ltr'));
    const order = await p.$$eval('.bat-body > section', (s) => s.map((e) => e.dataset.group || ''));
    check('the card comes right after «Taskbar»', order.indexOf('system') === order.indexOf('taskbar') + 1, order);
    check('its title', (await p.textContent('.bat-sys h3')) === (AR ? 'النظام على شريط المهام' : 'System on the taskbar'));
    let r = await rows(p);
    check('seven values, each a switch, all off by default and waiting for the background', r.length === 7 && r.every((x) => !x.on && x.dis && x.role === 'switch'), r);
    check('… the reason said', (await p.textContent('.bat-sys > .hint')) === (AR ? 'يقتضي تشغيلَ «مواصلة العمل في الخلفية».' : 'Needs «Keep running in the background».'));
    check('… its pickers wait too', await p.$$eval('.bat-sys .pick-btn', (b) => b.length === 10 && b.every((x) => x.disabled)));
    await p.click('.bat-bg [data-row="background"]'); await p.waitForTimeout(250);
    await p.waitForFunction(() => !/…/.test(document.querySelector('.bat-sys [data-metric="cpu"] small')?.textContent || '…'));
    r = await rows(p);
    check('with the background: switches free, still all off', r.every((x) => !x.dis && !x.on), r);
    const hint = (id) => r.find((x) => x.id === id).hint;
    check('what this computer gives, per value', hint('cpu') === (AR ? 'الآن: 12٪' : 'Now: 12%') && hint('cpuTemp') === (AR ? 'الآن: 54 °م' : 'Now: 54 °C') && hint('vram') === (AR ? 'الآن: 6٪' : 'Now: 6%') && hint('drive') === (AR ? 'الآن: 38 °م' : 'Now: 38 °C'), r.map((x) => x.hint));
    check('the graphics card named', (await p.textContent('.bat-sys-gpu')).includes('Made-up Graphics 7700'));
    check('the first cannot go up, the last cannot go down', r[0].up && !r[0].down && r[6].down && !r[6].up, r);
    // Turning values on: kept in the order shown.
    await p.click('.bat-sys [data-row="sys-ram"]'); await p.waitForTimeout(200);
    await p.click('.bat-sys [data-row="sys-cpu"]'); await p.waitForTimeout(200);
    let L = await last(p);
    check('values turned on kept as sysOn, in the order shown', JSON.stringify(L.sysOn) === JSON.stringify(['cpu', 'ram']), L);
    // Moving: the order kept, the rows follow.
    await p.click('.bat-sys [data-metric="ram"] [data-act="up"]'); await p.waitForTimeout(200);
    L = await last(p);
    check('moved up: kept as sysOrder', JSON.stringify(L.sysOrder) === JSON.stringify(['cpu', 'ram', 'cpuTemp', 'gpu', 'gpuTemp', 'vram', 'drive']), L);
    await p.click('.bat-sys [data-metric="cpu"] [data-act="down"]'); await p.waitForTimeout(200);
    r = await rows(p);
    check('moved down: the rows follow', r.map((x) => x.id).join() === 'ram,cpu,cpuTemp,gpu,gpuTemp,vram,drive', r.map((x) => x.id));
    await p.click('.bat-sys [data-row="sys-drive"]'); await p.waitForTimeout(200);
    check('a value turned on later joins in its row\'s place', JSON.stringify((await last(p)).sysOn) === JSON.stringify(['ram', 'cpu', 'drive']));
    // The pickers.
    check('every 2 s by default', (await p.textContent('[data-name="sysEvery"]')) === (AR ? 'كلَّ ثانيتين' : 'Every 2 seconds'));
    await p.click('[data-name="sysEvery"]'); await p.waitForSelector('.sheet .dest-row');
    check('1, 2 or 5 seconds', (await p.$$('.sheet .dest-row')).length === 3);
    await p.click('.sheet .dest-row:nth-child(3)'); await p.waitForTimeout(250);
    check('5 s kept', (await last(p)).sysEvery === 5);
    check('a click opens Task Manager by default', (await p.textContent('[data-name="sysClick"]')) === (AR ? 'يفتح مدير المهام' : 'Opens Task Manager'));
    await p.click('[data-name="sysClick"]'); await p.waitForSelector('.sheet .dest-row');
    check('Task Manager, Tools or nothing', (await p.$$('.sheet .dest-row')).length === 3);
    await p.click('.sheet .dest-row:nth-child(3)'); await p.waitForTimeout(250);
    check('«does nothing» kept', (await last(p)).sysClick === 'nothing');
    await p.click('[data-name="sysSide"]'); await p.waitForSelector('.sheet .dest-row'); await p.click('.sheet .dest-row:nth-child(2)'); await p.waitForTimeout(250);
    check('after the devices: kept', (await last(p)).sysSide === 'after');
    check('marks in °C by default: CPU 80 and 90, the drive 65 and 75', (await p.textContent('[data-name="sysCpuWarm"]')) === (AR ? '80 °م' : '80 °C') && (await p.textContent('[data-name="sysCpuHot"]')) === (AR ? '90 °م' : '90 °C') && (await p.textContent('[data-name="sysDriveWarm"]')) === (AR ? '65 °م' : '65 °C') && (await p.textContent('[data-name="sysDriveHot"]')) === (AR ? '75 °م' : '75 °C'));
    await p.click('[data-name="sysCpuWarm"]'); await p.waitForSelector('.sheet .dest-row');
    const opts = await p.$$eval('.sheet .dest-row .name', (e) => e.map((x) => x.textContent));
    check('CPU marks from 50 to 110 °C in fives', opts.length === 13 && opts[0] === (AR ? '50 °م' : '50 °C'), opts);
    await p.click('.sheet .dest-row:nth-child(8)'); await p.waitForTimeout(250);
    check('a warm mark kept in °C', (await last(p)).sysCpuWarm === 85);
    await p.click('[data-name="sysUnit"]'); await p.waitForSelector('.sheet .dest-row'); await p.click('.sheet .dest-row:nth-child(2)'); await p.waitForTimeout(250);
    check('Fahrenheit kept', (await last(p)).sysUnit === 'f');
    check('… the marks and the readings in °F, the settings still in °C', (await p.textContent('[data-name="sysCpuWarm"]')) === (AR ? '185 °ف' : '185 °F') && (await p.textContent('.bat-sys [data-metric="cpuTemp"] small')) === (AR ? 'الآن: 130 °ف' : 'Now: 130 °F'));
    check('no native number spinner, no plain checkbox', !(await p.$('.bat-sys input[type=number]')) && (await p.$$eval('.bat-sys input[type=checkbox]', (i) => i.every((x) => x.getAttribute('role') === 'switch'))));
    // Design: nothing touches; equal widths; no overflow; no yellow.
    const geo = await p.$$eval('.bat-sys .bat-sys-row, .bat-sys .bat-sys-move, .bat-sys .bat-row, .bat-sys .bat-sys-mark', (rs) => rs.map((r) => { const kids = [...r.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0); let g = 1e9; for (let i = 1; i < kids.length; i++) g = Math.min(g, Math.abs(kids[i].left - kids[i - 1].right), Math.abs(kids[i - 1].left - kids[i].right)); return g; }));
    check('nothing touches in the card', geo.every((g) => g >= 8), geo);
    const pw = await p.$$eval('.bat-sys .bat-row .pick-btn', (b) => b.map((x) => Math.round(x.getBoundingClientRect().width)));
    check('its pickers share a width', pw.length === 4 && pw.every((w) => w === pw[0]), pw);
    const mw = await p.$$eval('.bat-sys .bat-sys-mark .pick-btn', (b) => b.map((x) => Math.round(x.getBoundingClientRect().width)));
    check('the marks\' pickers share a width', mw.length === 6 && mw.every((w) => w === mw[0]), mw);
    const bw = await p.$$eval('.bat-sys .bat-sys-move .icon-btn', (b) => b.map((x) => `${Math.round(x.getBoundingClientRect().width)}x${Math.round(x.getBoundingClientRect().height)}`));
    check('the move buttons are all one size', bw.length === 14 && bw.every((w) => w === bw[0]), bw);
    check('no sideways overflow', (await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)) <= 1);
    check('no yellow, amber or orange in the card', await p.evaluate(() => [...document.querySelectorAll('.bat-sys, .bat-sys *')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    const probes = (await calls(p)).filter((c) => c[0] === 'probe');
    check('the look asked once, with no argument (bridge.js: sysmonProbe())', probes.length === 1 && probes[0][1] === 0, probes);
    await p.$eval('.bat-sys', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(250); await shot(p, 'card-light');
    await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(300); await shot(p, 'card-dark');
    await p.$eval('.bat-sys .bat-sys-mark', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'marks-dark');
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(300);
    check('leaving the page lets go of the subscription', (await p.evaluate(() => window.__subs)) === 0);
    await ctx.close();
  }
  {
    // (No CPU temperature without a driver, no graphics card: said calmly, nothing pretended.)
    const { ctx, p } = await open('bare');
    await p.waitForSelector('.bat-sys');
    await p.waitForFunction(() => !/…/.test(document.querySelector('.bat-sys [data-metric="cpu"] small')?.textContent || '…'));
    const r = await rows(p); const hint = (id) => r.find((x) => x.id === id).hint;
    check('the CPU temperature: Windows gives none without a driver, Tools installs none', hint('cpuTemp') === (AR ? 'لا يُعطيه ويندوز هنا إلا بتعريفٍ، والأدوات لا تُثبِّت تعريفًا؛ فلا يظهر له شيء.' : 'Windows does not give it here without a driver, and Tools installs none; nothing is shown for it.'), hint('cpuTemp'));
    check('no graphics card: said for its three values', ['gpu', 'gpuTemp', 'vram'].every((id) => hint(id) === (AR ? 'لم تُوجَد بطاقةُ رسوميات، فلا يظهر لها شيء.' : 'No graphics card found; nothing is shown for it.')) && !(await p.$('.bat-sys-gpu')), r.map((x) => x.hint));
    check('the drive: said', hint('drive') === (AR ? 'لا يُبلِغ قرصُ النظام برنامجًا عاديًّا بحرارته، فلا يظهر له شيء.' : 'The system drive does not report its temperature to an ordinary program; nothing is shown for it.'));
    check('memory still read', hint('ram') === (AR ? 'الآن: 48٪' : 'Now: 48%'));
    await ctx.close();
  }
  {
    const { ctx, p } = await open('linux');
    await p.waitForSelector('.bat-sys');
    check('Linux: «Windows only for now», nothing else', (await p.textContent('.bat-sys [data-state="notWindows"]')) === (AR ? 'على ويندوز وحده في الوقت الحاضر.' : 'Windows only for now.') && !(await p.$('.bat-sys input, .bat-sys button')));
    check('… and no look asked', !(await calls(p)).some((c) => c[0] === 'probe'));
    await ctx.close();
  }
  {
    // (An OS the shell did not name: not taken for Windows — the same calm line, nothing to switch.)
    const { ctx, p } = await open('unknown');
    await p.waitForSelector('.bat-sys');
    check('unknown OS: «Windows only for now», nothing else', (await p.textContent('.bat-sys [data-state="notWindows"]')) === (AR ? 'على ويندوز وحده في الوقت الحاضر.' : 'Windows only for now.') && !(await p.$('.bat-sys input, .bat-sys button')));
    check('… and no look asked (unknown OS)', !(await calls(p)).some((c) => c[0] === 'probe'));
    await ctx.close();
  }
  await br.close(); web.close();
  console.log(errors.length ? `FAILED: ${errors.length}` : 'all passed');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
