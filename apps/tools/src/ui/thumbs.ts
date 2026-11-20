// Small pictures in lists (the Videos tab, Files): asked for only when a row comes near the screen, a few at a time
// (a folder of a thousand photos does not ask for a thousand at once), dropped from the queue when the row is scrolled
// past before its turn, kept in memory for the session; a picture that cannot be had leaves the row's icon as it was.
// On a computer — no phone plugin — a picture or a video on the disk is drawn here from the shell's file address: a
// picture scaled down, a video's frame a little way in, a GIF's first frame.
type Job = { el: HTMLElement; key: string; load: () => Promise<string | null>; put: (url: string) => void };
const cache = new Map<string, string>();
// (Kept by size, not by count: a picture is held as its data address, some tens of KB each — a budget of bytes, smaller
// on a phone that says it has little memory, the oldest let go first.)
const MAX_CACHE = 500, AT_ONCE = 3;
const BUDGET = (((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8) <= 3 ? 3 : 6) * 1048576; let held = 0;
const waiting: Job[] = []; const jobOf = new WeakMap<Element, Job>(); let running = 0;
let io: IntersectionObserver | null = null;
const observer = (): IntersectionObserver => io ??= new IntersectionObserver((es) => {
  for (const e of es) {
    const j = jobOf.get(e.target); if (!j) continue;
    const i = waiting.indexOf(j);
    if (e.isIntersecting) { if (i < 0) { waiting.push(j); pump(); } } else if (i >= 0) waiting.splice(i, 1);
  }
}, { rootMargin: '240px 0px' });
function remember(key: string, url: string): void {
  const had = cache.get(key); if (had !== undefined) { held -= had.length; cache.delete(key); }
  cache.set(key, url); held += url.length;
  while (cache.size > 1 && (cache.size > MAX_CACHE || held > BUDGET)) { const k = cache.keys().next().value as string; held -= cache.get(k)!.length; cache.delete(k); }
}
function pump(): void {
  while (running < AT_ONCE && waiting.length) {
    const j = waiting.shift()!; io?.unobserve(j.el); jobOf.delete(j.el);
    if (!j.el.isConnected) continue;
    running++;
    void j.load().then((u) => { if (u) { remember(j.key, u); if (j.el.isConnected) j.put(u); } }).catch(() => undefined).finally(() => { running--; pump(); });
  }
}
/** Files renamed: their pictures kept in memory follow them (the key holds the path), not asked for again. */
export function moveThumbs(pairs: [string, string][]): void {
  if (!pairs.length || !cache.size) return; const to = new Map(pairs);
  for (const [k, v] of [...cache]) { const m = /^f:(.*):(\d+):(-?\d+):(\d+)$/.exec(k); if (!m) continue; const np = to.get(m[1]); if (np) { cache.delete(k); cache.set(`f:${np}:${m[2]}:${m[3]}:${m[4]}`, v); } }
}
/** The pictures of the rows inside `box` no longer asked for (the rows taken out of the page): not watched, not waiting. */
export function dropThumbs(box: Element): void {
  if (!io || !box.firstElementChild) return;
  for (const el of box.querySelectorAll('[data-thumb]')) { const j = jobOf.get(el); if (!j) continue; io.unobserve(el); jobOf.delete(el); const i = waiting.indexOf(j); if (i >= 0) waiting.splice(i, 1); }
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
