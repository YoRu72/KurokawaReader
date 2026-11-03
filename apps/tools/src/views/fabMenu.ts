// The + button's menu, the way Prism and the other download managers do it: the ways to add something, one tap
// each — a link or magnet, whatever is on the clipboard, a .torrent file, a video page (yt-dlp: ready, or where to
// get it), and the links of a page. Opens from the floating button on a phone and the rail's button on a computer.
import { canBrowse } from '../browser';
import { h, icon, toast } from '../ui/dom';
import { t } from '../i18n';
import { nativePlatform } from '../native';
import { getSettings } from '../settings';
import { navigate } from '../router';
import { getEngine, parseSources } from '../engine';
import { addSheet } from './add';
import { canInstallApps, installSheet } from './apk';
import { isIos } from './ipa';
import { videoEnabled, videoSupported, videoVersion } from '../video/ytdlp';

let open: HTMLElement | null = null;

/** The open menu's own closing (the button tapped again closes the menu it opened, not a new one's). */
let closeOpen: (() => void) | null = null;
export function fabMenu(anchor: HTMLElement): void {
  if (open) { closeOpen?.(); return; }
  const eng = getEngine(); const installer = canInstallApps() ? { installSheet } : null;
  const item = (ic: string, label: string, sub: string | null, run: () => void) => h('button', { type: 'button', class: 'fab-item', role: 'menuitem', 'data-act': ic, onclick: () => { close(); run(); } }, h('span', { class: 'fab-item-label' }, h('b', null, label), sub ? h('small', null, sub) : null), h('span', { class: 'fab-item-ic' }, icon(ic)));
  const ytdlp = h('small', null, videoEnabled() ? t('videoYtdlpChecking') : videoSupported() ? t('videoYtdlpMissing') : t('videoYtdlpNotHere'));
  const videoItem = item('film', t('fabVideo'), null, () => void videoEntry());
  videoItem.querySelector('.fab-item-label')!.append(ytdlp);
  const menu = h('div', { class: 'fab-menu', role: 'menu', 'aria-label': t('addDownload') },
    item('link', t('fabLink'), t('fabLinkHint'), () => addSheet()),
    item('copy', t('fabClipboard'), null, () => void fromClipboard()),
    ...(eng.can.torrents ? [item('file', t('pickTorrentFile'), null, () => addSheet('', { pickTorrent: true }))] : []),
    videoItem,
    item('search', t('grabTitle'), t('fabGrabHint'), () => void import('../downloads/prism').then((m) => m.grabberSheet(''))),
    item('puzzle', t('hfTitle'), t('fabModelHint'), () => void import('./models').then((m) => m.modelsSheet())),
    // (Translate on screen, when the add-on is here: its page — the bubble is started from it.)
    ...(nativePlatform() === 'android' && getSettings().addons.includes('screen') ? [item('translate', t('scrTitle'), t('scrFabHint'), () => navigate('/screen'))] : []),
    ...(canBrowse() ? [item('globe', t('browseTitle'), t('browseHint'), () => void import('./browse').then((m) => m.browseSheet()))] : []),
    // (An app from the phone: an APK, a bundle, or an archive with one inside — the installer reads it.)
    // (On an iPhone or iPad: an iOS app — an IPA — looked into and handed to SideStore, AltStore or TrollStore.)
    ...(!installer && isIos() ? [item('apps', t('installIosApp'), t('installIosAppHint'), () => void import('./ipa').then((m) => m.pickIpa()))] : []),
    ...(installer ? [item('apps', t('installAnApp'), t('installAnAppHint'), () => void (async () => { const { pickFiles } = await import('../archives'); const [f] = (await pickFiles(false).catch(() => [] as string[])) ?? []; if (f) await installer.installSheet(f); })())] : []));
  const scrim = h('div', { class: 'fab-scrim', onclick: close });
  open = h('div', { class: 'fab-menu-wrap' }, scrim, menu);
  document.body.append(open); anchor.classList.add('open'); anchor.setAttribute('aria-expanded', 'true');
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  window.addEventListener('keydown', onKey); closeOpen = close;
  // (Scrolled to its end — the items nearest the button — when it is taller than the screen allows.)
  menu.scrollTop = menu.scrollHeight; (menu.lastElementChild as HTMLElement | null)?.focus({ preventScroll: true });
  if (videoEnabled()) void videoVersion().then((v) => { ytdlp.textContent = v ? t('videoYtdlpReady', { v }) : t('videoYtdlpFirstUse'); });
  function close() { open?.remove(); open = null; closeOpen = null; anchor.classList.remove('open'); anchor.setAttribute('aria-expanded', 'false'); window.removeEventListener('keydown', onKey); }
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
  if (!videoSupported()) { toast(t('videoYtdlpNotHereLong'), 'error', 6000); return; }
  const { needAddon } = await import('../addons/need');
  if (await needAddon('video', t('addonWhyVideo'))) addSheet('', { video: true });
}
