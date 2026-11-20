// Device battery on the phone (0.21 P2, Android) with KtPlugin faked — the same method names and arguments as
// native/android/KtPlugin.java: batteryPhoneState(), batteryPhoneAsk(), batteryPhoneOpen({ what }),
// batteryPhoneConfig({ set, labels }), batteryPhoneWatch({ on }), notifyAccess({ ask }), and the «btBattery» event.
// Made-up devices only. Checked: «Nearby devices» explained first and asked only on «Allow» (the button waits while
// Android's dialog is open); refused — «Ask again»; refused for good — App info; Bluetooth off, none on the device, no
// paired devices — calm cards with «Bluetooth settings» where it helps; the list — connected first, our drawing per kind
// (a watch its own), the level exact or «unknown», a low one marked, a device away dimmed with its last known level and
// when it was last connected; a level changed by the event redrawn; refresh; the notices' switch (asking for
// notifications) and the low mark sent to the plugin with the notices' words in the page's language; the page watched
// while open and let go when left. None of the computer's options here (tray, taskbar, start with the system, family
// switches, the Linux / macOS cards), and the reverse: the computer's page never opens the phone's. Settings on Android
// lists it with the phone's words. 360×800, no sideways overflow, no touching buttons. Screenshots into KT_SHOTS
// (light and dark), prefix batP2-. `node tests/batphone.cjs [en|ar]` (KT_VIEW=412x915 for another phone size).
// 0.22.1: connected as the public sources say (a device whose hidden call was refused but whose A2DP link is up reads
// «Connected · Audio»), the links on the chip; an event changes one card and only that card is drawn again; a card
// tapped opens its details (rows known only — none «unknown»); Bluetooth turned off by an event shows the off card, on
// again the list; the page hidden lets Android's sources go and shown again takes them back.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const errors = []; const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok || x === undefined ? '' : JSON.stringify(x).slice(0, 300)); if (!ok) errors.push(what); };
const VIEW = (process.env.KT_VIEW || '360x800').split('x').map(Number);
const lang = process.argv[2] || 'en'; const AR = lang === 'ar'; const SHOTS = process.env.KT_SHOTS || '';
const shot = async (p, name) => {
  if (!SHOTS) return; fs.mkdirSync(SHOTS, { recursive: true });
  for (const scheme of ['light', 'dark']) {
    await p.emulateMedia({ colorScheme: scheme }); await p.waitForTimeout(250); await p.screenshot({ path: path.join(SHOTS, `batP2-${name}-${lang}-${scheme}.png`), fullPage: true });
    // (The page scrolls inside its body: its end too, when there is more below.)
    const more = await p.evaluate(() => { const b = document.querySelector('.bp-body'); if (!b || b.scrollHeight <= b.clientHeight + 4) return false; b.scrollTop = b.scrollHeight; return true; });
    if (more) { await p.waitForTimeout(150); await p.screenshot({ path: path.join(SHOTS, `batP2-${name}-end-${lang}-${scheme}.png`) }); await p.evaluate(() => { document.querySelector('.bp-body').scrollTop = 0; }); }
  }
  await p.emulateMedia({ colorScheme: 'light' });
};

