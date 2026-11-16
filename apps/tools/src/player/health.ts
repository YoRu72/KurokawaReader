// The player never leaves a silent black screen without a word (loaded after the first «playing», so the start is
// not slowed). Once the video has played three seconds of its own time:
//   · no sound: the file has no audio track — Firefox's mozHasAudio, Chromium's webkitAudioDecodedByteCount still 0
//     (it counts while muted too), audioTracks where the engine has them, mpv's own track list; not when the sound
//     comes from beside (the app plays an AC-3 / DTS track by ffmpeg next to the muted video) — a small notice, the
//     video goes on;
//   · no picture: the stream has a size (videoWidth) but not one frame was decoded while the time ran on
//     (requestVideoFrameCallback never called, else getVideoPlaybackQuality's totalVideoFrames 0) — the file looks
//     damaged: a sheet with «Open in another player» and, for a download, «Download again».
// Not reliable, and so not tried: frames that decode to grey or garbage (they count as frames); on the phone's mpv
// engine the picture (mpv draws on its own surface) — only the audio track list is read there.
import { h, icon, openSheet } from '../ui/dom';
import { t } from '../i18n';

type V = Omit<HTMLVideoElement, 'requestVideoFrameCallback' | 'cancelVideoFrameCallback'> & { mozHasAudio?: boolean; webkitAudioDecodedByteCount?: number; audioTracks?: { length: number }; requestVideoFrameCallback?(cb: () => void): number; cancelVideoFrameCallback?(h: number): void };
export interface HealthOpts { name: string; soundBeside(): boolean; mpvTracks?(): { type: string }[] | null; onNoAudio(): void; onNoPicture(): void; seconds?: number }

/** Watches; returns the function that stops it (the player's close). Each problem is told once. */
export function watchHealth(video: V, o: HealthOpts): () => void {
  const need = o.seconds ?? 3; let from = video.currentTime; let frames = 0; let rvfc = 0; let done = false;
  const audioName = /\.(mp3|m4a|aac|flac|ogg|opus|wav|wma|mka)$/i.test(o.name);
  const count = () => { frames++; if (!done && video.requestVideoFrameCallback) rvfc = video.requestVideoFrameCallback(count); };
  if (video.requestVideoFrameCallback) rvfc = video.requestVideoFrameCallback(count);
  const check = () => {
    if (done || video.paused || video.currentTime - from < need) return;
    done = true; stop();
    const mt = o.mpvTracks?.();
    if (mt) { if (!mt.some((x) => x.type === 'audio')) o.onNoAudio(); return; }
    const decoded = video.requestVideoFrameCallback ? frames : (video.getVideoPlaybackQuality?.().totalVideoFrames ?? 1);
    if (!audioName && video.videoWidth > 0 && decoded === 0) { o.onNoPicture(); return; }
    if (!o.soundBeside() && (video.mozHasAudio === false || (video.audioTracks !== undefined && video.audioTracks.length === 0) || (typeof video.webkitAudioDecodedByteCount === 'number' && video.webkitAudioDecodedByteCount === 0))) o.onNoAudio();
  };
  const onSeek = () => { from = video.currentTime; };
  video.addEventListener('timeupdate', check); video.addEventListener('seeked', onSeek);
  function stop() { video.removeEventListener('timeupdate', check); video.removeEventListener('seeked', onSeek); if (rvfc && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(rvfc); rvfc = 0; }
  return () => { done = true; stop(); };
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
