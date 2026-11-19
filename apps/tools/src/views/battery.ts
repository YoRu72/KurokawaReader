// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery (0.21, the computer's): the batteries of wireless mice, keyboards, headsets, earbuds and controllers,
// read by the Tauri shell over kt-battery (derived from Wireless Device Battery Monitor by krisgfx9 — NOTICE.md). A card
// per device with our own drawn icon for its kind (no makers' logos), its name (the user's own if he gave one), its
// brand as text, its level (exact, in steps, or unknown), charging, the reading's age, asleep or away dimmed; a menu
// per device (refresh, rename, hide, do not query, its own low mark); the hidden ones apart; how often to check and when
// a level is low. Piece 2, «Background» (the computer's Tauri build only): keep running in the background (closing the
// window leaves the app in the tray, the checking goes on), start with the system hidden, low-battery notices (per
// device mark — kt-battery notice.rs decides in the shell) and an optional «fully charged» one.
// Piece 3, «Connect a device» (views/btconnect.ts): the paired Bluetooth devices with our own pictures, Connect /
// Disconnect, «Find new devices» and pairing through Windows' own window.
// Piece 4, controllers: a controller's card shows our drawing of its family (two-stick pad, retro pad, one Joy-Con, a
// pad with trackpads — btconnect.ts's drawings), a level in steps as «n of max» with as many bars, why a level is
// missing (only in a mode Tools does not switch on, its family's reading off, no controller linked to a receiver); its
// menu says discreetly which reader read it and how far that reader is proven, and turns a family's status request on
// or off; «Controllers» holds one switch per family whose reading sends a request (off by default: ported, untested).
// Piece 5, mice and keyboards: «Mice and keyboards» lists every family (collapsed; a field finds a brand), each with
// its switch — a family whose reading sends a status request off until turned on, one read by listening alone on until
// turned off; a card's menu turns its family's request on or off as a controller's does; «no device linked to this
// receiver» for a receiver alone.
// Piece 6, headsets, earbuds and the rest: «Headsets and earbuds» and «Other» (a microphone, a phone through Phone Link)
// in the same collapsed, searchable design; earbuds' card shows its parts (left, right, case) as small labelled levels —
// the card's own level is the lowest part in use, never the case (kt-battery model.rs); «both in the case», «needs a
// part of Windows this build does not include» said calmly; Galaxy Buds' switch says it connects. Xbox pads named in
// the page's language.
// The Electron build and the phone have no reader: a calm word instead, never a dead button. Loaded on first use.
import { h, icon, iconButton, openSheet, pickButton, pickSheet, toast } from '../ui/dom';
import { btDesk, btPanel, picSvg } from './btconnect';
import { t, localDigits } from '../i18n';
import { back } from '../router';

type Lvl = { kind: 'exact'; value: number } | { kind: 'coarse'; value: 'empty' | 'low' | 'medium' | 'high' | 'full'; bars: number } | { kind: 'steps'; value: number; max: number } | { kind: 'unknown' };
/** note: why a level is missing — '' | 'needsQuery' | 'queryOff' | 'noPad' (piece 4) | 'unlinked' (piece 5) | 'inCase' |
 *  'notInBuild' (piece 6). parts: a device of several cells (earbuds: left, right, case), piece 6. */
type Part = { part: 'left' | 'right' | 'case'; level: Lvl; charging: 'yes' | 'no' | 'unknown'; inUse: boolean };
type Rd = { level: Lvl; charging: 'yes' | 'no' | 'unknown'; asleep: boolean; takenAt: number; note?: string; parts?: Part[] };
export type BatDevice = { key: string; name: string; kind: string; brand: string; connection: string; source: string; vid: number; pid: number; merged: string[];
  status: 'ok' | 'waiting' | 'asleep' | 'notConnected' | 'noAnswer' | 'notQueried'; reading: Rd | null; lastGood: Rd | null; checkedAt: number;
  /** Piece 4: a controller's reader, family, how far proven, whether it sends a request, and its drawing. */
  picture?: string; driver?: string; family?: string; proven?: 'tested' | 'untested' | ''; way?: 'passive' | 'query' | '' };
/** One controller family: its brand as text, how far proven, whether its reading sends a request, allowed now. */
type PadRow = { family: string; brand: string; proven: 'tested' | 'untested'; ask: boolean; listen: boolean; models: string[]; on: boolean };
/** Piece 5: one mice / keyboards family — its switch is on when its request is allowed (ask) or its listening kept. */
type MkRow = { family: string; brand: string; proven: 'tested' | 'untested'; ask: boolean; listen: boolean; on: boolean; group?: 'mice' | 'heads' | 'other'; connects?: boolean };
export type BatSettings = { intervalMin: number; low: number; names: Record<string, string>; hidden: string[]; noQuery: string[]; links: [string, string][];
  /** Piece 2: closing the window leaves the app in the tray; the start with the system, hidden (needs the background). */
  background: boolean; startup: boolean;
  /** Low-battery notices (on by default) and the «fully charged» one (off); a device's own mark: 0 = no notice. */
  notifyLow: boolean; notifyFull: boolean; thresholds: Record<string, number>;
  /** Piece 4: the controller families whose status request may be sent. */
  padQueries?: string[];
  /** Piece 5: mice / keyboards families whose request may be sent; those read by listening that are turned off. */
  mkAsk?: string[]; mkMute?: string[] };
