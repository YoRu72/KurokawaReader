// A simple player for what the browser's <video> can play (MP4, WebM, and a stream of either) — full screen,
// the system's controls, picture-in-picture where it exists. The full player (libmpv, every format,
// subtitles, gestures) comes as the player add-on; a file the browser cannot play is handed to the system.
import { h, iconButton, toast } from '../ui/dom';
import { t } from '../i18n';
import { openExternal } from '../native';

export function openPlayer(url: string, name: string): void {
  const video = h('video', { src: url, controls: true, autoplay: true, playsinline: true, class: 'kt-video' }) as HTMLVideoElement;
  const root = h('div', { class: 'player-view', role: 'dialog', 'aria-label': name },
    h('div', { class: 'player-bar' }, iconButton('back', t('back'), close), h('span', { class: 'grow', dir: 'auto' }, name)), video);
  function close() { video.pause(); video.removeAttribute('src'); video.load(); root.remove(); }
  video.addEventListener('error', () => { toast(t('stateFailed'), 'error'); close(); void openExternal(url); });
  document.body.append(root);
}
