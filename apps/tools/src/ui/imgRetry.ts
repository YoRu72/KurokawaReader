// A picture the web view could not load (a network that refuses its connection to a picture server, AniList's on
// some): asked once more through the app's own way of reaching sites (src/http.ts: the phone's client, then the web
// view's fetch), and shown from what came. Once a picture; a few at a time; on the phone and the desktop only.
import { request } from '../http';
import { nativePlatform } from '../native';

const busy = new Set<string>(); const queue: HTMLImageElement[] = []; let running = 0;
const failed = new Set<string>(); const made = new Map<string, string>();
const typeOf = (u: string, h: Record<string, string>) => h['content-type'] ?? (/\.png(\?|$)/i.test(u) ? 'image/png' : /\.webp(\?|$)/i.test(u) ? 'image/webp' : /\.gif(\?|$)/i.test(u) ? 'image/gif' : 'image/jpeg');
async function next(): Promise<void> {
  if (running >= 3) return; const img = queue.shift(); if (!img) return; running++;
  const url = img.dataset.ktSrc!;
  try {
    let blob = made.get(url);
    if (!blob) {
      const r = await request(url, { binary: true });
      if (r.status >= 400 || !r.body) throw new Error(String(r.status));
      const bin = atob(r.body); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      blob = URL.createObjectURL(new Blob([bytes], { type: typeOf(url, r.headers) })); made.set(url, blob);
    }
    if (img.isConnected) img.src = blob;
  } catch { failed.add(url); }
  finally { busy.delete(url); running--; void next(); }
}
export function startImgRetry(): void {
  if (nativePlatform() !== 'android' && nativePlatform() !== 'desktop') return;
  document.addEventListener('error', (e) => {
    const img = e.target; if (!(img instanceof HTMLImageElement)) return;
    const url = img.currentSrc || img.src; if (!/^https?:\/\//i.test(url) || img.dataset.ktRetried || failed.has(url)) return;
    img.dataset.ktRetried = '1'; img.dataset.ktSrc = url;
    // (Kept in the page while it is asked again: a picture's own «remove me on error» would take it away first.)
    e.stopImmediatePropagation();
    const had = made.get(url); if (had) { img.src = had; return; }
    if (busy.has(url)) { queue.push(img); return; } busy.add(url); queue.push(img); void next();
  }, true);
}
