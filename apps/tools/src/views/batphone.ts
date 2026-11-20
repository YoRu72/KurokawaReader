// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery on the phone (0.21 P2, Android): the phone's own, smaller page — main.ts opens it in place of
// views/battery.ts on Android. The PAIRED Bluetooth devices (KtBattery.java: nothing is searched for, paired,
// connected to or written to; no location), each a card with our drawn picture for its kind, its name, connected or
// not, the level Android knows (exact, or «unknown»; a device away shows its last known level), when it was last seen
// connected; a refresh; «Bluetooth settings» (pairing is the system's). Before anything, «Nearby devices» (Android 12+)
// explained calmly and asked only when «Allow» is tapped; refused, a calm card with «Ask again» or App info.
// Notices: on or off, one low mark — told once per drop, while the app runs (no service of its own: the page says so).
// None of the computer's options (tray, taskbar, start with the system, families, Linux / macOS cards) are here.
// 0.22.1: «connected» from Android's public sources together, with the links in use on the chip (KtBattery.presence);
// Android's broadcasts push a fresh reading by themselves (the «btBattery» event); a card tapped opens its details
// (only what Android already holds — unknown values left out); only the cards that changed are drawn again, and nothing
// runs while the page is hidden.
import { h, icon, iconButton, openSheet, pickButton, toast } from '../ui/dom';
import { t, localDigits, getLang } from '../i18n';
import type { Strings } from '../i18n/en';
import { back } from '../router';
import { ktPlugin, listen } from '../native';
import { picSvg } from './btconnect';
import { ageText } from './battery';

export type PhoneDev = {
  key: string; name: string; kind: string; connected: boolean; level: number; source: '' | 'system' | 'hfp'; seenAt: number; lastLevel: number; lastLevelAt: number;
  // (0.22.1, each left out when Android does not say: the links up, the details.)
  profiles?: string[]; lastSource?: '' | 'system' | 'hfp'; firstSeen?: number; alias?: string; sysName?: string; type?: 'classic' | 'le' | 'dual'; bond?: 'bonded' | 'bonding' | 'none';
  major?: string; minor?: string; services?: string[]; codec?: string; parts?: { left?: number; right?: number; case?: number };
};
export type PhoneCfg = { notify: boolean; low: number; marks?: Record<string, number> };
export type PhoneState = { sdk: number; now: number; adapter: boolean; on: boolean; access: 'granted' | 'ask' | 'refused' | 'blocked'; config: PhoneCfg; devices: PhoneDev[] };
/** KtPlugin's methods (native/android/KtPlugin.java — the same names and arguments; tests/batphone.cjs fakes them). */
type Plug = {
  batteryPhoneState(): Promise<PhoneState>;
  batteryPhoneAsk(): Promise<{ access: string }>;
  batteryPhoneOpen(o: { what: 'bluetooth' | 'app' }): Promise<void>;
  batteryPhoneConfig(o: { set?: Partial<PhoneCfg>; labels?: Record<string, string> }): Promise<PhoneCfg>;
  batteryPhoneWatch(o: { on: boolean }): Promise<void>;
  notifyAccess?(o: { ask?: boolean }): Promise<{ granted: boolean }>;
  addListener(ev: string, fn: (d: PhoneState) => void): unknown;
};
const plug = (): Plug | null => { const p = ktPlugin() as unknown as Partial<Plug> | null; return p?.batteryPhoneState ? p as Plug : null; };

/** The marks offered (as on the computer: kt-battery notice.rs CHOICES; KtBatPure.MARKS). */
const MARKS = [5, 10, 15, 20, 25, 30, 35, 40];
/** Our drawings by kind (btconnect.ts's set; a watch drawn here). */
const PIC: Record<string, string> = { headset: 'headset', earbuds: 'earbuds', speaker: 'speaker', controller: 'pad', keyboard: 'keyboard', mouse: 'mouse', phone: 'phone', other: 'other' };
const WATCH = '<rect x="13" y="13" width="22" height="22" rx="7"/><path d="M17.5 13l1.6-7.5h9.8l1.6 7.5M17.5 35l1.6 7.5h9.8l1.6-7.5"/><path d="M24 19v5.5l3.5 2.5"/><rect class="f" x="35" y="21.5" width="3" height="5" rx="1.5"/>';
function kindPic(kind: string): SVGElement {
  const s = picSvg(PIC[kind] ?? 'other');
  if (kind === 'watch') { s.innerHTML = WATCH; s.dataset.picture = 'watch'; }
  return s;
}
/** A word from one of the details' families; '' when the key is not one the page knows. */
const word = (family: string, key: string | undefined): string => {
  if (!key) return '';
  const k = `${family}_${key}` as keyof Strings; const v = t(k);
  return v && v !== k ? v : '';
};
/** A short list in the language's own separator (Arabic «، », Japanese «・», Chinese «、»). */
const SEP: Record<string, string> = { ar: '، ', ja: '・', zh: '、' };
const list = (xs: string[]): string => xs.filter(Boolean).join(SEP[getLang()] ?? ', ');
const kindWord = (kind: string): string => (kind === 'watch' ? t('bphWatch') : t(`batKind_${PIC[kind] ? kind : 'other'}` as 'batKind_other'));

