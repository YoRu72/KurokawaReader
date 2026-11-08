declare const __APP_VERSION__: string;
declare const __REPO_SLUG__: string;
declare module '*.css';
interface Window {
  /** The desktop app's bridge (Electron preload). */
  kurokawaTools?: import('./engine/desktop').DesktopBridge;
  Capacitor?: { isNativePlatform?(): boolean; getPlatform?(): string; Plugins?: Record<string, unknown>; registerPlugin?(name: string): unknown; PluginHeaders?: { name: string }[] };
  __ktInstallPrompt?: { prompt(): Promise<void> };
}
declare module '*.woff2' { const url: string; export default url; }
