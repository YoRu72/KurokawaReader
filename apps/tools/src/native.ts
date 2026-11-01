// Which platform this is, and the native plugin on Android/iOS (Capacitor), registered by name.
export type Platform = 'android' | 'ios' | 'desktop' | 'web';

export function nativePlatform(): Platform {
  if (window.kurokawaTools) return 'desktop';
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.()) { const p = cap.getPlatform?.(); return p === 'ios' ? 'ios' : 'android'; }
  return 'web';
}
export const isNative = (): boolean => nativePlatform() !== 'web';

/** Every plugin the native side announces is registered up front (nothing here imports the plugins' JS). */
export function registerNativePlugins(): void {
  const cap = window.Capacitor;
  if (!cap?.isNativePlatform?.() || !cap.registerPlugin) return;
  cap.Plugins = cap.Plugins ?? {};
  for (const hd of cap.PluginHeaders ?? []) { if (!cap.Plugins[hd.name]) { try { cap.registerPlugin(hd.name); } catch (e) { console.warn('[tools] registerPlugin failed', hd.name, e); } } }
}

/** The app's own plugin (KtPlugin.java), when on a phone. */
export interface KtPlugin {
  add(o: Record<string, unknown>): Promise<{ task: unknown }>;
  list(): Promise<{ tasks: unknown[] }>;
  pause(o: { id: string }): Promise<void>;
  resume(o: { id: string }): Promise<void>;
  remove(o: { id: string; deleteFiles: boolean }): Promise<void>;
  setFiles(o: { id: string; priorities: number[] }): Promise<void>;
  setSequential(o: { id: string; on: boolean }): Promise<void>;
  setLimits(o: { down: number; up: number }): Promise<void>;
  setUrl(o: { id: string; url: string }): Promise<void>;
  hosts(): Promise<{ hosts: Record<string, number> }>;
  torrentInfo(o: { source: unknown }): Promise<{ info: unknown }>;
  streamUrl(o: { id: string; fileIndex: number }): Promise<{ url: string }>;
  open(o: { id: string; fileIndex?: number }): Promise<void>;
  defaultDir(): Promise<{ dir: string }>;
  pickDir(): Promise<{ dir: string }>;
  configure(o: Record<string, unknown>): Promise<void>;
  installApk?(o: { path: string }): Promise<void>;
  openUrl?(o: { url: string }): Promise<void>;
  addListener(ev: string, fn: (p: never) => void): Promise<{ remove(): void }>;
}
export function ktPlugin(): KtPlugin | null {
  const p = window.Capacitor?.Plugins?.KurokawaTools as KtPlugin | undefined;
  return p ?? null;
}

/** A listener on a native plugin. Capacitor's bridge gives the handle back either as a promise or directly,
 *  depending on how the plugin was registered: both are taken. */
export async function listen<T>(p: { addListener(ev: string, fn: (d: T) => void): unknown; removeAllListeners?(): unknown }, ev: string, fn: (d: T) => void): Promise<{ remove(): void }> {
  const h = (await Promise.resolve(p.addListener(ev, fn))) as { remove?: () => unknown } | undefined;
  return { remove: () => { try { if (h && typeof h.remove === 'function') void Promise.resolve(h.remove()).catch(() => undefined); } catch { /* gone */ } } };
}

/** Opens a link outside the app (the browser, the system). */
export async function openExternal(url: string): Promise<void> {
  if (window.kurokawaTools?.openExternal) { await window.kurokawaTools.openExternal(url); return; }
  const p = ktPlugin(); if (p?.openUrl) { try { await p.openUrl({ url }); return; } catch { /* below */ } }
  window.open(url, '_blank', 'noopener');
}

/** A folder opened in the system's file manager (the desktop); false where that cannot be done. */
export async function openFolder(path: string): Promise<boolean> { const d = window.kurokawaTools as { openPath?(p: string): Promise<void> } | undefined; if (d?.openPath) { await d.openPath(path); return true; } return false; }
export const canOpenFolder = (): boolean => !!(window.kurokawaTools as { openPath?: unknown } | undefined)?.openPath;