/** What the shell can do here: a start with the system ('notYet' on a Mac), a tray icon. */
type BatSystem = { autostart: 'yes' | 'notYet'; tray: boolean };
type BatList = { available: boolean; reason?: string; now: number; devices: BatDevice[]; settings: BatSettings; system?: BatSystem; pads?: PadRow[]; mice?: MkRow[] };
/** The marks offered (kt-battery notice.rs CHOICES). */
const MARKS = [10, 15, 20, 30];
/** The bridge's methods (desktop-tauri/bridge.js — the same names and arguments). */
type Desk = { batteryList(): Promise<BatList>; batteryRefresh(o: { key?: string }): Promise<boolean>; batterySettings(o: { set?: Partial<BatSettings> }): Promise<BatSettings>; onBattery(cb: (e: { now: number; devices: BatDevice[] }) => void): () => void };
const desk = (): Desk | null => { const d = (window as unknown as { kurokawaTools?: Partial<Desk> }).kurokawaTools; return d?.batteryList && d.onBattery ? d as Desk : null; };

// Our own drawings, one per kind (24×24, strokes like the app's icons).
const KIND_SVG: Record<string, string> = {
  mouse: '<rect x="6.5" y="3" width="11" height="18" rx="5.5"/><path d="M12 3v6"/><path d="M6.5 9h11"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M6 13.5h.01M18 13.5h.01M9 14.5h6"/>',
  headset: '<path d="M4 15v-3a8 8 0 0 1 16 0v3"/><rect x="3" y="14" width="4.5" height="6.5" rx="1.8"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="1.8"/>',
  earbuds: '<path d="M7 4.5a3 3 0 0 1 3 3v1.5a3 3 0 0 1-3 3 3 3 0 0 1-3-3V7.5a3 3 0 0 1 3-3Z"/><path d="M8 12v7.5"/><path d="M17 4.5a3 3 0 0 0-3 3v1.5a3 3 0 0 0 3 3 3 3 0 0 0 3-3V7.5a3 3 0 0 0-3-3Z"/><path d="M16 12v7.5"/>',
  controller: '<path d="M7 7h10a5 5 0 0 1 4.8 6.4l-1 3.4a2.5 2.5 0 0 1-4.3.9L14.8 16H9.2l-1.7 1.7a2.5 2.5 0 0 1-4.3-.9l-1-3.4A5 5 0 0 1 7 7Z"/><path d="M7.5 10v3M6 11.5h3"/><path d="M16 10.5h.01M17.5 12.5h.01"/>',
  speaker: '<rect x="5" y="2.5" width="14" height="19" rx="3"/><circle cx="12" cy="14.5" r="3.5"/><path d="M12 7h.01"/>',
  phone: '<rect x="7" y="2.5" width="10" height="19" rx="2.5"/><path d="M11 18.5h2"/>',
  other: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M9 12h6"/>',
};
const BOLT = '<path d="M13 2.5 5.5 13H12l-1 8.5L18.5 11H12l1-8.5Z"/>';
function kindIcon(kind: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = KIND_SVG[kind] ?? KIND_SVG.other; return svg;
}
/** A controller's picture: its family's drawing (the reader's, else a two-stick pad); other kinds: the kind's icon. */
function deviceIcon(x: { kind: string; picture?: string }): SVGElement {
  if (x.picture || x.kind === 'controller') { const s = picSvg(x.picture || 'pad'); s.classList.add('bat-drawn'); return s; }
  return kindIcon(x.kind);
}
function bolt(): SVGElement { const s = kindIcon('other'); s.innerHTML = BOLT; s.classList.add('bat-bolt'); return s; }

