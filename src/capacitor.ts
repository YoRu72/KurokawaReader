// Capacitor 3+ only puts a plugin on `Capacitor.Plugins` once something calls
// `registerPlugin(name)`; the native side announces what it has in
// `Capacitor.PluginHeaders`. Nothing in this app imports the plugins' JS
// packages, so register every announced plugin up front — otherwise none of
// the native features (share, gallery, PDF renderer, open-with…) are reachable.
interface CapRuntime {
  isNativePlatform?(): boolean;
  PluginHeaders?: { name: string }[];
  Plugins?: Record<string, unknown>;
  registerPlugin?(name: string): unknown;
}

export function registerNativePlugins(): void {
  const cap = (window as unknown as { Capacitor?: CapRuntime }).Capacitor;
  if (!cap?.isNativePlatform?.() || !cap.registerPlugin) return;
  cap.Plugins = cap.Plugins ?? {};
  for (const h of cap.PluginHeaders ?? []) {
    if (!cap.Plugins[h.name]) { try { cap.registerPlugin(h.name); } catch (e) { console.warn('[kurokawa] registerPlugin failed', h.name, e); } }
  }
  console.info('[kurokawa] native plugins:', Object.keys(cap.Plugins).join(', '));
}
