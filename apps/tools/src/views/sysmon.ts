// SPDX-License-Identifier: GPL-3.0-or-later
// Piece S1, «System on the taskbar» (the computer's Tauri build, Windows): which of the processor's, memory's, graphics
// card's and drive's figures join the devices on the taskbar — on the strip when it is on, else as tray icons with the
// number drawn — and in what order; how often they are read; Celsius or Fahrenheit; what a click on one does (Task
// Manager, Tools, nothing); before or after the devices on the strip; the warm (rose) and hot (red) marks. Everything
// off until chosen. One look at what this computer gives (sysmonProbe) says, per value, what it reads now or, calmly,
// that Windows does not give it here without a driver. On Linux and macOS a calm «Windows only for now». The shell's
// side: desktop-tauri/src-tauri/src/battery.rs over kt-battery sysmon.rs (inspired by TraySense — NOTICE.md).
// Loaded with the Battery page's first draw (battery.ts imports it lazily); no listener or timer of its own.
import { h, iconButton, pickButton } from '../ui/dom';
import { t as tBase } from '../i18n';
import { osT as t, sysName } from './batplat';

const IDS = ['cpu', 'cpuTemp', 'ram', 'gpu', 'gpuTemp', 'vram', 'drive'] as const;
type Id = typeof IDS[number];
const TEMP: ReadonlySet<Id> = new Set(['cpuTemp', 'gpuTemp', 'drive']);
const GPU: ReadonlySet<Id> = new Set(['gpu', 'gpuTemp', 'vram']);
/** The settings the card changes (kept with the battery's, battery.rs clean()). */
export type SysSettings = { sysOn?: string[]; sysOrder?: string[]; sysUnit?: 'c' | 'f'; sysEvery?: number; sysClick?: 'taskmgr' | 'tools' | 'nothing'; sysSide?: 'before' | 'after';
  sysCpuWarm?: number; sysCpuHot?: number; sysGpuWarm?: number; sysGpuHot?: number; sysDriveWarm?: number; sysDriveHot?: number };
type Probe = { available: boolean; os?: string; values?: Partial<Record<Id, number | null>>; gpu?: string };
type Desk = { sysmonProbe?: () => Promise<Probe> };

const CSS = `
.battery-view .bat-sys { gap: 4px; }
.battery-view .bat-sys h3 { margin-bottom: 4px; }
.battery-view .bat-sys > .hint { margin: 0 0 8px; }
.battery-view .bat-sys .bat-sys-list { display: flex; flex-direction: column; border-top: 1px solid var(--md-outline-variant); margin-top: 4px; }
.battery-view .bat-sys .bat-sys-row { display: flex; align-items: center; gap: 12px; }
.battery-view .bat-sys .bat-sys-row + .bat-sys-row { border-top: 1px solid var(--md-outline-variant); }
.battery-view .bat-sys .bat-sys-row > .bat-switch { flex: 1; min-width: 0; }
.battery-view .bat-sys .bat-sys-move { display: flex; gap: 8px; flex: 0 0 auto; }
.battery-view .bat-sys .bat-sys-move .icon-btn { width: 40px; height: 40px; flex: 0 0 40px; }
.battery-view .bat-sys .bat-sys-move .icon-btn:disabled { opacity: .32; cursor: default; }
.battery-view .bat-sys .bat-sys-gpu { margin: 8px 0 4px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.battery-view .bat-sys .bat-row { padding: 6px 0; }
.battery-view .bat-sys .bat-row + .bat-row { margin-top: 6px; }
.battery-view .bat-sys .bat-row .pick-btn { flex: 0 1 260px; width: 260px; max-width: 100%; }
.battery-view .bat-sys h4 { margin: 14px 0 2px; font-size: 14px; font-weight: 650; color: var(--md-on-surface); }
.battery-view .bat-sys .bat-sys-marks-hint { margin: 0 0 6px; font-size: 12.5px; color: var(--md-on-surface-variant); }
.battery-view .bat-sys .bat-sys-mark { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 10px 16px; padding: 6px 0; }
.battery-view .bat-sys .bat-sys-mark > span { flex: 1 1 140px; min-width: 0; color: var(--md-on-surface); }
.battery-view .bat-sys .bat-sys-mark > label { display: flex; flex-direction: column; gap: 4px; flex: 0 1 125px; width: 125px; font-size: 12px; color: var(--md-on-surface-variant); }
.battery-view .bat-sys .bat-sys-mark .pick-btn { width: 100%; }
`;
function style(): void {
  if (document.getElementById('kt-sysmon-css')) return;
  const s = document.createElement('style'); s.id = 'kt-sysmon-css'; s.textContent = CSS; document.head.append(s);
}