const CSS = `
.bp-view .bp-body { display: flex; flex-direction: column; gap: 16px; padding-bottom: 96px; }
.bp-view .bp-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.bp-view .bp-head .bp-count { flex: 1 1 160px; margin: 0; color: var(--md-on-surface-variant); }
.bp-view .bp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 14px; }
.bp-card { display: grid; grid-template-columns: 52px minmax(0, 1fr); align-items: center; column-gap: 14px; row-gap: 12px; padding: 18px; border-radius: var(--sh-xl, 28px); background: var(--md-surface-container-low); }
.bp-card .bp-ic, .bp-state .bp-ic { width: 52px; height: 52px; border-radius: 18px; display: grid; place-items: center; background: var(--md-secondary-container); color: var(--md-on-secondary-container); }
.bp-view .bp-ic svg { width: 38px; height: 38px; fill: none; stroke: currentColor; stroke-width: 2.3; stroke-linecap: round; stroke-linejoin: round; }
.bp-view .bp-ic svg .f { fill: currentColor; fill-opacity: .22; stroke: none; }
.bp-card .bp-who { min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.bp-card .bp-name { font-weight: 650; font-size: 15px; color: var(--md-on-surface); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-card .bp-sub { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.bp-card .bp-chip { display: inline-flex; align-items: center; height: 24px; padding: 0 10px; border-radius: 12px; background: var(--md-surface-container-high); color: var(--md-on-surface-variant); font-weight: 600; }
.bp-card .bp-chip.on { background: var(--md-primary-container); color: var(--md-on-primary-container); }
.bp-card .bp-level { grid-column: 1 / -1; display: flex; align-items: center; gap: 12px; min-height: 36px; }
.bp-card .bp-pct { font-size: 28px; font-weight: 700; color: var(--md-on-surface); font-variant-numeric: tabular-nums; min-width: 3.4ch; }
.bp-card .bp-meter { flex: 1; height: 10px; border-radius: 5px; background: var(--md-surface-container-highest); overflow: hidden; }
.bp-card .bp-meter > i { display: block; height: 100%; border-radius: inherit; background: var(--md-primary); }
.bp-card .bp-unknown { font-size: 15px; color: var(--md-on-surface-variant); }
.bp-card .bp-foot { grid-column: 1 / -1; margin: 0; font-size: 12.5px; color: var(--md-on-surface-variant); line-height: 1.5; }
.bp-card.low .bp-pct { color: var(--md-error); }
.bp-card.low .bp-meter > i { background: var(--md-error); }
.bp-card.low .bp-ic { background: var(--md-error-container, color-mix(in srgb, var(--md-error) 18%, transparent)); color: var(--md-on-error-container, var(--md-error)); }
.bp-card.away .bp-ic, .bp-card.away .bp-level { opacity: .55; }
.bp-view .bp-state { display: flex; flex-direction: column; align-items: flex-start; gap: 12px; }
.bp-view .bp-state h3 { margin: 0; text-transform: none; letter-spacing: 0; font-size: 18px; color: var(--md-on-surface); }
.bp-view .bp-state p { margin: 0; line-height: 1.55; }
.bp-view .bp-state .bp-safe { color: var(--md-on-surface-variant); font-size: 13.5px; }
.bp-view .bp-acts { display: flex; flex-wrap: wrap; gap: 10px; }
.bp-view .bp-set { display: flex; flex-direction: column; gap: 4px; }
.bp-view .bp-set h3 { margin-bottom: 6px; }
.bp-view .bp-switch { gap: 20px; padding: 12px 0; cursor: pointer; }
.bp-view .bp-switch .bp-sw-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.bp-view .bp-switch .bp-sw-title { color: var(--md-on-surface); font-size: 15px; }
.bp-view .bp-set small, .bp-view .bp-row > span > small { color: var(--md-on-surface-variant); font-size: 12.5px; line-height: 1.5; }
.bp-view .bp-row { display: flex; align-items: center; justify-content: space-between; gap: 12px 16px; flex-wrap: wrap; padding: 12px 0; border-top: 1px solid var(--md-outline-variant); }
.bp-view .bp-row > span { flex: 1 1 160px; min-width: 0; display: flex; flex-direction: column; gap: 3px; color: var(--md-on-surface); }
.bp-view .bp-row .pick-btn { flex: 0 0 140px; width: 140px; }
.bp-view .bp-note { margin: 8px 0 0; font-size: 13px; color: var(--md-on-surface-variant); line-height: 1.55; }
.bp-card[role="button"] { cursor: pointer; -webkit-tap-highlight-color: transparent; }
.bp-card[role="button"]:focus-visible { outline: 2px solid var(--md-primary); outline-offset: 2px; }
.bp-card .bp-chip { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.bp-details .kv dd { color: var(--md-on-surface); }
`;
function style(): void {
  if (document.getElementById('kt-batphone-css')) return;
  const s = document.createElement('style'); s.id = 'kt-batphone-css'; s.textContent = CSS; document.head.append(s);
}

