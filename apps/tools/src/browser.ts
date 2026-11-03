// The app's browser (Android: a web view of the app's own, its DNS over HTTPS included; the computer: a window of
// the app's session): sites opened in it, a file a page downloads handed to the Add sheet with the site's cookies,
// page and identity, and «Grab» bringing back what the page links to and the media it loaded, to pick from.
import { ktPlugin, nativePlatform, listen } from './native';

export interface BrowserLink { href: string; text: string; kind: string }
type Ev = { kind: 'download'; url: string; name?: string; referer?: string; ua?: string; cookie?: string } | { kind: 'links'; url: string; title: string; links: BrowserLink[]; ua?: string };
type Bridge = { browse?(o: { url: string }): Promise<unknown>; onBrowser?(cb: (o: Ev) => void): () => void };

export const canBrowse = (): boolean => !!(window.kurokawaTools as unknown as Bridge | undefined)?.browse || nativePlatform() === 'android';
const RECENT = 'kt.browser.recent';
export const recentSites = (): string[] => { try { return JSON.parse(localStorage.getItem(RECENT) ?? '[]') as string[]; } catch { return []; } };
export function openBrowser(url = ''): void {
  if (url) { try { localStorage.setItem(RECENT, JSON.stringify([url, ...recentSites().filter((x) => x !== url)].slice(0, 12))); } catch { /* full */ } }
  const d = window.kurokawaTools as unknown as Bridge | undefined;
  if (d?.browse) { void d.browse({ url }); return; }
  const p = ktPlugin() as unknown as { browse?(o: { url: string }): Promise<void> } | null;
  if (p?.browse) { void p.browse({ url }); return; }
  window.open(url || 'https://duckduckgo.com/', '_blank', 'noopener');
}
let wired = false;
export function startBrowserEvents(): void {
  if (wired) return; wired = true;
  const on = (o: Ev) => {
    if (o.kind === 'download') {
      const headers: Record<string, string> = {}; if (o.referer) headers.Referer = o.referer; if (o.ua) headers['User-Agent'] = o.ua; if (o.cookie) headers.Cookie = o.cookie;
      // (A download whose link ran out waits for a new one from this browser: the first download caught goes to it.)
      const rl = relinkTarget(); if (rl) { clearRelink(); void import('./engine').then(async ({ getEngine }) => { const { toast } = await import('./ui/dom'); const { t } = await import('./i18n'); try { await getEngine().setUrl!(rl.id, o.url, Object.keys(headers).length ? headers : undefined); toast(t('relinked', { name: rl.name })); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }); return; }
      void import('./views/add').then((m) => m.addSheet(o.url, { headers: Object.keys(headers).length ? headers : undefined, name: o.name }));
    } else void import('./downloads/prism').then((m) => m.grabberSheet(o.url, undefined, { links: o.links, title: o.title, ua: o.ua }));
  };
  const d = window.kurokawaTools as unknown as Bridge | undefined;
  if (d?.onBrowser) { d.onBrowser(on); return; }
  const p = ktPlugin(); if (p) void listen<Ev>(p as never, 'browser', on);
}

/* ---------- a new link for a download whose link ran out (signed links: itch.io, cloud storage) ---------- */
const RELINK = 'kt.relink';
type Relink = { id: string; name: string; at: number };
function relinkTarget(): Relink | null { try { const r = JSON.parse(localStorage.getItem(RELINK) ?? 'null') as Relink | null; return r && Date.now() - r.at < 20 * 60000 ? r : null; } catch { return null; } }
function clearRelink(): void { try { localStorage.removeItem(RELINK); } catch { /* blocked */ } }
/** The page the download came from opened in the app's browser; the next download started there gives this one
 *  its new link (and the site's cookies), and it goes on from where it stopped. */
export function relinkFromBrowser(x: { id: string; name: string; source: { url?: string; headers?: Record<string, string> } }): void {
  try { localStorage.setItem(RELINK, JSON.stringify({ id: x.id, name: x.name, at: Date.now() })); } catch { /* blocked */ }
  const ref = x.source.headers?.Referer ?? x.source.headers?.referer; const u = ref && /^https?:/.test(ref) ? ref : x.source.url ?? '';
  void import('./ui/dom').then(async ({ toast }) => { const { t } = await import('./i18n'); toast(t('relinkHint'), 'info', 6000); });
  openBrowser(u);
}
