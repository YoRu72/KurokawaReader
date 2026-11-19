// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery, piece 3 (0.21, the computer's Tauri build): «Connect a device» — the paired Bluetooth devices with our
// own drawn picture of each (by kind, and a controller by its family: two-stick pad, compact retro pad, split pair —
// never a maker's logo, photo or art; the brand as text), name, connected or not, battery when the battery loop knows
// it, and Connect / Disconnect where Windows lets a program do it; «Find new devices» looks nearby for a bounded time
// (Stop ends it) and pairs through Windows' own window after our own question showing the device's picture. A busy row
// per device with Cancel; each failure said in plain words with what to do; «Bluetooth settings» where only Windows'
// own settings can help. The shell decides (kt-battery connect.rs); this draws. Part of views/battery's lazy chunk.
import { h, toast } from '../ui/dom';
import { localDigits, getLang, countSeconds } from '../i18n';
// (Piece P1: Linux's own words where these say «Windows» — views/batplat.ts.)
import { osT as t } from './batplat';

export type BtDev = { addr: string; name: string; kind: string; picture: string; brand: string; le: boolean; paired: boolean; connected: boolean; battery: number | null; can: 'both' | 'disconnectOnly' | 'settings' | 'pair' };
export type BtSnap = { available: boolean; reason?: string; radio: 'on' | 'off' | 'missing'; stale: boolean; now: number; scanUntil: number | null; devices: BtDev[]; found: BtDev[]; busy: { addr: string; op: string; until: number }[] };
type BtResult = { result: 'ok' | 'refused' | 'timedOut' | 'cancelled' | 'unreachable' | 'settings' | 'noRadio' | 'busy' | 'failed' | 'none'; code: number };
/** The bridge's methods (desktop-tauri/bridge.js — the same names and arguments). */
export type BtDesk = { btList(): Promise<BtSnap>; btScan(o: { stop?: boolean; seconds?: number }): Promise<BtSnap>; btAct(o: { op: 'connect' | 'disconnect' | 'pair' | 'cancel'; addr: string }): Promise<BtResult>; btOpenSettings(): Promise<void>; onBt(cb: (s: BtSnap) => void): () => void };
export const btDesk = (): BtDesk | null => { const d = (window as unknown as { kurokawaTools?: Partial<BtDesk> }).kurokawaTools; return d?.btList && d.onBt && d.btAct && d.btScan ? d as BtDesk : null; };

/** How long «Find new devices» looks (the shell bounds it: 5–60 s). */
const SCAN_S = 20;