export function batPhoneView(): HTMLElement & { dispose?: () => void } {
  style();
  const body = h('div', { class: 'body bp-body' });
  const refreshBtn = iconButton('refresh', t('bphRefresh'), () => void load());
  const root = h('div', { class: 'view bp-view' }, h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/settings')), h('div', { class: 'title' }, h('span', null, t('batTitle'))), refreshBtn), body) as HTMLElement & { dispose?: () => void };
  const p = plug();
  if (!p) { refreshBtn.hidden = true; body.append(stateCard('notHere', 'mouse', t('batNotHere'), t('batNotHereHint'))); return root; }
  let st: PhoneState | null = null; let asking = false; let gone = false;
  body.append(h('div', { class: 'spinner small' }));

  // (The notices are written by KtBattery in the page's language: its words handed over each time the page opens.)
  void p.batteryPhoneConfig({ labels: { channel: t('bphChannel'), title: t('bphNoticeTitle'), text: t('bphNoticeText'), unnamed: t('batUnnamed') } }).catch(() => undefined);
  void p.batteryPhoneWatch({ on: true }).catch(() => undefined);

  async function load(): Promise<void> {
    const s = await p!.batteryPhoneState().catch((e: unknown) => { toast(String((e as Error)?.message ?? e), 'error'); return null; });
    if (!s || gone) return;
    st = s; if (s.access !== 'ask') asking = false; draw();
  }
  const open = (what: 'bluetooth' | 'app') => void p.batteryPhoneOpen({ what }).catch(() => undefined);
  async function ask(): Promise<void> {
    const r = await p!.batteryPhoneAsk().catch(() => null);
    if (gone) return;
    if (r?.access === 'asking') { asking = true; draw(); return; }
    await load();
  }
  const saveCfg = async (set: Partial<PhoneCfg>) => {
    try { const c = await p.batteryPhoneConfig({ set }); if (st) st.config = c; } catch (e) { toast(String((e as Error)?.message ?? e), 'error'); }
    draw();
  };

  function stateCard(state: string, kind: string, title: string, text: string, ...more: (HTMLElement | null)[]): HTMLElement {
    return h('section', { class: 'card bp-state', 'data-state': state }, h('div', { class: 'bp-ic' }, kindPic(kind)), h('h3', null, title), h('p', null, text), ...more.filter(Boolean) as HTMLElement[]);
  }
  const btn = (cls: string, act: string, label: string, fn: () => void, ic?: string) => h('button', { type: 'button', class: `btn ${cls}`, 'data-act': act, onclick: fn }, ic ? icon(ic) : null, label);
  const acts = (...b: HTMLElement[]) => h('div', { class: 'bp-acts' }, ...b);

  const pct = (n: number) => t('batPct', { n: localDigits(n) });
  const markOf = (c: PhoneCfg, key: string) => { const v = c.marks?.[key]; return typeof v === 'number' ? v : c.low; };
  /** The chip: «Connected · Audio, Calls» — the links in use said compactly. */
  const chipText = (x: PhoneDev): string => {
    if (!x.connected) return t('bphNotConnected');
    const links = (x.profiles ?? []).map((k) => word('bphLinks', k)).filter(Boolean);
    return links.length ? `${t('bphConnected')} · ${list(links)}` : t('bphConnected');
  };
  /** What a card shows, as one string: the card is drawn again only when this changed (the ages included). */
  const cardSig = (x: PhoneDev, now: number, c: PhoneCfg): string => JSON.stringify([x, markOf(c, x.key), x.lastLevelAt ? ageText(x.lastLevelAt, now) : '', x.seenAt ? ageText(x.seenAt, now) : '']);
  const card = (x: PhoneDev, now: number, c: PhoneCfg): HTMLElement => {
    const has = x.level >= 0 && x.connected; const mk = markOf(c, x.key);
    const low = has && mk > 0 && x.level <= mk;
    const level = has
      ? h('div', { class: 'bp-level' }, h('span', { class: 'bp-pct' }, pct(x.level)), h('span', { class: 'bp-meter', role: 'meter', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(x.level), 'aria-label': pct(x.level) }, h('i', { style: { width: `${Math.max(2, Math.min(100, x.level))}%` } })))
      : h('div', { class: 'bp-level' }, h('span', { class: 'bp-unknown' }, !x.connected && x.lastLevel >= 0 && x.lastLevelAt > 0 ? t('bphLastKnown', { level: pct(x.lastLevel), age: ageText(x.lastLevelAt, now) }) : t('batLevelUnknown')));
    const foot = x.connected ? (has ? null : t('bphNoLevel')) : x.seenAt > 0 ? t('bphSeen', { age: ageText(x.seenAt, now) }) : t('bphNeverSeen');
    const el = h('section', { class: 'card bp-card' + (low ? ' low' : '') + (x.connected ? '' : ' away'), role: 'button', tabindex: '0', 'aria-haspopup': 'dialog', 'data-key': x.key, 'data-kind': x.kind, 'data-connected': String(x.connected), 'data-level': String(has ? x.level : -1), 'data-profiles': (x.profiles ?? []).join(' '),
      onclick: () => details(x.key), onkeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); details(x.key); } } },
      h('div', { class: 'bp-ic' }, kindPic(x.kind)),
      h('div', { class: 'bp-who' }, h('span', { class: 'bp-name', dir: 'auto' }, x.name || t('batUnnamed')),
        h('span', { class: 'bp-sub' }, h('span', null, kindWord(x.kind)), h('span', { class: 'bp-chip' + (x.connected ? ' on' : '') }, chipText(x)))),
      level, foot ? h('p', { class: 'bp-foot' }, foot) : null);
    return el;
  };

  /** The details' rows, read only: what Android already holds; a value it does not give is left out, never «unknown». */
  const detailRows = (x: PhoneDev, now: number): [string, string, string][] => {
    const rows: [string, string, string][] = [];
    const add = (id: string, k: keyof Strings, v: string | undefined) => { if (v) rows.push([id, t(k), v]); };
    const alias = x.alias?.trim(), sys = x.sysName?.trim();
    add('alias', 'bphRowAlias', alias && alias !== sys ? alias : undefined);
    add('name', 'bphRowName', sys);
    add('type', 'bphRowType', word('bphType', x.type));
    add('class', 'bphRowClass', [word('bphMajor', x.major), word('bphMinor', x.minor)].filter(Boolean).join(' · '));
    add('bond', 'bphRowBond', word('bphBond', x.bond));
    add('links', 'bphRowLinks', x.connected ? list((x.profiles ?? []).map((k) => word('bphLinks', k))) : '');
    add('services', 'bphRowServices', list((x.services ?? []).map((k) => word('bphSvc', k))));
    add('codec', 'bphRowCodec', x.connected ? x.codec : undefined);
    const pt = x.parts ?? {}; const part = (k: keyof Strings, v?: number) => (typeof v === 'number' && v >= 0 ? t(k, { n: pct(v) }) : '');
    add('parts', 'bphRowParts', x.connected ? [part('bphPartLeft', pt.left), part('bphPartRight', pt.right), part('bphPartCase', pt.case)].filter(Boolean).join(' · ') : '');
    const src = x.connected && x.level >= 0 ? x.source : x.lastSource;
    add('source', 'bphRowSource', word('bphSrc', src || undefined));
    add('read', 'bphRowRead', x.lastLevelAt > 0 ? ageText(x.lastLevelAt, now) : '');
    add('last', 'bphRowLast', x.connected ? t('bphConnectedNow') : x.seenAt > 0 ? ageText(x.seenAt, now) : '');
    add('first', 'bphRowFirst', x.firstSeen && x.firstSeen > 0 ? ageText(x.firstSeen, now) : '');
    return rows;
  };
  /** The open details sheet (one at a time): filled again when its device's reading changes. */
  let sheet: { key: string; body: HTMLElement; close: () => void } | null = null;
  const fillDetails = (x: PhoneDev, now: number) => {
    if (!sheet) return;
    sheet.body.replaceChildren(h('dl', { class: 'kv' }, ...detailRows(x, now).flatMap(([id, k, v]) => [h('dt', { 'data-row': id }, k), h('dd', { dir: 'auto', 'data-row': id }, v)])));
  };
  function details(key: string): void {
    const x = st?.devices.find((d) => d.key === key); if (!x || !st) return;
    const sh = openSheet(x.name || t('batUnnamed'), t('close'), { onClose: () => { if (sheet?.key === key) sheet = null; } });
    sh.el.classList.add('bp-details'); sh.el.dataset.key = key;
    sheet = { key, body: sh.body, close: sh.close }; fillDetails(x, st.now);
  }

  const settingsCard = (c: PhoneCfg): HTMLElement => {
    const sw = h('input', { type: 'checkbox', role: 'switch', checked: c.notify, 'aria-label': t('bphNotify'), onchange: () => {
      const on = sw.checked;
      // (Android 13+: notifications may be off for the app — its own dialog, or its notification settings.)
      if (on) void p.notifyAccess?.({ ask: true }).catch(() => null);
      void saveCfg({ notify: on });
    } }) as HTMLInputElement;
    const low = pickButton(t('bphLow'), MARKS.map((v) => [String(v), pct(v)] as [string, string]), String(MARKS.includes(c.low) ? c.low : 15), (v) => void saveCfg({ low: Number(v) }), t('close'));
    low.dataset.name = 'low';
    return h('section', { class: 'card bp-set', 'data-group': 'notices' }, h('h3', null, t('bphSettingsTitle')),
      h('label', { class: 'switch-row bp-switch', 'data-row': 'notify' }, h('span', { class: 'bp-sw-text' }, h('span', { class: 'bp-sw-title' }, t('bphNotify')), h('small', null, t('bphNotifyHint'))), sw),
      h('div', { class: 'bp-row' }, h('span', null, t('bphLow'), h('small', null, t('bphLowHint'))), low),
      h('p', { class: 'bp-note', 'data-note': 'limits' }, t('bphLimits')));
  };

  /** The frame of the list and its cards, kept between readings (Part D: only the cards that changed are drawn again). */
  type Shell = { mode: 'list' | 'empty'; count: HTMLElement; grid: HTMLElement; settings: HTMLElement; cfgSig: string };
  let shell: Shell | null = null; const cards = new Map<string, { sig: string; el: HTMLElement }>();
  /** One clear card in place of the list (off, not allowed, no Bluetooth): the list forgotten, an open details sheet closed. */
  const plain = (...els: HTMLElement[]) => { shell = null; cards.clear(); if (sheet) { const c = sheet.close; sheet = null; c(); } body.replaceChildren(...els); };
  function draw(): void {
    if (!st || gone) return;
    const s = st;
    refreshBtn.hidden = !(s.adapter && s.on && s.access === 'granted');
    if (!s.adapter) { plain(stateCard('noBluetooth', 'other', t('bphNoBtTitle'), t('bphNoBtBody'))); return; }
    if (s.access === 'ask' || (asking && s.access !== 'granted')) {
      const allow = btn('filled', 'allow', asking ? t('bphAsking') : t('bphAllow'), () => void ask());
      if (asking) allow.setAttribute('disabled', '');
      plain(stateCard('permission', 'earbuds', t('bphIntroTitle'), t('bphIntroBody'), h('p', { class: 'bp-safe' }, t('bphIntroSafe')), acts(allow)));
      return;
    }
    if (s.access === 'refused' || s.access === 'blocked') {
      const blocked = s.access === 'blocked';
      plain(stateCard(blocked ? 'blocked' : 'refused', 'earbuds', t('bphRefusedTitle'), blocked ? t('bphBlockedBody') : t('bphRefusedBody'),
        acts(blocked ? btn('filled', 'app', t('bphAppSettings'), () => open('app')) : btn('filled', 'allow', t('bphAskAgain'), () => void ask()))));
      return;
    }
    if (!s.on) { plain(stateCard('off', 'headset', t('bphOffTitle'), t('bphOffBody'), acts(btn('filled', 'bluetooth', t('bphBtSettings'), () => open('bluetooth'))))); return; }
    // (Connected first, then by name.)
    const devs = s.devices.slice().sort((a, b) => Number(b.connected) - Number(a.connected) || (a.name || '').localeCompare(b.name || ''));
    const mode = devs.length ? 'list' : 'empty';
    if (!shell || shell.mode !== mode) {
      // (The page's frame for the list, made once; afterwards only what changed is touched.)
      cards.clear();
      const btSettings = btn('tonal', 'bluetooth', t('bphBtSettings'), () => open('bluetooth'), 'settings');
      const count = h('p', { class: 'bp-count' }); const grid = h('div', { class: 'bp-grid' });
      const settings = h('div', { class: 'bp-set-slot' });
      const top = mode === 'list' ? [h('div', { class: 'bp-head' }, count, btSettings), grid] : [stateCard('empty', 'headset', t('bphEmptyTitle'), t('bphEmptyBody'), acts(btSettings))];
      shell = { mode, count, grid, settings, cfgSig: '' };
      body.replaceChildren(...top, settings, h('p', { class: 'bp-note', 'data-note': 'about' }, t('bphAbout')));
    }
    const sh = shell;
    const cfgSig = JSON.stringify(s.config);
    if (sh.cfgSig !== cfgSig) { sh.cfgSig = cfgSig; sh.settings.replaceChildren(settingsCard(s.config)); }
    if (mode === 'empty') return;
    const countText = t('bphCount', { n: localDigits(devs.length) }); if (sh.count.textContent !== countText) sh.count.textContent = countText;
    const keep = new Set<string>();
    devs.forEach((x, i) => {
      keep.add(x.key);
      const sig = cardSig(x, s.now, s.config); let c = cards.get(x.key);
      if (!c || c.sig !== sig) {
        const el = card(x, s.now, s.config);
        if (c) c.el.replaceWith(el);
        c = { sig, el }; cards.set(x.key, c);
        if (sheet?.key === x.key) fillDetails(x, s.now);
      }
      // (Moved only when out of place.)
      if (sh.grid.children[i] !== c.el) sh.grid.insertBefore(c.el, sh.grid.children[i] ?? null);
    });
    for (const [k, c] of cards) if (!keep.has(k)) { c.el.remove(); cards.delete(k); }
  }

  // (Android's answers: the plugin's event — a level changed, a device came or went, back from the permission dialog —
  // and coming back to the app from its settings.)
  let off: { remove(): void } | null = null;
  void listen(p as unknown as { addListener(ev: string, fn: (d: PhoneState) => void): unknown }, 'btBattery', (e) => { if (gone || !e) return; st = e; if (e.access !== 'ask') asking = false; draw(); }).then((l) => { if (gone) l.remove(); else off = l; });
  // (Hidden — another app in front, the screen off —: nothing runs, Android's sources let go; shown again: read anew.)
  let hidden = document.hidden;
  const vis = () => {
    if (gone) return;
    if (document.hidden) { if (!hidden) { hidden = true; void p.batteryPhoneWatch({ on: false }).catch(() => undefined); } return; }
    if (hidden) { hidden = false; void p.batteryPhoneWatch({ on: true }).catch(() => undefined); }
    void load();
  };
  const focus = () => { if (!document.hidden) void load(); };
  document.addEventListener('visibilitychange', vis); window.addEventListener('focus', focus);
  // (The ages move on while the list is shown: every half minute — no per-second timer, nothing while hidden, off or
  // not allowed; only cards whose words changed are drawn again.)
  const tick = window.setInterval(() => { if (!st || document.hidden || !shell || shell.mode !== 'list') return; st.now += 30_000; draw(); }, 30_000);
  void load();
  root.dispose = () => {
    gone = true; off?.remove(); document.removeEventListener('visibilitychange', vis); window.removeEventListener('focus', focus); clearInterval(tick);
    if (sheet) { const c = sheet.close; sheet = null; c(); }
    void p.batteryPhoneWatch({ on: false }).catch(() => undefined);
  };
  return root;
}
