// The + button's menu, the way Prism and the other download managers do it: the ways to add something, one tap
// each — a link or magnet, whatever is on the clipboard, a .torrent file, a video page (yt-dlp: ready, or where to
// get it), and the links of a page. Opens from the floating button on a phone and the rail's button on a computer.
import { h, icon, toast, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { navigate } from '../router';
import { getEngine, parseSources } from '../engine';
import { addSheet } from './add';
import { videoEnabled, videoSupported, videoVersion } from '../video/ytdlp';

let open: HTMLElement | null = null;
export function fabMenu(anchor: HTMLElement): void {
  if (open) { close(); return; }
  const eng = getEngine();
  const item = (ic: string, label: string, sub: string | null, run: () => void) => h('button', { type: 'button', class: 'fab-item', role: 'menuitem', onclick: () => { close(); run(); } }, h('span', { class: 'fab-item-label' }, h('b', null, label), sub ? h('small', null, sub) : null), h('span', { class: 'fab-item-ic' }, icon(ic)));
  const ytdlp = h('small', null, videoEnabled() ? t('videoYtdlpChecking') : videoSupported() ? t('videoYtdlpMissing') : t('videoYtdlpNotHere'));
  const videoItem = item('film', t('fabVideo'), null, () => void videoEntry());
  videoItem.querySelector('.fab-item-label')!.append(ytdlp);
  const menu = h('div', { class: 'fab-menu', role: 'menu', 'aria-label': t('addDownload') },
    item('link', t('fabLink'), t('fabLinkHint'), () => addSheet()),
    item('copy', t('fabClipboard'), null, () => void fromClipboard()),
    ...(eng.can.torrents ? [item('file', t('pickTorrentFile'), null, () => addSheet('', { pickTorrent: true }))] : []),
    videoItem,
    item('search', t('grabTitle'), t('fabGrabHint'), () => void import('../downloads/prism').then((m) => m.grabberSheet(''))));
  const scrim = h('div', { class: 'fab-scrim', onclick: close });
  open = h('div', { class: 'fab-menu-wrap' }, scrim, menu);
  document.body.append(open); anchor.classList.add('open'); anchor.setAttribute('aria-expanded', 'true');
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  window.addEventListener('keydown', onKey);
  (menu.firstElementChild as HTMLElement | null)?.focus();
  if (videoEnabled()) void videoVersion().then((v) => { ytdlp.textContent = v ? t('videoYtdlpReady', { v }) : t('videoYtdlpFirstUse'); });
  function close() { open?.remove(); open = null; anchor.classList.remove('open'); anchor.setAttribute('aria-expanded', 'false'); window.removeEventListener('keydown', onKey); }
}
async function fromClipboard(): Promise<void> {
  let text = '';
  try { const d = window.kurokawaTools as unknown as { clipboardText?(): Promise<string> } | undefined; text = d?.clipboardText ? await d.clipboardText() : await navigator.clipboard.readText(); } catch { /* not allowed */ }
  if (!text || !parseSources(text).length) { toast(t('nothingToPaste'), 'error'); addSheet(); return; }
  addSheet(text);
}
/** A video page: straight to the Add sheet when yt-dlp is here; otherwise what to do — install it now, or see it
 *  in Settings → Add-ons. */
async function videoEntry(): Promise<void> {
  if (videoEnabled()) { addSheet('', { video: true }); return; }
  const sh = openSheet(t('fabVideo'), t('close'));
  if (!videoSupported()) { sh.body.append(h('p', null, t('videoYtdlpNotHereLong'))); return; }
  sh.body.append(h('div', { class: 'empty small' }, h('div', { class: 'glyph' }, icon('film')), h('p', null, t('videoYtdlpMissingLong'))));
  const get = h('button', { type: 'button', class: 'btn primary' }, icon('download'), t('videoAddIt')) as HTMLButtonElement;
  get.addEventListener('click', async () => { get.disabled = true; try { const { install } = await import('../addons'); await install('video'); toast(t('addonInstalledToast', { name: t('videoKind') })); sh.close(); addSheet('', { video: true }); } catch (e) { toast(String((e as Error).message ?? e), 'error'); get.disabled = false; } });
  sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); navigate('/settings/addons'); } }, icon('settings'), t('videoOpenAddons')), get);
}