const CSS = `
.battery-view .bat-body { display: flex; flex-direction: column; gap: 16px; padding-bottom: 96px; }
.bat-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.bat-head .bat-count { flex: 1; margin: 0; color: var(--md-on-surface-variant); }
.bat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 14px; }
.bat-card { position: relative; display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; column-gap: 14px; row-gap: 10px; padding: 18px 14px 16px 18px; border-radius: var(--sh-xl, 28px); background: var(--md-surface-container-low); }
.bat-card .bat-ic { width: 52px; height: 52px; border-radius: 18px; display: grid; place-items: center; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.bat-card .bat-ic svg, .bat-empty .bat-ic svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.bat-card .bat-ic svg.bat-drawn { width: 38px; height: 38px; stroke-width: 2.3; }
.bat-card .bat-ic svg.bat-drawn .f { fill: currentColor; fill-opacity: .22; stroke: none; }
.bat-card .bat-bars.steps > i { width: 9px; }
.bat-card .bat-note { font-size: 14px; color: var(--md-on-surface-variant); line-height: 1.45; }
.sheet .bat-reader { margin: 12px 4px 2px; font-size: 12.5px; color: var(--md-on-surface-variant); line-height: 1.5; }
.battery-view .bat-pads { gap: 4px; }
.battery-view .bat-pads h3 { margin-bottom: 2px; }
.battery-view .bat-pads > .hint { margin: 0 0 6px; }
.battery-view .bat-word { white-space: nowrap; }
.battery-view .bat-fams .bat-mk-head { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; margin-top: 4px; }
.battery-view .bat-fams .bat-mk-find { flex: 1 1 200px; min-width: 0; height: 44px; padding: 0 16px; border-radius: 22px; border: 1px solid var(--md-outline-variant); background: var(--md-surface-container); color: var(--md-on-surface); font: inherit; }
.battery-view .bat-fams .bat-mk-list { display: flex; flex-direction: column; margin-top: 8px; }
.battery-view .bat-fams .bat-mk-none { margin: 10px 0 0; color: var(--md-on-surface-variant); }
.bat-card .bat-parts { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(auto-fit, minmax(84px, 1fr)); gap: 8px; }
.bat-card .bat-part { display: flex; flex-direction: column; gap: 6px; min-width: 0; padding: 10px 12px; border-radius: 16px; background: var(--md-surface-container); }
.bat-card .bat-part .bat-part-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.bat-card .bat-part .bat-part-val { font-size: 15px; font-weight: 650; color: var(--md-on-surface); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.bat-card .bat-part .bat-meter { flex: 0 0 auto; height: 6px; border-radius: 3px; }
.bat-card .bat-part.out .bat-part-val { font-weight: 500; font-size: 13px; color: var(--md-on-surface-variant); white-space: normal; line-height: 1.3; }
.bat-card .bat-part:not(.low) .bat-meter > i { background: var(--md-primary); }
.bat-card .bat-part .bat-bolt { width: 13px; height: 13px; color: var(--md-primary); }
.bat-card .bat-part.low .bat-part-val { color: var(--md-error); }
.bat-card .bat-part.low .bat-meter > i { background: var(--md-error); }
.battery-view .bat-pads .bat-listen { margin: 6px 0 0; font-size: 12.5px; color: var(--md-on-surface-variant); line-height: 1.5; }
.bat-card .bat-who { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.bat-card .bat-name { font-weight: 650; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--md-on-surface); }
.bat-card .bat-sub { font-size: 12.5px; color: var(--md-on-surface-variant); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bat-card .bat-level { grid-column: 1 / -1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; min-height: 36px; }
.bat-card .bat-pct { font-size: 28px; font-weight: 700; letter-spacing: -.01em; color: var(--md-on-surface); font-variant-numeric: tabular-nums; min-width: 3.4ch; }
.bat-card .bat-meter { flex: 1; height: 10px; border-radius: 5px; background: var(--md-surface-container-highest); overflow: hidden; }
.bat-card .bat-meter > i { display: block; height: 100%; border-radius: inherit; background: var(--md-primary); }
.bat-card .bat-bars { display: flex; gap: 5px; align-items: flex-end; }
.bat-card .bat-bars > i { width: 10px; height: 22px; border-radius: 4px; background: var(--md-surface-container-highest); }
.bat-card .bat-bars > i.on { background: var(--md-primary); }
.bat-card .bat-word { font-size: 18px; font-weight: 650; color: var(--md-on-surface); }
.bat-card .bat-unknown { font-size: 15px; color: var(--md-on-surface-variant); }
.bat-card .bat-via::before { content: '·'; margin-inline-end: 10px; }
.bat-card .bat-chip + .bat-via::before, .bat-card .bat-foot > .bat-via:first-child::before { content: none; margin: 0; }
.bat-card .bat-foot { grid-column: 1 / -1; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 12.5px; color: var(--md-on-surface-variant); }
.bat-card .bat-chip { display: inline-flex; align-items: center; gap: 4px; height: 26px; padding: 0 10px; border-radius: 13px; background: var(--md-surface-container-high); color: var(--md-on-surface-variant); font-weight: 600; }
.bat-card .bat-level > .bat-chip.charging { flex: 0 0 auto; margin-inline-start: auto; }
.bat-card .bat-level > .bat-meter + .bat-chip.charging { margin-inline-start: 0; }
.bat-card .bat-chip.charging { background: var(--md-primary-container); color: var(--md-on-primary-container); }
.bat-card .bat-bolt { width: 15px; height: 15px; fill: currentColor; stroke: none; }
.bat-card.low .bat-pct, .bat-card.low .bat-word { color: var(--md-error); }
.bat-card.low .bat-meter > i, .bat-card.low .bat-bars > i.on { background: var(--md-error); }
.bat-card.low .bat-ic { background: var(--md-error-container, color-mix(in srgb, var(--md-error) 18%, transparent)); color: var(--md-on-error-container, var(--md-error)); }
.bat-card.dim .bat-ic, .bat-card.dim .bat-who, .bat-card.dim .bat-level { opacity: .5; }
.bat-card .bat-more { align-self: start; }
.bat-empty { display: flex; flex-direction: column; gap: 12px; }
.bat-empty .bat-ic { width: 56px; height: 56px; border-radius: 20px; display: grid; place-items: center; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.bat-empty h3 { text-transform: none; letter-spacing: 0; font-size: 18px; color: var(--md-on-surface); }
.bat-empty ul { margin: 0; }
.bat-hidden-toggle { align-self: flex-start; }
.battery-view .bat-settings .bat-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; }
.battery-view .bat-settings .bat-row > span { flex: 1 1 220px; min-width: 0; display: flex; flex-direction: column; gap: 3px; color: var(--md-on-surface); }
.battery-view .bat-settings .bat-row > span > small { color: var(--md-on-surface-variant); font-size: 12.5px; }
.battery-view .bat-settings .bat-row .pick-btn { flex: 0 0 168px; width: 168px; }
.battery-view .bat-bg { gap: 4px; }
.battery-view .bat-bg h3 { margin-bottom: 6px; }
.battery-view .bat-switch { gap: 20px; padding: 12px 0; cursor: pointer; }
.battery-view .bat-switch + .bat-switch { border-top: 1px solid var(--md-outline-variant); }
.battery-view .bat-switch .bat-sw-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.battery-view .bat-switch .bat-sw-title { color: var(--md-on-surface); font-size: 15px; }
.battery-view .bat-switch small { color: var(--md-on-surface-variant); font-size: 12.5px; line-height: 1.5; }
.battery-view .bat-switch.is-off { cursor: default; }
.battery-view .bat-switch.is-off .bat-sw-title { color: var(--md-on-surface-variant); }
.sheet .dest-row[data-act="mark"] .name { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; text-align: start; }
.sheet .dest-row .bat-mark-val { color: var(--md-on-surface-variant); font-size: 12.5px; }
.bat-rename { display: flex; flex-direction: column; gap: 12px; }
.sheet-actions .bat-eq { flex: 1 1 0; min-width: 0; justify-content: center; }
.bat-rename input { height: 44px; padding: 0 14px; border-radius: 12px; }
`;
function style(): void {
  if (document.getElementById('kt-battery-css')) return;
  const s = document.createElement('style'); s.id = 'kt-battery-css'; s.textContent = CSS; document.head.append(s);
}