// Our own drawings (48×48, strokes; `.f` parts lightly filled).
const PIC: Record<string, string> = {
  headset: '<path d="M10 29v-5a14 14 0 0 1 28 0v5"/><rect x="6.5" y="26" width="9" height="14" rx="4"/><rect x="32.5" y="26" width="9" height="14" rx="4"/><rect class="f" x="8.5" y="29" width="5" height="8" rx="2.5"/><rect class="f" x="34.5" y="29" width="5" height="8" rx="2.5"/>',
  earbuds: '<path d="M14 9a6.5 6.5 0 0 1 6.5 6.5v2.5A6.5 6.5 0 0 1 14 24.5 6.5 6.5 0 0 1 7.5 18v-2.5A6.5 6.5 0 0 1 14 9Z"/><path d="M17 23.6V37a2.6 2.6 0 0 1-5.2 0V24.3"/><path d="M34 9a6.5 6.5 0 0 0-6.5 6.5v2.5a6.5 6.5 0 0 0 6.5 6.5 6.5 6.5 0 0 0 6.5-6.5v-2.5A6.5 6.5 0 0 0 34 9Z"/><path d="M31 23.6V37a2.6 2.6 0 0 0 5.2 0V24.3"/><circle class="f" cx="14" cy="16.5" r="2.6"/><circle class="f" cx="34" cy="16.5" r="2.6"/>',
  mouse: '<rect x="13.5" y="5" width="21" height="38" rx="10.5"/><path d="M24 5v12M13.5 17h21"/><rect class="f" x="22.2" y="9" width="3.6" height="6" rx="1.8"/>',
  keyboard: '<rect x="4" y="12" width="40" height="24" rx="5"/><path d="M10 19h.01M15.5 19h.01M21 19h.01M26.5 19h.01M32 19h.01M38 19h.01M12.5 24.5h.01M18 24.5h.01M23.5 24.5h.01M29 24.5h.01M35 24.5h.01" stroke-width="3.2"/><rect class="f" x="15" y="28.5" width="18" height="3" rx="1.5"/>',
  pad: '<path d="M15.5 13h17c6.6 0 11 6.2 9.7 13.2l-1.5 8a4.4 4.4 0 0 1-7.7 1.9L29.4 32H18.6L15 36.1a4.4 4.4 0 0 1-7.7-1.9l-1.5-8C4.5 19.2 8.9 13 15.5 13Z"/><circle class="f" cx="18.5" cy="26.5" r="3"/><circle class="f" cx="29.5" cy="26.5" r="3"/><path d="M13 18v5M10.5 20.5h5"/><path d="M35 17.4h.01M38 20.4h.01M32 20.4h.01M35 23.4h.01" stroke-width="3.4"/>',
  retro: '<rect x="3.5" y="14" width="41" height="20" rx="10"/><path d="M13 19.5v9M8.5 24h9"/><path d="M34.5 19.8h.01M38.6 24h.01M30.4 24h.01M34.5 28.2h.01" stroke-width="3.6"/><rect class="f" x="20" y="25" width="3.4" height="2" rx="1"/><rect class="f" x="24.6" y="25" width="3.4" height="2" rx="1"/>',
  split: '<path d="M21 6h-4.5A7.5 7.5 0 0 0 9 13.5v21A7.5 7.5 0 0 0 16.5 42H21Z"/><path d="M27 6h4.5a7.5 7.5 0 0 1 7.5 7.5v21a7.5 7.5 0 0 1-7.5 7.5H27Z"/><circle class="f" cx="15.5" cy="16" r="3"/><circle class="f" cx="32.5" cy="29" r="3"/><path d="M15.5 25.5h.01M15.5 32.5h.01M12 29h.01M19 29h.01M32.5 13h.01M32.5 19.5h.01M29.2 16.2h.01M35.8 16.2h.01" stroke-width="3"/>',
  // (Piece 4: one Joy-Con alone, and a pad with two trackpads.)
  half: '<path d="M27.5 5H22a8.5 8.5 0 0 0-8.5 8.5v21A8.5 8.5 0 0 0 22 43h5.5Z"/><circle class="f" cx="21" cy="15.5" r="3.2"/><path d="M21 25.5h.01M21 33.5h.01M17 29.5h.01M25 29.5h.01" stroke-width="3"/><path d="M33.5 10v28"/>',
  trackpads: '<path d="M14 11h20c6.5 0 10.6 6 9.4 12.7l-1.8 10a4.6 4.6 0 0 1-8 2.1L30 32H18l-3.6 3.8a4.6 4.6 0 0 1-8-2.1l-1.8-10C3.4 17 7.5 11 14 11Z"/><circle cx="15.5" cy="20.5" r="5"/><circle cx="32.5" cy="20.5" r="5"/><circle class="f" cx="24" cy="27.5" r="2.6"/>',
  speaker: '<rect x="11.5" y="4.5" width="25" height="39" rx="7"/><circle cx="24" cy="28" r="8"/><circle class="f" cx="24" cy="28" r="3"/><circle class="f" cx="24" cy="13" r="2.4"/>',
  phone: '<rect x="13.5" y="4" width="21" height="40" rx="5.5"/><path d="M21 9h6"/><path d="M21.5 39h5"/>',
  pen: '<path d="M33.5 6.5l8 8L19 37l-10.5 3 3-10.5L33.5 6.5Z"/><path d="M29.3 10.7l8 8"/><path class="f" d="M11.5 29.5l7.5 7.5-10.5 3Z"/>',
  other: '<rect x="8" y="8" width="32" height="32" rx="9"/><path d="M19 19l10 10-5 5V14l5 5-10 10"/>',
};
const RUNE = '<path d="M7 7l10 10-5 5V2l5 5L7 17"/>';