const cToF = (c: number) => Math.round(c * 9 / 5 + 32);
/** A temperature as the user reads it (°C kept in the settings). */
function deg(c: number, unit: 'c' | 'f'): string { return unit === 'f' ? t('sysDegF', { n: cToF(c) }) : t('sysDegC', { n: Math.round(c) }); }
function valueText(id: Id, v: number, unit: 'c' | 'f'): string { return TEMP.has(id) ? deg(v, unit) : t('sysPct', { n: Math.round(v) }); }
const range = (lo: number, hi: number) => Array.from({ length: (hi - lo) / 5 + 1 }, (_, i) => lo + i * 5);
/** The full order: the user's, then the rest (kt-battery sysmon.rs full_order). */
export function fullOrder(order: string[] | undefined): Id[] {
  const out: Id[] = [];
  for (const x of order ?? []) if ((IDS as readonly string[]).includes(x) && !out.includes(x as Id)) out.push(x as Id);
  for (const x of IDS) if (!out.includes(x)) out.push(x);
  return out;
}

/** The card's state for one Battery page: the one look at this computer, asked once. */
export function sysPanel(desk: unknown, redraw: () => void): { card(S: SysSettings, can: boolean, tray: boolean, save: (set: SysSettings) => void): HTMLElement; dispose(): void } {
  style();
  let probe: Probe | null = null; let failed = false; let gone = false; let asked = false;
  const d = desk as Desk;
  const ask = () => {
    if (asked) return; asked = true;
    // (A shell without the look — an older one — says nothing it cannot know: «not reported».)
    if (!d?.sysmonProbe) { failed = true; return; }
    void d.sysmonProbe().then((p) => { if (gone) return; probe = p; redraw(); }, () => { if (gone) return; failed = true; redraw(); });
  };

  const sw = (name: string, title: string, hint: string, on: boolean, off: boolean, fn: (v: boolean) => void): HTMLElement => {
    const i = h('input', { type: 'checkbox', role: 'switch', checked: on, disabled: off, 'aria-label': title, onchange: () => fn(i.checked) }) as HTMLInputElement;
    return h('label', { class: 'switch-row bat-switch' + (off ? ' is-off' : ''), 'data-row': name }, h('span', { class: 'bat-sw-text' }, h('span', { class: 'bat-sw-title', dir: 'auto' }, title), h('small', null, hint)), i);
  };

  function card(S: SysSettings, can: boolean, tray: boolean, save: (set: SysSettings) => void): HTMLElement {
    const root = h('section', { class: 'card bat-settings bat-sys', 'data-group': 'system' }, h('h3', null, t('sysTitle')));
    const os = sysName();
    // (Only Windows reads these: an OS the shell did not name ('') is not taken for Windows.)
    if (os !== 'windows') { root.append(h('p', { class: 'hint', 'data-state': 'notWindows' }, t('sysNotWindows'))); return root; }
    ask();
    const unit = S.sysUnit === 'f' ? 'f' : 'c';
    root.append(h('p', { class: 'hint' }, can ? t('sysHint') : tray ? tBase('batTbNeeds') : tBase('batBgNoTray')));
    const on = new Set((S.sysOn ?? []).filter((x) => (IDS as readonly string[]).includes(x)));
    const order = fullOrder(S.sysOrder);
    const vals = probe?.values ?? {};
    const hintOf = (id: Id): string => {
      if (failed) return t('sysAbsent');
      if (!probe) return t('sysChecking');
      const v = vals[id];
      if (typeof v === 'number' && Number.isFinite(v)) return t('sysNow', { value: valueText(id, v, unit) });
      if (GPU.has(id) && !probe.gpu) return t('sysNoGpu');
      return id === 'cpuTemp' ? t('sysAbsent_cpuTemp') : id === 'gpuTemp' ? t('sysAbsent_gpuTemp') : id === 'drive' ? t('sysAbsent_drive') : t('sysAbsent');
    };
    const move = (id: Id, dir: number) => {
      const o = order.slice(); const i = o.indexOf(id); const j = i + dir; if (i < 0 || j < 0 || j >= o.length) return;
      [o[i], o[j]] = [o[j], o[i]]; save({ sysOrder: o });
    };
    const rows = order.map((id, i) => {
      const s = sw(`sys-${id}`, t(`sys_${id}` as 'sys_cpu'), hintOf(id), on.has(id), !can, (v) => { const next = order.filter((x) => (x === id ? v : on.has(x))); save({ sysOn: next, sysOrder: order }); });
      const up = iconButton('arrowUp', t('sysUp'), () => move(id, -1)); const down = iconButton('arrowDown', t('sysDown'), () => move(id, 1));
      up.disabled = !can || i === 0; down.disabled = !can || i === order.length - 1; up.dataset.act = 'up'; down.dataset.act = 'down';
      return h('div', { class: 'bat-sys-row', 'data-metric': id }, s, h('div', { class: 'bat-sys-move' }, up, down));
    });
    root.append(h('div', { class: 'bat-sys-list' }, ...rows));
    if (probe?.gpu) root.append(h('p', { class: 'bat-sys-gpu', dir: 'auto' }, t('sysGpuName', { name: probe.gpu })));

    const pick = <T extends string>(name: string, title: string, hint: string | null, opts: [T, string][], cur: T, fn: (v: T) => void) => {
      const b = pickButton(title, opts, cur, fn, tBase('close')); b.dataset.name = name; b.disabled = !can;
      return h('div', { class: 'bat-row' }, h('span', null, title, hint ? h('small', null, hint) : null), b);
    };
    const every = String([1, 2, 5].includes(S.sysEvery ?? 2) ? S.sysEvery ?? 2 : 2) as '1' | '2' | '5';
    root.append(
      pick('sysEvery', t('sysEvery'), t('sysEveryHint'), (['1', '2', '5'] as const).map((v) => [v, t(`sysEvery_${v}` as 'sysEvery_1')] as ['1' | '2' | '5', string]), every, (v) => save({ sysEvery: Number(v) })),
      pick('sysUnit', t('sysUnit'), null, (['c', 'f'] as const).map((v) => [v, t(`sysUnit_${v}` as 'sysUnit_c')] as ['c' | 'f', string]), unit, (v) => save({ sysUnit: v })),
      pick('sysClick', t('sysClick'), null, (['taskmgr', 'tools', 'nothing'] as const).map((v) => [v, t(`sysClick_${v}` as 'sysClick_taskmgr')] as ['taskmgr' | 'tools' | 'nothing', string]), S.sysClick ?? 'taskmgr', (v) => save({ sysClick: v })),
      pick('sysSide', t('sysSide'), t('sysSideHint'), (['before', 'after'] as const).map((v) => [v, t(`sysSide_${v}` as 'sysSide_before')] as ['before' | 'after', string]), S.sysSide ?? 'before', (v) => save({ sysSide: v })));

    // The warm and hot marks (°C kept; shown in the unit chosen).
    root.append(h('h4', null, t('sysMarks')), h('p', { class: 'bat-sys-marks-hint' }, t('sysMarksHint')));
    const MARK = [['cpu', 'sysCpuWarm', 'sysCpuHot', 80, 90, 50, 110], ['gpu', 'sysGpuWarm', 'sysGpuHot', 80, 90, 50, 110], ['drive', 'sysDriveWarm', 'sysDriveHot', 65, 75, 35, 90]] as const;
    for (const [who, wk, hk, dw, dh, lo, hi] of MARK) {
      const warm = (S[wk] as number | undefined) ?? dw; const hot = (S[hk] as number | undefined) ?? dh;
      const opts = range(lo, hi).map((c) => [String(c), deg(c, unit)] as [string, string]);
      const wb = pickButton(t('sysWarm'), opts, String(warm), (v) => save({ [wk]: Number(v) } as SysSettings), tBase('close'));
      const hb = pickButton(t('sysHot'), opts, String(hot), (v) => save({ [hk]: Number(v) } as SysSettings), tBase('close'));
      wb.dataset.name = wk; hb.dataset.name = hk; wb.disabled = !can; hb.disabled = !can;
      root.append(h('div', { class: 'bat-sys-mark', 'data-mark': who }, h('span', null, t(`sysMark_${who}` as 'sysMark_cpu')),
        h('label', null, h('span', null, t('sysWarm')), wb), h('label', null, h('span', null, t('sysHot')), hb)));
    }
    return root;
  }
  return { card, dispose: () => { gone = true; } };
}
