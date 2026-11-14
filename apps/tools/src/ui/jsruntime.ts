// yt-dlp without a JavaScript runtime (the Tauri shell): YouTube's pages need one since yt-dlp 2025.11 — without it
// formats thin out or vanish. Electron gave yt-dlp its own Node; this shell names one found on the computer, else the
// person is told here ONCE, with the small «deno» component (a pack: fetched from this version's release, checked
// against its SHA-256, kept in the packs folder, removable in Settings → Storage; src-tauri/src/vtools.rs then names
// it to yt-dlp and puts its folder first on yt-dlp's PATH).
import { h, icon, openSheet, toast } from './dom';
import { t } from '../i18n';

const TOLD = 'kt.jsRuntime.told';
let showing = false;
export async function offerDeno(): Promise<void> {
  if (showing) return;
  try { if (localStorage.getItem(TOLD)) return; localStorage.setItem(TOLD, String(Date.now())); } catch { /* told this time only */ }
  showing = true;
  const s = openSheet(t('jsRtTitle'), t('notNow'), { stack: true, onClose: () => { showing = false; } });
  s.el.dataset.jsruntime = 'offer';
  s.body.append(h('p', null, t('jsRtBody')));
  s.actions.prepend(h('button', { type: 'button', class: 'btn primary', 'data-act': 'get-deno', onclick: async () => {
    s.close();
    const { ensurePacks, packLabel } = await import('../packs');
    if (await ensurePacks(['deno'], t('jsRtWhy'), { start: true })) { (await import('../video/ytdlp')).forgetPageInfo(); toast(t('packInstalled', { what: packLabel('deno') })); }
  } }, icon('download'), t('jsRtGet')));
}
