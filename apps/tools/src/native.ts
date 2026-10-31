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

/** Opens a link outside the app (the browser, the system). */
export async function openExternal(url: string): Promise<void> {
  if (window.kurokawaTools?.openExternal) { await window.kurokawaTools.openExternal(url); return; }
  const p = ktPlugin(); if (p?.openUrl) { try { await p.openUrl({ url }); return; } catch { /* below */ } }
  window.open(url, '_blank', 'noopener');
}
