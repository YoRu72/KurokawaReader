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
// The Electron build and the phone have no reader: a calm word instead, never a dead button. Loaded on first use.
import { h, icon, iconButton, openSheet, pickButton, pickSheet, toast } from '../ui/dom';
import { btDesk, btPanel } from './btconnect';
import { t, localDigits } from '../i18n';
import { back } from '../router';

type Lvl = { kind: 'exact'; value: number } | { kind: 'coarse'; value: 'empty' | 'low' | 'medium' | 'high' | 'full'; bars: number } | { kind: 'unknown' };
type Rd = { level: Lvl; charging: 'yes' | 'no' | 'unknown'; asleep: boolean; takenAt: number };
export type BatDevice = { key: string; name: string; kind: string; brand: string; connection: string; source: string; vid: number; pid: number; merged: string[];
  status: 'ok' | 'waiting' | 'asleep' | 'notConnected' | 'noAnswer' | 'notQueried'; reading: Rd | null; lastGood: Rd | null; checkedAt: number };
export type BatSettings = { intervalMin: number; low: number; names: Record<string, string>; hidden: string[]; noQuery: string[]; links: [string, string][];
  /** Piece 2: closing the window leaves the app in the tray; the start with the system, hidden (needs the background). */
  background: boolean; startup: boolean;
  /** Low-battery notices (on by default) and the «fully charged» one (off); a device's own mark: 0 = no notice. */
  notifyLow: boolean; notifyFull: boolean; thresholds: Record<string, number> };
/** What the shell can do here: a start with the system ('notYet' on a Mac), a tray icon. */
type BatSystem = { autostart: 'yes' | 'notYet'; tray: boolean };
type BatList = { available: boolean; reason?: string; now: number; devices: BatDevice[]; settings: BatSettings; system?: BatSystem };
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
function bolt(): SVGElement { const s = kindIcon('other'); s.innerHTML = BOLT; s.classList.add('bat-bolt'); return s; }

