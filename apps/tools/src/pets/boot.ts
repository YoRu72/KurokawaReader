// The pets started, changed and stopped as the settings say (fetched only once pets are on, a computer only): in the
// app's window (Tier A, ./stage.ts) or on the desktop (Tier B, ./desktop.ts, where the shell offers it; else in the
// window). Off: everything removed — no element, listener or timer left.
import { getSettings, updateSettings, type Settings } from '../settings';
import { petPrefs } from './prefs';
import type { Stage } from './stage';

type Desk = { stop(): void; apply(ids: string[]): Promise<void> };
let stage: Stage | null = null; let shown = ''; let desk: Desk | null = null;
/** One sync at a time (settings change in bursts): each waits for the one before. */
let chain: Promise<void> = Promise.resolve();
const pcNow = () => document.documentElement.classList.contains('pc');
export interface DeskCaps { desktop: boolean; follow: boolean; why: string }
let capsP: Promise<DeskCaps> | null = null;
/** What the shell can do for pets on the desktop (asked once): open their windows where they can be placed (not on
 *  Wayland itself, not the Tauri build on a Mac), and know the window in front (the Tauri build). */
export function desktopCaps(): Promise<DeskCaps> {
  const k = window.kurokawaTools as unknown as { pet?(o: unknown): Promise<unknown> } | undefined;
  if (typeof k?.pet !== 'function') return Promise.resolve({ desktop: false, follow: false, why: 'shell' });
  return (capsP ??= k.pet({ action: 'caps' }).then((c) => { const o = (c ?? {}) as Partial<DeskCaps>; return { desktop: o.desktop === true, follow: o.follow === true, why: typeof o.why === 'string' ? o.why : '' }; }, () => ({ desktop: false, follow: false, why: 'shell' })));
}
export function syncPets(): Promise<void> { chain = chain.then(sync, sync); return chain; }
async function sync(): Promise<void> {
  const p = petPrefs(getSettings().pets);
  const want = p.on && pcNow() && p.active.length > 0;
  const where = want ? (p.where === 'desktop' && (await desktopCaps()).desktop ? 'desktop' : 'app') : '';
  if (where !== 'app' && stage) { stage.dispose(); stage = null; }
  if (where !== 'desktop' && desk) { desk.stop(); desk = null; }
  watchStorage(where === 'desktop');
  await tray(!!where);
  if (!where) { shown = ''; return; }
  const key = p.active.join();
  if (where === 'desktop') {
    const d: Desk = desk ?? await import('./desktop').then((m) => m.startDesktop()); desk = d;
    await d.apply(p.active); shown = key; return;
  }
  const { t } = await import('../i18n');
  if (!stage) {
    const { Stage } = await import('./stage');
    stage = new Stage(p, {
      labels: { hide: t('petsHide'), settings: t('petsSettings') },
      hide: () => hidePets(),
      settings: () => { location.hash = '#/settings/pets'; },
      failed: (name) => void import('../ui/dom').then((d) => d.toast(t('petsFailed', { name }), 'error', 7000)),
    });
    shown = '';
  } else stage.applyPrefs(p);
  if (shown !== key) { shown = key; await stage.setPets(p.active); }
}
/** On the desktop, a pet window's own «Hide pets» writes the choice in the shared storage: taken here, so the main
 *  window's settings say the same (and the windows are closed by the sync that follows). */
let storageOff: (() => void) | null = null;
function watchStorage(on: boolean): void {
  if (on && !storageOff) {
    const fn = (e: StorageEvent) => {
      if (e.key !== 'kt.settings' || !e.newValue) return;
      try { const p = (JSON.parse(e.newValue) as { pets?: Settings['pets'] }).pets; if (p && JSON.stringify(p) !== JSON.stringify(getSettings().pets)) updateSettings({ pets: p }); } catch { /* not ours */ }
    };
    window.addEventListener('storage', fn); storageOff = () => window.removeEventListener('storage', fn);
  } else if (!on && storageOff) { storageOff(); storageOff = null; }
}
/** «Hide pets» in the shell's tray while pets are shown, and its click taken (the shell closes the desktop pets itself). */
let trayOn = false; let trayOff: (() => void) | null = null;
async function tray(on: boolean): Promise<void> {
  if (on === trayOn) return; trayOn = on;
  const k = window.kurokawaTools as unknown as { pet?(o: unknown): Promise<unknown>; onPetHide?(cb: () => void): () => void } | undefined;
  if (typeof k?.pet !== 'function') return;
  const { t } = await import('../i18n');
  void k.pet({ action: 'tray', shown: on, label: t('petsHide') }).catch(() => undefined);
  if (on && !trayOff && typeof k.onPetHide === 'function') { const off = k.onPetHide(() => hidePets()); trayOff = typeof off === 'function' ? off : null; }
  else if (!on && trayOff) { trayOff(); trayOff = null; }
}
/** «Hide pets»: off at once, with Undo. */
export function hidePets(): void {
  const before = petPrefs(getSettings().pets);
  updateSettings({ pets: { ...before, on: false } });
  void Promise.all([import('../ui/dom'), import('../i18n')]).then(([d, i]) => d.toast(i.t('petsHidden'), 'info', 6000, { label: i.t('undo'), run: () => updateSettings({ pets: { ...petPrefs(getSettings().pets), on: true } }) }));
}
/** The stage now (the settings' line saying why it is paused). */
export const currentStage = (): Stage | null => stage;