// (Run in the page. mode: 'ask' | 'blocked' | 'list' | 'empty' | 'off' | 'noBt'.)
function fake({ lang, mode }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.update.lastCheck', String(Date.now()));
  const NOW = 1_800_000_000_000; const min = 60_000;
  const dev = (o) => ({ name: '', kind: 'other', connected: false, level: -1, source: '', seenAt: 0, lastLevel: -1, lastLevelAt: 0, ...o });
  const devices = mode === 'empty' ? [] : [
    dev({ key: 'AA:00:00:00:00:04', name: 'Runner Watch', kind: 'watch', connected: false, seenAt: NOW - 3 * min, lastLevel: 40, lastLevelAt: NOW - 3 * min }),
    // (Its hidden isConnected refused by Android, its A2DP and hands-free proxies saying connected: KtBattery sends connected.)
    dev({ key: 'AA:00:00:00:00:01', name: 'Field Headset', kind: 'headset', connected: true, level: 82, source: 'system', seenAt: NOW, profiles: ['audio', 'calls'],
      alias: 'Field Headset', sysName: 'FH-200 Test', type: 'dual', bond: 'bonded', major: 'audioVideo', minor: 'headphones', services: ['audioSink', 'handsFree', 'remote', 'battery'], codec: 'AAC',
      lastLevel: 82, lastLevelAt: NOW - 2 * min, lastSource: 'system', firstSeen: NOW - 3 * 24 * 60 * min }),
    dev({ key: 'AA:00:00:00:00:02', name: 'Lake Buds', kind: 'earbuds', connected: true, level: 12, source: 'hfp', seenAt: NOW, profiles: ['audio'], parts: { left: 70, right: 60, case: 40 } }),
    dev({ key: 'AA:00:00:00:00:03', name: 'Pad One', kind: 'controller', connected: true, level: -1, seenAt: NOW }),
    dev({ key: 'AA:00:00:00:00:05', name: 'Desk Keys', kind: 'keyboard', connected: false }),
    dev({ key: 'AA:00:00:00:00:06', name: 'Garden Box', kind: 'speaker', connected: false, seenAt: NOW - 26 * 60 * min }),
  ];
  const S = window.__bp = { calls: [], listeners: [], cfg: { notify: false, low: 15, marks: {} }, access: mode === 'ask' ? 'ask' : mode === 'blocked' ? 'blocked' : 'granted', on: mode !== 'off', adapter: mode !== 'noBt', devices };
  const state = () => ({ sdk: 34, now: NOW, adapter: S.adapter, on: S.on, access: S.access, config: { ...S.cfg }, devices: S.access === 'granted' ? S.devices.map((d) => ({ ...d })) : [] });
  window.__bpFire = () => { const st = state(); for (const l of S.listeners) l(st); };
  const api = {
    addListener: (ev, fn) => { if (ev === 'btBattery') S.listeners.push(fn); return { remove() { S.listeners = S.listeners.filter((x) => x !== fn); S.calls.push(['unlisten']); } }; },
    list: async () => ({ tasks: [] }),
    batteryPhoneState: async () => { S.calls.push(['state']); return state(); },
    batteryPhoneAsk: async () => { S.calls.push(['ask']); if (S.access === 'granted') return { access: 'granted' }; if (S.access === 'blocked') return { access: 'blocked' }; return { access: 'asking' }; },
    batteryPhoneOpen: async (o) => { S.calls.push(['open', o.what]); },
    batteryPhoneConfig: async (o) => { S.calls.push(['config', o.set ?? null, o.labels ?? null]); if (o.set) Object.assign(S.cfg, o.set); return { ...S.cfg }; },
    batteryPhoneWatch: async (o) => { S.calls.push(['watch', o.on]); },
    notifyAccess: async (o) => { S.calls.push(['notifyAccess', !!o.ask]); return { granted: true }; },
  };
  const plugin = new Proxy(api, { get: (t, k) => (k in t ? t[k] : k === 'then' ? undefined : async () => ({})) });
  window.Capacitor = { isNativePlatform: () => true, getPlatform: () => 'android', Plugins: { KurokawaTools: plugin }, PluginHeaders: [] };
}

