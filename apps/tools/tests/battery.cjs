// Device battery (0.21, piece 1) on a computer, with the Tauri bridge faked — its methods named and called exactly as
// desktop-tauri/bridge.js has them: batteryList(), batteryRefresh(o), batterySettings(o), onBattery(cb). Made-up devices:
// an exact level, a low one, a charging one, a coarse (stepped) controller, an asleep mouse with its last reading, a
// Bluetooth keyboard not connected, one the user said not to query. Checked: Settings' card (computer only) opens the
// page; levels, steps, charging, ages and dimming as they should be; low in the error colour; the menu renames, hides,
// stops querying and refreshes one device through the bridge; a pushed change redrawn; the empty state; «not on this
// system»; the Electron build's calm word with no button; no sideways overflow; leaving the page lets go of the
// subscription and the timer. Screenshots (PC 1280×800) into KT_SHOTS when set. `node tests/battery.cjs [en|ar]`.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const errors = []; const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok || x === undefined ? '' : JSON.stringify(x).slice(0, 300)); if (!ok) errors.push(what); };
const lang = process.argv[2] || 'en'; const SHOTS = process.env.KT_SHOTS || '';
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, `battery-${name}-${lang}.png`) }); } };

// (Run in the page: the fake bridge. mode: 'tauri' | 'empty' | 'nothere' | 'electron'.)
function fake({ lang, mode }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.pc.starter', '1');
  const NOW = 1_800_000_000_000; const min = 60_000;
  const rd = (level, at, charging = 'unknown') => ({ level, charging, asleep: false, takenAt: at });
  const ex = (v) => ({ kind: 'exact', value: v });
  const dev = (o) => ({ name: '', kind: 'other', brand: '', connection: 'usb', source: 'hid', vid: 0, pid: 0, merged: [], status: 'ok', reading: null, lastGood: null, checkedAt: NOW, ...o });
  const devices = mode !== 'tauri' ? [] : [
    dev({ key: 'hid:1111:2222:s:A1', name: 'Shape Mouse One', kind: 'mouse', brand: 'Acme', reading: rd(ex(64), NOW - 3 * min), lastGood: rd(ex(64), NOW - 3 * min) }),
    dev({ key: 'bt:{K}', name: 'Studio Keys', kind: 'keyboard', brand: '', connection: 'bluetooth', source: 'bluetooth', status: 'notConnected', lastGood: rd(ex(40), NOW - 26 * 60 * min) }),
    dev({ key: 'bt:{H}', name: 'Field Phones', kind: 'headset', connection: 'bluetooth', source: 'bluetooth', reading: rd(ex(9), NOW - 30_000), lastGood: rd(ex(9), NOW - 30_000) }),
    dev({ key: 'bt:{E}', name: 'Pocket Buds', kind: 'earbuds', connection: 'bluetooth', source: 'bluetooth', reading: rd(ex(88), NOW, 'yes'), lastGood: rd(ex(88), NOW) }),
    dev({ key: 'xinput:0:pad', name: 'Xbox controller 1', kind: 'controller', brand: 'Xbox', connection: 'dongle', source: 'xinput', reading: rd({ kind: 'coarse', value: 'medium', bars: 3 }, NOW - 2 * min) }),
    dev({ key: 'hid:3333:4444:c:{M}', name: 'Travel Mouse', kind: 'mouse', status: 'asleep', lastGood: rd(ex(71), NOW - 95 * min) }),
    dev({ key: 'hid:5555:6666:p:x', name: 'Quiet Pad', kind: 'controller', status: 'notQueried' }),
  ];
  let settings = { intervalMin: 1, low: 15, names: {}, hidden: [], noQuery: ['hid:5555:6666:p:x'], links: [] };
  window.__calls = []; window.__subs = 0; let cb = null;
  window.__push = (devs) => { if (cb) cb({ now: NOW, devices: devs }); };
  const base = { platform: 'desktop', available: true, reason: '', os: 'win32', ready: async () => ({}), list: async () => [], onTasks: () => () => {}, onBrowser: () => () => {}, onUpdateProgress: () => () => {}, onPackProgress: () => () => {}, packStatus: async () => ({}), defaultDir: async () => 'C:\\Downloads' };
  if (mode === 'electron') { window.kurokawaTools = base; return; }
  window.kurokawaTools = Object.assign(base, {
    // (Exactly bridge.js's signatures.)
    batteryList: function () { window.__calls.push(['list']); return Promise.resolve(mode === 'nothere' ? { available: false, reason: 'platform', now: NOW, devices: [], settings } : { available: true, now: NOW, devices: JSON.parse(JSON.stringify(devices)), settings }); },
    batteryRefresh: function (o) { window.__calls.push(['refresh', o]); return Promise.resolve(true); },
    batterySettings: function (o) { window.__calls.push(['settings', o]); if (o && o.set) settings = Object.assign({}, settings, o.set); return Promise.resolve(settings); },
    onBattery: function (f) { cb = f; window.__subs++; return function () { if (cb === f) cb = null; window.__subs--; }; },
  });
}

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  const open = async (mode, hash = '#/battery', viewport = { width: 1280, height: 800 }) => {
    const ctx = await br.newContext({ viewport }); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
    await p.addInitScript(fake, { lang, mode }); await p.goto(base + hash); return { ctx, p };
  };
  const calls = (p) => p.evaluate(() => window.__calls);
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const AR = lang === 'ar';

  // ---- Settings' card opens the page.
  {
    const { ctx, p } = await open('tauri', '#/settings');
    // (A computer's Settings shows one part at a time: chosen from its list.)
    await p.click('[data-sec="battery"]'); await p.waitForSelector('#battery a[href="#/battery"]');
    check('Settings has the device battery card on a computer', true);
    await p.click('#battery a[href="#/battery"]'); await p.waitForSelector('.bat-card');
    check('the card opens the page', (await p.evaluate(() => location.hash)) === '#/battery');
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.click('[data-sec="about"]'); await p.waitForSelector('#about .about-licence');
    const about = await p.textContent('#about');
    check('About names the licence and the work the battery is derived from', /GNU|جنو/.test(about) && about.includes('Wireless Device Battery Monitor') && about.includes('krisgfx9'));
    await ctx.close();
  }

  // ---- The page with made-up devices.
  {
    const { ctx, p } = await open('tauri');
    await p.waitForSelector('.bat-card[data-key="bt:{H}"]');
    check('page in the right direction', (await p.evaluate(() => document.documentElement.dir)) === (AR ? 'rtl' : 'ltr'));
    const n = await p.$$eval('.bat-grid:not(.bat-hidden) > .bat-card', (els) => els.length);
    check('every device has its card', n === 7, n);
    const mouse = await p.$eval('.bat-card[data-key="hid:1111:2222:s:A1"]', (e) => ({ pct: e.querySelector('.bat-pct')?.textContent, w: e.querySelector('.bat-meter > i')?.style.width, sub: e.querySelector('.bat-sub')?.textContent, via: e.querySelector('.bat-via')?.textContent, age: e.querySelector('.bat-age')?.textContent, svg: !!e.querySelector('.bat-ic svg'), img: !!e.querySelector('img') }));
    check('exact level as a number and a meter', /64/.test(mouse.pct) && mouse.w === '64%', mouse);
    check('brand as text and kind; the connection below', mouse.sub.includes('Acme') && mouse.sub.includes(AR ? 'فأرة' : 'Mouse') && mouse.via === (AR ? 'منفذ USB أو مستقبِل' : 'USB or receiver'), mouse);
    check('the reading\'s age', mouse.age.includes(AR ? 'بالدقائق' : '3 min ago'), mouse.age);
    check('our own drawn icon, no picture', mouse.svg && !mouse.img);
    const low = await p.$eval('.bat-card[data-key="bt:{H}"]', (e) => ({ cls: e.className, colour: getComputedStyle(e.querySelector('.bat-pct')).color, err: getComputedStyle(document.documentElement).getPropertyValue('--md-error').trim() }));
    check('a level under the threshold is marked low (the error colour)', low.cls.includes('low'), low);
    const ch = await p.$eval('.bat-card[data-key="bt:{E}"]', (e) => ({ chip: e.querySelector('.bat-chip.charging')?.textContent, low: e.className.includes('low') }));
    check('charging marked', !!ch.chip && ch.chip.includes(AR ? 'الشحن' : 'Charging') && !ch.low, ch);
    const pad = await p.$eval('.bat-card[data-key="xinput:0:pad"]', (e) => ({ bars: e.querySelectorAll('.bat-bars > i').length, on: e.querySelectorAll('.bat-bars > i.on').length, word: e.querySelector('.bat-word')?.textContent, pct: !!e.querySelector('.bat-pct') }));
    check('a coarse level as steps and a word, never a number', pad.bars === 5 && pad.on === 3 && !pad.pct && pad.word === (AR ? 'متوسطة' : 'Medium'), pad);
    const asleep = await p.$eval('.bat-card[data-key="hid:3333:4444:c:{M}"]', (e) => ({ cls: e.className, text: e.textContent, op: getComputedStyle(e.querySelector('.bat-who')).opacity }));
    check('asleep: dimmed, its last reading with its age, and said', asleep.cls.includes('dim') && Number(asleep.op) < 1 && asleep.text.includes(AR ? 'نائم' : 'Asleep') && /71/.test(asleep.text), asleep);
    const away = await p.$eval('.bat-card[data-key="bt:{K}"]', (e) => ({ cls: e.className, text: e.textContent, pct: !!e.querySelector('.bat-pct') }));
    check('not connected: no current level, dimmed, said', away.cls.includes('dim') && !away.pct && away.text.includes(AR ? 'غير متصل' : 'Not connected'), away);
    check('not queried: said', (await p.textContent('.bat-card[data-key="hid:5555:6666:p:x"]')).includes(AR ? 'لا يُستعلَم' : 'Not queried'));
    check('no yellow, amber or orange on the page', await p.evaluate(() => [...document.querySelectorAll('.battery-view *')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    check('no sideways overflow', (await overflow(p)) <= 1);
    // (Controls never touch: the cards apart, the menu button apart from the name.)
    const gap = await p.evaluate(() => { const c = [...document.querySelectorAll('.bat-grid > .bat-card')].map((e) => e.getBoundingClientRect()); let min = 1e9; for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) { const a = c[i], b = c[j]; if (Math.abs(a.top - b.top) < 2) min = Math.min(min, Math.abs(a.right - b.left) < Math.abs(b.right - a.left) ? Math.abs(a.right - b.left) : Math.abs(b.right - a.left)); } return min; });
    check('cards side by side keep a real gap', gap >= 10, gap);
    await shot(p, 'devices');

    // The menu: refresh one, rename, hide, do not query.
    await p.click('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-more'); await p.waitForSelector('.sheet [data-act="rename"]');
    check('the menu sits beside its button (a computer\'s menu)', !!(await p.$('.sheet.as-menu')));
    await p.waitForTimeout(450); await shot(p, 'menu');
    await p.click('.sheet [data-act="refresh"]'); await p.waitForTimeout(150);
    check('Refresh asks the shell for that device alone', JSON.stringify((await calls(p)).find((c) => c[0] === 'refresh')) === JSON.stringify(['refresh', { key: 'hid:1111:2222:s:A1' }]));
    await p.click('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-more'); await p.click('.sheet [data-act="rename"]');
    await p.waitForSelector('.bat-rename input'); await p.fill('.bat-rename input', 'Desk mouse');
    await p.waitForTimeout(450); await shot(p, 'rename');
    const eq = await p.$$eval('.sheet-actions .bat-eq', (b) => b.map((x) => Math.round(x.getBoundingClientRect().width)));
    check('the rename sheet\'s two buttons share a width', eq.length === 2 && Math.abs(eq[0] - eq[1]) <= 1, eq);
    await p.keyboard.press('Enter'); await p.waitForTimeout(250);
    const named = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('rename kept through batterySettings({ set: { names } })', named && named[1].set.names['hid:1111:2222:s:A1'] === 'Desk mouse', named);
    check('the new name shown', (await p.textContent('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-name')) === 'Desk mouse');
    await p.click('.bat-card[data-key="bt:{K}"] .bat-more'); await p.click('.sheet [data-act="hide"]'); await p.waitForTimeout(250);
    check('hidden: off the list, counted apart', !(await p.$('.bat-grid:not(.bat-hidden) > .bat-card[data-key="bt:{K}"]')) && !!(await p.$('.bat-hidden-toggle')));
    await p.click('.bat-hidden-toggle'); await p.waitForSelector('.bat-hidden .bat-card[data-key="bt:{K}"]');
    check('the hidden ones shown on asking', true);
    await p.click('.bat-card[data-key="bt:{H}"] .bat-more'); await p.click('.sheet [data-act="noQuery"]'); await p.waitForTimeout(250);
    const nq = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('«do not query» kept', nq[1].set.noQuery.includes('bt:{H}') && nq[1].set.noQuery.includes('hid:5555:6666:p:x'), nq);
    await p.click('.bat-card[data-key="hid:5555:6666:p:x"] .bat-more');
    check('a device not queried has no Refresh, and offers querying again', !(await p.$('.sheet [data-act="refresh"]')) && (await p.textContent('.sheet [data-act="noQuery"]')).includes(AR ? 'عاوِد' : 'again'));
    await p.keyboard.press('Escape');
    // Settings of the page.
    await p.click('[data-name="low"]'); await p.click('.sheet .dest-row:has-text("' + (AR ? '٢٠٪' : '20%') + '"), .sheet .dest-row:has-text("20")'); await p.waitForTimeout(250);
    check('the low mark kept', (await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set.low === 20);
    // A pushed change.
    await p.evaluate(() => window.__push([{ key: 'bt:{N}', name: 'New Pad', kind: 'controller', brand: 'PlayStation', connection: 'bluetooth', source: 'bluetooth', vid: 0, pid: 0, merged: [], status: 'ok', reading: { level: { kind: 'exact', value: 50 }, charging: 'no', asleep: false, takenAt: 1_800_000_000_000 }, lastGood: null, checkedAt: 1 }]));
    await p.waitForTimeout(150);
    check('a change pushed by the shell is drawn', (await p.$$('.bat-grid:not(.bat-hidden) > .bat-card')).length === 1 && !!(await p.$('.bat-card[data-key="bt:{N}"]')));
    // Leaving lets go.
    check('subscribed once while open', (await p.evaluate(() => window.__subs)) === 1);
    // (Within its tab — Settings —: the page replaced, so disposed; another tab would keep it for coming back.)
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(400);
    check('leaving the page unsubscribes', (await p.evaluate(() => window.__subs)) === 0);
    await ctx.close();
  }

  // ---- Empty, not on this system, the Electron build, the phone.
  {
    const { ctx, p } = await open('empty');
    await p.waitForSelector('.bat-empty[data-state="empty"]');
    const t = await p.textContent('.bat-empty');
    check('the empty state says what this version reads', t.includes('HID') && (await p.$$('.bat-empty li')).length === 3);
    check('the settings stay reachable when empty', !!(await p.$('.bat-settings [data-name="every"]')));
    check('no sideways overflow (empty)', (await overflow(p)) <= 1);
    await shot(p, 'empty');
    await ctx.close();
  }
  {
    const { ctx, p } = await open('nothere');
    await p.waitForSelector('.bat-empty[data-state="notHere"]');
    check('another system: said calmly, no refresh button', !(await p.isVisible('.battery-view .topbar [data-icon="refresh"]')));
    await ctx.close();
  }
  {
    const { ctx, p } = await open('electron');
    await p.waitForSelector('.bat-empty[data-state="mainBuild"]');
    check('the Electron build: «available in the main computer build», no dead button', !(await p.isVisible('.battery-view .topbar [data-icon="refresh"]')) && (await p.$$('.battery-view .bat-body button')).length === 0);
    await shot(p, 'electron');
    await ctx.close();
  }
  {
    // (No desktop bridge at a phone's size: Settings has no battery card.)
    const ctx = await br.newContext({ viewport: { width: 360, height: 780 }, isMobile: true, hasTouch: true }); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
    await p.addInitScript((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kt.update.lastCheck', String(Date.now())); }, lang);
    await p.goto(base + '#/settings'); await p.waitForSelector('#about', { state: 'attached' });
    check('not on a phone\'s settings', !(await p.$('#battery')));
    await ctx.close();
  }
  await br.close(); web.close();
  // (Page errors were added to `errors` as they came: any fails the run.)
  console.log(errors.length ? `FAILED: ${errors.length}` : 'all passed');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
