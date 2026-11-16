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
/** True where the shell can open the pet's own window. */
export const canDesktop = (): boolean => { const k = window.kurokawaTools as unknown as { pet?: unknown; os?: string } | undefined; return typeof k?.pet === 'function' && !((window as unknown as { __KT_SHELL__?: string }).__KT_SHELL__ === 'tauri' && k.os === 'darwin'); };

export function syncPets(): Promise<void> { chain = chain.then(sync, sync); return chain; }
async function sync(): Promise<void> {
  const p = petPrefs(getSettings().pets);
  const want = p.on && pcNow() && p.active.length > 0;
  const where = want ? (p.where === 'desktop' && canDesktop() ? 'desktop' : 'app') : '';
  if (where !== 'app' && stage) { stage.dispose(); stage = null; }
  if (where !== 'desktop' && desk) { desk.stop(); desk = null; }
  watchStorage(where === 'desktop');
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
/** «Hide pets»: off at once, with Undo. */
export function hidePets(): void {
  const before = petPrefs(getSettings().pets);
  updateSettings({ pets: { ...before, on: false } });
  void Promise.all([import('../ui/dom'), import('../i18n')]).then(([d, i]) => d.toast(i.t('petsHidden'), 'info', 6000, { label: i.t('undo'), run: () => updateSettings({ pets: { ...petPrefs(getSettings().pets), on: true } }) }));
}
/** The stage now (the settings' line saying why it is paused). */
export const currentStage = (): Stage | null => stage;
