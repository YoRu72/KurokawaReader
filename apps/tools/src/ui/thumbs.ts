// Small pictures in lists (the Videos tab, Files): asked for only when a row comes near the screen, a few at a time
// (a folder of a thousand photos does not ask for a thousand at once), dropped from the queue when the row is scrolled
// past before its turn, kept in memory for the session; a picture that cannot be had leaves the row's icon as it was.
// On a computer — no phone plugin — a picture or a video on the disk is drawn here from the shell's file address: a
// picture scaled down, a video's frame a little way in, a GIF's first frame.
type Job = { el: HTMLElement; key: string; load: () => Promise<string | null>; put: (url: string) => void };
const cache = new Map<string, string>();
const MAX_CACHE = 500, AT_ONCE = 3;
const waiting: Job[] = []; const jobOf = new WeakMap<Element, Job>(); let running = 0;
let io: IntersectionObserver | null = null;
const observer = (): IntersectionObserver => io ??= new IntersectionObserver((es) => {
  for (const e of es) {
    const j = jobOf.get(e.target); if (!j) continue;
    const i = waiting.indexOf(j);
    if (e.isIntersecting) { if (i < 0) { waiting.push(j); pump(); } } else if (i >= 0) waiting.splice(i, 1);
  }
}, { rootMargin: '240px 0px' });
function remember(key: string, url: string): void { cache.delete(key); cache.set(key, url); if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value as string); }
function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const j = waiting.shift()!; io?.unobserve(j.el); jobOf.delete(j.el);
    if (!j.el.isConnected) continue;
    running++;
    void j.load().then((u) => { if (u) { remember(j.key, u); if (j.el.isConnected) j.put(u); } }).catch(() => undefined).finally(() => { running--; pump(); });
  }
}
/** `el`'s picture: at once from memory, else `load`ed when it comes near the screen; `put` places it. */
export function lazyThumb(el: HTMLElement, key: string, load: () => Promise<string | null>, put: (url: string) => void): void {
  const have = cache.get(key); if (have) { put(have); return; }
  const j: Job = { el, key, load, put }; jobOf.set(el, j);
  // (Watched from the next frame: the row is in the page by then.)
  requestAnimationFrame(() => { if (jobOf.get(el) === j) observer().observe(el); });
}
/** An <img> of the picture in `box`, the icon taken out only once it has loaded (a broken one leaves the icon). */
export function placeImg(box: HTMLElement, url: string): void {
  const img = document.createElement('img'); img.alt = ''; img.decoding = 'async'; img.draggable = false;
  img.onload = () => { box.querySelector(':scope > svg')?.remove(); box.classList.add('has-img'); };
  img.onerror = () => img.remove();
  img.src = url; box.prepend(img);
}

/* ---------- a computer's pictures, drawn here ---------- */
const IMG_RE = /\.(jpe?g|png|webp|gif|bmp|avif|ico)$/i; const VID_RE = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
export const pcThumbable = (name: string): boolean => IMG_RE.test(name) || VID_RE.test(name);
const toUrl = (c: HTMLCanvasElement): string | null => { try { return c.toDataURL('image/jpeg', 0.78); } catch { return null; } };
function fit(w: number, hh: number, px: number): [number, number] { const k = Math.min(1, px / Math.max(1, Math.min(w, hh))); return [Math.max(1, Math.round(w * k)), Math.max(1, Math.round(hh * k))]; }
/** A picture (its first frame, for a GIF) or a video's frame from `src` (a file's address), as a small JPEG. */
export function drawThumb(src: string, name: string, px: number): Promise<string | null> {
  return new Promise((res) => {
    const c = document.createElement('canvas'); const g = c.getContext('2d'); if (!g) { res(null); return; }
    let done = false; const end = (u: string | null) => { if (done) return; done = true; clearTimeout(timer); res(u); }; const timer = setTimeout(() => end(null), 15000);
    if (IMG_RE.test(name)) {
      const im = new Image(); im.decoding = 'async';
      im.onload = () => { const [w, hh] = fit(im.naturalWidth, im.naturalHeight, px); c.width = w; c.height = hh; g.drawImage(im, 0, 0, w, hh); end(toUrl(c)); };
      im.onerror = () => end(null); im.src = src; return;
    }
    if (!VID_RE.test(name)) { end(null); return; }
    const v = document.createElement('video'); v.muted = true; v.preload = 'metadata'; v.playsInline = true;
    const stop = () => { v.removeAttribute('src'); v.load(); };
    v.onloadedmetadata = () => { v.currentTime = isFinite(v.duration) && v.duration > 0 ? Math.min(v.duration * 0.1, 30) : 0; };
    v.onseeked = () => { const [w, hh] = fit(v.videoWidth || 320, v.videoHeight || 180, px); c.width = w; c.height = hh; try { g.drawImage(v, 0, 0, w, hh); } catch { /* none */ } stop(); end(toUrl(c)); };
    v.onerror = () => { stop(); end(null); };
    v.src = src;
  });
}
