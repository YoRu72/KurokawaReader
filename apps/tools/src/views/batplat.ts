// SPDX-License-Identifier: GPL-3.0-or-later
// Device battery, piece P1 (Linux and macOS): what the page says differently on each system, kept apart from
// battery.ts so that file only gains an import and one card.
// - osT: the page's words, with a system's own variant where the Windows wording would be wrong there («…_linux»,
//   «…_macos»: the empty state's list, the connect panel's mentions of Windows);
// - platCard: on Linux, when a raw HID node Tools would read is closed to this user, the udev rule's steps — where the
//   shell saved the rule (the app's own folder), the two commands with a Copy button each, how to undo it; Tools never
//   runs them. On a Mac, a calm note: what macOS reports is shown, the family readers are not on macOS yet, connecting
//   is the system's Bluetooth settings' (a button opens them).
import { h, icon, toast } from '../ui/dom';
import { t as tBase } from '../i18n';
import type { Strings } from '../i18n/en';

type Key = keyof Strings;
/** The keys that have a system's own variant. */
const VARIANTS: Partial<Record<'linux' | 'macos', ReadonlySet<string>>> = {
  linux: new Set(['batEmpty2', 'batEmpty3', 'btcLeHint', 'btcPairing', 'btcOffHint', 'btcPairBody', 'btcEnd_refused', 'btcEnd_settings', 'btcEnd_failed']),
  macos: new Set(['batEmpty1', 'batEmpty2', 'batEmpty3', 'batEmptyLater', 'batSafeNote']),
};
/** This system as the bridge names it (Tauri: 'windows' | 'linux' | 'macos'; Electron: process.platform). */
export function sysName(): 'windows' | 'linux' | 'macos' | '' {
  const os = String((window as unknown as { kurokawaTools?: { os?: string } }).kurokawaTools?.os ?? '');
  return os === 'linux' ? 'linux' : os === 'macos' || os === 'darwin' ? 'macos' : os === 'windows' || os === 'win32' ? 'windows' : '';
}
/** t(), with this system's own words where it has them. */
export function osT(key: Key, vars?: Record<string, string | number>): string {
  const sys = sysName();
  const v = sys === 'linux' || sys === 'macos' ? VARIANTS[sys] : undefined;
  return v?.has(key) ? tBase(`${key}_${sys}` as Key, vars) : tBase(key, vars);
}

/** batteryList's system part as the Linux and Mac shells give it. */
type Access = { needed: boolean; saved?: boolean; file?: string | null; steps?: string[] };
type Sys = { os?: string; access?: Access };
type Desk = { btOpenSettings?: () => Promise<void> };

const CSS = `
.battery-view .bat-plat { display: flex; flex-direction: column; gap: 10px; }
.battery-view .bat-plat h3 { margin: 0; }
.battery-view .bat-plat p { margin: 0; line-height: 1.5; }
.battery-view .bat-plat .bat-cmd { display: flex; align-items: center; gap: 10px; }
.battery-view .bat-plat .bat-cmd code { flex: 1; min-width: 0; padding: 10px 12px; border-radius: 12px; background: var(--md-surface-container-high); color: var(--md-on-surface); font-size: 12.5px; line-height: 1.5; overflow-wrap: anywhere; white-space: pre-wrap; }
.battery-view .bat-plat .bat-cmd .icon-btn { flex: 0 0 auto; }
.battery-view .bat-plat .bat-plat-after { color: var(--md-on-surface-variant); font-size: 13px; }
.battery-view .bat-plat .bat-plat-acts { display: flex; flex-wrap: wrap; gap: 10px; }
`;
function style(): void {
  if (document.getElementById('kt-batplat-css')) return;
  const s = document.createElement('style'); s.id = 'kt-batplat-css'; s.textContent = CSS; document.head.append(s);
}

/** A command shown as it is, left to right, with its Copy button. */
function cmd(text: string): HTMLElement {
  const copy = h('button', { type: 'button', class: 'icon-btn', title: tBase('copy'), 'aria-label': tBase('copy'), onclick: () => void navigator.clipboard?.writeText(text).then(() => toast(tBase('copied')), () => undefined) }, icon('copy'));
  return h('div', { class: 'bat-cmd' }, h('code', { dir: 'ltr' }, text), copy);
}

/** Linux's access steps or the Mac's note; null elsewhere (or when nothing needs saying). */
export function platCard(system: unknown, desk: unknown): HTMLElement | null {
  const sys = (system ?? {}) as Sys; const os = sys.os || sysName();
  if (os === 'linux') {
    const a = sys.access; if (!a?.needed) return null;
    style();
    const steps = Array.isArray(a.steps) ? a.steps.filter((x) => typeof x === 'string') : [];
    return h('section', { class: 'card bat-plat', 'data-plat': 'linuxAccess' }, h('h3', null, tBase('batAccessTitle')), h('p', null, tBase('batAccessBody')),
      ...(a.saved && a.file && steps.length ? [h('p', null, tBase('batAccessFile')), cmd(a.file), h('p', null, tBase('batAccessSteps')), ...steps.map(cmd)] : [h('p', { 'data-saved': 'no' }, tBase('batAccessNotSaved'))]),
      h('p', { class: 'bat-plat-after' }, tBase('batAccessAfter')));
  }
  if (os === 'macos') {
    style();
    const d = desk as Desk;
    const open = d?.btOpenSettings ? h('button', { type: 'button', class: 'btn tonal', 'data-act': 'btSettings', onclick: () => void d.btOpenSettings!().catch((e: unknown) => toast(String((e as Error)?.message ?? e), 'error')) }, tBase('btcSettings')) : null;
    return h('section', { class: 'card bat-plat', 'data-plat': 'mac' }, h('h3', null, tBase('batMacTitle')), h('p', null, tBase('batMacBody')), open ? h('div', { class: 'bat-plat-acts' }, open) : null);
  }
  return null;
}
