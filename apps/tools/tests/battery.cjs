// Device battery (0.21, pieces 1–2) on a computer, with the Tauri bridge faked — its methods named and called exactly as
// desktop-tauri/bridge.js has them: batteryList(), batteryRefresh(o), batterySettings(o), onBattery(cb). Made-up devices:
// an exact level, a low one, a charging one, a coarse (stepped) controller, an asleep mouse with its last reading, a
// Bluetooth keyboard not connected, one the user said not to query. Checked: Settings' card (computer only) opens the
// page; levels, steps, charging, ages and dimming as they should be; low in the error colour; the menu renames, hides,
// stops querying and refreshes one device through the bridge; a pushed change redrawn; the empty state; «not on this
// system»; the Electron build's calm word with no button; no sideways overflow; leaving the page lets go of the
// subscription and the timer. Piece 2: the «Background» group (switches only: keep running in the background, start
// with the system hidden — needing the first, offered on a Mac too (the shell's LaunchAgent), a refusal from the shell said and drawn back —, low
// and fully-charged notices), the low marks (10/15/20/30; a device's own mark or «no notice» in its menu, and the card's
// red following it), none of it in the Electron build or another system. Screenshots (PC 1280×800) into KT_SHOTS when
// set. Piece 3, «Connect a device» (btList, btScan, btAct, btOpenSettings, onBt — bridge.js's signatures): the paired
// Bluetooth devices with our own drawn pictures (no picture files), connected or not, battery when known, the right
// action per device; connect ok / refused / timed out / cancelled (a busy row with Cancel); a scan with Stop and its new
// devices; pairing asked first with the device's picture, then handed to Windows' own window; Bluetooth off or missing
// said calmly; equal button widths, no touching controls; nothing of it in the Electron build or another system; leaving
// lets go of its subscription and stops a scan. Piece 4, controllers (mode 'pads', made-up pads): each family's own
// drawing (no picture files), a level in steps («7 of 10», as many bars, no number), a charging pad, «needs a query we do
// not send», a family switched off, a receiver with no pad (dimmed); the card menu says the reader and «ported, not yet
// tested» and turns a family's request on only for families that send one; «Controllers» has one switch per such
// family, off by default, kept through batterySettings({ set: { padQueries } }) and followed by a refresh, and names
// the families read by listening alone. Piece 5, mice and keyboards (mode 'mice', made-up devices): «Mice and
// keyboards» lists every family, collapsed until asked for, sorted by brand, each row brand + status + a switch (a family
// that sends: off by default, kept as mkAsk; one read by listening alone: on by default, turned off as mkMute), a field
// that finds a brand (and says when none matches), its count as the language writes it; a mouse in steps, a receiver
// with no device linked (dimmed), a family switched off said with its brand, a card's menu turning its family's
// request on. Piece 6, headsets, earbuds and the rest (mode 'heads', made-up devices): earbuds' cards with their parts
// (left, right, case — small labelled levels; the card's level the lowest bud in use, never the case; a bud in its case
// said), «both in the case», «needs a part of Windows this build does not include», headsets in per cent and in steps, a
// phone from Phone Link, an Xbox pad named in the page's language; «Headsets and earbuds» and «Other» in the same
// collapsed, searchable design (Galaxy Buds' switch says it connects, off by default; AirPods' and Phone Link's on); the
// rename sheet's Save is the app's real filled button. W1, the taskbar like the original (mode 'tauri'): «Taskbar» (the
// tray's three ways and two drawings as pickers, asleep and disconnected devices, the strip on the taskbar with its two
// looks — switches, needing the background), «Notices» (sound, quiet hours with hour pickers), the checking interval
// from 30 s, the low marks 5–40 %; a device's menu moves it up and down (the cards follow, kept as order), gives it one
// of our drawn pictures (kept as pictures; the card shows it) or its own back, joins two entries (links) and separates
// them; Phone Link named as Windows names it in the page's language. Screenshots batW1-* when KT_SHOTS is set.
// W2, the battery history (batteryHistory(o), batteryHistoryClear(o) — bridge.js's signatures; made-up readings): a
// card's quiet «about 5 hours left» / «full in about 40 minutes» (Arabic's counted nouns, the dual genitive), none for an
// asleep device; «History» (on by default, 7/30/90 days — kept as history, historyDays); a device's menu opens its
// history: three periods (a week first), the summary sentence that is also the chart's text, the line in the accent,
// red below the low mark, blue while charging with a band, a gap where the device was away, the value under the pointer
// and with the arrow keys, time running from the right in Arabic; «Clear this device's history» asked first, then
// cleared through the bridge; a microphone may be given our microphone drawing. Screenshots batW2-* (light and dark).
// W4, «Report a device» (batteryReport() — bridge.js's signature — and saveText(o)): the page's «More» button (the
// computer's build only, none where the platform has no reader) opens a sheet with one row, which opens the report: its
// text whole in a box (left to right even in Arabic), the English-text sentence, the counts; Copy and Save (the real
// saveText with the name and the text as shown); the text editable and what is copied the edited text; nothing forbidden
// (serial, Bluetooth address, user name, folder) in what is shown; no network request carries it. Screenshots batW4-*.
// `node tests/battery.cjs [en|ar]`.
const { chromium } = require('playwright'); const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const DIST = path.join(__dirname, '..', 'dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ogg': 'audio/ogg' };
const serve = () => http.createServer((req, res) => { let p = decodeURIComponent(req.url.split('?')[0]); if (p === '/') p = '/index.html'; const f = path.join(DIST, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res); });
const errors = []; const check = (what, ok, x) => { console.log(ok ? 'ok  ' : 'FAIL', what, ok || x === undefined ? '' : JSON.stringify(x).slice(0, 300)); if (!ok) errors.push(what); };
const lang = process.argv[2] || 'en'; const SHOTS = process.env.KT_SHOTS || '';
const shot = async (p, name) => { if (SHOTS) { fs.mkdirSync(SHOTS, { recursive: true }); await p.screenshot({ path: path.join(SHOTS, /^batW[124]-/.test(name) ? `${name}-${lang}.png` : `battery-${name}-${lang}.png`) }); } };