function pic(name: string, size: 'row' | 'big' = 'row'): HTMLElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PIC[name] ?? PIC.other;
  return h('div', { class: 'bt-pic' + (size === 'big' ? ' big' : ''), 'data-picture': PIC[name] ? name : 'other' }, svg);
}
/** One of our drawings as a bare SVG (the battery cards' controller pictures, by family). */
export function picSvg(name: string): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 48 48'); svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = PIC[name] ?? PIC.other; svg.classList.add('bt-drawn'); svg.dataset.picture = PIC[name] ? name : 'other';
  return svg;
}
function rune(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.innerHTML = RUNE; return svg;
}

const CSS = `
.bt-panel { gap: 16px; }
.bt-panel .bt-head { display: flex; align-items: flex-start; gap: 16px 20px; flex-wrap: wrap; }
.bt-panel .bt-head-text { flex: 1 1 300px; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.bt-panel .bt-head-acts { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; flex: 0 0 auto; }
.bt-panel .bt-head-acts .btn { min-width: 184px; justify-content: center; white-space: nowrap; }
.bt-row .bt-act .btn { width: 184px; justify-content: center; white-space: nowrap; }
.bt-row .bt-act .btn.text { width: auto; min-width: 96px; }
.bt-panel .bt-head-acts .btn svg { width: 18px; height: 18px; }
.bt-panel h4 { margin: 4px 0 0; font-size: 13px; font-weight: 650; color: var(--md-on-surface-variant); }
.bt-list { display: flex; flex-direction: column; }
.bt-row { display: grid; grid-template-columns: 56px minmax(0, 1fr) auto; align-items: center; column-gap: 16px; row-gap: 8px; padding: 12px 0; }
.bt-row + .bt-row { border-top: 1px solid var(--md-outline-variant); }
.bt-pic { width: 56px; height: 56px; border-radius: 18px; display: grid; place-items: center; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.bt-pic.big { width: 112px; height: 112px; border-radius: 32px; margin: 4px auto 0; }
.bt-pic svg { width: 36px; height: 36px; fill: none; stroke: currentColor; stroke-width: 2.1; stroke-linecap: round; stroke-linejoin: round; }
.bt-pic.big svg { width: 72px; height: 72px; stroke-width: 1.8; }
.bt-pic svg .f { fill: currentColor; fill-opacity: .22; stroke: none; }
.bt-row.on .bt-pic { background: var(--md-primary-container); color: var(--md-on-primary-container); }
.bt-row .bt-who { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
html[dir='rtl'] .bt-row .bt-name { text-align: right; }
.bt-row .bt-name { font-weight: 650; font-size: 15px; color: var(--md-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bt-row .bt-sub { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.bt-row .bt-chip { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 12px; font-weight: 600; background: var(--md-surface-container-high); color: var(--md-on-surface-variant); }
.bt-row .bt-chip.on { background: var(--md-primary-container); color: var(--md-on-primary-container); }
.bt-row .bt-chip.low { background: var(--md-error-container, color-mix(in srgb, var(--md-error) 18%, transparent)); color: var(--md-on-error-container, var(--md-error)); }
.bt-row .bt-act { display: flex; align-items: center; justify-content: flex-end; gap: 12px; }
.bt-row .bt-busy { display: inline-flex; align-items: center; gap: 10px; color: var(--md-on-surface-variant); font-size: 13px; white-space: nowrap; }
.bt-row .bt-busy .spinner.small { width: 16px; height: 16px; flex: 0 0 auto; }
.bt-row .bt-note { font-size: 12.5px; color: var(--md-on-surface-variant); text-align: end; max-width: 240px; }
.bt-row .bt-msg { grid-column: 2 / -1; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; color: var(--md-error); font-size: 13px; line-height: 1.5; }
.bt-row .bt-msg .btn { height: 32px; font-size: 13px; }
.bt-row.busy .bt-pic { animation: bt-pulse 1.4s ease-in-out infinite; }
@keyframes bt-pulse { 50% { opacity: .55; } }
.bt-scan { display: flex; flex-direction: column; gap: 8px; }
.bt-scan .bt-scan-line { display: flex; align-items: center; gap: 12px; color: var(--md-on-surface); font-size: 14px; }
.bt-scan .bt-scan-line svg { width: 20px; height: 20px; fill: none; stroke: var(--md-primary); stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
.bt-scan .bt-bar { height: 6px; border-radius: 3px; background: var(--md-surface-container-highest); overflow: hidden; }
.bt-scan .bt-bar > i { display: block; height: 100%; width: 0; border-radius: inherit; background: var(--md-primary); animation: bt-fill linear forwards; }
@keyframes bt-fill { to { width: 100%; } }
.bt-state { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; padding: 6px 0; }
.bt-state .bt-pic { background: var(--md-surface-container-high); color: var(--md-on-surface-variant); }
.bt-state .bt-state-text { flex: 1 1 240px; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.bt-state .bt-state-text b { color: var(--md-on-surface); font-size: 16px; font-weight: 650; }
.bt-state .bt-state-text span { color: var(--md-on-surface-variant); font-size: 13.5px; line-height: 1.6; }
.bt-empty-line { color: var(--md-on-surface-variant); font-size: 13.5px; line-height: 1.6; margin: 0; }
.bt-pair-sheet { display: flex; flex-direction: column; align-items: center; gap: 12px; text-align: center; }
.bt-pair-sheet .bt-pair-name { font-weight: 700; font-size: 18px; color: var(--md-on-surface); }
.bt-pair-sheet .bt-pair-addr { font-size: 12.5px; color: var(--md-on-surface-variant); font-variant-numeric: tabular-nums; }
.bt-pair-sheet p { margin: 0; color: var(--md-on-surface-variant); line-height: 1.6; max-width: 420px; }
@media (max-width: 720px) {
  .bt-panel .bt-head-acts { grid-template-columns: 1fr; width: 100%; }
  .bt-panel .bt-head-acts .btn { width: 100%; }
  .bt-row { grid-template-columns: 56px minmax(0, 1fr); }
  .bt-row .bt-act { grid-column: 1 / -1; justify-content: flex-start; }
}
`;
function style(): void {
  if (document.getElementById('kt-btconnect-css')) return;
  const s = document.createElement('style'); s.id = 'kt-btconnect-css'; s.textContent = CSS; document.head.append(s);
}

