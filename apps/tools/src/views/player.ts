// Playing a video: the full player (the Player add-on) when installed — controls, gestures, subtitles, clips —
// else the browser's own <video> with its controls; a file the browser cannot decode is handed to the system.
import { h, iconButton, toast } from '../ui/dom';
import { t } from '../i18n';
import { openExternal } from '../native';
import { getSettings } from '../settings';
import { getEngine, isVideo } from '../engine';
import type { Task } from '../engine/types';

export async function openPlayer(url: string, name: string, opts: { task?: Task; fileIndex?: number; localPath?: string; playlist?: { url: string; name: string; localPath?: string; task?: Task; fileIndex?: number }[] } = {}): Promise<void> {
  if (getSettings().addons.includes('player')) { const { openPlayer: full } = await import('../player/player'); full({ url, name, ...opts }); return; }
  const video = h('video', { src: url, controls: true, autoplay: true, playsinline: true, class: 'kt-video' }) as HTMLVideoElement;
  const root = h('div', { class: 'player-view', role: 'dialog', 'aria-label': name },
    h('div', { class: 'player-bar' }, iconButton('back', t('back'), close), h('span', { class: 'grow', dir: 'auto' }, name)), video);
  function close() { video.pause(); video.removeAttribute('src'); video.load(); root.remove(); }
  video.addEventListener('error', () => { toast(t('stateFailed'), 'error'); close(); void openExternal(url); });
  document.body.append(root);
}
/** A task's file in the player: streamed while it comes, or the finished file from disk; the task's other videos as the playlist. */
export async function playTaskFile(x: Task, fileIndex: number): Promise<void> {
  const eng = getEngine(); const f = x.files.find((g) => g.index === fileIndex) ?? x.files[0]; const name = f?.path.split('/').pop() ?? x.name;
  const localOf = (g: { path: string }) => (x.dir && !x.dir.startsWith('content:') ? `${x.dir.replace(/[\\/]$/, '')}/${x.kind === 'torrent' && x.files.length > 1 ? `${x.name}/` : ''}${g.path}`.replace(/\/+/g, '/') : undefined);
  const { localFileUrl } = await import('../player/files');
  const urlOf = async (g: { index: number; path: string; done: number; size: number }) => { const lp = localOf(g); if (x.state === 'done' && lp) { const u = await localFileUrl(lp); if (u) return u; } if (eng.streamUrl) return eng.streamUrl(x.id, g.index); return null; };
  const url = f ? await urlOf(f) : null; if (!url) { if (eng.open) await eng.open(x.id, fileIndex); else toast(t('playerCantPlay'), 'error'); return; }
  const vids = x.files.filter((g) => isVideo(g.path) && g.priority > 0);
  const playlist = vids.length > 1 ? await Promise.all(vids.map(async (g) => ({ url: (await urlOf(g)) ?? '', name: g.path.split('/').pop() ?? g.path, localPath: localOf(g), task: x, fileIndex: g.index }))) : undefined;
  await openPlayer(url, name, { task: x, fileIndex, localPath: x.state === 'done' ? localOf(f) : undefined, playlist: playlist?.filter((p) => p.url) });
}