// (Run in the page: the fake bridge. mode: 'tauri' | 'mac' | 'empty' | 'nothere' | 'electron'.)
function fake({ lang, mode }) {
  localStorage.setItem('kr.lang', lang); localStorage.setItem('kt.update.lastCheck', String(Date.now())); localStorage.setItem('kt.pc.starter', '1');
  const NOW = 1_800_000_000_000; const min = 60_000;
  const rd = (level, at, charging = 'unknown') => ({ level, charging, asleep: false, takenAt: at });
  const ex = (v) => ({ kind: 'exact', value: v });
  const dev = (o) => ({ name: '', kind: 'other', brand: '', connection: 'usb', source: 'hid', vid: 0, pid: 0, merged: [], status: 'ok', reading: null, lastGood: null, checkedAt: NOW, ...o });
  const st = (n, max) => ({ kind: 'steps', value: n, max });
  const pad = (o) => dev({ kind: 'controller', source: 'pad', proven: 'untested', way: 'passive', ...o });
  const PADS = [
    pad({ key: 'hid:054C:0CE6:c:{DS}', name: 'DualSense', brand: 'PlayStation', connection: 'bluetooth', picture: 'pad', driver: 'playstation', family: 'playstation', reading: rd(st(7, 10), NOW - min, 'no') }),
    pad({ key: 'hid:057E:2009:c:{SW}', name: 'Pro Controller', brand: 'Nintendo', connection: 'usb', picture: 'pad', driver: 'nintendo', family: 'nintendo', reading: rd(st(2, 4), NOW, 'yes') }),
    pad({ key: 'hid:057E:2006:c:{JL}', name: 'Joy-Con (L)', brand: 'Nintendo', connection: 'bluetooth', picture: 'half', driver: 'nintendo', family: 'nintendo', reading: Object.assign(rd({ kind: 'unknown' }, NOW), { note: 'needsQuery' }) }),
    pad({ key: 'hid:28DE:1304:c:{SC}:i:01', name: 'Steam Controller', brand: 'Steam', connection: 'dongle', picture: 'trackpads', driver: 'steam', family: 'steam', reading: rd(ex(64), NOW) }),
    pad({ key: 'hid:28DE:1304:c:{SC}:i:02', name: 'Steam Controller', brand: 'Steam', connection: 'dongle', picture: 'trackpads', driver: 'steam', family: 'steam', reading: Object.assign(rd({ kind: 'unknown' }, NOW), { note: 'noPad' }) }),
    pad({ key: 'hid:2DC8:6001:c:{SN}', name: '8BitDo SN30 Pro', brand: '8BitDo', connection: 'bluetooth', picture: 'retro', driver: '8bitdo', family: 'eightbitdo', reading: rd(ex(81), NOW - 2 * min, 'no') }),
    pad({ key: 'hid:3537:1098:c:{GS}', name: 'GameSir Nova', brand: 'GameSir', connection: 'dongle', picture: 'pad', driver: 'gamesir-nova', family: 'gamesir', way: 'query', reading: Object.assign(rd({ kind: 'unknown' }, NOW), { note: 'queryOff' }) }),
    dev({ key: 'xinput:0:pad', name: 'Xbox controller 1', kind: 'controller', brand: 'Xbox', connection: 'dongle', source: 'xinput', reading: rd({ kind: 'coarse', value: 'medium', bars: 3 }, NOW - 2 * min) }),
  ];
  const fam = (family, brand, ask, listen, models = []) => ({ family, brand, proven: 'untested', ask, listen, models, on: false });
  const padRows = [fam('playstation', 'PlayStation', false, true), fam('xbox', 'Xbox', false, true), fam('nintendo', 'Nintendo', false, true), fam('steam', 'Steam', false, true), fam('eightbitdo', '8BitDo', true, true, ['8BitDo Ultimate 2 Wireless', '8BitDo Ultimate 2']), fam('gamesir', 'GameSir', true, true, ['GameSir Nova', 'GameSir Nova Lite 2', 'GameSir Nova 2 Lite']), fam('flydigi', 'Flydigi', true, false, ['Flydigi Vader 5 Pro']), fam('beitong', 'BEITONG', true, false, ['BEITONG KP20'])];
  // (Piece 5: made-up mice and keyboards; the families' rows as the shell gives them, every family.)
  const mk = (o) => dev({ source: 'vendor', proven: 'untested', way: 'query', ...o });
  const MICE = [
    mk({ key: 'hid:046D:C52B:c:{LR}:slot:1', name: 'Shape Mouse Pro', kind: 'mouse', brand: 'Logitech', connection: 'dongle', driver: 'mk-logitech', family: 'mk-logitech', reading: rd(ex(77), NOW - min, 'no') }),
    mk({ key: 'hid:046D:C52B:c:{LR}:slot:2', name: 'Shape Keys', kind: 'keyboard', brand: 'Logitech', connection: 'dongle', driver: 'mk-logitech', family: 'mk-logitech', reading: rd({ kind: 'coarse', value: 'high', bars: 4 }, NOW - min) }),
    mk({ key: 'hid:1038:1838:c:{AX}', name: 'SteelSeries Aerox 3 Wireless', kind: 'mouse', brand: 'SteelSeries', connection: 'dongle', driver: 'mk-steelseries', family: 'mk-steelseries', reading: rd(st(14, 20), NOW, 'yes') }),
    mk({ key: 'hid:1532:00B6:c:{RZ}', name: 'Razer mouse', kind: 'mouse', brand: 'Razer', connection: 'usb', driver: 'mk-razer', family: 'mk-razer', reading: Object.assign(rd({ kind: 'unknown' }, NOW), { note: 'queryOff' }) }),
    mk({ key: 'hid:1B1C:2B00:c:{CS}', name: 'Corsair Slipstream receiver', kind: 'mouse', brand: 'Corsair', connection: 'dongle', driver: 'mk-corsair-bragi', family: 'mk-corsair', reading: Object.assign(rd({ kind: 'unknown' }, NOW), { note: 'unlinked' }) }),
    mk({ key: 'hid:24AE:1410:c:{RP}', name: 'Rapoo VT0', kind: 'mouse', brand: 'Rapoo', connection: 'dongle', driver: 'mk-rapoo', family: 'mk-rapoo', way: 'passive', reading: rd(ex(42), NOW - 2 * min, 'no') }),
  ];
  const MK = ['Logitech:q', 'Razer:q', 'SteelSeries:q', 'Corsair:q', 'Glorious:q', 'Hitscan:q', 'G-Wolves:q', 'WLMouse:q', 'LAMZU:q', 'Arbiter Studio:q', 'Pulsar:q', 'Finalmouse:q', 'Endgame Gear:q', 'VAXEE:q', 'ZOWIE:q', 'Ninjutso:q', 'Sprime:q', 'Darmoshark:q', 'ATK / VXE:q', 'Kysona:q', 'Fantech:q', 'DAREU:q', 'Redragon:q', 'Rapoo:l', 'Keychron:q', 'Royal Kludge:q', 'SONiX:q', 'Semico:q', 'AULA:b', 'MCHOSE:q', 'CHERRY:q', 'Cooler Master:q', 'Machenike:q', 'MSI:q', 'ASUS ROG:q', 'NZXT:q', 'Niceboy:q', 'Motospeed:q', 'Xenta:l', 'Delux:q', 'AJAZZ:q', 'Incott / Wraith:q'];
  const ids = { 'Logitech': 'mk-logitech', 'Razer': 'mk-razer', 'SteelSeries': 'mk-steelseries', 'Corsair': 'mk-corsair', 'Rapoo': 'mk-rapoo', 'AULA': 'mk-aula', 'Xenta': 'mk-xenta', 'Royal Kludge': 'mk-rk' };
  const miceRows = MK.map((x) => { const [brand, w] = x.split(':'); const ask = w !== 'l'; const listen = w !== 'q'; return { family: ids[brand] || 'mk-' + brand.toLowerCase().replace(/[^a-z0-9]+/g, ''), brand, group: 'mice', proven: 'untested', ask, listen, on: !ask }; });
  // (Piece 6: the headsets' and earbuds' families and the rest's, as the shell gives them; c = connects.)
  const HS = ['Razer:q', 'SteelSeries:q', 'Corsair:q', 'Logitech G:q', 'ASTRO:q', 'Audeze:q', 'HyperX:q', 'Sony INZONE:q', 'Jabra:q', 'JBL:b', 'Poly / Plantronics:q', 'MOONDROP:q', 'MCHOSE:q', 'Alienware:q', 'Fractal Design:q', 'ASUS ROG:q', 'AirPods / Beats:l', 'Galaxy Buds:c'];
  const hsIds = { 'Logitech G': 'hs-logitech', 'Sony INZONE': 'hs-sony', 'Poly / Plantronics': 'hs-poly', 'Fractal Design': 'hs-fractal', 'ASUS ROG': 'hs-rog', 'AirPods / Beats': 'hs-airpods', 'Galaxy Buds': 'hs-galaxybuds', 'MAONO': 'ot-maono', 'Phone Link': 'ot-phonelink' };
  const row6 = (group, prefix) => (x) => { const [brand, w] = x.split(':'); const ask = w !== 'l'; const listen = w === 'l' || w === 'b'; return { family: hsIds[brand] || prefix + brand.toLowerCase().replace(/[^a-z0-9]+/g, ''), brand, group, connects: w === 'c', proven: 'untested', ask, listen, on: !ask }; };
  miceRows.push(...HS.map(row6('heads', 'hs-')), ...['MAONO:q', 'Phone Link:l'].map(row6('other', 'ot-')));
  // (Piece 6: made-up headsets, earbuds with parts, a phone.)
  const part = (p, level, inUse, charging = 'unknown') => ({ part: p, level, charging, inUse });
  const UNK = { kind: 'unknown' };
  const HEADS = [
    mk({ key: 'hid:054C:0EC2:c:{IB}', name: 'Field Buds', kind: 'earbuds', brand: 'Sony INZONE', connection: 'dongle', driver: 'hs-sony', family: 'hs-sony', reading: Object.assign(rd(ex(70), NOW - min), { parts: [part('left', ex(70), true), part('right', UNK, false), part('case', ex(35), false)] }) }),
    mk({ key: 'spp:A1B2C3D4E5F6', name: 'Galaxy Buds2 Pro', kind: 'earbuds', brand: 'Samsung', connection: 'bluetooth', source: 'spp', driver: 'hs-galaxybuds', family: 'hs-galaxybuds', reading: Object.assign(rd(ex(12), NOW), { parts: [part('left', ex(82), true), part('right', ex(12), true), part('case', ex(5), false, 'yes')] }) }),
    mk({ key: 'hid:1532:0565:c:{BS}', name: 'Razer BlackShark V2 HyperSpeed', kind: 'headset', brand: 'Razer', connection: 'dongle', driver: 'hs-razer-hs', family: 'hs-razer', reading: rd(ex(64), NOW - 2 * min, 'yes') }),
    mk({ key: 'hid:1038:12E0:c:{NP}', name: 'SteelSeries Arctis Nova Pro Wireless', kind: 'headset', brand: 'SteelSeries', connection: 'dongle', driver: 'hs-steelseries', family: 'hs-steelseries', reading: rd(st(6, 8), NOW) }),
    mk({ key: 'hid:1038:230A:c:{GB}', name: 'SteelSeries Arctis GameBuds', kind: 'earbuds', brand: 'SteelSeries', connection: 'dongle', driver: 'hs-steelseries', family: 'hs-steelseries', reading: Object.assign(rd(UNK, NOW), { note: 'inCase' }) }),
    mk({ key: 'advert:{AP}', name: 'Studio Pods', kind: 'earbuds', brand: 'Apple', connection: 'bluetooth', source: 'advert', driver: 'hs-airpods', family: 'hs-airpods', way: 'passive', reading: Object.assign(rd(UNK, NOW), { note: 'notInBuild' }) }),
    mk({ key: 'phonelink', name: 'Field Phone', kind: 'phone', brand: '', connection: 'unknown', source: 'phonelink', driver: 'ot-phonelink', family: 'ot-phonelink', way: 'passive', reading: rd(ex(58), NOW - 40 * min) }),
    // (D1: the microphone kind, the original's v1.1.0.)
    mk({ key: 'hid:352F:040E:c:{MC}', name: 'Studio Mic', kind: 'microphone', brand: 'MAONO', connection: 'dongle', driver: 'ot-maono', family: 'ot-maono', reading: rd(ex(77), NOW - min) }),
    dev({ key: 'xinput:1:pad', name: '', kind: 'controller', brand: 'Xbox', connection: 'dongle', source: 'xinput', reading: rd({ kind: 'coarse', value: 'high', bars: 4 }, NOW) }),
  ];
  const devices = mode === 'heads' ? HEADS : mode === 'mice' ? MICE : mode === 'pads' ? PADS : mode !== 'tauri' && mode !== 'mac' ? [] : [
    dev({ key: 'hid:1111:2222:s:A1', name: 'Shape Mouse One', kind: 'mouse', brand: 'Acme', reading: rd(ex(64), NOW - 3 * min), lastGood: rd(ex(64), NOW - 3 * min), estimate: { state: 'empty', minutes: 302 } }),
    dev({ key: 'bt:{K}', name: 'Studio Keys', kind: 'keyboard', brand: '', connection: 'bluetooth', source: 'bluetooth', status: 'notConnected', lastGood: rd(ex(40), NOW - 26 * 60 * min) }),
    dev({ key: 'bt:{H}', name: 'Field Phones', kind: 'headset', connection: 'bluetooth', source: 'bluetooth', reading: rd(ex(9), NOW - 30_000), lastGood: rd(ex(9), NOW - 30_000), estimate: { state: 'empty', minutes: 118 } }),
    dev({ key: 'bt:{E}', name: 'Pocket Buds', kind: 'earbuds', connection: 'bluetooth', source: 'bluetooth', reading: rd(ex(88), NOW, 'yes'), lastGood: rd(ex(88), NOW), estimate: { state: 'full', minutes: 41 } }),
    dev({ key: 'xinput:0:pad', name: 'Xbox controller 1', kind: 'controller', brand: 'Xbox', connection: 'dongle', source: 'xinput', reading: rd({ kind: 'coarse', value: 'medium', bars: 3 }, NOW - 2 * min) }),
    dev({ key: 'hid:3333:4444:c:{M}', name: 'Travel Mouse', kind: 'mouse', status: 'asleep', lastGood: rd(ex(71), NOW - 95 * min), estimate: { state: 'empty', minutes: 600 } }),
    dev({ key: 'hid:5555:6666:p:x', name: 'Quiet Pad', kind: 'controller', status: 'notQueried' }),
  ];
  let settings = { intervalMin: 1, low: 15, names: {}, hidden: [], noQuery: ['hid:5555:6666:p:x'], links: [], background: false, startup: false, notifyLow: true, notifyFull: false, thresholds: {} };
  // (A Mac: the shell starts with the system through its LaunchAgent now — the same 'yes' as Windows and Linux.)
  const system = { autostart: 'yes', tray: true };
  window.__calls = []; window.__subs = 0; let cb = null;
  // (Piece 3: the connect panel's fake — a device: { addr, name, kind, picture, brand, le, paired, connected, battery, can }.)
  const BT = (addr, o) => ({ addr, name: '', kind: 'other', picture: 'other', brand: '', le: false, paired: true, connected: false, battery: null, can: 'both', ...o });
  const bt = { available: mode !== 'nothere', radio: mode === 'btoff' ? 'off' : mode === 'btmissing' ? 'missing' : 'on', stale: false, now: NOW, scanUntil: null, found: [], busy: [], devices: mode === 'nothere' ? [] : [
    BT('00:11:22:33:44:55', { name: 'Field Phones', kind: 'headset', picture: 'headset', connected: true, battery: 9 }),
    BT('AA:BB:CC:DD:EE:FF', { name: 'Shape Mouse', kind: 'mouse', picture: 'mouse', le: true, connected: true, battery: 64, can: 'settings' }),
    BT('00:11:22:33:44:66', { name: 'Studio Speaker', kind: 'speaker', picture: 'speaker', brand: 'Acme' }),
    BT('00:11:22:33:44:77', { name: 'Split Pads', kind: 'controller', picture: 'split', can: 'disconnectOnly' }),
    BT('00:11:22:33:44:88', { name: 'Travel Keys', kind: 'keyboard', picture: 'keyboard', can: 'disconnectOnly' }),
  ] };
  const NEAR = [BT('10:20:30:40:50:60', { name: 'Field Pad', kind: 'controller', picture: 'pad', paired: false, can: 'pair' }), BT('10:20:30:40:50:61', { name: 'Retro Pad', kind: 'controller', picture: 'retro', paired: false, can: 'pair' }), BT('10:20:30:40:50:62', { picture: 'other', paired: false, can: 'pair' })];
  let btCb = null; const pending = {}; window.__btSubs = 0; window.__btPlan = {};
  const btSnap = () => JSON.parse(JSON.stringify(bt));
  const btPush = () => { if (btCb) btCb(btSnap()); };
  window.__btPush = (o) => { Object.assign(bt, o); btPush(); };
  window.__push = (devs) => { if (cb) cb({ now: NOW, devices: devs }); };
  // (W2: a made-up week of one mouse — a slow discharge, a charge, a night away, a discharge below the low mark.)
  const HOUR = 3_600_000; const cleared = new Set();
  const hist = []; const P = (t, v, charging = 'no') => hist.push({ t: NOW - t, level: v === null ? null : ex(v), charging });
  for (let i = 0, v = 96; i <= 120; i++) { if (i % 3 === 0 && v > 22) v -= 2; P((168 - i * 0.5) * HOUR, v); }
  for (let i = 0; i <= 12; i++) P((107 - i * (10 / 60)) * HOUR, Math.min(97, 22 + i * 6), 'yes');
  P(104.5 * HOUR, null);
  for (let i = 0, v = 97; i <= 190; i++) { if (i % 2 === 0 && v > 9) v -= 1; P((96 - i * 0.5) * HOUR, v); }
  hist.sort((a, b) => a.t - b.t);
  window.__histCalls = [];
  const base = { platform: 'desktop', available: true, reason: '', os: 'win32', ready: async () => ({}), list: async () => [], onTasks: () => () => {}, onBrowser: () => () => {}, onUpdateProgress: () => () => {}, onPackProgress: () => () => {}, packStatus: async () => ({}), defaultDir: async () => 'C:\\Downloads' };
  if (mode === 'electron') { window.kurokawaTools = base; return; }
  window.kurokawaTools = Object.assign(base, {
    // (Exactly bridge.js's signatures.)
    batteryList: function () { window.__calls.push(['list']); return Promise.resolve(mode === 'nothere' ? { available: false, reason: 'platform', now: NOW, devices: [], settings, system } : { available: true, now: NOW, devices: JSON.parse(JSON.stringify(devices)), settings, system, pads: JSON.parse(JSON.stringify(padRows)), mice: JSON.parse(JSON.stringify(miceRows)) }); },
    batteryRefresh: function (o) { window.__calls.push(['refresh', o]); return Promise.resolve(true); },
    batterySettings: function (o) { window.__calls.push(['settings', o]); if (o && o.set && 'startup' in o.set && window.__failStartup) return Promise.reject(new Error('access denied')); if (o && o.set) settings = Object.assign({}, settings, o.set); return Promise.resolve(settings); },
    onBattery: function (f) { cb = f; window.__subs++; return function () { if (cb === f) cb = null; window.__subs--; }; },
    // (W2 — exactly bridge.js's signatures: batteryHistory(o), batteryHistoryClear(o).)
    batteryHistory: function (o) {
      window.__histCalls.push(['history', o]);
      const days = o.range === 'day' ? 1 : o.range === 'month' ? 30 : 7; const since = NOW - days * 24 * HOUR;
      const points = cleared.has(o.key) || o.key !== 'hid:1111:2222:s:A1' ? [] : hist.filter((x) => x.t >= since);
      const pc = points.filter((x) => x.level).map((x) => x.level.value);
      const stats = { count: pc.length, lowest: pc.length ? Math.min(...pc) : null, highest: pc.length ? Math.max(...pc) : null, first: pc.length ? pc[0] : null, last: pc.length ? pc[pc.length - 1] : null };
      return Promise.resolve(JSON.parse(JSON.stringify({ key: o.key, on: settings.history !== false, days: settings.historyDays || 30, now: NOW, since, gap: 2 * HOUR, points, stats,
        estimate: points.length ? { state: 'empty', minutes: 302, perHour: 1.6, samples: 24 } : { state: 'none', why: 'collecting' } })));
    },
    batteryHistoryClear: function (o) { window.__histCalls.push(['clear', o]); const had = !cleared.has(o.key); cleared.add(o.key); return Promise.resolve(had); },
    // (Piece 3 — exactly bridge.js's signatures: btList(), btScan(o), btAct(o), btOpenSettings(), onBt(cb).)
    btList: function () { window.__calls.push(['btList']); return Promise.resolve(btSnap()); },
    btScan: function (o) {
      window.__calls.push(['btScan', o]);
      if (o && o.stop) { bt.scanUntil = null; return Promise.resolve(btSnap()); }
      bt.scanUntil = NOW + 1000 * ((o && o.seconds) || 20); bt.found = [];
      setTimeout(() => { if (bt.scanUntil) { bt.found = JSON.parse(JSON.stringify(NEAR)); btPush(); } }, 120);
      return Promise.resolve(btSnap());
    },
    btAct: function (o) {
      window.__calls.push(['btAct', o]);
      if (o.op === 'cancel') { const r = pending[o.addr]; if (r) { delete pending[o.addr]; r({ result: 'cancelled', code: 0 }); } return Promise.resolve({ result: r ? 'cancelled' : 'none', code: 0 }); }
      const plan = window.__btPlan[o.addr] || { result: 'ok', ms: 60 };
      return new Promise((ok) => {
        pending[o.addr] = ok;
        setTimeout(() => {
          if (pending[o.addr] !== ok) return; delete pending[o.addr];
          if (plan.result === 'ok') {
            if (o.op === 'pair') { const d = bt.found.find((x) => x.addr === o.addr); bt.found = bt.found.filter((x) => x.addr !== o.addr); if (d) bt.devices.push(Object.assign(d, { paired: true, can: 'disconnectOnly' })); }
            for (const d of bt.devices) if (d.addr === o.addr && o.op !== 'pair') d.connected = o.op === 'connect';
            btPush();
          }
          ok({ result: plan.result, code: plan.code || 0 });
        }, plan.ms);
      });
    },
    btOpenSettings: function () { window.__calls.push(['btOpenSettings']); return Promise.resolve(); },
    // (W4 — exactly bridge.js's signature: batteryReport() → { text, devices, collections }; the text as kt-battery's report.rs writes it, of made-up devices.)
    batteryReport: function () {
      window.__calls.push(['report']);
      const text = ['Kurokawa Tools device report', 'Format: 1', 'App: Kurokawa Tools 0.21.0', 'System: Windows 11 10.0.22631', "Left out on purpose: serial numbers, Bluetooth addresses, the computer's and the user's name, folders, and what the devices send (only the sizes of their reports are given).", 'A device is called "device N" by its place in this text.', '',
        'Devices the app sees (2)', '', 'device 1: Shape Mouse One', '  kind (a guess): mouse, connection: usb', '  vendor id: 1111, product id: 2222', '  built-in reader: generic HID battery field', '  test level: untested', '  status: ok', '  last reading: exact 64%, charging: unknown, asleep: no', '  note: none', '',
        'device 2: [name]\'s Buds [address]', '  kind (a guess): earbuds, connection: bluetooth', '  vendor id: unknown, product id: unknown', '  built-in reader: bluetooth (the system\'s own or a built-in generic reader)', '  test level: untested', '  status: notConnected', '  last reading: none', '  note: none', '',
        'HID collections seen (1)', '', 'device 1: Shape Mouse One', '  vendor id: 1111, product id: 2222, connection: usb', '  usage page: 0x0001, usage: 0x0002, interface: 0', '  report lengths: input 8, output 0, feature 0', '  battery field declared: yes', '  built-in reader: generic HID battery field (untested)', ''].join('\n');
      return Promise.resolve({ text, devices: 2, collections: 1 });
    },
    saveText: function (o) { window.__saved = o; return Promise.resolve({ path: 'C:/Users/x/Downloads/' + o.name }); },
    onBt: function (f) { btCb = f; window.__btSubs++; return function () { if (btCb === f) btCb = null; window.__btSubs--; }; },
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
    check('the reading\'s age', mouse.age.includes(AR ? 'قبل 3 دقائق' : '3 min ago'), mouse.age);
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
    // The low marks: the default's choices, a device's own mark from its menu, the card's red following it.
    await p.click('[data-name="low"]'); await p.waitForSelector('.sheet .dest-row');
    const bare = (x) => x.replace(/[\u200F\u2068\u2069]/g, '');
    const marks = (await p.$$eval('.sheet .dest-row .name', (e) => e.map((x) => x.textContent))).map(bare);
    const MK = [5, 10, 15, 20, 25, 30, 35, 40];
    check('the default mark offers 5 to 40 in steps of 5 (the original\'s v1.1.0)', JSON.stringify(marks) === JSON.stringify(MK.map((n) => n + (AR ? '٪' : '%'))), marks);
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.evaluate(() => window.__push([{ key: 'bt:{N}', name: 'New Pad', kind: 'controller', brand: '', connection: 'bluetooth', source: 'bluetooth', vid: 0, pid: 0, merged: [], status: 'ok', reading: { level: { kind: 'exact', value: 12 }, charging: 'no', asleep: false, takenAt: 1_800_000_000_000 }, lastGood: null, checkedAt: 1 }]));
    await p.waitForTimeout(150);
    check('12% under the default mark (20%): red', (await p.getAttribute('.bat-card[data-key="bt:{N}"]', 'class')).includes('low'));
    await p.click('.bat-card[data-key="bt:{N}"] .bat-more'); await p.waitForSelector('.sheet [data-act="mark"]');
    check('the menu shows the device\'s mark (as the others)', (await p.textContent('.sheet [data-act="mark"] .bat-mark-val')) === (AR ? 'كسائر الأجهزة (20٪)' : 'Same as the others (20%)'));
    await p.click('.sheet [data-act="mark"]'); await p.waitForSelector('.sheet .dest-row input[type=radio]');
    const opts = (await p.$$eval('.sheet .dest-row .name', (e) => e.map((x) => x.textContent))).map(bare);
    check('a device\'s own mark: as the others, 5–40, or no notice', opts.length === 10 && opts[9] === (AR ? 'بلا تنبيه' : 'No notice'), opts);
    await p.waitForTimeout(450); await shot(p, 'mark');
    await p.click('.sheet .dest-row >> text=/^\\u200F?10' + (AR ? '٪' : '%') + '$/'); await p.waitForTimeout(250);
    const th = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('its own mark kept through batterySettings({ set: { thresholds } })', th && th[1].set.thresholds && th[1].set.thresholds['bt:{N}'] === 10, th);
    check('12% over its own mark (10%): not red', !(await p.getAttribute('.bat-card[data-key="bt:{N}"]', 'class')).includes('low'));
    await p.click('.bat-card[data-key="bt:{N}"] .bat-more'); await p.waitForSelector('.sheet [data-act="mark"]');
    await p.click('.sheet [data-act="mark"]'); await p.waitForSelector('.sheet .dest-row input[type=radio]');
    await p.click('.sheet .dest-row:has-text("' + (AR ? 'بلا تنبيه' : 'No notice') + '")'); await p.waitForTimeout(250);
    check('«no notice» kept as 0', (await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set.thresholds['bt:{N}'] === 0);
    check('no notice: the card still reddens at the default mark', (await p.getAttribute('.bat-card[data-key="bt:{N}"]', 'class')).includes('low'));
    await p.click('.bat-card[data-key="bt:{N}"] .bat-more'); await p.waitForSelector('.sheet [data-act="mark"]');
    check('the menu says «no notice»', (await p.textContent('.sheet [data-act="mark"] .bat-mark-val')) === (AR ? 'بلا تنبيه' : 'No notice'));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);

    // Piece 2: the Background group.
    const bg = await p.$('.bat-bg[data-group="background"]');
    check('the Background group is on the page', !!bg);
    const sws = await p.$$eval('.bat-bg input', (e) => e.map((x) => ({ type: x.type, role: x.getAttribute('role'), app: getComputedStyle(x).appearance, w: x.getBoundingClientRect().width })));
    check('four switches (drawn switches, not checkboxes)', sws.length === 4 && sws.every((x) => x.type === 'checkbox' && x.role === 'switch' && x.app === 'none' && x.w >= 48), sws);
    check('no native number spinner on the page', !(await p.$('.battery-view input[type=number]')));
    const st = async (n) => p.$eval(`.bat-bg [data-row="${n}"]`, (e) => ({ on: e.querySelector('input').checked, dis: e.querySelector('input').disabled, hint: e.querySelector('small').textContent }));
    let s0 = await st('startup');
    check('off by default; start with the system needs the background first', !(await st('background')).on && !s0.on && s0.dis && s0.hint === (AR ? 'يقتضي تشغيلَ «مواصلة العمل في الخلفية».' : 'Needs «Keep running in the background».'), s0);
    check('low notices on, fully charged off by default', (await st('notifyLow')).on && !(await st('notifyFull')).on);
    await p.click('.bat-bg [data-row="background"]'); await p.waitForTimeout(250);
    check('keep running in the background kept', JSON.stringify((await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set) === JSON.stringify({ background: true }));
    s0 = await st('startup');
    check('then the start with the system can be chosen', !s0.dis && !s0.on && s0.hint === (AR ? 'يُفتَح في علبة النظام عند تسجيل دخولك.' : 'Opens in the tray when you sign in.'), s0);
    await p.evaluate(() => { window.__failStartup = true; });
    await p.click('.bat-bg [data-row="startup"]'); await p.waitForTimeout(300);
    const toastT = await p.evaluate(() => document.querySelector('.toast, .snackbar')?.textContent ?? '');
    check('a refusal from the shell said, the switch drawn back', !(await st('startup')).on && toastT.includes('access denied'), toastT);
    await p.evaluate(() => { window.__failStartup = false; }); await p.waitForTimeout(2300);
    await p.click('.bat-bg [data-row="startup"]'); await p.waitForTimeout(250);
    check('start with the system kept', (await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set.startup === true && (await st('startup')).on);
    await p.click('.bat-bg [data-row="notifyFull"]'); await p.waitForTimeout(250);
    check('the fully-charged notice kept', (await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set.notifyFull === true);
    // (Controls never touch: the rows apart, the switch apart from its words.)
    const geo = await p.$$eval('.bat-bg .bat-switch', (rows) => rows.map((r) => { const a = r.querySelector('.bat-sw-text').getBoundingClientRect(); const b = r.querySelector('input').getBoundingClientRect(); return { gap: Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right)), h: r.getBoundingClientRect().height }; }));
    check('each switch keeps a real gap from its words', geo.every((g) => g.gap >= 12), geo);
    check('no sideways overflow (background group)', (await overflow(p)) <= 1);
    await p.$eval('.bat-bg', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'background');
    // Leaving lets go.
    check('subscribed once while open', (await p.evaluate(() => window.__subs)) === 1);
    // (Within its tab — Settings —: the page replaced, so disposed; another tab would keep it for coming back.)
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(400);
    check('leaving the page unsubscribes', (await p.evaluate(() => window.__subs)) === 0);
    await ctx.close();
  }

  // ---- Piece 4: controllers.
  {
    const { ctx, p } = await open('pads');
    await p.waitForSelector('.bat-card[data-key="hid:054C:0CE6:c:{DS}"]');
    const card = (k) => p.$eval(`.bat-card[data-key="${k}"]`, (e) => ({ cls: e.className, pic: e.querySelector('.bat-ic svg')?.dataset.picture, img: !!e.querySelector('img'), bars: e.querySelectorAll('.bat-bars > i').length, on: e.querySelectorAll('.bat-bars > i.on').length, word: e.querySelector('.bat-word')?.textContent, pct: e.querySelector('.bat-pct')?.textContent ?? null, note: e.querySelector('.bat-note')?.dataset.note ?? '', noteText: e.querySelector('.bat-note')?.textContent ?? '', chip: e.querySelector('.bat-chip.charging')?.textContent ?? '' }));
    const ds = await card('hid:054C:0CE6:c:{DS}');
    check('a pad in steps: as many bars as steps, «7 of 10», never a percentage', ds.bars === 10 && ds.on === 7 && ds.pct === null && ds.word === (AR ? '7 من 10' : '7 of 10'), ds);
    const pics = await p.$$eval('.bat-card[data-kind="controller"]', (els) => els.map((e) => e.querySelector('.bat-ic svg')?.dataset.picture));
    check('each controller drawn by its family (our own drawings, no picture files)', JSON.stringify(pics.slice().sort()) === JSON.stringify(['half', 'pad', 'pad', 'pad', 'pad', 'retro', 'trackpads', 'trackpads'].sort()) && !(await p.$('.bat-card img')), pics);
    const sw = await card('hid:057E:2009:c:{SW}');
    check('a charging pad in steps: 2 of 4 with the charging mark', sw.bars === 4 && sw.on === 2 && sw.chip.includes(AR ? 'الشحن' : 'Charging') && sw.word === (AR ? '2 من 4' : '2 of 4'), sw);
    check('2 of 4 is not low, 1 of 4 would be', !sw.cls.includes('low'));
    const jl = await card('hid:057E:2006:c:{JL}');
    check('«needs a query we do not send», said', jl.note === 'needsQuery' && jl.noteText === (AR ? 'لا يُخبر بمستواه إلا في وضعٍ لا تُشغِّله أدوات كروكاوا' : 'Tells its level only in a mode Kurokawa Tools does not switch on'), jl);
    const gs = await card('hid:3537:1098:c:{GS}');
    check('a family switched off: said with its name', gs.note === 'queryOff' && gs.noteText.includes('GameSir'), gs);
    const slot = await card('hid:28DE:1304:c:{SC}:i:02');
    check('a receiver with no pad: dimmed, said', slot.cls.includes('dim') && slot.note === 'noPad', slot);
    const sn = await card('hid:2DC8:6001:c:{SN}');
    check('a pad that gives a percentage: shown as one', /81/.test(sn.pct || '') && sn.pic === 'retro', sn);
    check('no sideways overflow (controllers)', (await overflow(p)) <= 1);
    await shot(p, 'pads');
    // The card menu: the reader and its proof, quietly; the family's request only where the family sends one.
    await p.click('.bat-card[data-key="hid:054C:0CE6:c:{DS}"] .bat-more'); await p.waitForSelector('.sheet .bat-reader');
    const rd1 = await p.textContent('.sheet .bat-reader');
    check('the menu names the reader and «ported, not yet tested on real hardware»', rd1 === (AR ? 'القارئ: PlayStation — منقولٌ لم يُختبَر بعدُ على جهازٍ حقيقي' : 'Reader: PlayStation — ported, not yet tested on real hardware'), rd1);
    check('a passive family offers no request', !(await p.$('.sheet [data-act="padQuery"]')));
    await p.keyboard.press('Escape'); await p.waitForTimeout(300);
    await p.click('.bat-card[data-key="hid:3537:1098:c:{GS}"] .bat-more'); await p.waitForSelector('.sheet [data-act="padQuery"]');
    check('a family that must be asked: «Try reading: GameSir» in its menu', (await p.textContent('.sheet [data-act="padQuery"]')) === (AR ? 'جرِّب القراءة: GameSir' : 'Try reading: GameSir'));
    await p.waitForTimeout(400); await shot(p, 'pads-menu');
    await p.click('.sheet [data-act="padQuery"]'); await p.waitForTimeout(250);
    const set1 = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('turned on from the menu: padQueries kept, then a refresh asked', set1 && JSON.stringify(set1[1].set.padQueries) === '["gamesir"]' && (await calls(p)).some((c) => c[0] === 'refresh'), set1);
    // «Controllers»: a switch per family that sends a request, off by default.
    const pads = await p.$$eval('.bat-pads .bat-switch', (rows) => rows.map((r) => ({ fam: r.dataset.family, on: r.querySelector('input').checked, role: r.querySelector('input').getAttribute('role'), title: r.querySelector('.bat-sw-title').textContent, hint: r.querySelector('small').textContent })));
    check('«Controllers»: one switch per family that must be asked', JSON.stringify(pads.map((x) => x.fam)) === '["eightbitdo","gamesir","flydigi","beitong"]' && pads.every((x) => x.role === 'switch'), pads);
    check('off by default, but GameSir now on', pads.filter((x) => x.on).map((x) => x.fam).join() === 'gamesir', pads);
    check('each says «Try reading: {family}» and «ported, not yet tested»', pads.every((x) => x.title.startsWith(AR ? 'جرِّب القراءة: ' : 'Try reading: ') && x.hint.includes(AR ? 'لم يُختبَر بعدُ' : 'not yet tested')), pads);
    check('the products it would ask are named', pads.find((x) => x.fam === 'flydigi').hint.includes('Vader 5 Pro'));
    await p.click('.bat-pads [data-row="pad-flydigi"]'); await p.waitForTimeout(250);
    const set2 = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('a switch kept: padQueries with both', JSON.stringify(set2[1].set.padQueries) === '["gamesir","flydigi"]', set2);
    await p.click('.bat-pads [data-row="pad-gamesir"]'); await p.waitForTimeout(250);
    check('and off again', JSON.stringify((await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set.padQueries) === '["flydigi"]');
    const listen = await p.textContent('.bat-pads .bat-listen');
    check('the families read by listening alone are named', ['PlayStation', 'Xbox', 'Nintendo', 'Steam', '8BitDo'].every((b) => listen.includes(b)) && !listen.includes('Flydigi'), listen);
    const geo = await p.$$eval('.bat-pads .bat-switch', (rows) => rows.map((r) => { const a = r.querySelector('.bat-sw-text').getBoundingClientRect(); const b = r.querySelector('input').getBoundingClientRect(); return Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right)); }));
    check('the switches keep a real gap from their words', geo.every((g) => g >= 12), geo);
    check('no yellow, amber or orange (controllers)', await p.evaluate(() => [...document.querySelectorAll('.battery-view *')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor, c.fill, c.stroke].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    await p.$eval('.bat-pads', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'pads-switches');
    await ctx.close();
  }

  // ---- Piece 5: mice and keyboards.
  {
    const { ctx, p } = await open('mice');
    await p.waitForSelector('.bat-card[data-key="hid:046D:C52B:c:{LR}:slot:1"]');
    const card = (k) => p.$eval(`.bat-card[data-key="${k}"]`, (e) => ({ cls: e.className, bars: e.querySelectorAll('.bat-bars > i').length, on: e.querySelectorAll('.bat-bars > i.on').length, word: e.querySelector('.bat-word')?.textContent, pct: e.querySelector('.bat-pct')?.textContent ?? null, note: e.querySelector('.bat-note')?.dataset.note ?? '', noteText: e.querySelector('.bat-note')?.textContent ?? '', sub: e.querySelector('.bat-sub')?.textContent ?? '' }));
    const s1 = await card('hid:046D:C52B:c:{LR}:slot:1'); const s2 = await card('hid:046D:C52B:c:{LR}:slot:2');
    check('a receiver\'s two devices: two cards, each its own level', /77/.test(s1.pct || '') && s2.bars === 5 && s2.on === 4 && s1.sub.includes('Logitech'), [s1, s2]);
    const ax = await card('hid:1038:1838:c:{AX}');
    check('a mouse in steps: «14 of 20» drawn in tenths, never a percentage', ax.pct === null && ax.word === (AR ? '14 من 20' : '14 of 20') && ax.bars === 10 && ax.on === 7, ax);
    const rz = await card('hid:1532:00B6:c:{RZ}');
    check('a family switched off: said with its brand (not a controller\'s words)', rz.note === 'queryOff' && rz.noteText === (AR ? 'القراءة موقوفة لأجهزة Razer' : 'Reading is off for Razer'), rz);
    const cs = await card('hid:1B1C:2B00:c:{CS}');
    check('a receiver with no device linked: dimmed, said', cs.cls.includes('dim') && cs.note === 'unlinked' && cs.noteText === (AR ? 'لم يُوصَل بهذا المستقبِل جهاز' : 'No device linked to this receiver'), cs);
    check('no sideways overflow (mice)', (await overflow(p)) <= 1);
    await shot(p, 'mice');
    // «Mice and keyboards»: collapsed, its count, then every family sorted by brand.
    check('«Mice and keyboards»: collapsed at first', (await p.$$('.bat-mice .bat-switch')).length === 0 && (await p.getAttribute('.bat-mice .bat-mk-toggle', 'aria-expanded')) === 'false');
    const tg = await p.textContent('.bat-mice .bat-mk-toggle');
    check('the count, as the language writes it', tg.includes(AR ? 'العدد: 42' : '(42)'), tg);
    await p.click('.bat-mice .bat-mk-toggle'); await p.waitForSelector('.bat-mice .bat-switch');
    const rows = await p.$$eval('.bat-mice .bat-switch', (r) => r.map((e) => ({ fam: e.dataset.family, on: e.querySelector('input').checked, role: e.querySelector('input').getAttribute('role'), title: e.querySelector('.bat-sw-title').textContent, hint: e.querySelector('small').textContent })));
    check('one row per family, each a switch', rows.length === 42 && rows.every((x) => x.role === 'switch'), rows.length);
    const titles = rows.map((x) => x.title);
    check('sorted by brand, brands as text', JSON.stringify(titles) === JSON.stringify(titles.slice().sort((a, b) => a.localeCompare(b))) && titles.includes('Logitech') && titles.includes('Incott / Wraith'), titles.slice(0, 6));
    check('a family that sends: off by default; one that listens: on', rows.filter((x) => x.on).map((x) => x.fam).sort().join() === 'mk-rapoo,mk-xenta', rows.filter((x) => x.on));
    const hintOf = (f) => rows.find((x) => x.fam === f).hint;
    check('each row says its way and «ported, not yet tested»', hintOf('mk-logitech').startsWith(AR ? 'يُرسِل سؤالًا عن الحال' : 'Sends a status request') && hintOf('mk-rapoo').startsWith(AR ? 'يُنصِت فحسب' : 'Listens only') && hintOf('mk-aula').startsWith(AR ? 'يُنصِت دائمًا' : 'Always listens') && rows.every((x) => x.hint.includes(AR ? 'لم يُختبَر بعدُ' : 'not yet tested')), [hintOf('mk-logitech'), hintOf('mk-aula')]);
    await p.click('.bat-mice [data-row="mk-logitech"]'); await p.waitForTimeout(250);
    let set = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('a family turned on: mkAsk kept, then a refresh asked', JSON.stringify(set[1].set.mkAsk) === '["mk-logitech"]' && (await calls(p)).some((c) => c[0] === 'refresh'), set);
    check('the list stays open after a switch', (await p.$$('.bat-mice .bat-switch')).length === 42);
    await p.click('.bat-mice [data-row="mk-rapoo"]'); await p.waitForTimeout(250);
    set = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('a listening family turned off: mkMute kept', JSON.stringify(set[1].set.mkMute) === '["mk-rapoo"]', set);
    await p.click('.bat-mice [data-row="mk-rapoo"]'); await p.waitForTimeout(250);
    check('and on again', JSON.stringify((await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set.mkMute) === '[]');
    // The field finds a brand; none matching is said.
    await p.fill('.bat-mice .bat-mk-find', 'stee'); await p.waitForTimeout(100);
    const vis = await p.$$eval('.bat-mice .bat-switch', (r) => r.filter((e) => !e.hidden).map((e) => e.dataset.family));
    check('the field finds a brand', JSON.stringify(vis) === '["mk-steelseries"]' && (await p.isHidden('.bat-mice .bat-mk-none')), vis);
    check('the field keeps its focus while typing', await p.evaluate(() => document.activeElement?.classList.contains('bat-mk-find')));
    await p.fill('.bat-mice .bat-mk-find', 'zzzz'); await p.waitForTimeout(100);
    check('no family by that name: said', (await p.isVisible('.bat-mice .bat-mk-none')) && (await p.$$eval('.bat-mice .bat-switch', (r) => r.filter((e) => !e.hidden).length)) === 0);
    await p.fill('.bat-mice .bat-mk-find', ''); await p.waitForTimeout(100);
    const geo = await p.$$eval('.bat-mice .bat-switch', (r) => r.slice(0, 8).map((e) => { const a = e.querySelector('.bat-sw-text').getBoundingClientRect(); const b = e.querySelector('input').getBoundingClientRect(); return Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right)); }));
    check('the switches keep a real gap from their words (mice)', geo.every((g) => g >= 12), geo);
    const gap = await p.$eval('.bat-mice .bat-mk-head', (e) => { const [a, b] = [...e.children].map((x) => x.getBoundingClientRect()); return b.top >= a.bottom ? b.top - a.bottom : Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right)); });
    check('the toggle and the field do not touch', gap >= 8, gap);
    check('no yellow, amber or orange (mice)', await p.evaluate(() => [...document.querySelectorAll('.battery-view *')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor, c.fill, c.stroke].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    check('no sideways overflow (the families open)', (await overflow(p)) <= 1);
    await p.$eval('.bat-mice', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(200); await shot(p, 'mice-families');
    // A card's menu turns its family's request on, as a controller's does.
    await p.click('.bat-card[data-key="hid:1532:00B6:c:{RZ}"] .bat-more'); await p.waitForSelector('.sheet [data-act="padQuery"]');
    check('a mouse\'s menu: «Try reading: Razer»', (await p.textContent('.sheet [data-act="padQuery"]')) === (AR ? 'جرِّب القراءة: Razer' : 'Try reading: Razer'));
    check('… and its reader quietly', (await p.textContent('.sheet .bat-reader')).startsWith(AR ? 'القارئ: Razer' : 'Reader: Razer'));
    await p.click('.sheet [data-act="padQuery"]'); await p.waitForTimeout(250);
    set = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('turned on from the menu: mkAsk with both', JSON.stringify(set[1].set.mkAsk) === '["mk-logitech","mk-razer"]', set);
    await ctx.close();
  }

  // ---- Piece 6: headsets, earbuds and the rest.
  {
    const { ctx, p } = await open('heads');
    await p.waitForSelector('.bat-card[data-key="hid:054C:0EC2:c:{IB}"]');
    const parts = (k) => p.$eval(`.bat-card[data-key="${k}"]`, (e) => ({ cls: e.className, pct: e.querySelector('.bat-pct')?.textContent ?? null, parts: [...e.querySelectorAll('.bat-part')].map((x) => ({ part: x.dataset.part, use: x.dataset.inUse, cls: x.className, label: x.querySelector('.bat-part-head').textContent, val: x.querySelector('.bat-part-val').textContent, bolt: !!x.querySelector('.bat-bolt') })) }));
    const ib = await parts('hid:054C:0EC2:c:{IB}');
    check('earbuds: one card with its parts — left, right, case, each labelled', JSON.stringify(ib.parts.map((x) => x.label)) === JSON.stringify(AR ? ['اليسرى', 'اليمنى', 'العلبة'] : ['Left', 'Right', 'Case']), ib.parts);
    check('… the card\'s level is the bud in use (70), a bud in its case said', /70/.test(ib.pct || '') && ib.parts[1].val === (AR ? 'في العلبة' : 'in the case') && ib.parts[1].cls.includes('out') && /35/.test(ib.parts[2].val), ib);
    const gb = await parts('spp:A1B2C3D4E5F6');
    check('the lowest bud in use marks the card low; the case at 5 % is never low', gb.cls.includes('low') && /12/.test(gb.pct || '') && gb.parts[1].cls.includes('low') && !gb.parts[2].cls.includes('low') && gb.parts[2].bolt, gb);
    const gap = await p.$$eval('.bat-card[data-key="spp:A1B2C3D4E5F6"] .bat-part', (r) => r.slice(0, 2).map((e) => e.getBoundingClientRect()).reduce((a, b) => Math.min(Math.abs(b.left - a.right), Math.abs(a.left - b.right))));
    check('the parts keep a real gap', gap >= 6, gap);
    const note = (k) => p.$eval(`.bat-card[data-key="${k}"] .bat-note`, (e) => ({ n: e.dataset.note, t: e.textContent }));
    const inCase = await note('hid:1038:230A:c:{GB}'); const nib = await note('advert:{AP}');
    check('«both in the case» said', inCase.n === 'inCase' && inCase.t === (AR ? 'السماعتان كلتاهما في علبتهما' : 'Both earbuds are in their case'), inCase);
    check('«not available in this build» said calmly', nib.n === 'notInBuild' && nib.t.startsWith(AR ? 'قراءتها تحتاج' : 'Reading these needs'), nib);
    const ns = await p.$eval('.bat-card[data-key="hid:1038:12E0:c:{NP}"]', (e) => ({ word: e.querySelector('.bat-word')?.textContent, bars: e.querySelectorAll('.bat-bars > i').length, sub: e.querySelector('.bat-sub').textContent }));
    check('a headset in steps: «6 of 8», its kind said', ns.word === (AR ? '6 من 8' : '6 of 8') && ns.bars === 8 && ns.sub.includes(AR ? 'سماعة رأس' : 'Headset'), ns);
    const ph = await p.$eval('.bat-card[data-key="phonelink"]', (e) => ({ name: e.querySelector('.bat-name').textContent, sub: e.querySelector('.bat-sub').textContent, kind: e.dataset.kind }));
    check('a phone through Phone Link: a «phone» card', ph.kind === 'phone' && ph.name === 'Field Phone' && ph.sub.includes(AR ? 'هاتف' : 'Phone'), ph);
    const mic = await p.$eval('.bat-card[data-key="hid:352F:040E:c:{MC}"]', (e) => ({ kind: e.dataset.kind, sub: e.querySelector('.bat-sub').textContent, svg: e.querySelector('.bat-ic svg').innerHTML }));
    check('D1: a microphone card — its own drawing and word', mic.kind === 'microphone' && mic.sub.includes(AR ? 'لاقط صوت' : 'Microphone') && mic.svg.includes('M5.5 11a6.5') && !mic.sub.includes('batKind'), mic);
    check('Phone Link named as Windows names it in the page\'s language', ph.sub.includes(AR ? 'ارتباط الهاتف' : 'Phone Link') && (AR ? !ph.sub.includes('Phone Link') : true), ph.sub);
    check('an Xbox pad named in the page\'s language', (await p.textContent('.bat-card[data-key="xinput:1:pad"] .bat-name')) === (AR ? 'يد Xbox رقم 2' : 'Xbox controller 2'));
    check('no sideways overflow (headsets)', (await overflow(p)) <= 1);
    await shot(p, 'heads');
    // «Headsets and earbuds» and «Other»: collapsed, then every family, as «Mice and keyboards».
    check('«Headsets and earbuds» and «Other»: collapsed at first', (await p.$$('.bat-heads .bat-switch, .bat-other .bat-switch')).length === 0 && (await p.textContent('.bat-heads h3')) === (AR ? 'سماعات الرأس والأذن' : 'Headsets and earbuds') && (await p.textContent('.bat-other h3')) === (AR ? 'أجهزة أخرى' : 'Other'));
    check('… the headsets\' count as the language writes it', (await p.textContent('.bat-heads .bat-mk-toggle')).includes(AR ? 'العدد: 18' : '(18)'));
    await p.click('.bat-heads .bat-mk-toggle'); await p.waitForSelector('.bat-heads .bat-switch');
    const hr = await p.$$eval('.bat-heads .bat-switch', (r) => r.map((e) => ({ fam: e.dataset.family, on: e.querySelector('input').checked, title: e.querySelector('.bat-sw-title').textContent, hint: e.querySelector('small').textContent })));
    const ht = hr.map((x) => x.title);
    check('one switch per headset family, sorted by brand', hr.length === 18 && JSON.stringify(ht) === JSON.stringify(ht.slice().sort((a, b) => a.localeCompare(b))), ht.slice(0, 5));
    check('off by default but the ones that listen (AirPods)', hr.filter((x) => x.on).map((x) => x.fam).join() === 'hs-airpods', hr.filter((x) => x.on));
    check('Galaxy Buds\' switch says it connects', hr.find((x) => x.fam === 'hs-galaxybuds').hint.startsWith(AR ? 'يتصل إذا شُغِّل' : 'When on, connects'), hr.find((x) => x.fam === 'hs-galaxybuds'));
    check('the mice\' list stays shut', (await p.$$('.bat-mice .bat-switch')).length === 0);
    await p.click('.bat-heads [data-row="hs-galaxybuds"]'); await p.waitForTimeout(250);
    let set = (await calls(p)).filter((c) => c[0] === 'settings').pop();
    check('a headset family turned on: mkAsk', JSON.stringify(set[1].set.mkAsk) === '["hs-galaxybuds"]', set);
    await p.fill('.bat-heads .bat-mk-find', 'buds'); await p.waitForTimeout(100);
    check('the field finds a brand among the headsets', JSON.stringify(await p.$$eval('.bat-heads .bat-switch', (r) => r.filter((e) => !e.hidden).map((e) => e.dataset.family))) === '["hs-galaxybuds"]');
    await p.fill('.bat-heads .bat-mk-find', ''); await p.waitForTimeout(100);
    await p.click('.bat-other .bat-mk-toggle'); await p.waitForSelector('.bat-other .bat-switch');
    const orr = await p.$$eval('.bat-other .bat-switch', (r) => r.map((e) => ({ fam: e.dataset.family, on: e.querySelector('input').checked })));
    check('«Other»: the microphone off, Phone Link (read only) on', JSON.stringify(orr.slice().sort((a, b) => a.fam.localeCompare(b.fam))) === JSON.stringify([{ fam: 'ot-maono', on: false }, { fam: 'ot-phonelink', on: true }]), orr);
    const plTitle = await p.textContent('.bat-other [data-row="ot-phonelink"] .bat-sw-title'); const plHint = await p.textContent('.bat-other > .hint');
    check('… Phone Link\'s row and the group\'s words in the page\'s language', AR ? plTitle === 'ارتباط الهاتف' && !plHint.includes('Phone Link') : plTitle === 'Phone Link', [plTitle, plHint]);
    check('no yellow, amber or orange (headsets)', await p.evaluate(() => [...document.querySelectorAll('.battery-view *')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor, c.fill, c.stroke].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    check('no sideways overflow (the headset families open)', (await overflow(p)) <= 1);
    await p.$eval('.bat-heads', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(200); await shot(p, 'heads-families');
    await p.$eval('.bat-other', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'other-families');
    // The rename sheet's Save: the app's real filled button (it had a class with no style).
    await p.click('.bat-card[data-key="hid:1532:0565:c:{BS}"] .bat-more'); await p.waitForSelector('.sheet [data-act="rename"]');
    await p.click('.sheet [data-act="rename"]'); await p.waitForSelector('.bat-rename input');
    const sv = await p.$$eval('.sheet-actions .bat-eq', (b) => b.map((x) => ({ cls: x.className, bg: getComputedStyle(x).backgroundColor, w: Math.round(x.getBoundingClientRect().width) })));
    const prim = await p.evaluate(() => { const d = document.createElement('div'); d.style.background = 'var(--md-primary)'; document.body.append(d); const c = getComputedStyle(d).backgroundColor; d.remove(); return c; });
    check('rename: Save is the filled (primary) button, both buttons one width', sv.length === 2 && sv[1].cls.includes('primary') && sv[1].bg === prim && Math.abs(sv[0].w - sv[1].w) <= 1, [sv, prim]);
    await shot(p, 'rename');
    await ctx.close();
  }

  // ---- Piece 3: «Connect a device».
  {
    const { ctx, p } = await open('tauri');
    await p.waitForSelector('.bt-panel .bt-row[data-addr="00:11:22:33:44:55"]');
    const rows = await p.$$eval('.bt-paired > .bt-row', (r) => r.map((e) => ({ addr: e.dataset.addr, pic: e.querySelector('.bt-pic')?.dataset.picture, svg: !!e.querySelector('.bt-pic svg'), img: !!e.querySelector('img'), acts: [...e.querySelectorAll('.bt-act [data-act]')].map((b) => b.dataset.act), note: !!e.querySelector('.bt-note'), text: e.textContent })));
    check('the paired devices listed, each with its own drawn picture (no picture files)', rows.length === 5 && rows.every((r) => r.svg && !r.img) && JSON.stringify(rows.map((r) => r.pic)) === JSON.stringify(['headset', 'mouse', 'speaker', 'split', 'keyboard']), rows);
    check('the count in the heading, as the language writes it', (await p.textContent('.bt-panel h4')).includes(AR ? 'العدد: 5' : '(5)'));
    const ph = rows[0];
    check('connected, with its battery (low in the error colour)', ph.text.includes(AR ? 'متصل' : 'Connected') && /9/.test(ph.text) && !!(await p.$('.bt-row[data-addr="00:11:22:33:44:55"] .bt-chip.low[data-battery="9"]')), ph);
    check('the action each device offers: disconnect / settings (LE) / connect / «press a button» (HID)', JSON.stringify(rows.map((r) => r.acts)) === JSON.stringify([['disconnect'], ['settings'], ['connect'], [], []]) && rows[3].note && rows[4].note, rows.map((r) => r.acts));
    check('LE said, the brand as text', rows[1].text.includes(AR ? 'منخفض الطاقة' : 'Bluetooth LE') && rows[2].text.includes('Acme'));
    const head = await p.$$eval('.bt-head-acts .btn', (b) => b.map((x) => { const r = x.getBoundingClientRect(); return { w: Math.round(r.width), l: r.left, r: r.right, t: r.top }; }));
    check('the two head buttons share a width and keep a gap', head.length === 2 && Math.abs(head[0].w - head[1].w) <= 1 && Math.min(Math.abs(head[0].r - head[1].l), Math.abs(head[1].r - head[0].l)) >= 8, head);
    const aw = await p.$$eval('.bt-paired .bt-act .btn', (b) => b.map((x) => Math.round(x.getBoundingClientRect().width)));
    check('the rows\' buttons share a width', aw.length === 3 && aw.every((w) => Math.abs(w - aw[0]) <= 1), aw);
    check('no sideways overflow (connect panel)', (await overflow(p)) <= 1);
    await p.$eval('.bt-panel', (e) => e.scrollIntoView({ block: 'start' })); await p.waitForTimeout(150); await shot(p, 'bt-panel');
    // Connect: a busy row with Cancel, then done.
    await p.evaluate(() => { window.__btPlan['00:11:22:33:44:66'] = { result: 'ok', ms: 700 }; });
    await p.click('.bt-row[data-addr="00:11:22:33:44:66"] [data-act="connect"]');
    await p.waitForSelector('.bt-row[data-addr="00:11:22:33:44:66"][aria-busy="true"] [data-act="cancel"]');
    const busy = await p.textContent('.bt-row[data-addr="00:11:22:33:44:66"] .bt-busy');
    check('connecting: the row says so, with Cancel', busy.includes(AR ? 'جارٍ الاتصال' : 'Connecting'), busy);
    await p.$eval('.bt-row[data-addr="00:11:22:33:44:66"]', (e) => e.scrollIntoView({ block: 'center' })); await shot(p, 'bt-connecting');
    check('Connect asked through btAct({ op, addr })', JSON.stringify((await calls(p)).filter((c) => c[0] === 'btAct').pop()) === JSON.stringify(['btAct', { op: 'connect', addr: '00:11:22:33:44:66' }]));
    await p.waitForSelector('.bt-row[data-addr="00:11:22:33:44:66"][aria-busy="false"] [data-act="disconnect"]');
    const tt = await p.evaluate(() => document.querySelector('.toast')?.textContent ?? '');
    check('connected: told, and the row now offers Disconnect', tt.includes('Studio Speaker') && tt.includes(AR ? 'اتصل' : 'is connected'), tt);
    // Refused: in plain words with what to do, and the settings at hand.
    await p.evaluate(() => { window.__btPlan['00:11:22:33:44:55'] = { result: 'refused', ms: 30 }; });
    await p.click('.bt-row[data-addr="00:11:22:33:44:55"] [data-act="disconnect"]');
    await p.waitForSelector('.bt-row[data-addr="00:11:22:33:44:55"] .bt-msg');
    const ref = await p.textContent('.bt-row[data-addr="00:11:22:33:44:55"] .bt-msg');
    check('refused: said with what to do', ref.includes(AR ? 'رفض ويندوز' : 'Windows refused'), ref);
    await p.click('.bt-row[data-addr="00:11:22:33:44:55"] .bt-msg [data-act="settings"]'); await p.waitForTimeout(60);
    check('«Bluetooth settings» opens Windows\' own (btOpenSettings())', JSON.stringify((await calls(p)).pop()) === JSON.stringify(['btOpenSettings']));
    // Timed out.
    await p.evaluate(() => { window.__btPlan['00:11:22:33:44:55'] = { result: 'timedOut', ms: 30 }; });
    await p.click('.bt-row[data-addr="00:11:22:33:44:55"] [data-act="disconnect"]'); await p.waitForTimeout(250);
    const to = await p.textContent('.bt-row[data-addr="00:11:22:33:44:55"] .bt-msg');
    check('timed out: said with what to do', to.includes(AR ? 'طال الانتظار' : 'took too long'), to);
    // Cancelled: the row free again, no error.
    await p.evaluate(() => { window.__btPlan['00:11:22:33:44:55'] = { result: 'ok', ms: 8000 }; });
    await p.click('.bt-row[data-addr="00:11:22:33:44:55"] [data-act="disconnect"]');
    await p.click('.bt-row[data-addr="00:11:22:33:44:55"] [data-act="cancel"]');
    await p.waitForSelector('.bt-row[data-addr="00:11:22:33:44:55"][aria-busy="false"]');
    check('cancelled: btAct({ op: cancel }) and the row free, nothing said as a failure', (await calls(p)).some((c) => c[0] === 'btAct' && c[1].op === 'cancel' && c[1].addr === '00:11:22:33:44:55') && !(await p.$('.bt-row[data-addr="00:11:22:33:44:55"] .bt-msg')));
    // A scan, then Stop.
    await p.click('.bt-head [data-act="find"]');
    await p.waitForSelector('.bt-found .bt-row[data-addr="10:20:30:40:50:60"]');
    check('Find asks for a bounded scan (btScan({ seconds: 20 }))', JSON.stringify((await calls(p)).filter((c) => c[0] === 'btScan').pop()) === JSON.stringify(['btScan', { seconds: 20 }]));
    const found = await p.$$eval('.bt-found > .bt-row', (r) => r.map((e) => ({ pic: e.querySelector('.bt-pic')?.dataset.picture, act: e.querySelector('[data-act]')?.dataset.act, name: e.querySelector('.bt-name').textContent })));
    check('the new devices with their pictures and Pair; an unnamed one said so', found.length === 3 && found.every((f) => f.act === 'pair') && found[0].pic === 'pad' && found[1].pic === 'retro' && found[2].name === (AR ? 'جهاز بلا اسم' : 'Unnamed device'), found);
    check('scanning: said, with a progress bar and Stop', !!(await p.$('.bt-scan .bt-bar > i')) && !!(await p.$('.bt-head [data-act="stop"]')));
    await p.$eval('.bt-scan', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(120); await shot(p, 'bt-scan');
    await p.click('.bt-head [data-act="stop"]'); await p.waitForTimeout(120);
    check('Stop ends the scan (btScan({ stop: true }))', JSON.stringify((await calls(p)).filter((c) => c[0] === 'btScan').pop()) === JSON.stringify(['btScan', { stop: true }]) && !(await p.$('.bt-scan')) && !!(await p.$('.bt-head [data-act="find"]')));
    // Pairing: our question with the picture, then Windows' own window.
    await p.click('.bt-found .bt-row[data-addr="10:20:30:40:50:60"] [data-act="pair"]');
    await p.waitForSelector('.sheet .bt-pair-sheet .bt-pic.big[data-picture="pad"]');
    const sheet = await p.evaluate(() => { const s = document.querySelector('.sheet'); const b = s.querySelector('.sheet-body').getBoundingClientRect(); const last = s.querySelector('.bt-pair-sheet > :last-child').getBoundingClientRect(); const a = s.querySelector('.sheet-actions').getBoundingClientRect(); return { text: s.textContent, w: [...s.querySelectorAll('.sheet-actions .bat-eq')].map((x) => Math.round(x.getBoundingClientRect().width)), lastBottom: last.bottom, actionsTop: a.top, bodyBottom: b.bottom }; });
    check('the pairing question shows the device\'s picture and name, and that Windows\' own window confirms (no code of ours)', sheet.text.includes('Field Pad') && sheet.text.includes(AR ? 'لا تُدخِل' : 'never enters a code'), sheet.text);
    check('its two buttons share a width; the footer covers nothing', sheet.w.length === 2 && Math.abs(sheet.w[0] - sheet.w[1]) <= 1 && sheet.lastBottom <= sheet.actionsTop + 1, sheet);
    await p.waitForTimeout(400); await shot(p, 'bt-pair');
    await p.evaluate(() => { window.__btPlan['10:20:30:40:50:60'] = { result: 'ok', ms: 600 }; });
    await p.click('.sheet [data-act="pair"]');
    await p.waitForSelector('.bt-row[data-addr="10:20:30:40:50:60"][aria-busy="true"]');
    check('pairing handed to the system: btAct({ op: pair }) and the row asks to answer Windows\' window', JSON.stringify((await calls(p)).filter((c) => c[0] === 'btAct').pop()) === JSON.stringify(['btAct', { op: 'pair', addr: '10:20:30:40:50:60' }]) && (await p.textContent('.bt-row[data-addr="10:20:30:40:50:60"] .bt-busy')).includes(AR ? 'نافذة الاقتران' : 'pairing window'));
    await p.waitForSelector('.bt-paired .bt-row[data-addr="10:20:30:40:50:60"]');
    check('paired: now among the paired devices', !(await p.$('.bt-found .bt-row[data-addr="10:20:30:40:50:60"]')));
    check('no yellow, amber or orange in the panel', await p.evaluate(() => [...document.querySelectorAll('.bt-panel *, .bt-panel')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor, c.fill, c.stroke].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    // Leaving: the subscription let go, a running scan stopped.
    await p.click('.bt-head [data-act="find"]'); await p.waitForSelector('.bt-scan');
    check('subscribed to onBt once while open', (await p.evaluate(() => window.__btSubs)) === 1);
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(400);
    check('leaving: onBt let go and the scan stopped', (await p.evaluate(() => window.__btSubs)) === 0 && JSON.stringify((await calls(p)).filter((c) => c[0] === 'btScan').pop()) === JSON.stringify(['btScan', { stop: true }]));
    await ctx.close();
  }
  for (const m of ['btoff', 'btmissing']) {
    const { ctx, p } = await open(m);
    await p.waitForSelector(`.bt-state[data-radio="${m === 'btoff' ? 'off' : 'missing'}"]`);
    const st = await p.evaluate(() => ({ text: document.querySelector('.bt-state').textContent, find: document.querySelector('.bt-head [data-act="find"]').disabled, settings: !!document.querySelector('.bt-head [data-act="settings"]'), rows: document.querySelectorAll('.bt-row').length }));
    const want = m === 'btoff' ? (AR ? 'البلوتوث مُطفأ' : 'Bluetooth is off') : (AR ? 'لا بلوتوث' : 'has no Bluetooth');
    check(`${m}: said calmly, no list, Find off, the settings at hand`, st.text.includes(want) && st.find && st.settings && st.rows === 0, st);
    if (m === 'btoff') { await p.$eval('.bt-panel', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(150); await shot(p, 'bt-radio-off'); }
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
    check('another system: no Background group', !(await p.$('.bat-bg')));
    check('another system: no connect panel', !(await p.$('.bt-panel')) || !(await p.isVisible('.bt-panel')));
    await ctx.close();
  }
  // ---- W1: the taskbar like the original, device order, pictures, joins, notices.
  {
    const { ctx, p } = await open('tauri');
    await p.waitForSelector('.bat-tb[data-group="taskbar"]');
    const last = async () => (await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set;
    const tb = async () => p.$$eval('.bat-tb .bat-switch', (r) => r.map((e) => ({ row: e.dataset.row, on: e.querySelector('input').checked, dis: e.querySelector('input').disabled, role: e.querySelector('input').getAttribute('role') })));
    let rows = await tb();
    check('«Taskbar»: switches, all waiting for the background at first', rows.length === 5 && rows.every((r) => r.dis && r.role === 'switch'), rows);
    check('… its pickers too, and the reason said', (await p.$eval('[data-name="trayStyle"]', (e) => e.disabled)) && (await p.textContent('.bat-tb > .hint')) === (AR ? 'يقتضي تشغيلَ «مواصلة العمل في الخلفية».' : 'Needs «Keep running in the background».'));
    await p.click('.bat-bg [data-row="background"]'); await p.waitForTimeout(250);
    rows = await tb();
    const by = (n) => rows.find((r) => r.row === n);
    check('with the background: asleep devices shown, disconnected ones not, the strip off — as the original', by('trayAway').on && !by('trayGone').on && !by('strip').on && by('stripStacked').dis && by('stripPlate').dis, rows);
    check('one icon per device by default, drawn as the number', (await p.textContent('[data-name="trayStyle"]')) === (AR ? 'أيقونةٌ لكل جهاز' : 'One icon per device') && (await p.textContent('[data-name="trayDraw"]')) === (AR ? 'الرقم' : 'The number'));
    await p.click('[data-name="trayStyle"]'); await p.waitForSelector('.sheet .dest-row');
    const styles = await p.$$eval('.sheet .dest-row .name', (e) => e.map((x) => x.textContent));
    check('the tray\'s three ways', styles.length === 3, styles);
    await p.waitForTimeout(400); await shot(p, 'batW1-tray-style');
    await p.click('.sheet .dest-row:nth-child(2)'); await p.waitForTimeout(250);
    check('«one icon with the lowest level» kept', (await last()).trayStyle === 'lowest');
    await p.click('[data-name="trayDraw"]'); await p.waitForSelector('.sheet .dest-row'); await p.click('.sheet .dest-row:nth-child(2)'); await p.waitForTimeout(250);
    check('«a battery» kept', (await last()).trayDraw === 'bar');
    await p.click('.bat-tb [data-row="trayGone"]'); await p.waitForTimeout(250);
    check('disconnected devices shown: kept', (await last()).trayGone === true);
    await p.click('.bat-tb [data-row="strip"]'); await p.waitForTimeout(250);
    rows = await tb();
    check('the strip turned on, then its two looks can be chosen', (await last()).strip === true && !rows.find((r) => r.row === 'stripStacked').dis && !rows.find((r) => r.row === 'stripPlate').dis, rows);
    await p.click('.bat-tb [data-row="stripPlate"]'); await p.waitForTimeout(250);
    check('a background behind the strip kept', (await last()).stripPlate === true);
    const geo = await p.$$eval('.bat-tb .bat-row, .bat-tb .bat-switch', (rs) => rs.map((r) => { const kids = [...r.children].map((c) => c.getBoundingClientRect()).filter((b) => b.width > 0); let g = 1e9; for (let i = 1; i < kids.length; i++) g = Math.min(g, Math.abs(kids[i].left - kids[i - 1].right), Math.abs(kids[i - 1].left - kids[i].right)); return g; }));
    check('nothing touches in «Taskbar»', geo.every((g) => g >= 12), geo);
    const pw = await p.$$eval('.bat-tb .pick-btn', (b) => b.map((x) => Math.round(x.getBoundingClientRect().width)));
    check('its pickers share a width', pw.length === 2 && pw[0] === pw[1], pw);
    await p.$eval('.bat-tb', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'batW1-taskbar');
    // «Notices».
    const nt = await p.$$eval('.bat-nt .bat-switch', (r) => r.map((e) => ({ row: e.dataset.row, on: e.querySelector('input').checked })));
    check('«Notices»: sound on, quiet hours off by default', JSON.stringify(nt) === JSON.stringify([{ row: 'sound', on: true }, { row: 'quiet', on: false }]), nt);
    check('… the hours wait for the quiet hours', await p.$eval('[data-name="quietFrom"]', (e) => e.disabled));
    await p.click('.bat-nt [data-row="sound"]'); await p.waitForTimeout(250);
    check('the sound turned off: kept', (await last()).sound === false);
    await p.click('.bat-nt [data-row="quiet"]'); await p.waitForTimeout(250);
    check('quiet hours on: kept, said with their hours', (await last()).quiet === true && (await p.textContent('.bat-nt [data-row="quiet"] small')).replace(/\u200F/g, '') === (AR ? 'لا تنبيهات من 22:00 إلى 07:00.' : 'No notices from 22:00 to 07:00.'));
    await p.click('[data-name="quietFrom"]'); await p.waitForSelector('.sheet .dest-row');
    check('24 hours offered', (await p.$$('.sheet .dest-row')).length === 24);
    await p.click('.sheet .dest-row:nth-child(24)'); await p.waitForTimeout(250);
    check('from 23:00 kept', (await last()).quietFrom === 23);
    check('no native number spinner', !(await p.$('.battery-view input[type=number]')));
    await p.$eval('.bat-nt', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'batW1-notices');
    // (The same two cards in a dark system theme, for the pictures.)
    if (SHOTS) {
      await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(300);
      await shot(p, 'batW1-notices-dark');
      await p.$eval('.bat-tb', (e) => e.scrollIntoView({ block: 'center' })); await p.waitForTimeout(200); await shot(p, 'batW1-taskbar-dark');
      await p.emulateMedia({ colorScheme: 'light' }); await p.waitForTimeout(300);
    }
    // The checking interval from 30 s.
    await p.click('[data-name="every"]'); await p.waitForSelector('.sheet .dest-row');
    const ev = (await p.$$eval('.sheet .dest-row .name', (e) => e.map((x) => x.textContent.replace(/\u200F/g, ''))));
    check('checking every 30 s to every hour', ev.length === 8 && ev[0] === (AR ? '30 ثانيةً' : '30 seconds') && ev[7] === (AR ? '60 دقيقةً' : '60 minutes'), ev);
    await p.click('.sheet .dest-row:nth-child(1)'); await p.waitForTimeout(250);
    check('30 s kept as intervalSec', (await last()).intervalSec === 30);
    // Order: the cards follow the user's order; up and down from a device's menu.
    await p.$eval('.bat-grid', (e) => e.scrollIntoView({ block: 'start' }));
    const keys = () => p.$$eval('.bat-grid:not(.bat-hidden) > .bat-card', (c) => c.map((e) => e.dataset.key));
    const k0 = await keys();
    check('by default: by kind (headsets first), then name', k0[0] === 'bt:{H}' && k0[1] === 'bt:{E}', k0);
    await p.click('.bat-card[data-key="bt:{H}"] .bat-more'); await p.waitForSelector('.sheet [data-act="rename"]');
    check('the first has no «Move up»', !(await p.$('.sheet [data-act="up"]')) && !!(await p.$('.sheet [data-act="down"]')));
    await p.waitForTimeout(400); await shot(p, 'batW1-menu');
    await p.click('.sheet [data-act="down"]'); await p.waitForTimeout(250);
    const o1 = (await last()).order;
    check('moved down: kept as order, the cards follow', o1[0] === 'bt:{E}' && o1[1] === 'bt:{H}' && (await keys())[1] === 'bt:{H}', o1);
    check('… the menu button keeps the focus', (await p.evaluate(() => document.activeElement?.closest('.bat-card')?.dataset.key)) === 'bt:{H}');
    await p.click('.bat-card[data-key="bt:{H}"] .bat-more'); await p.click('.sheet [data-act="up"]'); await p.waitForTimeout(250);
    check('moved up again', (await keys())[0] === 'bt:{H}');
    // A picture of our own.
    await p.click('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-more'); await p.click('.sheet [data-act="picture"]'); await p.waitForSelector('.bat-pics button');
    const pics = await p.$$eval('.bat-pics button', (b) => b.map((x) => ({ p: x.dataset.picture, svg: !!x.querySelector('svg'), img: !!x.querySelector('img'), label: x.getAttribute('aria-label') })));
    check('our own drawn pictures, each named', pics.length === 14 && pics.every((x) => x.svg && !x.img && x.label), pics.slice(0, 3));
    const pg = await p.$$eval('.bat-pics button', (b) => { const r = b.map((x) => x.getBoundingClientRect()); let g = 1e9; for (let i = 1; i < r.length; i++) if (Math.abs(r[i].top - r[i - 1].top) < 2) g = Math.min(g, Math.max(r[i].left - r[i - 1].right, r[i - 1].left - r[i].right)); return g; });
    check('the pictures keep a real gap', pg >= 8, pg);
    await p.waitForTimeout(400); await shot(p, 'batW1-picture');
    await p.click('.bat-pics button[data-picture="retro"]'); await p.waitForTimeout(250);
    check('a picture kept as pictures; the card shows it', (await last()).pictures['hid:1111:2222:s:A1'] === 'retro' && (await p.$eval('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-ic svg', (e) => e.dataset.picture)) === 'retro');
    await p.click('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-more'); await p.click('.sheet [data-act="picture"]'); await p.waitForSelector('.bat-pics button');
    check('the chosen one is marked', (await p.getAttribute('.bat-pics button[data-picture="retro"]', 'aria-pressed')) === 'true');
    await p.click('.sheet [data-act="pictureOwn"]'); await p.waitForTimeout(250);
    check('its own picture back', !('hid:1111:2222:s:A1' in (await last()).pictures));
    // Join two entries, then separate them.
    await p.click('.bat-card[data-key="bt:{K}"] .bat-more'); await p.click('.sheet [data-act="join"]'); await p.waitForSelector('.sheet .dest-row[data-key]');
    await p.waitForTimeout(400); await shot(p, 'batW1-join');
    await p.click('.sheet .dest-row[data-key="hid:1111:2222:s:A1"]'); await p.waitForTimeout(250);
    const ln = (await last()).links;
    check('joined: kept as a link, then the list read again', JSON.stringify(ln) === JSON.stringify([['bt:{K}', 'hid:1111:2222:s:A1']]) && (await calls(p)).some((c) => c[0] === 'refresh'), ln);
    await p.click('.bat-card[data-key="bt:{K}"] .bat-more');
    check('a joined device offers to separate', !!(await p.$('.sheet [data-act="separate"]')) && !(await p.$('.sheet [data-act="join"]')));
    await p.click('.sheet [data-act="separate"]'); await p.waitForTimeout(250);
    check('separated: the link gone', JSON.stringify((await last()).links) === '[]');
    check('no sideways overflow (W1)', (await overflow(p)) <= 1);
    check('no yellow, amber or orange (W1)', await p.evaluate(() => [...document.querySelectorAll('.battery-view *')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForTimeout(400);
    check('leaving the page unsubscribes (W1)', (await p.evaluate(() => window.__subs)) === 0);
    await ctx.close();
  }
  // ---- W2: the battery history and the time-left estimate; the microphone's picture.
  {
    const { ctx, p } = await open('tauri');
    await p.waitForSelector('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-est');
    const est = await p.$$eval('.bat-card', (cs) => Object.fromEntries(cs.map((c) => [c.dataset.key, c.querySelector('.bat-est')?.textContent ?? null])));
    check('a card says its time left, quietly', est['hid:1111:2222:s:A1'] === (AR ? 'يبقى نحوُ 5 ساعات' : 'About 5 hours left'), est);
    check('… two hours in Arabic\'s dual, genitive after «نحو»', est['bt:{H}'] === (AR ? 'يبقى نحوُ ساعتين' : 'About 2 hours left'), est);
    check('… «full in» while charging', est['bt:{E}'] === (AR ? 'يكتمل شحنُه بعد نحوِ 40 دقيقةً' : 'Full in about 40 minutes'), est);
    check('… nothing for an asleep device or one without an estimate', est['hid:3333:4444:c:{M}'] === null && est['xinput:0:pad'] === null, est);
    const estStyle = await p.$eval('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-est', (e) => ({ size: parseFloat(getComputedStyle(e).fontSize), colour: getComputedStyle(e).color, title: e.title }));
    check('… small, in the quiet colour, with a word that it is a trend', estStyle.size <= 13.5 && !!estStyle.title, estStyle);
    await shot(p, 'batW2-cards');
    if (SHOTS) { await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForFunction(() => document.documentElement.dataset.ui !== 'light'); await shot(p, 'batW2-cards-dark'); await p.emulateMedia({ colorScheme: 'light' }); await p.waitForFunction(() => document.documentElement.dataset.ui === 'light'); }
    // «History»: on by default, 30 days; kept through batterySettings.
    const last = async () => (await calls(p)).filter((c) => c[0] === 'settings').pop()[1].set;
    const hs = await p.$eval('.bat-hs[data-group="history"]', (e) => ({ on: e.querySelector('[data-row="history"] input').checked, role: e.querySelector('[data-row="history"] input').getAttribute('role'), keep: e.querySelector('[data-name="historyDays"]').textContent }));
    check('«History»: a switch, on by default, kept 30 days', hs.on && hs.role === 'switch' && hs.keep.includes('30'), hs);
    await p.click('[data-name="historyDays"]'); await p.waitForSelector('.sheet .dest-row');
    const keeps = await p.$$eval('.sheet .dest-row .name', (e) => e.map((x) => x.textContent));
    check('… 7, 30 or 90 days', keeps.length === 3 && /7/.test(keeps[0]) && /90/.test(keeps[2]), keeps);
    await p.click('.sheet .dest-row:nth-child(3)'); await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'settings' && c[1].set && c[1].set.historyDays === 90));
    check('… 90 days kept as historyDays', (await last()).historyDays === 90);
    await p.$eval('.bat-hs', (e) => e.scrollIntoView({ block: 'center' })); await shot(p, 'batW2-settings');

    // The history of a device, from its menu.
    await p.click('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-more'); await p.waitForSelector('.sheet [data-act="history"]');
    await p.click('.sheet [data-act="history"]'); await p.waitForSelector('.bat-hist-chart svg .ln', { state: 'attached' });
    const hc = await p.evaluate(() => window.__histCalls);
    check('asked of the shell for that device and a week', JSON.stringify(hc[0]) === JSON.stringify(['history', { key: 'hid:1111:2222:s:A1', range: 'week' }]), hc);
    const v = await p.evaluate(() => {
      const svg = document.querySelector('.bat-hist-chart svg'); const st = (sel) => [...svg.querySelectorAll(sel)].map((e) => getComputedStyle(e).stroke);
      const root = getComputedStyle(document.documentElement);
      return { pressed: [...document.querySelectorAll('.bat-hist-range button')].map((b) => b.getAttribute('aria-pressed')), role: svg.getAttribute('role'), tab: svg.getAttribute('tabindex'), label: svg.getAttribute('aria-label'),
        sum: document.querySelector('.bat-hist-sum').textContent, est: document.querySelector('.bat-hist-est').textContent, acc: st('.ln.acc'), low: st('.ln.low'), chg: st('.ln.chg'), bands: svg.querySelectorAll('.band').length,
        runs: new Set([...svg.querySelectorAll('.ln')].map((e) => e.dataset.run)).size, primary: root.getPropertyValue('--md-primary').trim(), W: Number(svg.getAttribute('width')),
        now: Number(svg.querySelector('text.now').getAttribute('x')), yLab: Number(svg.querySelector('text').getAttribute('x')), title: document.querySelector('.sheet .sheet-head h3').textContent };
    });
    check('three periods, a week first', JSON.stringify(v.pressed) === '["false","true","false"]', v.pressed);
    check('the summary: readings, lowest, highest, latest', v.sum.includes(AR ? 'عدد القراءات' : 'readings') && /9/.test(v.sum) && /96/.test(v.sum), v.sum);
    check('the chart is an image with that sentence, reachable by the keyboard', v.role === 'img' && v.tab === '0' && v.label.includes(v.sum), v.label);
    check('the estimate with its rate', v.est.includes(AR ? 'يبقى نحوُ 5 ساعات' : 'About 5 hours left') && /1\.6/.test(v.est), v.est);
    const rgb = (c) => (/rgba?\((\d+), (\d+), (\d+)/.exec(c) || []).slice(1).map(Number);
    check('the line in the accent', v.acc.length > 10 && v.acc.every((c) => c === v.acc[0]), v.acc.slice(0, 2));
    check('red only below the low mark', v.low.length > 0 && v.low.every((c) => { const [r, g, b] = rgb(c); return r > g && r > b; }), v.low.slice(0, 2));
    check('blue while charging, with a band behind', v.chg.length > 0 && v.bands > 0 && v.chg.every((c) => { const [r, g, b] = rgb(c); return b > r && b > g; }), [v.chg[0], v.bands]);
    check('a gap where the device was away (two runs at least)', v.runs >= 2, v.runs);
    check(AR ? 'right to left: «now» on the left, the level\'s labels on the right' : '«now» on the right, the level\'s labels on the left', AR ? v.now < v.W / 2 && v.yLab > v.W / 2 : v.now > v.W / 2 && v.yLab < v.W / 2, v);
    check('the sheet names the device', v.title.includes('Shape Mouse One'), v.title);
    check('no yellow, amber or orange (W2)', await p.evaluate(() => [...document.querySelectorAll('.sheet *')].every((e) => { const c = getComputedStyle(e); return [c.color, c.backgroundColor, c.borderColor, c.stroke, c.fill].every((x) => { const m = /rgba?\((\d+), (\d+), (\d+)/.exec(x); if (!m) return true; const [r, g, b] = m.slice(1).map(Number); return !(r > 180 && g > 100 && b < 90 && r - b > 120); }); })));
    // (The value under the pointer, then with the keys.)
    const box = await p.$eval('.bat-hist-chart svg', (e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; });
    await p.mouse.move(box.x + box.w * 0.5, box.y + box.h * 0.5); await p.waitForSelector('.bat-hist-tip:not([hidden])');
    const tip1 = await p.textContent('.bat-hist-tip');
    check('the pointer shows a reading\'s time and level', /\d/.test(tip1) && tip1.includes(AR ? '٪' : '%'), tip1);
    await shot(p, 'batW2-history');
    await p.focus('.bat-hist-chart svg'); await p.keyboard.press('End');
    const tipEnd = await p.textContent('.bat-hist-tip');
    check('End: the latest reading', tipEnd.includes(AR ? '9٪' : '9%'), tipEnd);
    await p.keyboard.press(AR ? 'ArrowRight' : 'ArrowLeft'); await p.waitForFunction((x) => document.querySelector('.bat-hist-tip').textContent !== x, tipEnd);
    check('the arrow toward the past moves back a reading', (await p.textContent('.bat-hist-tip')) !== tipEnd);
    if (SHOTS) { await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForFunction(() => document.documentElement.dataset.ui !== 'light'); await shot(p, 'batW2-history-dark'); await p.emulateMedia({ colorScheme: 'light' }); await p.waitForFunction(() => document.documentElement.dataset.ui === 'light'); }
    // (Another period.)
    await p.click('.bat-hist-range [data-range="day"]'); await p.waitForFunction(() => window.__histCalls.some((c) => c[1] && c[1].range === 'day'));
    await p.waitForFunction(() => document.querySelector('.bat-hist-range [data-range="day"]').getAttribute('aria-pressed') === 'true' && document.querySelectorAll('.bat-hist-chart svg .ln').length > 0);
    check('the last 24 hours asked for', true);
    await p.click('.bat-hist-range [data-range="month"]'); await p.waitForFunction(() => window.__histCalls.some((c) => c[1] && c[1].range === 'month'));
    await p.waitForFunction(() => document.querySelectorAll('.bat-hist-chart svg .ln').length > 0);
    await shot(p, 'batW2-history-month');
    check('no sideways overflow in the sheet', await p.evaluate(() => { const s = document.querySelector('.sheet'); return s.scrollWidth <= s.clientWidth + 1; }));
    // (Clearing: asked first.)
    await p.click('.sheet [data-act="historyClear"]'); await p.waitForSelector('.sheet [data-act="historyClearYes"]');
    check('clearing asks first, naming the device', (await p.textContent('.sheet .bat-hist-ask')).includes('Shape Mouse One'));
    await shot(p, 'batW2-clear');
    await p.click('.sheet [data-act="historyCancel"]'); await p.waitForFunction(() => !document.querySelector('.sheet [data-act="historyClearYes"]'));
    check('Cancel clears nothing', !(await p.evaluate(() => window.__histCalls.some((c) => c[0] === 'clear'))));
    await p.click('.sheet [data-act="historyClear"]'); await p.click('.sheet [data-act="historyClearYes"]');
    await p.waitForFunction(() => window.__histCalls.some((c) => c[0] === 'clear'));
    check('… cleared through the bridge for that device', JSON.stringify((await p.evaluate(() => window.__histCalls.find((c) => c[0] === 'clear')))) === JSON.stringify(['clear', { key: 'hid:1111:2222:s:A1' }]));
    await p.waitForSelector('.bat-hist-empty');
    check('… then nothing to show, said', (await p.textContent('.bat-hist-sum')) === (AR ? 'لا قراءاتِ في هذه المدة بعدُ؛ وإنما تُسجَّل ما دامت أدوات كروكاوا تفحص هذا الجهاز.' : 'No readings in this period yet. They are recorded while Kurokawa Tools checks this device.'));
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('.sheet'));
    // (History off: kept through the settings; the sheet then says recording is off.)
    await p.click('.bat-hs [data-row="history"]'); await p.waitForFunction(() => window.__calls.some((c) => c[0] === 'settings' && c[1].set && c[1].set.history === false));
    check('turning the history off is kept', (await last()).history === false);
    // (The microphone's picture, among ours.)
    await p.click('.bat-card[data-key="hid:1111:2222:s:A1"] .bat-more'); await p.click('.sheet [data-act="picture"]'); await p.waitForSelector('.bat-pics [data-picture="microphone"] svg');
    check('a microphone drawing among the pictures', (await p.getAttribute('.bat-pics [data-picture="microphone"]', 'aria-label')) === (AR ? 'لاقط صوت' : 'Microphone'));
    await p.keyboard.press('Escape');
    check('no sideways overflow (W2)', (await overflow(p)) <= 1);
    await p.evaluate(() => { location.hash = '#/settings'; }); await p.waitForFunction(() => window.__subs === 0);
    check('leaving the page unsubscribes (W2)', true);
    await ctx.close();
  }
  {
    // ---- W4: «Report a device».
    const { ctx, p } = await open('tauri');
    await p.waitForSelector('.bat-card');
    const net = []; p.on('request', (r) => { if (!/^http:\/\/127\.0\.0\.1/.test(r.url()) && !/^(data|blob):/.test(r.url())) net.push(r.url()); });
    check('«More» is in the page\'s bar', await p.isVisible('.battery-view .topbar [data-icon="more"], .battery-view .topbar button[aria-label="' + (AR ? 'المزيد' : 'More') + '"]'));
    await p.click('.battery-view .topbar button[aria-label="' + (AR ? 'المزيد' : 'More') + '"]'); await p.waitForSelector('.sheet [data-act="report"]');
    check('one row: «Report a device»', (await p.$$('.sheet .dest-row')).length === 1 && (await p.textContent('.sheet [data-act="report"] .name')).includes(AR ? 'الإبلاغ عن جهاز' : 'Report a device'));
    await shot(p, 'batW4-more');
    await p.click('.sheet [data-act="report"]'); await p.waitForSelector('.sheet textarea.bat-rep-text'); await p.waitForFunction(() => document.querySelector('.sheet textarea.bat-rep-text').value.startsWith('Kurokawa Tools device report'));
    check('asked of the shell once', (await calls(p)).filter((c) => c[0] === 'report').length === 1);
    const shown = await p.$eval('.sheet textarea.bat-rep-text', (e) => ({ v: e.value, dir: getComputedStyle(e).direction, ro: e.readOnly, label: e.getAttribute('aria-label') }));
    check('the whole text is shown, left to right, editable', shown.v.includes('Devices the app sees (2)') && shown.v.includes('HID collections seen (1)') && shown.dir === 'ltr' && !shown.ro && !!shown.label, shown);
    check('nothing forbidden in what is shown (serial, address, user name, folder)', !/[0-9a-f]{2}([:-])[0-9a-f]{2}(\1[0-9a-f]{2}){4}/i.test(shown.v) && !/serial number:|SN-|Users[\\/]|\/home\//i.test(shown.v) && !/\bTester\b|MY-PC/i.test(shown.v), shown.v.slice(0, 200));
    const words = await p.$eval('.sheet .bat-rep', (e) => e.innerText);
    check('says the text is English, what is left out, that nothing is sent by the app, and that it can be edited', words.includes(AR ? 'بالإنجليزية' : 'in English') && words.includes(AR ? 'حُذف عمدًا' : 'Left out on purpose') && words.includes(AR ? 'لا يرسل منه شيئًا' : 'sends nothing') && words.includes(AR ? 'تعديل النص' : 'edit the text') && words.includes('Kurokawa Tools'), words);
    check('the counts', words.includes(AR ? 'الأجهزة: 2، ومجموعات HID: 1' : 'Devices: 2, HID collections: 1'), words);
    check('no link in the sheet', !(await p.$('.sheet .bat-rep a')));
    // Copy: the clipboard gets the text as it is shown — after an edit too.
    await p.evaluate(() => { window.__clip = null; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: (t) => { window.__clip = t; return Promise.resolve(); } } }); });
    await p.click('.sheet [data-act="copy"]'); await p.waitForFunction(() => window.__clip !== null);
    check('Copy puts the shown text on the clipboard', (await p.evaluate(() => window.__clip)) === shown.v);
    await p.fill('.sheet textarea.bat-rep-text', shown.v.split('Shape Mouse One').join('My mouse')); await p.evaluate(() => { window.__clip = null; });
    await p.click('.sheet [data-act="copy"]'); await p.waitForFunction(() => window.__clip !== null);
    check('an edited text is what is copied', (await p.evaluate(() => window.__clip)).includes('My mouse') && !(await p.evaluate(() => window.__clip)).includes('Shape Mouse One'));
    await shot(p, 'batW4-report');
    await p.click('.sheet [data-act="save"]'); await p.waitForFunction(() => window.__saved);
    const sv = await p.evaluate(() => window.__saved);
    check('Save goes through saveText with a file name and the shown text', sv.name === 'kurokawa-tools-device-report.txt' && sv.text.includes('My mouse') && Object.keys(sv).sort().join() === 'name,text', sv.name);
    const eq = await p.$$eval('.sheet-actions .btn', (bs) => bs.map((b) => { const r = b.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.left), Math.round(r.right)]; }));
    check('Copy and Save are equal and do not touch', eq.length === 2 && Math.abs(eq[0][0] - eq[1][0]) <= 1 && (eq[0][2] <= eq[1][1] - 4 || eq[1][2] <= eq[0][1] - 4), eq);
    check('the last line is not covered by the footer', await p.evaluate(() => { const b = document.querySelector('.sheet .sheet-body'); const a = document.querySelector('.sheet .sheet-actions'); const hnt = [...b.querySelectorAll('.hint')].pop(); b.scrollTop = b.scrollHeight; return hnt.getBoundingClientRect().bottom <= a.getBoundingClientRect().top + 1; }));
    check('no network request (the page sent nothing anywhere)', net.length === 0, net);
    check('no sideways overflow (W4)', (await overflow(p)) <= 1);
    await p.keyboard.press('Escape'); await p.waitForFunction(() => !document.querySelector('.sheet'));
    await ctx.close();
  }
  {
    // (Where the platform has no reader the page has no «More».)
    const { ctx, p } = await open('nothere');
    await p.waitForSelector('.bat-empty[data-state="notHere"]');
    check('no «More» where the platform has no reader', !(await p.isVisible('.battery-view .topbar button[aria-label="' + (AR ? 'المزيد' : 'More') + '"]')));
    await ctx.close();
  }
  {
    // (A Mac: the start with the system is offered as on the other systems — the shell writes its LaunchAgent —, its
    //  switch usable once the background is on, with the usual line.)
    const { ctx, p } = await open('mac');
    await p.waitForSelector('.bat-bg [data-row="startup"]');
    await p.click('.bat-bg [data-row="background"]'); await p.waitForTimeout(250);
    const m = await p.$eval('.bat-bg [data-row="startup"]', (e) => ({ dis: e.querySelector('input').disabled, hint: e.querySelector('small').textContent }));
    check('a Mac: start with the system offered (LaunchAgent), its switch usable', !m.dis && m.hint === (AR ? 'يُفتَح في علبة النظام عند تسجيل دخولك.' : 'Opens in the tray when you sign in.'), m);
    await ctx.close();
  }
  {
    const { ctx, p } = await open('electron');
    await p.waitForSelector('.bat-empty[data-state="mainBuild"]');
    check('the Electron build: no Background group', !(await p.$('.bat-bg')));
    check('the Electron build: no connect panel', !(await p.$('.bt-panel')));
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
