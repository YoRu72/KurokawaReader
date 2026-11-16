// The player never leaves a silent black screen without a word (loaded after the first «playing», so the start is
// not slowed). Counted only while the page is seen (a hidden or minimised window, a phone playing in the background:
// frames are not drawn then, so nothing is counted, and the count starts again when it is seen); once the video has
// played three seconds of its own time in view:
//   · the picture: the stream has a size (videoWidth) but not one frame was drawn while the time ran on
//     (requestVideoFrameCallback never called, else getVideoPlaybackQuality's totalVideoFrames 0) — not while the app
//     is converting the picture itself — the file looks damaged: a sheet with «Open in another player» and, for a
//     download, «Download again»;
//   · the sound, once the app has settled how it plays it (its probe done, the sound played beside the video ready):
//     «This file has no audio track» only when a track list says so (the probe, Firefox's mozHasAudio, audioTracks,
//     mpv's tracks); «No sound could be played from this file» when Chromium decoded no audio
//     (webkitAudioDecodedByteCount still 0) and nothing says why — a small notice, the video goes on.
// Not reliable, and so not tried: frames that decode to grey or garbage (they count as frames); the picture on the
// phone's mpv engine (mpv draws on its own surface) — only its audio track list is read there.
import { h, icon, openSheet } from '../ui/dom';
import { t } from '../i18n';

type V = Omit<HTMLVideoElement, 'requestVideoFrameCallback' | 'cancelVideoFrameCallback'> & { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; audioTracks?: { length: number }; requestVideoFrameCallback?(cb: () => void): number; cancelVideoFrameCallback?(h: number): void };
export interface HealthOpts {
  name: string;
  /** How the app plays the sound: still settling (probe running, the sound beside starting, the picture being
   *  converted), and the audio tracks the probe found (null: not known). */
  sound(): { busy: boolean; tracks: number | null };
  /** The app is converting the picture itself (no verdict on the picture then). */
  pictureBusy(): boolean;
  mpvTracks?(): { type: string }[] | null;
  onNoAudio(kind: 'none' | 'unplayable'): void; onNoPicture(): void; seconds?: number;
}

/** Watches; returns the function that stops it (the player's close). Each problem is told once. */
export function watchHealth(video: V, o: HealthOpts): () => void {
  const need = o.seconds ?? 3; let from = video.currentTime; let frames = 0; let rvfc = 0;
  let pictureDone = false; let soundDone = false; let gone = false;
  const audioName = /\.(mp3|m4a|aac|flac|ogg|opus|wav|wma|mka)$/i.test(o.name);
  const count = () => { if (gone) return; if (!document.hidden) frames++; if (video.requestVideoFrameCallback) rvfc = video.requestVideoFrameCallback(count); };
  if (video.requestVideoFrameCallback) rvfc = video.requestVideoFrameCallback(count);
  const restart = () => { from = video.currentTime; frames = 0; };
  const onVis = () => restart();
  const check = () => {
    if (gone || document.hidden || video.paused || video.currentTime - from < need) return;
    const mt = o.mpvTracks?.();
    if (mt) { pictureDone = true; if (!soundDone) { soundDone = true; if (!mt.some((x) => x.type === 'audio')) o.onNoAudio('none'); } }
    if (!pictureDone && !o.pictureBusy()) {
      pictureDone = true;
      const decoded = video.requestVideoFrameCallback ? frames : (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 1);
      if (!audioName && video.videoWidth > 0 && decoded === 0) { soundDone = true; o.onNoPicture(); }
    }
    if (!soundDone) {
      const st = o.sound();
      if (!st.busy) {
        soundDone = true;
        const listed = st.tracks === 0 || video.mozHasAudio === false || (video.audioTracks !== undefined && video.audioTracks.length === 0);
        if (listed) o.onNoAudio('none');
        else if (typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount === 0) o.onNoAudio('unplayable');
      }
    }
    if (pictureDone && soundDone) stop();
  };
  const onSeek = () => restart();
  video.addEventListener('timeupdate', check); video.addEventListener('seeked', onSeek); document.addEventListener('visibilitychange', onVis);
  function stop() { gone = true; video.removeEventListener('timeupdate', check); video.removeEventListener('seeked', onSeek); document.removeEventListener('visibilitychange', onVis); if (rvfc && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfc); rvfc = 0; }
  return stop;
}

/** A file the player cannot show: damaged (the picture does not decode) or a kind this player cannot open here. */
export function problemSheet(kind: 'damaged' | 'format', o: { openWith(): void; redownload?(): void; detail?: string }): void {
  const sh = openSheet(kind === 'damaged' ? t('fileDamagedTitle') : t('fileFormatTitle'), t('close'), { stack: true });
  sh.body.classList.add('kt-problem');
  sh.body.append(h('p', { class: 'kt-problem-msg' }, kind === 'damaged' ? t('fileDamaged') : t('fileFormat')), o.detail ? h('p', { class: 'hint', dir: 'ltr' }, o.detail) : '',
    h('div', { class: 'ext-error-actions' },
      h('button', { type: 'button', class: 'btn primary', onclick: () => { sh.close(); o.openWith(); } }, icon('external'), t('openWithPlayer')),
      o.redownload ? h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); o.redownload!(); } }, icon('refresh'), t('redownload')) : ''));
}