const CSS = `
.battery-view .bat-body { display: flex; flex-direction: column; gap: 16px; padding-bottom: 96px; }
.bat-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.bat-head .bat-count { flex: 1; margin: 0; color: var(--md-on-surface-variant); }
.bat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 14px; }
.bat-card { position: relative; display: grid; grid-template-columns: 52px minmax(0, 1fr) auto; align-items: center; column-gap: 14px; row-gap: 10px; padding: 18px 14px 16px 18px; border-radius: var(--sh-xl, 28px); background: var(--md-surface-container-low); }
.bat-card .bat-ic { width: 52px; height: 52px; border-radius: 18px; display: grid; place-items: center; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.bat-card .bat-ic svg, .bat-empty .bat-ic svg { width: 28px; height: 28px; fill: none; stroke: currentColor; stroke-width: 1.7; stroke-linecap: round; stroke-linejoin: round; }
.bat-card .bat-who { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.bat-card .bat-name { font-weight: 650; font-size: 15px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--md-on-surface); }
.bat-card .bat-sub { font-size: 12.5px; color: var(--md-on-surface-variant); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bat-card .bat-level { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; min-height: 36px; }
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
  return t('batLevelUnknown');
}
/** A device's own mark (0: no notice), else the default. */
export function markOf(S: BatSettings, key: string): number { const v = S.thresholds?.[key]; return typeof v === 'number' && (v === 0 || MARKS.includes(v)) ? v : S.low; }
const isLow = (l: Lvl | undefined, low: number): boolean => !!l && (l.kind === 'exact' ? l.value <= low : l.kind === 'coarse' ? l.value === 'empty' || l.value === 'low' : false);

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
  const nameOf = (x: BatDevice) => list?.settings.names[x.key] || x.name || t('batUnnamed');
  // (A refusal — the start with the system could not be written — said, and the switches drawn back as they were.)
  const saveSettings = async (set: Partial<BatSettings>, errKey?: 'batStartFailed') => { try { const s = await d.batterySettings({ set }); if (list) list.settings = s; draw(); } catch (e) { const m = String((e as Error)?.message ?? e); toast(errKey ? t(errKey, { error: m }) : m, 'error'); draw(); } };
  async function refreshAll(): Promise<void> { await d!.batteryRefresh({}).catch(() => false); }

  const card = (x: BatDevice): HTMLElement => {
    const S = list!.settings; const r = x.reading; const lvl = r?.level;
    const dim = x.status !== 'ok' && x.status !== 'waiting';
    const mk = markOf(S, x.key); const low = x.status === 'ok' && isLow(lvl, mk || S.low);
    const via = t(`batVia_${x.connection}` as 'batVia_usb');
    const sub = [x.brand, t(`batKind_${x.kind}` as 'batKind_mouse')].filter(Boolean).join(' · ');
    const level = h('div', { class: 'bat-level' });
    if (r && lvl?.kind === 'exact') level.append(h('span', { class: 'bat-pct', dir: 'ltr' }, levelText(lvl)), h('div', { class: 'bat-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(lvl.value), 'aria-label': t('batTitle') }, h('i', { style: { width: `${lvl.value}%` } })));
    else if (r && lvl?.kind === 'coarse') level.append(h('div', { class: 'bat-bars', title: t('batCoarseHint'), 'aria-label': levelText(lvl) }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= lvl.bars ? 'on' : '' }))), h('span', { class: 'bat-word' }, levelText(lvl)));
    else if (x.lastGood && dim) level.append(h('span', { class: 'bat-unknown' }, t('batLastKnown', { age: ageText(x.lastGood.takenAt, list!.now), level: levelText(x.lastGood.level) })));
    else level.append(h('span', { class: 'bat-unknown' }, x.status === 'waiting' ? t('batSt_waiting') : t('batLevelUnknown')));
    const foot = h('div', { class: 'bat-foot' });
    if (r?.charging === 'yes') foot.append(h('span', { class: 'bat-chip charging' }, bolt(), t('batCharging')));
    if (x.status !== 'ok' && x.status !== 'waiting') foot.append(h('span', { class: 'bat-chip', 'data-status': x.status }, t(`batSt_${x.status}` as 'batSt_asleep')));
    if (r) foot.append(h('span', { class: 'bat-age' }, t('batReadAt', { age: ageText(r.takenAt, list!.now) })));
    if (x.connection !== 'unknown') foot.append(h('span', { class: 'bat-via' }, via));
    const more = iconButton('more', t('batMenu', { name: nameOf(x) }), (e) => menu(x, e)); more.classList.add('bat-more');
    return h('article', { class: 'bat-card' + (low ? ' low' : '') + (dim ? ' dim' : ''), 'data-key': x.key, 'data-kind': x.kind, 'data-status': x.status },
      h('div', { class: 'bat-ic' }, kindIcon(x.kind)), h('div', { class: 'bat-who' }, h('span', { class: 'bat-name', dir: 'auto' }, nameOf(x)), h('span', { class: 'bat-sub', dir: 'auto' }, sub)), more, level, foot);
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
      act(quiet ? 'refresh' : 'shield', quiet ? t('batQueryAgain') : t('batNoQuery'), () => { void saveSettings({ noQuery: quiet ? S.noQuery.filter((k) => k !== x.key) : [...S.noQuery, x.key] }).then(() => { if (!quiet) toast(t('batNoQueryDone', { name: nameOf(x) })); }); }, 'noQuery')));
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
      h('button', { type: 'button', class: 'btn filled bat-eq', onclick: save }, t('save')));
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

  // Piece 2: «Background» — switches, each with its line of explanation; what cannot be had here said, not hidden.
  const backgroundCard = (): HTMLElement => {
    const S = list!.settings; const sys: BatSystem = list!.system ?? { autostart: 'yes', tray: true };
    const sw = (name: string, title: string, hint: string, on: boolean, off: boolean, fn: (v: boolean) => void): HTMLElement => {
      const i = h('input', { type: 'checkbox', role: 'switch', checked: on, disabled: off, 'aria-label': title, onchange: () => fn(i.checked) }) as HTMLInputElement;
      return h('label', { class: 'switch-row bat-switch' + (off ? ' is-off' : ''), 'data-row': name }, h('span', { class: 'bat-sw-text' }, h('span', { class: 'bat-sw-title' }, title), h('small', null, hint)), i);
    };
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
    body.replaceChildren(...[empty ? null : head, empty ?? grid, extra, bt?.el ?? null, settingsCard(), backgroundCard()].filter(Boolean) as HTMLElement[]);
  }

  const off = d.onBattery((e) => { if (!list || !e) return; list.now = e.now; list.devices = Array.isArray(e.devices) ? e.devices : []; draw(); });
  // (The ages move on while the page is open: redrawn every half minute — no per-second timer.)
  const tick = window.setInterval(() => { if (list) { list.now += 30_000; draw(); } }, 30_000);
  void d.batteryList().then((l) => { list = l; draw(); }).catch((e) => { body.replaceChildren(h('section', { class: 'card' }, h('p', null, String((e as Error).message ?? e)))); });
  root.dispose = () => { gone = true; off(); clearInterval(tick); bt?.dispose(); };
  return root;
}
