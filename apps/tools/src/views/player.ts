// Playing a video: in another app (VLC, MX Player, mpv… on a phone; the system's player on a computer) or in the
// app's own player — the Player add-on, installed on the spot the first time it is chosen. Which one is asked each
// time until a choice is remembered (Settings → Player). The web has only the in-app way.
import { h, icon, iconButton, toast, openSheet } from '../ui/dom';
import { t } from '../i18n';
import { openExternal, ktPlugin, nativePlatform, openFolder } from '../native';
import { getSettings, updateSettings } from '../settings';
import { getEngine, isVideo } from '../engine';
import type { Task } from '../engine/types';

type PlayOpts = { task?: Task; fileIndex?: number; localPath?: string; playlist?: { url: string; name: string; localPath?: string; task?: Task; fileIndex?: number }[]; meta?: Task['meta']; subtitles?: { url: string; name: string; lang?: string; isDefault?: boolean }[] };
export type PlayWith = 'ask' | 'app' | 'external';
export const canPlayExternally = (): boolean => { const p = nativePlatform(); return p === 'android' || p === 'desktop'; };

export async function openPlayer(url: string, name: string, opts: PlayOpts = {}): Promise<void> {
  const how = canPlayExternally() ? await chooseHow() : 'app'; if (!how) return;
  if (how === 'external' && (await external(url, name, opts.localPath))) return;
  if (!getSettings().addons.includes('player')) {
    // (Offered in the download card, with its ffmpeg; declined or offline: the system's own controls this time.)
    const { needAddon } = await import('../addons/need');
    if (!(await needAddon('player', t('addonWhyPlayer')))) { bare(url, name); return; }
  }
  const { openPlayer: full } = await import('../player/player'); full({ url, name, ...opts });
}
/** The question, unless a choice is remembered: another app, or the in-app player (with what it brings). */
function chooseHow(): Promise<'app' | 'external' | null> {
  const pref = getSettings().playerWith; if (pref === 'app' || pref === 'external') return Promise.resolve(pref);
  return new Promise((resolve) => {
    let done = false; const answer = (v: 'app' | 'external' | null) => { if (done) return; done = true; if (v && remember.checked) updateSettings({ playerWith: v }); sh.close(); resolve(v); };
    const sh = openSheet(t('watchWith'), t('close'), { stack: true });
    const has = getSettings().addons.includes('player'); const android = nativePlatform() === 'android';
    const remember = h('input', { type: 'checkbox' }) as HTMLInputElement;
    const choice = (ic: string, title: string, sub: string, v: 'app' | 'external') => h('button', { type: 'button', class: 'watch-choice', onclick: () => answer(v) }, h('span', { class: 'watch-ic' }, icon(ic)), h('span', { class: 'grow' }, h('b', null, title), h('small', null, sub)));
    sh.body.append(h('div', { class: 'watch-choices' },
      choice('play', t('watchInApp'), has ? t('watchInAppHint') : `${t('watchInAppHint')} · ${t('watchInAppGet')}`, 'app'),
      choice('external', t('watchExternal'), android ? t('watchExternalHintAndroid') : t('watchExternalHintDesktop'), 'external')),
      h('label', { class: 'row switch-row' }, h('span', null, t('watchRemember')), remember), h('p', { class: 'hint' }, t('watchChangeLater')));
    const mo = new MutationObserver(() => { if (!sh.el.isConnected) { mo.disconnect(); if (!done) { done = true; resolve(null); } } }); mo.observe(document.body, { childList: true, subtree: true });
  });
}
/** Handed to another app: the phone's chooser (the file itself, or the local stream while it comes), or the
 *  computer's default player for a file. False when there is no way, so the in-app player takes it. */
async function external(url: string, name: string, localPath?: string): Promise<boolean> {
  const p = ktPlugin() as unknown as { openWith?(o: { url?: string; path?: string; mime: string; title: string }): Promise<void> } | null;
  try {
    if (p?.openWith) { await p.openWith({ url: localPath ? undefined : url, path: localPath, mime: 'video/*', title: name }); return true; }
    if (localPath && (await openFolder(localPath))) return true;
    if (window.kurokawaTools) { await openExternal(url); return true; }
  } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
  return false;
}
/** The browser's own <video> (when the Player add-on cannot be fetched). */
function bare(url: string, name: string): void {
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
