// The app's browser (Android: a web view of the app's own, its DNS over HTTPS included; the computer: a window of
// the app's session): sites opened in it, a file a page downloads handed to the Add sheet with the site's cookies,
// page and identity, and «Grab» bringing back what the page links to and the media it loaded, to pick from.
import { ktPlugin, nativePlatform, listen } from './native';

export interface BrowserLink { href: string; text: string; kind: string; /** What the browser's probe learnt: the content type, the size (estimated for a playlist), a refusal. */ type?: string; size?: number; est?: boolean; status?: number }
type Bridge = { browse?(o: { url: string }): Promise<unknown> };

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
/* ---------- a new link for a download whose link ran out (signed links: itch.io, cloud storage) ---------- */
const RELINK = 'kt.relink';
type Relink = { id: string; name: string; at: number };
export function relinkTarget(): Relink | null { try { const r = JSON.parse(localStorage.getItem(RELINK) ?? 'null') as Relink | null; return r && Date.now() - r.at < 20 * 60000 ? r : null; } catch { return null; } }
export function clearRelink(): void { try { localStorage.removeItem(RELINK); } catch { /* blocked */ } }
/** The page the download came from opened in the app's browser; the next download started there gives this one
 *  its new link (and the site's cookies), and it goes on from where it stopped. */
export function relinkFromBrowser(x: { id: string; name: string; source: { url?: string; headers?: Record<string, string> } }): void {
  // (The way to it kept: replayed — the same pages, the same buttons — instead of being done by hand.)
  void import('./downloads/relink').then((m) => { if (!m.replayTrail(x as never)) relinkByHand(x); });
}
function relinkByHand(x: { id: string; name: string; source: { url?: string; headers?: Record<string, string> } }): void {
  try { localStorage.setItem(RELINK, JSON.stringify({ id: x.id, name: x.name, at: Date.now() })); } catch { /* blocked */ }
  const ref = x.source.headers?.Referer ?? x.source.headers?.referer; const u = ref && /^https?:/.test(ref) ? ref : x.source.url ?? '';
  void import('./ui/dom').then(async ({ toast }) => { const { t } = await import('./i18n'); toast(t('relinkHint'), 'info', 6000); });
  openBrowser(u);
}