/** «just now», «3 min ago», … for a time in the shell's clock. */
export function ageText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t('batAgoNow');
  if (s < 3600) return t('batAgoMin', { n: localDigits(Math.floor(s / 60)) });
  if (s < 86400) return t('batAgoHour', { n: localDigits(Math.floor(s / 3600)) });
  return t('batAgoDay', { n: localDigits(Math.floor(s / 86400)) });
}
export function levelText(l: Lvl): string {
  if (l.kind === 'exact') return t('batPct', { n: localDigits(l.value) });
  if (l.kind === 'coarse') return t(`batCoarse_${l.value}` as 'batCoarse_low');
  if (l.kind === 'steps') return t('batSteps', { n: localDigits(l.value), max: localDigits(l.max) });
  return t('batLevelUnknown');
}
/** Steps as the core reads them (kt-battery model.rs Steps::coarse): none left, or up to a quarter, is low. */
const stepsLow = (n: number, max: number): boolean => n === 0 || n * 4 <= max;
/** A device's own mark (0: no notice), else the default. */
export function markOf(S: BatSettings, key: string): number { const v = S.thresholds?.[key]; return typeof v === 'number' && (v === 0 || MARKS.includes(v)) ? v : S.low; }
const isLow = (l: Lvl | undefined, low: number): boolean => !!l && (l.kind === 'exact' ? l.value <= low : l.kind === 'coarse' ? l.value === 'empty' || l.value === 'low' : l.kind === 'steps' ? stepsLow(l.value, l.max) : false);

