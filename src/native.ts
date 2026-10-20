// Native bridges: files handed to the app by the OS (Android "Open with",
// iOS share sheet, Electron file associations) are imported into the library
// and opened straight away. Everything here is optional at runtime — the plain
// web build simply has none of these globals.
import { importFiles } from './library';
import { navigate } from './router';
import { toast } from './ui/dom';
import { t } from './i18n';

interface CapApp { addListener(ev: 'appUrlOpen', fn: (d: { url: string }) => void): Promise<unknown>; getLaunchUrl(): Promise<{ url?: string } | null> }
interface CapFs { readFile(o: { path: string }): Promise<{ data: string | Blob }> }
interface CapGlobal { isNativePlatform?(): boolean; getPlatform?(): string; Plugins?: { App?: CapApp; Filesystem?: CapFs } }
interface DesktopBridge { onOpenFile(cb: (p: { name: string; data: ArrayBuffer }) => void): void; platform: string }

declare global { interface Window { Capacitor?: CapGlobal; kurokawaDesktop?: DesktopBridge } }

export function isNative(): boolean { return !!window.Capacitor?.isNativePlatform?.() || !!window.kurokawaDesktop; }
export function nativePlatform(): string { return window.kurokawaDesktop ? 'desktop' : window.Capacitor?.getPlatform?.() ?? 'web'; }

function base64ToBlob(b64: string): Blob {
  const bin = atob(b64);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr]);
}

async function openIncoming(file: File): Promise<void> {
  const added = await importFiles([file], (book, f, err) => { if (!book) toast(t('importFailed', { name: f.name, error: String((err as Error)?.message ?? err) }), 'error', 5000); });
  if (added.length) navigate(`/read/${added.map((b) => b.id).join(',')}`);
}

async function handleUrl(url: string): Promise<void> {
  if (!/^(content|file):/i.test(url)) return;
  const fs = window.Capacitor?.Plugins?.Filesystem;
  if (!fs) return;
  try {
    const res = await fs.readFile({ path: url });
    const blob = typeof res.data === 'string' ? base64ToBlob(res.data) : res.data;
    let name = decodeURIComponent(url.split('?')[0].split('/').pop() ?? '');
    if (!name || !/\.[a-z0-9]{2,5}$/i.test(name)) name = (name || 'document') + '.bin';
    await openIncoming(new File([blob], name));
  } catch (err) {
    toast(t('openError', { error: String((err as Error)?.message ?? err) }), 'error', 5000);
  }
}

export function initNativeBridges(): void {
  const cap = window.Capacitor;
  if (cap?.isNativePlatform?.() && cap.Plugins?.App) {
    void cap.Plugins.App.addListener('appUrlOpen', (d) => void handleUrl(d.url));
    void cap.Plugins.App.getLaunchUrl().then((d) => { if (d?.url) void handleUrl(d.url); }).catch(() => undefined);
  }
  if (window.kurokawaDesktop) {
    window.kurokawaDesktop.onOpenFile((p) => void openIncoming(new File([p.data], p.name)));
  }
}
