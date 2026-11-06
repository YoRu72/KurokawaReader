// The computer's app comes ready: every add-on (with its sources), the player and ffmpeg installed on its first start
// — or the first start after this was added —, in the background, the usual card showing the packs coming. Debrid is
// left to be chosen (it needs a paid account). Done once; what failed (offline) is tried again at the next start.
import { nativePlatform } from './native';
import { getSettings } from './settings';

const DONE = 'kt.pc.starter';
const WANT = ['torrent-search', 'anime', 'tv', 'subtitles', 'video', 'player', 'files', 'archives', 'courses', 'screen'];

export function startDesktopStarter(): void {
  if (nativePlatform() !== 'desktop') return;
  try { if (localStorage.getItem(DONE) === '1') return; } catch { return; }
  window.setTimeout(() => void run(), 4000);
}
async function run(): Promise<void> {
  const { install, loadIndex } = await import('./addons');
  let ix; try { ix = await loadIndex(); } catch { return; }
  let ok = true;
  for (const id of WANT) {
    const e = ix.addons.find((a) => a.id === id); if (!e || (e.platforms && !e.platforms.includes('desktop'))) continue;
    if (getSettings().addons.includes(id) && !(e.children ?? []).some((k) => !getSettings().addons.includes(k))) continue;
    try { await install(id); } catch { ok = false; }
  }
  if (ok) try { localStorage.setItem(DONE, '1'); } catch { /* private */ }
}
