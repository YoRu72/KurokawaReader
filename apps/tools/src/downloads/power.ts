// When the downloads may run: on Wi-Fi only (Android: held on mobile data, resumed on Wi-Fi), not on a low battery
// (Android: held at 15 % or less, resumed when charging or past 20 %); on a computer, the computer kept awake while
// they run, and what it does when they are all done (nothing, quit the app, sleep, shut down).
import { getSettings, updateSettings } from '../settings';
import { ktPlugin, nativePlatform } from '../native';

export interface Power { wifiOnly?: boolean; batteryGuard?: boolean; keepAwake?: boolean; whenDone?: 'nothing' | 'quit' | 'sleep' | 'shutdown';
  /** A computer: a notice when a download finishes, the tray icon with the speed, and the clipboard hotkeys by mode (Electron accelerators). */
  notifyDone?: boolean; tray?: boolean; hotkeys?: { video?: string; audio?: string; clip?: string; file?: string } }
export const powerOf = (): Power => getSettings().power ?? {};
/** The choices handed to the engine (at start and when they change). */
export async function applyPower(): Promise<void> {
  const p = powerOf();
  try {
    if (nativePlatform() === 'android') await (ktPlugin() as unknown as { configure(o: Record<string, unknown>): Promise<void> } | null)?.configure({ wifiOnly: !!p.wifiOnly, batteryGuard: !!p.batteryGuard, dedupe: !!getSettings().dedupe });
    else { const d = window.kurokawaTools as unknown as { desktopPrefs?(o: Record<string, unknown>): Promise<unknown> } | undefined; await d?.desktopPrefs?.({ keepAwake: p.keepAwake !== false, whenDone: p.whenDone ?? 'nothing', notifyDone: p.notifyDone !== false, tray: !!p.tray, hotkeys: p.hotkeys ?? {} }); }
  } catch { /* an older native side */ }
}
export function setPower(o: Partial<Power>): void { updateSettings({ power: { ...powerOf(), ...o } }); void applyPower(); }