/** The panel; `dispose` lets go of its subscription and stops a scan it started. `low`: the page's low mark. */
export function btPanel(d: BtDesk, openSheet: (title: string, close: string) => { body: HTMLElement; actions: HTMLElement; close: () => void }, low: () => number): { el: HTMLElement; dispose: () => void } {
  style();
  const el = h('section', { class: 'card bt-panel', 'data-group': 'bluetooth' }, h('div', { class: 'spinner small' }));
  let snap: BtSnap | null = null; let gone = false; let scannedOnce = false;
  /** Rows the page is waiting on (op), and each device's last failure (its words). */
  const waiting = new Map<string, string>(); const msgs = new Map<string, { text: string; settings: boolean }>();
  const nameOf = (x: BtDev) => x.name.trim() || t('btcUnnamed');
  const openSettings = () => { void d.btOpenSettings().catch((e) => toast(String((e as Error)?.message ?? e), 'error')); };
  const settingsBtn = (cls = 'btn tonal') => h('button', { type: 'button', class: cls, 'data-act': 'settings', onclick: openSettings }, t('btcSettings'));

  const endText = (r: BtResult): string => r.result === 'failed' ? t('btcEnd_failed', { code: localDigits(r.code) }) : t(`btcEnd_${r.result}` as 'btcEnd_refused');
  const act = async (x: BtDev, op: 'connect' | 'disconnect' | 'pair') => {
    if (waiting.has(x.addr)) return;
    waiting.set(x.addr, op); msgs.delete(x.addr); draw();
    let r: BtResult;
    try { r = await d.btAct({ op, addr: x.addr }); } catch (e) { r = { result: 'failed', code: 0 }; void e; }
    waiting.delete(x.addr);
    if (gone) return;
    if (r.result === 'ok') toast(t(`btcDone_${op}` as 'btcDone_connect', { name: nameOf(x) }));
    else if (r.result !== 'cancelled' && r.result !== 'none') msgs.set(x.addr, { text: endText(r), settings: r.result !== 'busy' && r.result !== 'noRadio' });
    draw();
  };
  const cancel = (x: BtDev) => { void d.btAct({ op: 'cancel', addr: x.addr }).catch(() => undefined); };

  // Pairing: our own question first, with the device's picture; then Windows' own window.
  const askPair = (x: BtDev) => {
    const sh = openSheet(t('btcPairTitle'), t('close'));
    sh.body.append(h('div', { class: 'bt-pair-sheet', 'data-addr': x.addr }, pic(x.picture, 'big'), h('span', { class: 'bt-pair-name', dir: 'auto' }, nameOf(x)),
      h('span', { class: 'bt-pair-addr' }, [x.brand, t(`batKind_${x.kind}` as 'batKind_mouse')].filter(Boolean).join(' · '), ' · ', h('span', { dir: 'ltr' }, x.addr)),
      h('p', null, t('btcPairBody')), h('p', null, t('btcPairNoPin'))));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal bat-eq', 'data-act': 'no', onclick: () => sh.close() }, t('btcCancel')),
      h('button', { type: 'button', class: 'btn primary bat-eq', 'data-act': 'pair', onclick: () => { sh.close(); void act(x, 'pair'); } }, t('btcPair')));
  };

  const row = (x: BtDev): HTMLElement => {
    const shellBusy = snap?.busy.find((b) => b.addr === x.addr)?.op;
    const busyOp = waiting.get(x.addr) ?? shellBusy;
    const sub = h('div', { class: 'bt-sub' });
    if (x.paired) sub.append(h('span', { class: 'bt-chip' + (x.connected ? ' on' : ''), 'data-state': x.connected ? 'connected' : 'notConnected' }, x.connected ? t('btcConnected') : t('btcNotConnected')));
    if (x.battery !== null && x.battery !== undefined && x.connected) sub.append(h('span', { class: 'bt-chip' + (x.battery <= low() ? ' low' : ''), 'data-battery': String(x.battery), dir: 'ltr' }, t('batPct', { n: localDigits(x.battery) })));
    const what = [x.brand, t(`batKind_${x.kind}` as 'batKind_mouse'), x.le ? t('btcLe') : ''].filter(Boolean).join(' · ');
    sub.append(h('span', { dir: 'auto' }, what));
    const actBox = h('div', { class: 'bt-act' });
    if (busyOp) {
      const label = busyOp === 'pair' ? t('btcPairing') : busyOp === 'disconnect' ? t('btcDisconnecting') : t('btcConnecting');
      actBox.append(h('span', { class: 'bt-busy', role: 'status' }, h('span', { class: 'spinner small' }), label), h('button', { type: 'button', class: 'btn text', 'data-act': 'cancel', onclick: () => cancel(x) }, t('btcCancel')));
    } else if (x.can === 'pair') {
      actBox.append(h('button', { type: 'button', class: 'btn primary', 'data-act': 'pair', onclick: () => askPair(x) }, t('btcPair')));
    } else if (x.connected && (x.can === 'both' || x.can === 'disconnectOnly')) {
      actBox.append(h('button', { type: 'button', class: 'btn tonal', 'data-act': 'disconnect', onclick: () => void act(x, 'disconnect') }, t('btcDisconnect')));
    } else if (x.can === 'both') {
      actBox.append(h('button', { type: 'button', class: 'btn', 'data-act': 'connect', onclick: () => void act(x, 'connect') }, t('btcConnect')));
    } else if (x.can === 'disconnectOnly') {
      actBox.append(h('span', { class: 'bt-note' }, t('btcSelfConnects')));
    } else {
      actBox.append(settingsBtn());
    }
    const r = h('div', { class: 'bt-row' + (x.connected ? ' on' : '') + (busyOp ? ' busy' : ''), 'data-addr': x.addr, 'data-can': x.can, 'aria-busy': busyOp ? 'true' : 'false' },
      pic(x.picture), h('div', { class: 'bt-who' }, h('span', { class: 'bt-name', dir: 'auto', title: nameOf(x) }, nameOf(x)), sub), actBox);
    const m = msgs.get(x.addr);
    if (m && !busyOp) r.append(h('div', { class: 'bt-msg', role: 'alert' }, h('span', null, m.text), m.settings ? settingsBtn('btn text') : null));
    return r;
  };

  const scanBlock = (s: BtSnap): HTMLElement | null => {
    if (!s.scanUntil) return null;
    const left = Math.max(0, s.scanUntil - s.now);
    return h('div', { class: 'bt-scan', role: 'status' }, h('div', { class: 'bt-scan-line' }, rune(), h('span', null, t('btcScanning'))),
      h('div', { class: 'bt-bar' }, h('i', { style: { animationDuration: `${left}ms` } })), h('p', { class: 'bt-empty-line' }, t('btcScanHint', { n: getLang() === 'ar' ? countSeconds(Math.round(left / 1000)) : localDigits(Math.round(left / 1000)) })));
  };

  function draw(): void {
    if (gone || !snap) return;
    const s = snap;
    const scanning = !!s.scanUntil;
    const find = h('button', { type: 'button', class: 'btn ' + (scanning ? 'tonal' : 'primary'), 'data-act': scanning ? 'stop' : 'find', disabled: s.radio !== 'on', onclick: () => void scan(!scanning) }, rune(), scanning ? t('btcStop') : t('btcFind'));
    const head = h('div', { class: 'bt-head' }, h('div', { class: 'bt-head-text' }, h('h3', null, t('btcTitle')), h('p', null, t('btcHint'))), h('div', { class: 'bt-head-acts' }, find, settingsBtn()));
    const parts: (HTMLElement | null)[] = [head];
    if (s.radio !== 'on') {
      const off = s.radio === 'off';
      parts.push(h('div', { class: 'bt-state', 'data-radio': s.radio }, pic('other'), h('div', { class: 'bt-state-text' }, h('b', null, off ? t('btcOff') : t('btcMissing')), h('span', null, off ? t('btcOffHint') : t('btcMissingHint')))));
    } else {
      if (s.stale) parts.push(h('p', { class: 'bt-empty-line', 'data-stale': '1' }, t('btcStale')));
      parts.push(h('h4', null, t('btcPairedHead', { n: localDigits(s.devices.length) })));
      parts.push(s.devices.length ? h('div', { class: 'bt-list bt-paired' }, ...s.devices.map(row)) : h('p', { class: 'bt-empty-line' }, t('btcNonePaired')));
      const sb = scanBlock(s);
      if (sb) parts.push(sb);
      if (scanning || s.found.length || scannedOnce) {
        parts.push(h('h4', null, t('btcNearby', { n: localDigits(s.found.length) })));
        if (s.found.length) parts.push(h('div', { class: 'bt-list bt-found' }, ...s.found.map(row)));
        else if (!scanning) parts.push(h('p', { class: 'bt-empty-line', 'data-none': '1' }, t('btcNoneNearby')));
        if (!scanning) parts.push(h('p', { class: 'bt-empty-line' }, t('btcLeHint')));
      }
    }
    el.replaceChildren(...parts.filter(Boolean) as HTMLElement[]);
  }

  async function scan(start: boolean): Promise<void> {
    if (start) scannedOnce = true;
    try { const s = await d.btScan(start ? { seconds: SCAN_S } : { stop: true }); if (!gone && s) { snap = s; draw(); } } catch (e) { toast(String((e as Error)?.message ?? e), 'error'); }
  }

  const off = d.onBt((s) => { if (gone || !s || s.available === false) return; snap = s; draw(); });
  void d.btList().then((s) => { if (gone) return; if (!s || s.available === false) { el.hidden = true; return; } snap = s; draw(); }).catch(() => { el.hidden = true; });
  return { el, dispose: () => { gone = true; off(); if (snap?.scanUntil) void d.btScan({ stop: true }).catch(() => undefined); } };
}
