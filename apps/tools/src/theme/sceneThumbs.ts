// The Appearance picker's thumbnails: each scene drawn ONCE by the engine at a small size — loaded, stepped a moment,
// one frame rendered, let go — and kept as an image for the theme's mode and ground (another mode or theme: drawn
// again). Never a live engine per thumbnail. Without the engine, the scene's sky as a gradient. Loaded lazily.
import { openScene, sceneSky } from './sceneHost';
import { sceneTheme } from './animbg';
import { mixKey } from './sceneMix';

const cache = new Map<string, string>();
const W = 320, H = 200, PX = 1.5;
let queue: Promise<unknown> = Promise.resolve();

/** A thumbnail of scene `id` as an image URL (or a CSS gradient, prefixed «gradient:»), for the theme now. */
export function sceneThumb(id: string): Promise<string> {
  const th = sceneTheme(document.documentElement);
  // (A mix: its contents too — a saved mix changed is drawn again.)
  const key = `${id}|${th.light ? 'l' : 'd'}|${th.ground.map((v) => Math.round(v)).join(',')}${id.startsWith('mix:') ? '|' + mixKey(id.slice(4)) : ''}`;
  const hit = cache.get(key); if (hit) return Promise.resolve(hit);
  // (One at a time, each after a frame: the page stays responsive while a dozen are drawn.)
  const job = queue.then(() => new Promise<void>((r) => requestAnimationFrame(() => r()))).then(async () => {
    const again = cache.get(key); if (again) return again;
    let out: string;
    try {
      const run = await openScene(id, 7, 'thumb');
      try {
        run.thumb = true; run.setTheme(th); run.viewport(W, H); run.step(1000 / 60);
        const cv = document.createElement('canvas'); cv.width = Math.round(W * PX); cv.height = Math.round(H * PX);
        const g = cv.getContext('2d', { alpha: false }); if (!g) throw new Error('no 2d');
        run.render(g, cv.width, cv.height, PX);
        out = cv.toDataURL('image/webp', 0.82); if (!out.startsWith('data:image/webp')) out = cv.toDataURL('image/jpeg', 0.85);
      } finally { run.free(); }
    } catch {
      const stops = sceneSky(id, th.light); out = `gradient:linear-gradient(180deg, ${stops.length ? stops.join(', ') : 'rgb(40 48 72), rgb(20 24 40)'})`;
    }
    cache.set(key, out); return out;
  });
  queue = job.catch(() => undefined);
  return job;
}
