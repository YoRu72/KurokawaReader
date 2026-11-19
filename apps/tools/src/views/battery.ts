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
// W1, the taskbar like the original: «Taskbar» — in the notification area one icon with the devices in its menu, one
// icon showing the lowest level, or one icon per device (the level drawn in it: the number or a small battery), asleep
// and away devices shown dimmed or left out, and the original's strip on the taskbar itself (off by default; the
// drawing above the level, a background behind it); «Notices» — their sound and quiet hours. A device's menu moves it
// up or down (the page, the tray and the strip follow that order), gives it another of our drawn pictures, and joins
// two entries of one device (its receiver and Bluetooth) or separates them again. Phone Link said in the page's words.
// The Electron build and the phone have no reader: a calm word instead, never a dead button. Loaded on first use.
// Piece S1: «System on the taskbar» (views/sysmon.ts, loaded with the page's first draw) after «Taskbar».
// W2, the battery history (after the original's v1.1.0): a card says «about 5 hours left» or «full in about 40 minutes»
// quietly under its level when the shell's estimate (kt-battery history.rs) has one, and nothing otherwise; a device's
// menu opens its history (views/bathistory.ts, loaded on first use); «History» keeps a battery history (on by default,
// as the original) for 7, 30 or 90 days. A microphone may be given our microphone drawing.
import { h, icon, iconButton, openSheet, pickButton, pickSheet, toast } from '../ui/dom';
import { btDesk, btPanel, picSvg } from './btconnect';
import { localDigits, getLang, countMinutes, countHours, countDays, countSeconds } from '../i18n';
// (Piece P1: the words with Linux's and macOS's own variants, and their card — views/batplat.ts.)
import { osT as t, platCard } from './batplat';
import { back } from '../router';

type Lvl = { kind: 'exact'; value: number } | { kind: 'coarse'; value: 'empty' | 'low' | 'medium' | 'high' | 'full'; bars: number } | { kind: 'steps'; value: number; max: number } | { kind: 'unknown' };
/** note: why a level is missing — '' | 'needsQuery' | 'queryOff' | 'noPad' (piece 4) | 'unlinked' (piece 5) | 'inCase' |
 *  'notInBuild' (piece 6). parts: a device of several cells (earbuds: left, right, case), piece 6. */
type Part = { part: 'left' | 'right' | 'case'; level: Lvl; charging: 'yes' | 'no' | 'unknown'; inUse: boolean };
type Rd = { level: Lvl; charging: 'yes' | 'no' | 'unknown'; asleep: boolean; takenAt: number; note?: string; parts?: Part[] };
export type BatDevice = { key: string; name: string; kind: string; brand: string; connection: string; source: string; vid: number; pid: number; merged: string[];
  status: 'ok' | 'waiting' | 'asleep' | 'notConnected' | 'noAnswer' | 'notQueried'; reading: Rd | null; lastGood: Rd | null; checkedAt: number;
  /** Piece 4: a controller's reader, family, how far proven, whether it sends a request, and its drawing. */
  picture?: string; driver?: string; family?: string; proven?: 'tested' | 'untested' | ''; way?: 'passive' | 'query' | '';
  /** W2: about this long until empty, or until full while charging (from the recorded history); null: nothing to say. */
  estimate?: { state: 'empty' | 'full'; minutes: number } | null };
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
  mkAsk?: string[]; mkMute?: string[];
  /** W1: the tray ('app' | 'lowest' | 'each'), its drawing, asleep and away devices shown, the strip on the taskbar and its
   *  looks; the user's order of devices, a device's own picture; the notices' sound and quiet hours (whole hours). */
  trayStyle?: 'app' | 'lowest' | 'each'; trayDraw?: 'number' | 'bar'; trayAway?: boolean; trayGone?: boolean;
  /** The checking interval in seconds (30 s to an hour, the original's v1.1.0 choices); intervalMin follows it. */
  intervalSec?: number; strip?: boolean; stripStacked?: boolean; stripPlate?: boolean;
  order?: string[]; pictures?: Record<string, string>; quiet?: boolean; quietFrom?: number; quietTo?: number; sound?: boolean;
  /** W2: keep a battery history (on by default), for 7, 30 or 90 days. */
  history?: boolean; historyDays?: number };