export function batteryView(): HTMLElement & { dispose?: () => void } {
  style();
  const body = h('div', { class: 'body bat-body' });
  const refreshBtn = iconButton('refresh', t('batRefreshAll'), () => void refreshAll());
  const root = h('div', { class: 'view battery-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/settings')), h('div', { class: 'title' }, h('span', null, t('batTitle'))), refreshBtn), body) as HTMLElement & { dispose?: () => void };
  const d = desk();
  if (!d) {
    // (The Electron build, the phone, the web: no reader here.)
    refreshBtn.hidden = true;
    body.append(h('section', { class: 'card bat-empty', 'data-state': 'mainBuild' }, h('div', { class: 'bat-ic' }, kindIcon('mouse')), h('h3', null, t('batMainBuild')), h('p', null, t('batMainBuildHint'))));
    return root;
  }
  let list: BatList | null = null; let showHidden = false; let gone = false;
  // (Piece 3: made once, kept across redraws — its rows' busy states and messages are its own.)
  const bd = btDesk(); const bt = bd ? btPanel(bd, (title, close) => openSheet(title, close), () => list?.settings.low ?? 15) : null;
  const grid = h('div', { class: 'bat-grid' }); const head = h('div', { class: 'bat-head' }); const extra = h('div');
  body.append(h('div', { class: 'spinner small' }));
  // (An XInput slot is named in the page's words — its key «xinput:<user>:pad|headset»; the shell's tray says the same.)
  const xboxName = (key: string): string => { const m = /^xinput:(\d+):(pad|headset)$/.exec(key); return !m ? '' : m[2] === 'headset' ? t('batXboxHeadset') : t('batXboxPad', { n: localDigits(Number(m[1]) + 1) }); };
  const nameOf = (x: BatDevice) => list?.settings.names[x.key] || x.name || xboxName(x.key) || t('batUnnamed');
  // (A refusal — the start with the system could not be written — said, and the switches drawn back as they were.)
  const saveSettings = async (set: Partial<BatSettings>, errKey?: 'batStartFailed') => { try { const s = await d.batterySettings({ set }); if (list) list.settings = s; draw(); } catch (e) { const m = String((e as Error)?.message ?? e); toast(errKey ? t(errKey, { error: m }) : m, 'error'); draw(); } };
  async function refreshAll(): Promise<void> { await d!.batteryRefresh({}).catch(() => false); }

  const padBrand = (x: BatDevice): string => list?.pads?.find((p) => p.family === x.family)?.brand || list?.mice?.find((p) => p.family === x.family)?.brand || x.brand;
  // (Piece 5's and 6's families: one setting, mkAsk / mkMute, for mice, headsets and the rest alike.)
  const isMk = (family?: string): boolean => !!family && /^(mk|hs|ot)-/.test(family);
  const card = (x: BatDevice): HTMLElement => {
    const S = list!.settings; const r = x.reading; const lvl = r?.level;
    const dim = (x.status !== 'ok' && x.status !== 'waiting') || r?.note === 'noPad' || r?.note === 'unlinked';
    const mk = markOf(S, x.key); const low = x.status === 'ok' && isLow(lvl, mk || S.low);
    const via = t(`batVia_${x.connection}` as 'batVia_usb');
    const sub = [x.brand, t(`batKind_${x.kind}` as 'batKind_mouse')].filter(Boolean).join(' · ');
    const level = h('div', { class: 'bat-level' });
    if (r && lvl?.kind === 'exact') level.append(h('span', { class: 'bat-pct', dir: 'ltr' }, levelText(lvl)), h('div', { class: 'bat-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(lvl.value), 'aria-label': t('batTitle') }, h('i', { style: { width: `${lvl.value}%` } })));
    else if (r && lvl?.kind === 'coarse') level.append(h('div', { class: 'bat-bars', title: t('batCoarseHint'), 'aria-label': levelText(lvl) }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= lvl.bars ? 'on' : '' }))), h('span', { class: 'bat-word' }, levelText(lvl)));
    else if (r && lvl?.kind === 'steps') {
      // (As many bars as the device has steps, ten at most — a longer scale drawn in tenths.)
      const n = Math.min(lvl.max, 10); const on = Math.round(lvl.value * n / Math.max(1, lvl.max));
      level.append(h('div', { class: 'bat-bars steps', title: t('batStepsHint'), 'aria-label': levelText(lvl) }, ...Array.from({ length: n }, (_, i) => h('i', { class: i < on ? 'on' : '' }))), h('span', { class: 'bat-word', dir: 'auto' }, levelText(lvl)));
    }
    else if (r && r.note && x.status === 'ok') level.append(h('span', { class: 'bat-note', 'data-note': r.note }, t(`batNote_${r.note === 'queryOff' && isMk(x.family) ? 'queryOffMk' : r.note}` as 'batNote_noPad', { family: padBrand(x) })));
    else if (x.lastGood && dim) level.append(h('span', { class: 'bat-unknown' }, t('batLastKnown', { age: ageText(x.lastGood.takenAt, list!.now), level: levelText(x.lastGood.level) })));
    else level.append(h('span', { class: 'bat-unknown' }, x.status === 'waiting' ? t('batSt_waiting') : t('batLevelUnknown')));
    // (Piece 6: earbuds' parts — left, right, case — each a small labelled level; a bud in its case without a level says
    //  so. The card's own level above is the lowest part in use.)
    const parts = r && x.status === 'ok' && r.parts?.length ? h('div', { class: 'bat-parts', role: 'list' }, ...r.parts.map((p) => {
      const known = p.level.kind !== 'unknown'; const plow = known && p.part !== 'case' && isLow(p.level, mk || S.low);
      const val = known ? levelText(p.level) : p.part !== 'case' && !p.inUse ? t('batPartInCase') : t('batLevelUnknown');
      return h('div', { class: 'bat-part' + (known ? '' : ' out') + (plow ? ' low' : ''), role: 'listitem', 'data-part': p.part, 'data-in-use': String(p.inUse) },
        h('span', { class: 'bat-part-head' }, h('span', null, t(`batPart_${p.part}` as 'batPart_left')), p.charging === 'yes' ? bolt() : null),
        h('span', { class: 'bat-part-val', dir: 'auto' }, val),
        p.level.kind === 'exact' ? h('div', { class: 'bat-meter', 'aria-hidden': 'true' }, h('i', { style: { width: `${p.level.value}%` } })) : p.level.kind === 'steps' ? h('div', { class: 'bat-meter', 'aria-hidden': 'true' }, h('i', { style: { width: `${Math.round(100 * p.level.value / Math.max(1, p.level.max))}%` } })) : null);
    })) : null;
    const foot = h('div', { class: 'bat-foot' });
    // (Charging sits with the level it qualifies, so the foot's line of small facts stays one line on a narrow card.)
    if (r?.charging === 'yes') level.append(h('span', { class: 'bat-chip charging' }, bolt(), t('batCharging')));
    if (x.status !== 'ok' && x.status !== 'waiting') foot.append(h('span', { class: 'bat-chip', 'data-status': x.status }, t(`batSt_${x.status}` as 'batSt_asleep')));
    if (r) foot.append(h('span', { class: 'bat-age' }, t('batReadAt', { age: ageText(r.takenAt, list!.now) })));
    if (x.connection !== 'unknown') foot.append(h('span', { class: 'bat-via' }, via));
    const more = iconButton('more', t('batMenu', { name: nameOf(x) }), (e) => menu(x, e)); more.classList.add('bat-more');
    return h('article', { class: 'bat-card' + (low ? ' low' : '') + (dim ? ' dim' : ''), 'data-key': x.key, 'data-kind': x.kind, 'data-status': x.status },
      h('div', { class: 'bat-ic' }, deviceIcon(x)), h('div', { class: 'bat-who' }, h('span', { class: 'bat-name', dir: 'auto' }, nameOf(x)), h('span', { class: 'bat-sub', dir: 'auto' }, sub)), more, level, parts, foot);
  };

  const menu = (x: BatDevice, ev: Event) => {
    const S = list!.settings; const sh = openSheet(nameOf(x), t('close'), { at: ev });
    const act = (ic: string, label: string, fn: () => void, name: string) => h('button', { type: 'button', class: 'dest-row', 'data-act': name, onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    const hidden = S.hidden.includes(x.key); const quiet = S.noQuery.includes(x.key);
    const markRow = act('bell', t('batMark'), () => markPick(x, ev), 'mark'); markRow.querySelector('.name')?.append(h('small', { class: 'bat-mark-val', dir: 'auto' }, markText(S, x.key)));
    sh.body.append(h('div', { class: 'dest-list' },
      ...(quiet ? [] : [act('refresh', t('batRefreshOne'), () => void d.batteryRefresh({ key: x.key }).catch(() => false), 'refresh')]),
      act('pencil', t('batRename'), () => rename(x), 'rename'),
      markRow,
      act(hidden ? 'eye' : 'eyeOff', hidden ? t('batUnhide') : t('batHide'), () => void saveSettings({ hidden: hidden ? S.hidden.filter((k) => k !== x.key) : [...S.hidden, x.key] }), 'hide'),
      act(quiet ? 'refresh' : 'shield', quiet ? t('batQueryAgain') : t('batNoQuery'), () => { void saveSettings({ noQuery: quiet ? S.noQuery.filter((k) => k !== x.key) : [...S.noQuery, x.key] }).then(() => { if (!quiet) toast(t('batNoQueryDone', { name: nameOf(x) })); }); }, 'noQuery'),
      ...(x.way === 'query' && x.family ? [padToggle(x.family, padBrand(x), sh.close)] : [])));
    // (Which reader read it, and how far that reader is proven — said quietly at the end.)
    if (x.family && x.proven) sh.body.append(h('p', { class: 'bat-reader', dir: 'auto', 'data-proven': x.proven }, t('batReader', { family: padBrand(x), status: t(`batProven_${x.proven}` as 'batProven_untested') })));
  };
  const padOn = (family: string): boolean => isMk(family) ? (list?.settings.mkAsk ?? []).includes(family) : (list?.settings.padQueries ?? []).includes(family);
  const setPad = (family: string, on: boolean) => { if (isMk(family)) { setMk(family, true, on); return; } const cur = list?.settings.padQueries ?? []; void saveSettings({ padQueries: on ? [...cur.filter((f) => f !== family), family] : cur.filter((f) => f !== family) }).then(() => void d.batteryRefresh({}).catch(() => false)); };
  const padToggle = (family: string, brand: string, close: () => void): HTMLElement => {
    const on = padOn(family);
    return h('button', { type: 'button', class: 'dest-row', 'data-act': 'padQuery', 'data-family': family, onclick: () => { close(); setPad(family, !on); } }, icon(on ? 'stop' : 'chip'), h('span', { class: 'name' }, on ? t('batPadsStop', { family: brand }) : t('batPadsTry', { family: brand })));
  };

  // (Piece 5: a family that sends — its request allowed or not (mkAsk); one read by listening alone — kept or turned
  // off (mkMute). Followed by a refresh, as the controllers' switches.)
  const setMk = (family: string, ask: boolean, on: boolean) => {
    const S = list?.settings; const key = ask ? 'mkAsk' : 'mkMute'; const cur = (ask ? S?.mkAsk : S?.mkMute) ?? [];
    const add = ask ? on : !on; const next = add ? [...cur.filter((f) => f !== family), family] : cur.filter((f) => f !== family);
    void saveSettings({ [key]: next } as Partial<BatSettings>).then(() => void d.batteryRefresh({}).catch(() => false));
  };
  const pct = (n: number) => t('batPct', { n: localDigits(n) });
  // (Right to left: a choice that is only a number opens with a right-to-left mark, so it sits beside its radio as the
  // words do; a device's name kept apart from the words around it.)
  const rtl = (s: string) => (document.documentElement.dir === 'rtl' ? '\u200F' + s : s);
  const iso = (s: string) => '\u2068' + s + '\u2069';
  const markText = (S: BatSettings, key: string) => { const own = S.thresholds?.[key]; return own === undefined || !(own === 0 || MARKS.includes(own)) ? t('batMarkDefault', { level: pct(S.low) }) : own === 0 ? t('batMarkOff') : pct(own); };
  // A device's own low mark: as the others, one of the marks, or no notice.
  const markPick = (x: BatDevice, ev: Event) => {
    const S = list!.settings; const own = S.thresholds?.[x.key];
    const cur = own === undefined || !(own === 0 || MARKS.includes(own)) ? 'default' : String(own);
    const opts: [string, string][] = [['default', t('batMarkDefault', { level: pct(S.low) })], ...MARKS.map((m) => [String(m), rtl(pct(m))] as [string, string]), ['0', t('batMarkOff')]];
    pickSheet(t('batMarkFor', { name: iso(nameOf(x)) }), opts, cur, (v) => { const next = { ...(S.thresholds ?? {}) }; if (v === 'default') delete next[x.key]; else next[x.key] = Number(v); void saveSettings({ thresholds: next }); }, t('close'), ev);
  };

  const rename = (x: BatDevice) => {
    const sh = openSheet(t('batRename'), t('close'));
    const input = h('input', { type: 'text', value: list!.settings.names[x.key] ?? '', placeholder: x.name || t('batUnnamed'), maxlength: '64', dir: 'auto', 'aria-label': t('batRename') }) as HTMLInputElement;
    const names = () => ({ ...list!.settings.names });
    const save = () => { const n = names(); const v = input.value.trim(); if (v) n[x.key] = v; else delete n[x.key]; sh.close(); void saveSettings({ names: n }); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    sh.body.append(h('div', { class: 'bat-rename' }, input, h('p', { class: 'hint' }, t('batRenameHint'))));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal bat-eq', onclick: () => { const n = names(); delete n[x.key]; sh.close(); void saveSettings({ names: n }); } }, t('batNameOwn')),
      h('button', { type: 'button', class: 'btn primary bat-eq', onclick: save }, t('save')));
    setTimeout(() => input.focus(), 50);
  };

  const settingsCard = (): HTMLElement => {
    const S = list!.settings;
    const every = pickButton(t('batEvery'), ['1', '2', '5', '10', '15', '30', '60'].map((v) => [v, rtl(t('batEveryN', { n: localDigits(v) }))] as [string, string]), String(S.intervalMin), (v) => void saveSettings({ intervalMin: Number(v) }), t('close'));
    const low = pickButton(t('batLow'), MARKS.map((v) => [String(v), rtl(pct(v))] as [string, string]), String(S.low), (v) => void saveSettings({ low: Number(v) }), t('close'));
    every.dataset.name = 'every'; low.dataset.name = 'low';
    return h('section', { class: 'card bat-settings' }, h('h3', null, t('batSettingsTitle')),
      h('div', { class: 'bat-row' }, h('span', null, t('batEvery')), every),
      h('div', { class: 'bat-row' }, h('span', null, t('batLow'), h('small', null, t('batLowHint'))), low),
      h('p', { class: 'hint' }, t('batSafeNote')));
  };

  const sw = (name: string, title: string, hint: string, on: boolean, off: boolean, fn: (v: boolean) => void): HTMLElement => {
    const i = h('input', { type: 'checkbox', role: 'switch', checked: on, disabled: off, 'aria-label': title, onchange: () => fn(i.checked) }) as HTMLInputElement;
    return h('label', { class: 'switch-row bat-switch' + (off ? ' is-off' : ''), 'data-row': name }, h('span', { class: 'bat-sw-text' }, h('span', { class: 'bat-sw-title', dir: 'auto' }, title), h('small', null, hint)), i);
  };

  // Piece 4: «Controllers» — a switch per family whose reading sends a status request (off until turned on), and the
  // families read by listening alone named below.
  const padsCard = (): HTMLElement | null => {
    const rows = list!.pads ?? []; if (!rows.length) return null;
    const ask = rows.filter((p) => p.ask); const listen = rows.filter((p) => p.listen);
    return h('section', { class: 'card bat-settings bat-pads', 'data-group': 'pads' }, h('h3', null, t('batPadsTitle')), h('p', { class: 'hint' }, t('batPadsHint')),
      ...ask.map((p) => {
        const hint = [p.models.join(t('batListSep')), p.proven === 'tested' ? t('batProven_tested') : t('batPadsTryHint')].filter(Boolean).join(' — ');
        const row = sw(`pad-${p.family}`, t('batPadsTry', { family: p.brand }), hint, padOn(p.family), false, (v) => setPad(p.family, v)); row.dataset.family = p.family; return row;
      }),
      listen.length ? h('p', { class: 'bat-listen', dir: 'auto' }, t('batPadsListen', { list: listen.map((p) => p.brand).join(t('batListSep')) })) : null);
  };

  // Piece 5: «Mice and keyboards» — every family with its switch, collapsed until asked for; a field finds a brand
  // (the rows hidden in place, so the field keeps its focus while typing). Piece 6: «Headsets and earbuds» and «Other»
  // the same way, each with its own open state and field.
  const GROUPS = { mice: { cls: 'bat-mice', title: 'batMiceTitle', hint: 'batMiceHint' }, heads: { cls: 'bat-heads', title: 'batHeadsTitle', hint: 'batHeadsHint' }, other: { cls: 'bat-other', title: 'batOtherTitle', hint: 'batOtherHint' } } as const;
  type GroupId = keyof typeof GROUPS;
  const famState: Record<GroupId, { open: boolean; find: string }> = { mice: { open: false, find: '' }, heads: { open: false, find: '' }, other: { open: false, find: '' } };
  const famCard = (g: GroupId): HTMLElement | null => {
    const st = famState[g]; const G = GROUPS[g];
    const rows = (list!.mice ?? []).filter((p) => (p.group ?? 'mice') === g).sort((a, b) => a.brand.localeCompare(b.brand)); if (!rows.length) return null;
    const toggle = h('button', { type: 'button', class: 'btn tonal small bat-mk-toggle', 'aria-expanded': String(st.open), onclick: () => { st.open = !st.open; draw(); } }, icon(st.open ? 'chevronUp' : 'chevronDown'), st.open ? t('batMiceHide') : t('batMiceShow', { n: localDigits(rows.length) }));
    const head = h('div', { class: 'bat-mk-head' }, toggle);
    const card = h('section', { class: `card bat-settings bat-fams ${G.cls}`, 'data-group': g }, h('h3', null, t(G.title)), h('p', { class: 'hint' }, t(G.hint)), head);
    if (!st.open) return card;
    const none = h('p', { class: 'bat-mk-none' }, t('batMiceNone')); none.hidden = true;
    const els = rows.map((p) => {
      const way = p.connects ? t('batMiceConnect') : p.ask && p.listen ? t('batMiceBoth') : p.ask ? t('batMiceAsk') : t('batMiceListen');
      const hint = [way, p.proven === 'tested' ? t('batProven_tested') : t('batProven_untested')].join(' — ');
      const row = sw(p.family, p.brand, hint, p.ask ? (list!.settings.mkAsk ?? []).includes(p.family) : !(list!.settings.mkMute ?? []).includes(p.family), false, (v) => setMk(p.family, p.ask, v));
      // (The brand is a name, set in the page's direction: a Latin brand in an Arabic list stays at the row's start.)
      row.querySelector('.bat-sw-title')?.removeAttribute('dir');
      row.dataset.family = p.family; return { p, row };
    });
    const filter = () => { const q = st.find.trim().toLowerCase(); let n = 0; for (const e of els) { e.row.hidden = !!q && !e.p.brand.toLowerCase().includes(q); if (!e.row.hidden) n++; } none.hidden = n > 0; };
    const find = h('input', { type: 'search', class: 'bat-mk-find', dir: 'auto', value: st.find, placeholder: t('batMiceSearch'), 'aria-label': t('batMiceSearch'), oninput: () => { st.find = find.value; filter(); } }) as HTMLInputElement;
    head.append(find); card.append(h('div', { class: 'bat-mk-list' }, ...els.map((e) => e.row)), none); filter();
    return card;
  };

  // Piece 2: «Background» — switches, each with its line of explanation; what cannot be had here said, not hidden.
  const backgroundCard = (): HTMLElement => {
    const S = list!.settings; const sys: BatSystem = list!.system ?? { autostart: 'yes', tray: true };
    const canKeep = sys.tray; const canStart = sys.autostart === 'yes' && canKeep && S.background;
    const startHint = sys.autostart !== 'yes' ? t('batBgStartNotYet') : !S.background ? t('batBgStartNeeds') : t('batBgStartHint');
    return h('section', { class: 'card bat-settings bat-bg', 'data-group': 'background' }, h('h3', null, t('batBgTitle')),
      sw('background', t('batBgKeep'), canKeep ? t('batBgKeepHint') : t('batBgNoTray'), canKeep && S.background, !canKeep, (v) => void saveSettings({ background: v }, 'batStartFailed')),
      sw('startup', t('batBgStart'), startHint, canStart && S.startup, !canStart, (v) => void saveSettings({ startup: v }, 'batStartFailed')),
      sw('notifyLow', t('batBgLowOn'), t('batBgLowOnHint'), S.notifyLow !== false, false, (v) => void saveSettings({ notifyLow: v })),
      sw('notifyFull', t('batBgFullOn'), t('batBgFullOnHint'), !!S.notifyFull, false, (v) => void saveSettings({ notifyFull: v })));
  };

  function draw(): void {
    if (!list || gone) return;
    if (!list.available) {
      refreshBtn.hidden = true;
      body.replaceChildren(h('section', { class: 'card bat-empty', 'data-state': 'notHere' }, h('div', { class: 'bat-ic' }, kindIcon('mouse')), h('h3', null, t('batNotHere')), h('p', null, t('batNotHereHint'))));
      return;
    }
    const S = list.settings; const hid = new Set(S.hidden);
    const shown = list.devices.filter((x) => !hid.has(x.key)).sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    const hiddenOnes = list.devices.filter((x) => hid.has(x.key));
    head.replaceChildren(h('p', { class: 'bat-count' }, t('batCount', { n: localDigits(shown.length) })));
    grid.replaceChildren(...shown.map(card));
    extra.replaceChildren();
    if (hiddenOnes.length) {
      extra.append(h('button', { type: 'button', class: 'btn tonal small bat-hidden-toggle', 'aria-expanded': String(showHidden), onclick: () => { showHidden = !showHidden; draw(); } }, icon(showHidden ? 'chevronUp' : 'chevronDown'), t('batHidden', { n: localDigits(hiddenOnes.length) })));
      if (showHidden) extra.append(h('div', { class: 'bat-grid bat-hidden', style: { marginTop: '14px' } }, ...hiddenOnes.map(card)));
    }
    const empty = !list.devices.length ? h('section', { class: 'card bat-empty', 'data-state': 'empty' }, h('div', { class: 'bat-ic' }, kindIcon('controller')), h('h3', null, t('batEmptyTitle')), h('p', null, t('batEmptyBody')),
      h('ul', null, h('li', null, t('batEmpty1')), h('li', null, t('batEmpty2')), h('li', null, t('batEmpty3'))), h('p', null, t('batEmptyLater'))) : null;
    body.replaceChildren(...[empty ? null : head, empty ?? grid, extra, bt?.el ?? null, padsCard(), famCard('mice'), famCard('heads'), famCard('other'), settingsCard(), backgroundCard()].filter(Boolean) as HTMLElement[]);
  }

  const off = d.onBattery((e) => { if (!list || !e) return; list.now = e.now; list.devices = Array.isArray(e.devices) ? e.devices : []; draw(); });
  // (The ages move on while the page is open: redrawn every half minute — no per-second timer.)
  const tick = window.setInterval(() => { if (list) { list.now += 30_000; draw(); } }, 30_000);
  void d.batteryList().then((l) => { list = l; draw(); }).catch((e) => { body.replaceChildren(h('section', { class: 'card' }, h('p', null, String((e as Error).message ?? e)))); });
  root.dispose = () => { gone = true; off(); clearInterval(tick); bt?.dispose(); };
  return root;
}
