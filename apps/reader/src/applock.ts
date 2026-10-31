// The app lock (Mihon's, Android): the device's own lock — fingerprint, face, PIN, pattern, password — asked
// for when the app opens and when it comes back after a while away; and its contents kept out of screenshots
// and the recent-apps preview when asked.
import { t } from './i18n';

type Lock = { canUnlock?(): Promise<{ can: boolean }>; unlock?(o: { title: string; subtitle?: string; cancel?: string }): Promise<{ ok: boolean; error?: string }>; secureScreen?(o: { on: boolean }): Promise<void> };
const plugin = (): Lock | null => {
  const cap = (window as unknown as { Capacitor?: { getPlatform?(): string; Plugins?: { Kurokawa?: Lock } } }).Capacitor;
  return cap?.getPlatform?.() === 'android' ? cap.Plugins?.Kurokawa ?? null : null;
};
const get = (k: string, d: string) => { try { return localStorage.getItem(`kr.lock.${k}`) ?? d; } catch { return d; } };
const set = (k: string, v: string) => { try { localStorage.setItem(`kr.lock.${k}`, v); } catch { /* private mode */ } };

let shield: HTMLElement | null = null; let asking = false; let hiddenAt = 0; let quietUntil = 0;
export const lockAvailable = (): boolean => !!plugin()?.unlock;
export async function canLock(): Promise<boolean> { try { return !!(await plugin()?.canUnlock?.())?.can; } catch { return false; } }
export const lockOn = (): boolean => get('on', 'off') === 'on';
export const lockAfter = (): number => { const v = Number(get('after', '1')); return Number.isFinite(v) ? v : 1; };
export const secureOn = (): boolean => get('secure', 'off') === 'on';
export function setLockAfter(min: number): void { set('after', String(min)); }
export async function setSecure(on: boolean): Promise<void> { set('secure', on ? 'on' : 'off'); await plugin()?.secureScreen?.({ on }).catch(() => undefined); }
/** Turned on only once the device's lock has been passed (so a reader cannot lock themselves out). */
export async function setLock(on: boolean): Promise<boolean> {
  if (on) {
    asking = true;
    try { const r = await plugin()?.unlock?.({ title: t('appLockTurnOn'), cancel: t('cancel') }).catch(() => ({ ok: false })); if (!r?.ok) return false; }
    finally { asking = false; quietUntil = Date.now() + 2500; }
  }
  set('on', on ? 'on' : 'off');
  return true;
}

/** The app covered until the device's lock is passed. */
export async function lockNow(): Promise<void> {
  if (!lockOn() || !plugin()?.unlock) return;
  if (!shield) {
    const btn = document.createElement('button'); btn.type = 'button'; btn.className = 'btn primary'; btn.textContent = t('appLockUnlock');
    btn.addEventListener('click', () => void ask());
    const title = document.createElement('p'); title.className = 'app-lock-title'; title.textContent = t('appLockLocked');
    shield = document.createElement('div'); shield.className = 'app-lock'; shield.setAttribute('role', 'dialog'); shield.append(title, btn);
    document.body.append(shield);
  }
  await ask();
}
async function ask(): Promise<void> {
  if (asking) return; asking = true;
  try {
    const r = await plugin()!.unlock!({ title: t('appLockTitle'), cancel: t('cancel') }).catch(() => ({ ok: false }));
    if (r.ok) { shield?.remove(); shield = null; }
  } finally { asking = false; quietUntil = Date.now() + 2500; }
}

/** At start: the screen kept private when asked, the lock asked for, and asked again on coming back. */
export function initAppLock(): void {
  if (!plugin()) return;
  if (secureOn()) void plugin()?.secureScreen?.({ on: true }).catch(() => undefined);
  if (lockOn()) void lockNow();
  document.addEventListener('visibilitychange', () => {
    // (The lock's own screen takes the app away for a moment: not a leaving.)
    if (asking || Date.now() < quietUntil) return;
    if (document.visibilityState === 'hidden') { hiddenAt = Date.now(); return; }
    if (lockOn() && hiddenAt && Date.now() - hiddenAt >= lockAfter() * 60000) void lockNow();
  });
}