(async () => {
  const web = serve().listen(0); const base = `http://127.0.0.1:${web.address().port}/`;
  const br = await chromium.launch();
  const open = async (mode, route = '#/battery') => {
    const ctx = await br.newContext({ viewport: { width: VIEW[0], height: VIEW[1] }, isMobile: true, hasTouch: true }); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', (e) => errors.push(`${mode}: ${e.message}`));
    await p.addInitScript(fake, { lang, mode }); await p.goto(base + route);
    return { ctx, p };
  };
  const calls = (p) => p.evaluate(() => window.__bp.calls);
  const noOverflow = async (p, what) => { const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })); check(`${what}: no sideways overflow at 360 px`, o.sw <= o.cw, o); };
  const noPcBits = async (p, what) => {
    const pc = await p.evaluate(() => ['.bat-bg', '.bat-tb', '.bat-nt', '.bat-pads', '.bat-fams', '.bt-panel', '[data-plat]', '.sys-card', '[data-row="background"]', '[data-row="startup"]', '[data-row="strip"]'].filter((s) => document.querySelector(s)));
    const txt = await p.textContent('.bp-view');
    check(`${what}: none of the computer's options (tray, taskbar, start with the system, families, Linux/macOS)`, !pc.length && !/Taskbar|taskbar|tray|Start with|شريط المهام|علبة النظام|Linux|macOS|لينكس|ماك/.test(txt), { pc, txt: txt.slice(0, 200) });
  };

  // ---- «Nearby devices»: explained, asked on «Allow», refused, asked again, allowed.
  {
    const { ctx, p } = await open('ask');
    await p.waitForSelector('.bp-state[data-state="permission"]');
    let c = await calls(p);
    check('the explanation first, nothing asked by itself', !c.some((x) => x[0] === 'ask'));
    const txt = await p.textContent('.bp-state');
    check('the explanation names the permission and says it only reads, no location', AR ? /الأجهزة المجاورة/.test(txt) && /موقعك/.test(txt) && /[؀-ۿ]/.test(txt) : /Nearby devices/.test(txt) && /location/.test(txt), txt);
    check('the page watched while open; the notices\' words handed over in the page\'s language', c.some((x) => x[0] === 'watch' && x[1] === true) && c.some((x) => x[0] === 'config' && x[2] && x[2].title.includes('{name}') && x[2].text.includes('{n}') && (AR ? /[؀-ۿ]/.test(x[2].channel) : x[2].channel === 'Device batteries')), c.filter((x) => x[0] === 'config'));
    check('no refresh before the permission', !(await p.isVisible('.bp-view .topbar [data-icon="refresh"]')));
    await noOverflow(p, 'permission'); await noPcBits(p, 'permission');
    await shot(p, 'permission');
    await p.click('[data-act="allow"]'); await p.waitForSelector('[data-act="allow"][disabled]');
    c = await calls(p); check('«Allow» asks Android; the button waits for the answer', c.some((x) => x[0] === 'ask') && (await p.textContent('[data-act="allow"]')).trim() === (AR ? 'في انتظار جوابك…' : 'Waiting for your answer…'));
    // (Android's answer: refused — the event sent when the app comes back.)
    await p.evaluate(() => { window.__bp.access = 'refused'; window.__bpFire(); });
    await p.waitForSelector('.bp-state[data-state="refused"]');
    check('refused: a calm card with «Ask again»', (await p.textContent('.bp-state[data-state="refused"] [data-act="allow"]')).trim() === (AR ? 'اطلب الإذن ثانيةً' : 'Ask again'));
    await noOverflow(p, 'refused');
    await shot(p, 'refused');
    await p.click('[data-act="allow"]'); await p.waitForSelector('[data-act="allow"][disabled]');
    await p.evaluate(() => { window.__bp.access = 'granted'; window.__bpFire(); });
    await p.waitForSelector('.bp-card');
    check('allowed: the devices listed', (await p.$$('.bp-card')).length === 6);
    await ctx.close();
  }
  // ---- Refused for good: App info.
  {
    const { ctx, p } = await open('blocked');
    await p.waitForSelector('.bp-state[data-state="blocked"]');
    await p.click('[data-act="app"]'); await p.waitForTimeout(150);
    check('refused for good: «Open app settings» opens App info', (await calls(p)).some((x) => x[0] === 'open' && x[1] === 'app'));
    await shot(p, 'blocked');
    await ctx.close();
  }
  // ---- The list.
  {
    const { ctx, p } = await open('list');
    await p.waitForSelector('.bp-card');
    const cards = await p.$$eval('.bp-card', (els) => els.map((e) => ({ key: e.dataset.key, kind: e.dataset.kind, con: e.dataset.connected, level: e.dataset.level, low: e.classList.contains('low'), away: e.classList.contains('away'), pic: e.querySelector('.bp-ic svg')?.dataset.picture, name: e.querySelector('.bp-name').textContent, sub: e.querySelector('.bp-sub').textContent, lvl: e.querySelector('.bp-level').textContent, foot: e.querySelector('.bp-foot')?.textContent ?? '' })));
    check('connected first', cards.slice(0, 3).every((x) => x.con === 'true') && cards.slice(3).every((x) => x.con === 'false'), cards.map((x) => x.name));
    const by = Object.fromEntries(cards.map((x) => [x.name, x]));
    check('our drawing per kind (a pad for a controller, a watch of its own)', by['Field Headset'].pic === 'headset' && by['Lake Buds'].pic === 'earbuds' && by['Pad One'].pic === 'pad' && by['Runner Watch'].pic === 'watch' && by['Desk Keys'].pic === 'keyboard' && by['Garden Box'].pic === 'speaker', cards.map((x) => x.pic));
    check('an exact level, «connected»', by['Field Headset'].lvl === (AR ? '82٪' : '82%') && by['Field Headset'].sub.includes(AR ? 'متصل' : 'Connected'), by['Field Headset']);
    check('12% under the 15% mark: low', by['Lake Buds'].low && !by['Field Headset'].low);
    check('connected without a level: «unknown», and why', by['Pad One'].lvl === (AR ? 'المستوى مجهول' : 'Level unknown') && by['Pad One'].foot === (AR ? 'لا يُخبر هذا الجهازُ أندرويدَ بمستوى بطاريته.' : 'This device does not tell Android its level.'), by['Pad One']);
    check('away: dimmed, its last known level and when it was last connected', by['Runner Watch'].away && by['Runner Watch'].lvl.includes(AR ? '40٪' : '40%') && by['Runner Watch'].foot === (AR ? 'آخر اتصال: قبل 3 دقائق' : 'Last connected 3 min ago') && by['Runner Watch'].sub.includes(AR ? 'ساعة' : 'Watch'), by['Runner Watch']);
    check('never seen connected: said', by['Desk Keys'].foot === (AR ? 'لم يُرَ متصلًا بعد' : 'Not seen connected yet'), by['Desk Keys']);
    check('the count', (await p.textContent('.bp-count')) === (AR ? 'الأجهزة المقترنة — العدد: 6' : 'Paired devices: 6'));
    check('Arabic digits are 0-9', !/[٠-٩]/.test(await p.textContent('.bp-view')));
    await noOverflow(p, 'list'); await noPcBits(p, 'list');
    // (Buttons never touch: the count's row and the card's own.)
    const gap = await p.evaluate(() => { const a = document.querySelector('.bp-count').getBoundingClientRect(), b = document.querySelector('.bp-head [data-act="bluetooth"]').getBoundingClientRect(); return { overlap: !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top) }; });
    check('the count and «Bluetooth settings» do not touch', !gap.overlap, gap);
    await shot(p, 'list');
    // A level changed (the event): that card alone drawn again.
    await p.evaluate(() => { for (const el of document.querySelectorAll('.bp-card')) el.__was = true; window.__bp.devices[2].level = 9; window.__bpFire(); });
    await p.waitForFunction(() => document.querySelector('.bp-card[data-key="AA:00:00:00:00:02"]')?.dataset.level === '9');
    const kept = await p.$$eval('.bp-card', (els) => els.map((e) => [e.dataset.key, !!e.__was]));
    check('the event updated one card; the others untouched (not rebuilt)', kept.filter((x) => !x[1]).map((x) => x[0]).join() === 'AA:00:00:00:00:02' && kept.length === 6, kept);
    // Connected by the public sources (hidden call refused): the chip says so, with its links.
    check('refused hidden call + A2DP up: «Connected · Audio, Calls»', by['Field Headset'].con === 'true' && (await p.textContent('.bp-card[data-key="AA:00:00:00:00:01"] .bp-chip')) === (AR ? 'متصل · الصوت، المكالمات' : 'Connected · Audio, Calls'), await p.textContent('.bp-card[data-key="AA:00:00:00:00:01"] .bp-chip'));
    check('a device away: «Not connected», no links', (await p.textContent('.bp-card[data-key="AA:00:00:00:00:06"] .bp-chip')) === (AR ? 'غير متصل' : 'Not connected'));
    // Details.
    await p.click('.bp-card[data-key="AA:00:00:00:00:01"]'); await p.waitForSelector('.sheet.bp-details');
    const rows = await p.$$eval('.bp-details dt', (els) => els.map((e) => e.dataset.row));
    const val = (id) => p.textContent(`.bp-details dd[data-row="${id}"]`);
    check('details: the rows Android gave, in order', rows.join() === 'alias,name,type,class,bond,links,services,codec,source,read,last,first', rows);
    check('details: words for type, class, links, services', (await val('type')) === (AR ? 'تقليدي ومنخفض الطاقة معًا' : 'Classic and Low Energy') && (await val('class')) === (AR ? 'صوت وصورة · سماعات رأس' : 'Audio and video · Headphones') && (await val('services')).includes(AR ? 'خدمة البطارية' : 'Battery service') && (await val('codec')) === 'AAC', [await val('type'), await val('class'), await val('services')]);
    check('details: nothing said «unknown»', !/unknown|مجهول/i.test(await p.textContent('.bp-details')));
    await noOverflow(p, 'details');
    await shot(p, 'details');
    await p.click('.bp-details .sheet-head [data-icon="close"]'); await p.waitForSelector('.sheet.bp-details', { state: 'detached' });
    await p.click('.bp-card[data-key="AA:00:00:00:00:05"]'); await p.waitForSelector('.sheet.bp-details');
    const few = await p.$$eval('.bp-details dt', (els) => els.map((e) => e.dataset.row));
    check('details of a device Android knows little of: only what it gave (first listed at most)', few.every((r) => ['first', 'last'].includes(r)), few);
    await p.click('.bp-details .sheet-head [data-icon="close"]'); await p.waitForSelector('.sheet.bp-details', { state: 'detached' });
    await p.click('.bp-card[data-key="AA:00:00:00:00:02"]'); await p.waitForSelector('.sheet.bp-details');
    check('true-wireless parts when Android gives them', (await val('parts')) === (AR ? 'اليسرى 70٪ · اليمنى 60٪ · العلبة 40٪' : 'Left 70% · Right 60% · Case 40%'), await val('parts'));
    // (The open sheet follows its device: a new level read fills it again.)
    await p.evaluate(() => { window.__bp.devices[2].parts = { left: 65, right: 60, case: 40 }; window.__bpFire(); });
    await p.waitForFunction(() => /65/.test(document.querySelector('.bp-details dd[data-row="parts"]')?.textContent || ''));
    check('the open details follow the event', true);
    await p.click('.bp-details .sheet-head [data-icon="close"]'); await p.waitForSelector('.sheet.bp-details', { state: 'detached' });
    // Bluetooth turned off (the adapter's broadcast → the event): the off card, not a stale list; on again: the list.
    await p.evaluate(() => { window.__bp.on = false; window.__bpFire(); });
    await p.waitForSelector('.bp-state[data-state="off"]');
    check('Bluetooth off by the event: one clear card, no list left', !(await p.$('.bp-card')));
    await p.evaluate(() => { window.__bp.on = true; window.__bpFire(); });
    await p.waitForSelector('.bp-card');
    check('on again: the list back', (await p.$$('.bp-card')).length === 6);
    // Hidden: Android's sources let go; shown: taken back and read anew.
    let w0 = (await calls(p)).filter((x) => x[0] === 'watch').length;
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForFunction((n) => window.__bp.calls.filter((x) => x[0] === 'watch').length > n, w0);
    check('hidden: the watch let go', (await calls(p)).filter((x) => x[0] === 'watch').slice(-1)[0][1] === false);
    w0 = (await calls(p)).filter((x) => x[0] === 'watch').length;
    await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange')); });
    await p.waitForFunction((n) => window.__bp.calls.filter((x) => x[0] === 'watch').length > n, w0);
    check('shown again: watched again', (await calls(p)).filter((x) => x[0] === 'watch').slice(-1)[0][1] === true);
    // Refresh and «Bluetooth settings».
    const before = (await calls(p)).filter((x) => x[0] === 'state').length;
    await p.click('.bp-view .topbar [data-icon="refresh"]'); await p.waitForTimeout(200);
    check('refresh asks the plugin again', (await calls(p)).filter((x) => x[0] === 'state').length > before);
    await p.click('.bp-head [data-act="bluetooth"]'); await p.waitForTimeout(150);
    check('«Bluetooth settings» opens the system\'s (pairing is there)', (await calls(p)).some((x) => x[0] === 'open' && x[1] === 'bluetooth'));
    // Notices.
    check('notices off by default', !(await p.isChecked('[data-row="notify"] input')));
    check('the limits said calmly (no background service of its own)', (await p.textContent('[data-note="limits"]')).length > 40);
    await p.click('[data-row="notify"]'); await p.waitForTimeout(250);
    let c = await calls(p);
    check('notices on: sent, and notifications asked for', c.some((x) => x[0] === 'config' && x[1] && x[1].notify === true) && c.some((x) => x[0] === 'notifyAccess' && x[1] === true));
    await p.click('[data-name="low"]'); await p.waitForSelector('.sheet .dest-row'); await p.click('.sheet .dest-row:has-text("' + (AR ? '20٪' : '20%') + '")'); await p.waitForTimeout(250);
    c = await calls(p);
    check('the low mark sent (20)', c.some((x) => x[0] === 'config' && x[1] && x[1].low === 20));
    await p.waitForSelector('.sheet', { state: 'detached' }).catch(() => undefined);
    check('the switch stays on after the redraw', await p.isChecked('[data-row="notify"] input'));
    // Leaving the page: let go.
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForSelector('.settings-view');
    await p.waitForTimeout(200); c = await calls(p);
    check('left: the watch let go and the listener removed', c.some((x) => x[0] === 'watch' && x[1] === false) && c.some((x) => x[0] === 'unlisten'));
    // Settings on Android: the card in the phone's words.
    await p.waitForSelector('#battery', { state: 'attached' });
    const hint = await p.textContent('#battery .hint');
    check('Settings on Android: «Device battery» listed in the phone\'s words', hint === (AR ? 'ما بقي من شحنٍ في سماعاتك ومكبِّرات الصوت وأيدي التحكم والساعات المقترنة بهاتفك عبر البلوتوث، كما يُخبر به أندرويد.' : 'How full your Bluetooth headphones, earbuds, speakers, controllers and watches are, as Android reports them.'), hint);
    await ctx.close();
  }
  // ---- Bluetooth off, none on the device, nothing paired.
  for (const [mode, state] of [['off', 'off'], ['noBt', 'noBluetooth'], ['empty', 'empty']]) {
    const { ctx, p } = await open(mode);
    await p.waitForSelector(`.bp-state[data-state="${state}"]`);
    const b = await p.$(`.bp-state[data-state="${state}"] [data-act="bluetooth"]`);
    check(`${mode}: a calm card${mode === 'noBt' ? ', no dead button' : ' with «Bluetooth settings»'}`, mode === 'noBt' ? !(await p.$('.bp-state button')) : !!b);
    if (mode === 'empty') { check('nothing paired: the notices still there', !!(await p.$('[data-row="notify"]'))); await shot(p, 'empty'); }
    if (mode === 'off') await shot(p, 'off');
    await noOverflow(p, mode);
    await ctx.close();
  }
  // ---- The reverse: a computer never opens the phone's page.
  {
    const ctx = await br.newContext({ viewport: { width: 1280, height: 800 } }); await ctx.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 404, body: '' }));
    const p = await ctx.newPage(); p.on('pageerror', (e) => errors.push(`pc: ${e.message}`));
    await p.addInitScript((l) => { localStorage.setItem('kr.lang', l); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.pc.starter', '1'); window.kurokawaTools = { os: 'windows' }; }, lang);
    await p.goto(base + '#/battery'); await p.waitForSelector('.battery-view');
    check('a computer: the computer\'s page, nothing of the phone\'s', !(await p.$('.bp-view')) && !(await p.$('[data-row="notify"]')));
    await ctx.close();
  }
  await br.close(); web.close();
  console.log(errors.length ? `FAILED: ${errors.length}` : 'all passed');
  process.exit(errors.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