/** What the shell can do here: a start with the system ('notYet' on a Mac), a tray icon. */
type BatSystem = { autostart: 'yes' | 'notYet'; tray: boolean };
type BatList = { available: boolean; reason?: string; now: number; devices: BatDevice[]; settings: BatSettings; system?: BatSystem; pads?: PadRow[]; mice?: MkRow[] };
/** Our drawn pictures a device may be given (btconnect.ts's set; kt-battery taskbar.rs PICTURES). */
const PICTURES = ['mouse', 'keyboard', 'headset', 'earbuds', 'pad', 'retro', 'split', 'half', 'trackpads', 'speaker', 'phone', 'microphone', 'pen', 'other'];
/** The default order by kind (kt-battery taskbar.rs kind_rank, as the original's). */
const KIND_RANK: Record<string, number> = { headset: 0, earbuds: 1, mouse: 2, keyboard: 3, controller: 4, phone: 5, speaker: 6 };
/** The marks offered (kt-battery notice.rs CHOICES). */
const MARKS = [5, 10, 15, 20, 25, 30, 35, 40];
/** The bridge's methods (desktop-tauri/bridge.js — the same names and arguments). */
type Desk = { batteryList(): Promise<BatList>; batteryRefresh(o: { key?: string }): Promise<boolean>; batterySettings(o: { set?: Partial<BatSettings> }): Promise<BatSettings>; onBattery(cb: (e: { now: number; devices: BatDevice[] }) => void): () => void;
  /** W2 (bathistory.ts's HistDesk): a device's history, and clearing it. */
  batteryHistory?: import('./bathistory').HistDesk['batteryHistory']; batteryHistoryClear?: import('./bathistory').HistDesk['batteryHistoryClear'];
  /** W4 (batreport.ts's ReportDesk): the text of «Report a device» — the computer's build only. */
  batteryReport?: import('./batreport').ReportDesk['batteryReport'] };
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
  microphone: '<rect x="9" y="2.5" width="6" height="11.5" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5v4M9 21.5h6"/>',
  other: '<rect x="4" y="5" width="16" height="14" rx="3"/><path d="M9 12h6"/>',
};
const BOLT = '<path d="M13 2.5 5.5 13H12l-1 8.5L18.5 11H12l1-8.5Z"/>';
function kindIcon(kind: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = KIND_SVG[kind] ?? KIND_SVG.other; return svg;
}
/** A device's picture: the user's choice, else its family's drawing (a controller: a two-stick pad), else its kind's icon. */
function deviceIcon(x: { kind: string; picture?: string }, own?: string): SVGElement {
  const p = own || x.picture;
  if (p || x.kind === 'controller') { const s = picSvg(p || 'pad'); s.classList.add('bat-drawn'); return s; }
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
.bat-pics { display: grid; grid-template-columns: repeat(auto-fill, minmax(76px, 1fr)); gap: 10px; }
.bat-pics > button { display: grid; place-items: center; height: 72px; border-radius: 18px; border: 1px solid var(--md-outline-variant); background: var(--md-surface-container); color: var(--md-on-surface); cursor: pointer; }
.bat-pics > button[aria-pressed="true"] { background: var(--md-secondary-container); color: var(--md-on-secondary-container); border-color: transparent; outline: 2px solid var(--md-primary); outline-offset: 2px; }
.bat-pics > button:focus-visible { outline: 2px solid var(--md-primary); outline-offset: 2px; }
.bat-pics svg { width: 40px; height: 40px; fill: none; stroke: currentColor; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; }
.bat-pics svg .f { fill: currentColor; fill-opacity: .22; stroke: none; }
.sheet .dest-row .bat-join-ic { display: grid; place-items: center; width: 28px; height: 28px; flex: 0 0 28px; }
.sheet .dest-row .bat-join-ic svg { width: 26px; height: 26px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
.sheet .dest-row .bat-join-ic svg.bat-drawn { stroke-width: 2.6; }
.sheet .dest-row .bat-join-ic svg .f { fill: currentColor; fill-opacity: .22; stroke: none; }
.sheet .bat-join-hint { margin: 0 4px 10px; font-size: 13px; color: var(--md-on-surface-variant); line-height: 1.5; }
.battery-view .bat-tb .bat-row + .bat-row, .battery-view .bat-nt .bat-row + .bat-row { margin-top: 10px; }
.battery-view .bat-tb .bat-switch:first-of-type, .battery-view .bat-nt .bat-switch:first-of-type { border-top: 1px solid var(--md-outline-variant); margin-top: 8px; }
.battery-view .bat-tb .bat-sub-sw { padding-inline-start: 20px; }
.battery-view .bat-tb .bat-row .pick-btn { flex: 0 1 300px; width: 300px; max-width: 100%; }
.battery-view .bat-tb .hint, .battery-view .bat-nt .hint { margin: 0 0 8px; }
.battery-view .bat-hours { display: flex; flex-wrap: wrap; gap: 12px; padding: 4px 0 8px; }
.battery-view .bat-hours > label { flex: 1 1 160px; display: flex; flex-direction: column; gap: 6px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.battery-view .bat-hours .pick-btn { width: 100%; }
.bat-card .bat-est { grid-column: 1 / -1; margin: -4px 0 0; font-size: 13px; line-height: 1.4; color: var(--md-on-surface-variant); }
.battery-view .bat-hs .bat-row { margin-top: 10px; }
.battery-view .bat-hs .bat-switch:first-of-type { border-top: 1px solid var(--md-outline-variant); margin-top: 8px; }
`;
function style(): void {
  if (document.getElementById('kt-battery-css')) return;
  const s = document.createElement('style'); s.id = 'kt-battery-css'; s.textContent = CSS; document.head.append(s);
}

/** «just now», «3 min ago», … for a time in the shell's clock. */
export function ageText(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return t('batAgoNow');
  // (Arabic counts its noun by the number's grammar: «قبل 3 دقائق»، «قبل 11 دقيقةً»; the others write the figure alone.)
  // (After «قبل» the dual is genitive: «قبل دقيقتين».)
  const ar = getLang() === 'ar';
  const n = (v: number, count: (x: number) => string, two: string) => (!ar ? localDigits(v) : v === 2 ? two : count(v));
  if (s < 3600) return t('batAgoMin', { n: n(Math.floor(s / 60), countMinutes, 'دقيقتين') });
  if (s < 86400) return t('batAgoHour', { n: n(Math.floor(s / 3600), countHours, 'ساعتين') });
  return t('batAgoDay', { n: n(Math.floor(s / 86400), countDays, 'يومين') });
}
/** «5 hours», «40 minutes», «3 days» for an estimate (rounded as an estimate should be: five minutes under an hour and a
 *  half, hours under two days, else days). Arabic's dual is genitive here (after «نحو»). */
export function durText(min: number): string {
  const lang = getLang();
  const [n, u] = min < 90 ? [Math.max(5, Math.round(min / 5) * 5), 'm'] as const : min < 48 * 60 ? [Math.round(min / 60), 'h'] as const : [Math.round(min / 1440), 'd'] as const;
  if (lang === 'ja' || lang === 'ko' || lang === 'zh') return t(u === 'm' ? 'batDurMin' : u === 'h' ? 'batDurHour' : 'batDurDay', { n: localDigits(n) });
  if (lang === 'ar' && n === 2) return u === 'm' ? 'دقيقتين' : u === 'h' ? 'ساعتين' : 'يومين';
  return u === 'm' ? countMinutes(n) : u === 'h' ? countHours(n) : countDays(n);
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
  // (W4: the page's «More» — «Report a device» — where the shell can build the report: the computer's build.)
  const moreBtn = d.batteryReport ? iconButton('more', t('batMoreTitle'), (e) => void import('./batreport').then((m) => { if (!gone) m.openMore(d as unknown as import('./batreport').ReportDesk, e); })) : null;
  if (moreBtn) { moreBtn.hidden = true; root.querySelector('header.topbar')?.append(moreBtn); }
  // (Piece 3: made once, kept across redraws — its rows' busy states and messages are its own.)
  const bd = btDesk(); const bt = bd ? btPanel(bd, (title, close) => openSheet(title, close), () => list?.settings.low ?? 15) : null;
  const grid = h('div', { class: 'bat-grid' }); const head = h('div', { class: 'bat-head' }); const extra = h('div');
  // (Piece S1: the system's card, its module fetched once the page is up — the page draws again when it comes.)
  let sys: ReturnType<typeof import('./sysmon')['sysPanel']> | null = null;
  void import('./sysmon').then((m) => { if (gone) return; sys = m.sysPanel(d, () => draw()); draw(); }, () => undefined);
  body.append(h('div', { class: 'spinner small' }));
  // (An XInput slot is named in the page's words — its key «xinput:<user>:pad|headset»; the shell's tray says the same.)
  const xboxName = (key: string): string => { const m = /^xinput:(\d+):(pad|headset)$/.exec(key); return !m ? '' : m[2] === 'headset' ? t('batXboxHeadset') : t('batXboxPad', { n: localDigits(Number(m[1]) + 1) }); };
  const nameOf = (x: BatDevice) => list?.settings.names[x.key] || x.name || xboxName(x.key) || t('batUnnamed');
  // (A refusal — the start with the system could not be written — said, and the switches drawn back as they were.)
  const saveSettings = async (set: Partial<BatSettings>, errKey?: 'batStartFailed') => { try { const s = await d.batterySettings({ set }); if (list) list.settings = s; draw(); } catch (e) { const m = String((e as Error)?.message ?? e); toast(errKey ? t(errKey, { error: m }) : m, 'error'); draw(); } };
  async function refreshAll(): Promise<void> { await d!.batteryRefresh({}).catch(() => false); }

  // (Phone Link is named as Windows names it in the page's language.)
  const brandOf = (family: string | undefined, brand: string): string => family === 'ot-phonelink' ? t('batPhoneLink') : brand;
  const padBrand = (x: BatDevice): string => brandOf(x.family, list?.pads?.find((p) => p.family === x.family)?.brand || list?.mice?.find((p) => p.family === x.family)?.brand || x.brand);
  // (Piece 5's and 6's families: one setting, mkAsk / mkMute, for mice, headsets and the rest alike.)
  const isMk = (family?: string): boolean => !!family && /^(mk|hs|ot)-/.test(family);
  const card = (x: BatDevice): HTMLElement => {
    const S = list!.settings; const r = x.reading; const lvl = r?.level;
    const dim = (x.status !== 'ok' && x.status !== 'waiting') || r?.note === 'noPad' || r?.note === 'unlinked';
    const mk = markOf(S, x.key); const low = x.status === 'ok' && isLow(lvl, mk || S.low);
    const via = t(`batVia_${x.connection}` as 'batVia_usb');
    const sub = [x.family === 'ot-phonelink' ? t('batPhoneLink') : x.brand, t(`batKind_${x.kind}` as 'batKind_mouse')].filter(Boolean).join(' · ');
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
    // (W2: the estimate, quietly, when the shell has one for a device answering now.)
    const e = x.status === 'ok' ? x.estimate : null;
    const estLine = e && (e.state === 'empty' || e.state === 'full') && e.minutes > 0 ? h('p', { class: 'bat-est', 'data-est': e.state, title: t('batEstHint') }, t(e.state === 'empty' ? 'batEstLeft' : 'batEstFull', { d: durText(e.minutes) })) : null;
    const foot = h('div', { class: 'bat-foot' });
    // (Charging sits with the level it qualifies, so the foot's line of small facts stays one line on a narrow card.)
    if (r?.charging === 'yes') level.append(h('span', { class: 'bat-chip charging' }, bolt(), t('batCharging')));
    if (x.status !== 'ok' && x.status !== 'waiting') foot.append(h('span', { class: 'bat-chip', 'data-status': x.status }, t(`batSt_${x.status}` as 'batSt_asleep')));
    if (r) foot.append(h('span', { class: 'bat-age' }, t('batReadAt', { age: ageText(r.takenAt, list!.now) })));
    if (x.connection !== 'unknown') foot.append(h('span', { class: 'bat-via' }, via));
    const more = iconButton('more', t('batMenu', { name: nameOf(x) }), (e) => menu(x, e)); more.classList.add('bat-more');
    return h('article', { class: 'bat-card' + (low ? ' low' : '') + (dim ? ' dim' : ''), 'data-key': x.key, 'data-kind': x.kind, 'data-status': x.status },
      h('div', { class: 'bat-ic' }, deviceIcon(x, S.pictures?.[x.key])), h('div', { class: 'bat-who' }, h('span', { class: 'bat-name', dir: 'auto', title: nameOf(x) }, nameOf(x)), h('span', { class: 'bat-sub', dir: 'auto' }, sub)), more, level, estLine, parts, foot);
  };

  const menu = (x: BatDevice, ev: Event) => {
    const S = list!.settings; const sh = openSheet(nameOf(x), t('close'), { at: ev });
    const act = (ic: string, label: string, fn: () => void, name: string) => h('button', { type: 'button', class: 'dest-row', 'data-act': name, onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'name' }, label));
    const hidden = S.hidden.includes(x.key); const quiet = S.noQuery.includes(x.key);
    const markRow = act('bell', t('batMark'), () => markPick(x, ev), 'mark'); markRow.querySelector('.name')?.append(h('small', { class: 'bat-mark-val', dir: 'auto' }, markText(S, x.key)));
    // (Its place among the shown devices: up and down while there is room — the tray and the strip follow it.)
    const keys = shownKeys(); const at = keys.indexOf(x.key);
    const joined = (x.merged?.length ?? 0) > 0 || (S.links ?? []).some((l) => l.includes(x.key));
    sh.body.append(h('div', { class: 'dest-list' },
      ...(quiet ? [] : [act('refresh', t('batRefreshOne'), () => void d.batteryRefresh({ key: x.key }).catch(() => false), 'refresh')]),
      ...(d.batteryHistory && d.batteryHistoryClear ? [act('chart', t('batHistory'), () => history(x), 'history')] : []),
      act('pencil', t('batRename'), () => rename(x), 'rename'),
      act('images', t('batPicture'), () => picturePick(x), 'picture'),
      ...(at > 0 ? [act('arrowUp', t('batMoveUp'), () => move(x.key, -1), 'up')] : []),
      ...(at >= 0 && at < keys.length - 1 ? [act('arrowDown', t('batMoveDown'), () => move(x.key, 1), 'down')] : []),
      joined ? act('swap', t('batSeparate'), () => separate(x), 'separate') : act('link', t('batJoin'), () => joinPick(x, ev), 'join'),
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

  // W1: the order (the user's keys first, then by kind and name — kt-battery taskbar.rs ordered).
  const sorted = (xs: BatDevice[]): BatDevice[] => {
    const order = list?.settings.order ?? []; const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? 1e9 : i; };
    return xs.slice().sort((a, b) => rank(a.key) - rank(b.key) || (KIND_RANK[a.kind] ?? 7) - (KIND_RANK[b.kind] ?? 7) || nameOf(a).toLowerCase().localeCompare(nameOf(b).toLowerCase()) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  };
  const shownKeys = (): string[] => { const hid = new Set(list?.settings.hidden ?? []); return sorted((list?.devices ?? []).filter((v) => !hid.has(v.key))).map((v) => v.key); };
  // (As kt-battery taskbar.rs moved: the shown ones swapped, the keys of absent devices kept after them.)
  const move = (key: string, dir: -1 | 1) => {
    const order = shownKeys(); const i = order.indexOf(key); const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    [order[i], order[j]] = [order[j], order[i]];
    for (const k of list?.settings.order ?? []) if (!order.includes(k)) order.push(k);
    void saveSettings({ order: order.slice(0, 200) }).then(() => { (document.querySelector(`.bat-card[data-key="${window.CSS.escape(key)}"] .bat-more`) as HTMLElement | null)?.focus(); });
  };
  // A device's picture: one of our own drawings, or the one it was found with.
  const picturePick = (x: BatDevice) => {
    const sh = openSheet(t('batPictureFor', { name: iso(nameOf(x)) }), t('close'));
    const own = list!.settings.pictures?.[x.key];
    const choose = (p: string | null) => { const next = { ...(list!.settings.pictures ?? {}) }; if (p) next[x.key] = p; else delete next[x.key]; sh.close(); void saveSettings({ pictures: next }); };
    sh.body.append(h('div', { class: 'bat-pics', role: 'group', 'aria-label': t('batPicture') }, ...PICTURES.map((p) => {
      const b = h('button', { type: 'button', 'data-picture': p, 'aria-pressed': String(own === p), 'aria-label': t(`batPic_${p}` as 'batPic_mouse'), title: t(`batPic_${p}` as 'batPic_mouse'), onclick: () => choose(p) }, picSvg(p)); return b;
    })));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal bat-eq', 'data-act': 'pictureOwn', disabled: !own, onclick: () => choose(null) }, t('batPictureOwn')));
  };
  // Two entries of one device (its receiver and Bluetooth, say) joined into one — kept as a link the shell's identity
  // rules follow (kt-battery identity.rs) —, or separated again.
  const joinPick = (x: BatDevice, ev: Event) => {
    const others = sorted(list!.devices.filter((v) => v.key !== x.key));
    const sh = openSheet(t('batJoinFor', { name: iso(nameOf(x)) }), t('close'), { at: ev });
    sh.body.append(h('p', { class: 'bat-join-hint' }, t('batJoinHint')));
    if (!others.length) { sh.body.append(h('p', { class: 'bat-join-hint', 'data-none': '1' }, t('batJoinNone'))); return; }
    sh.body.append(h('div', { class: 'dest-list' }, ...others.map((v) => h('button', { type: 'button', class: 'dest-row', 'data-key': v.key, onclick: () => {
      sh.close(); const links = [...(list!.settings.links ?? []).filter((l) => !(l.includes(x.key) && l.includes(v.key))), [x.key, v.key] as [string, string]];
      void saveSettings({ links }).then(() => { toast(t('batJoined', { a: iso(nameOf(x)), b: iso(nameOf(v)) })); void d.batteryRefresh({}).catch(() => false); });
    } }, h('span', { class: 'bat-join-ic' }, deviceIcon(v, list!.settings.pictures?.[v.key])), h('span', { class: 'name', dir: 'auto' }, nameOf(v))))));
  };
  const separate = (x: BatDevice) => {
    const mine = new Set([x.key, ...(x.merged ?? [])]);
    const links = (list!.settings.links ?? []).filter((l) => !l.some((k) => mine.has(k)));
    void saveSettings({ links }).then(() => void d.batteryRefresh({}).catch(() => false));
  };

  // W2: a device's history (its module fetched on first use).
  const history = (x: BatDevice) => {
    const S = list!.settings; const mk = markOf(S, x.key);
    void import('./bathistory').then((m) => { if (!gone) m.openHistory(d as unknown as import('./bathistory').HistDesk, x.key, { name: nameOf(x), low: mk || S.low, levelText: levelText as (l: unknown) => string, durText }); }, (e) => toast(String((e as Error)?.message ?? e), 'error'));
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
    // (Every 30 s to every hour, as the original's v1.1.0 «Check battery every».)
    const secs = ['30', '60', '120', '300', '600', '900', '1800', '3600'];
    const cur = String(S.intervalSec ?? S.intervalMin * 60);
    const every = pickButton(t('batEvery'), secs.map((v) => [v, rtl(Number(v) < 60 ? countSeconds(Number(v)) : countMinutes(Number(v) / 60))] as [string, string]), secs.includes(cur) ? cur : '60', (v) => void saveSettings({ intervalSec: Number(v) }), t('close'));
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
    const rows = (list!.mice ?? []).filter((p) => (p.group ?? 'mice') === g).sort((a, b) => brandOf(a.family, a.brand).localeCompare(brandOf(b.family, b.brand))); if (!rows.length) return null;
    const toggle = h('button', { type: 'button', class: 'btn tonal small bat-mk-toggle', 'aria-expanded': String(st.open), onclick: () => { st.open = !st.open; draw(); } }, icon(st.open ? 'chevronUp' : 'chevronDown'), st.open ? t('batMiceHide') : t('batMiceShow', { n: localDigits(rows.length) }));
    const head = h('div', { class: 'bat-mk-head' }, toggle);
    const card = h('section', { class: `card bat-settings bat-fams ${G.cls}`, 'data-group': g }, h('h3', null, t(G.title)), h('p', { class: 'hint' }, t(G.hint)), head);
    if (!st.open) return card;
    const none = h('p', { class: 'bat-mk-none' }, t('batMiceNone')); none.hidden = true;
    const els = rows.map((p) => {
      const way = p.connects ? t('batMiceConnect') : p.ask && p.listen ? t('batMiceBoth') : p.ask ? t('batMiceAsk') : t('batMiceListen');
      const hint = [way, p.proven === 'tested' ? t('batProven_tested') : t('batProven_untested')].join(' — ');
      const row = sw(p.family, brandOf(p.family, p.brand), hint, p.ask ? (list!.settings.mkAsk ?? []).includes(p.family) : !(list!.settings.mkMute ?? []).includes(p.family), false, (v) => setMk(p.family, p.ask, v));
      // (The brand is a name, set in the page's direction: a Latin brand in an Arabic list stays at the row's start.)
      row.querySelector('.bat-sw-title')?.removeAttribute('dir');
      row.dataset.family = p.family; return { p, row };
    });
    const filter = () => { const q = st.find.trim().toLowerCase(); let n = 0; for (const e of els) { e.row.hidden = !!q && !e.p.brand.toLowerCase().includes(q) && !brandOf(e.p.family, e.p.brand).toLowerCase().includes(q); if (!e.row.hidden) n++; } none.hidden = n > 0; };
    const find = h('input', { type: 'search', class: 'bat-mk-find', dir: 'auto', value: st.find, placeholder: t('batMiceSearch'), 'aria-label': t('batMiceSearch'), oninput: () => { st.find = find.value; filter(); } }) as HTMLInputElement;
    head.append(find); card.append(h('div', { class: 'bat-mk-list' }, ...els.map((e) => e.row)), none); filter();
    return card;
  };

  // W2: «History» — keep a battery history (on by default, as the original's «Record battery history»), and how long.
  const historyCard = (): HTMLElement | null => {
    if (!d.batteryHistory) return null;
    const S = list!.settings; const on = S.history !== false; const days = [7, 30, 90];
    const keep = pickButton(t('batHistKeep'), days.map((v) => [String(v), rtl(countDays(v))] as [string, string]), String(days.includes(S.historyDays ?? 30) ? S.historyDays ?? 30 : 30), (v) => void saveSettings({ historyDays: Number(v) }), t('close'));
    keep.dataset.name = 'historyDays';
    return h('section', { class: 'card bat-settings bat-hs', 'data-group': 'history' }, h('h3', null, t('batHistTitle')),
      sw('history', t('batHistOn'), t('batHistOnHint'), on, false, (v) => void saveSettings({ history: v })),
      h('div', { class: 'bat-row' }, h('span', null, t('batHistKeep'), h('small', null, t('batHistKeepHint'))), keep));
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

  // W1: «Taskbar» — how the devices show in the notification area and on the taskbar itself (the background needed).
  const taskbarCard = (): HTMLElement => {
    const S = list!.settings; const sys: BatSystem = list!.system ?? { autostart: 'yes', tray: true };
    const can = sys.tray && S.background; const strip = !!S.strip;
    const style = pickButton(t('batTbStyle'), (['each', 'lowest', 'app'] as const).map((v) => [v, t(`batTbStyle_${v}` as 'batTbStyle_each')] as [string, string]), S.trayStyle ?? 'each', (v) => void saveSettings({ trayStyle: v as 'each' }), t('close'));
    const drawn = pickButton(t('batTbDraw'), (['number', 'bar'] as const).map((v) => [v, t(`batTbDraw_${v}` as 'batTbDraw_number')] as [string, string]), S.trayDraw ?? 'number', (v) => void saveSettings({ trayDraw: v as 'number' }), t('close'));
    style.dataset.name = 'trayStyle'; drawn.dataset.name = 'trayDraw'; style.disabled = !can; drawn.disabled = !can || (S.trayStyle ?? 'each') === 'app';
    const sub = (el: HTMLElement) => { el.classList.add('bat-sub-sw'); return el; };
    return h('section', { class: 'card bat-settings bat-tb', 'data-group': 'taskbar' }, h('h3', null, t('batTbTitle')),
      h('p', { class: 'hint' }, can ? t('batTbHint') : sys.tray ? t('batTbNeeds') : t('batBgNoTray')),
      h('div', { class: 'bat-row' }, h('span', null, t('batTbStyle'), h('small', null, t('batTbStyleHint'))), style),
      h('div', { class: 'bat-row' }, h('span', null, t('batTbDraw'), h('small', null, t('batTbDrawHint'))), drawn),
      sw('trayAway', t('batTbAway'), t('batTbAwayHint'), S.trayAway !== false, !can, (v) => void saveSettings({ trayAway: v })),
      sw('trayGone', t('batTbGone'), t('batTbGoneHint'), !!S.trayGone, !can, (v) => void saveSettings({ trayGone: v })),
      sw('strip', t('batTbStrip'), t('batTbStripHint'), can && strip, !can, (v) => void saveSettings({ strip: v })),
      sub(sw('stripStacked', t('batTbStacked'), t('batTbStackedHint'), !!S.stripStacked, !can || !strip, (v) => void saveSettings({ stripStacked: v }))),
      sub(sw('stripPlate', t('batTbPlate'), t('batTbPlateHint'), !!S.stripPlate, !can || !strip, (v) => void saveSettings({ stripPlate: v }))),
      h('p', { class: 'hint', style: { marginTop: '10px' } }, t('batTbOrderHint')));
  };
  // W1: «Notices» — their sound, and quiet hours (whole hours of the computer's clock).
  const hourText = (n: number) => rtl(localDigits(String(n).padStart(2, '0')) + ':' + localDigits('00'));
  const noticesCard = (): HTMLElement => {
    const S = list!.settings; const from = S.quietFrom ?? 22; const to = S.quietTo ?? 7; const q = !!S.quiet;
    const hours = Array.from({ length: 24 }, (_, i) => [String(i), hourText(i)] as [string, string]);
    const fromB = pickButton(t('batNtFrom'), hours, String(from), (v) => void saveSettings({ quietFrom: Number(v) }), t('close'));
    const toB = pickButton(t('batNtTo'), hours, String(to), (v) => void saveSettings({ quietTo: Number(v) }), t('close'));
    fromB.dataset.name = 'quietFrom'; toB.dataset.name = 'quietTo'; fromB.disabled = !q; toB.disabled = !q;
    return h('section', { class: 'card bat-settings bat-nt', 'data-group': 'notices' }, h('h3', null, t('batNtTitle')),
      h('p', { class: 'hint' }, t('batNtHint')),
      sw('sound', t('batNtSound'), t('batNtSoundHint'), S.sound !== false, false, (v) => void saveSettings({ sound: v })),
      sw('quiet', t('batNtQuiet'), from === to ? t('batNtQuietSame') : t('batNtQuietHint', { from: hourText(from), to: hourText(to) }), q, false, (v) => void saveSettings({ quiet: v })),
      h('div', { class: 'bat-hours' }, h('label', null, h('span', null, t('batNtFrom')), fromB), h('label', null, h('span', null, t('batNtTo')), toB)));
  };

  function draw(): void {
    if (!list || gone) return;
    if (!list.available) {
      refreshBtn.hidden = true;
      body.replaceChildren(h('section', { class: 'card bat-empty', 'data-state': 'notHere' }, h('div', { class: 'bat-ic' }, kindIcon('mouse')), h('h3', null, t('batNotHere')), h('p', null, t('batNotHereHint'))));
      return;
    }
    const S = list.settings; const hid = new Set(S.hidden);
    const shown = sorted(list.devices.filter((x) => !hid.has(x.key)));
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
    const tb: BatSystem = list.system ?? { autostart: 'yes', tray: true };
    const sysCard = sys ? sys.card(S as import('./sysmon').SysSettings, tb.tray && S.background, tb.tray, (set) => void saveSettings(set as Partial<BatSettings>)) : null;
    body.replaceChildren(...[empty ? null : head, empty ?? grid, extra, platCard(list.system, d), bt?.el ?? null, padsCard(), famCard('mice'), famCard('heads'), famCard('other'), settingsCard(), historyCard(), backgroundCard(), taskbarCard(), sysCard, noticesCard()].filter(Boolean) as HTMLElement[]);
  }

  const off = d.onBattery((e) => { if (!list || !e) return; list.now = e.now; list.devices = Array.isArray(e.devices) ? e.devices : []; draw(); });
  // (The ages move on while the page is open: redrawn every half minute — no per-second timer.)
  const tick = window.setInterval(() => { if (list) { list.now += 30_000; draw(); } }, 30_000);
  void d.batteryList().then((l) => { list = l; if (moreBtn) moreBtn.hidden = !l.available; draw(); }).catch((e) => { body.replaceChildren(h('section', { class: 'card' }, h('p', null, String((e as Error).message ?? e)))); });
  root.dispose = () => { gone = true; off(); clearInterval(tick); bt?.dispose(); sys?.dispose(); };
  return root;
}
