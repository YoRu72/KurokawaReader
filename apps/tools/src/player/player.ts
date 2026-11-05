// The video player (the Player add-on): the browser's decoder with the controls and gestures of REX Player and
// VLC around it.
//   Gestures — taps (each side's and the middle's double tap chosen: seek, play/pause, chapter, nothing; seeks
//   adding up while tapped again), swipes for seek / volume / brightness (sides swappable, the swipe's reach
//   set), a long press for speed (a swipe while held changing it, the speed remembered), pinch zoom and pan.
//   Controls — a seek bar with previews of the time under the finger, chapters, bookmarks and the A/B marks; the
//   remaining time; a clock; how long they stay; a lock.
//   Playback — speed presets and fine steps, frame steps at the video's own rate, A/B repeat, repeat one / all,
//   shuffle, a playlist, jump to a time, bookmarks, a sleep timer, the position remembered, the next file, closing
//   at the end, picture-in-picture, casting where the system offers it, the system's media controls.
//   Picture — aspect modes, crop ratios, rotation and mirroring, filters (brightness, contrast, saturation, hue,
//   gamma, sharpness, colour temperature) and presets of them, the ambient glow, screenshots.
//   Sound — volume past 100%, VLC's 10-band equaliser and its presets, loudness evened out, mono, balance, the
//   sound delayed against the picture, the video's audio tracks where the browser lists them.
//   Subtitles — SRT/VTT/ASS (libass when bundled), size, colours, outline, background, italic, position, a second
//   track on top, delay, timing stretched, line by line seeking, VLC's two-tap sync, files beside the video,
//   the Subtitles add-on's search, preferred languages.
//   And: openings/endings skipped (AniSkip, chapters), the episode marked watched on AniList, the A/B range cut to
//   a file through ffmpeg, another player.
import { getSettings } from '../settings';
import { h, icon, iconButton, toast, openSheet, pickButton, onLongPress } from '../ui/dom';
import { t, localDigits, formatBytes } from '../i18n';
import type { Task } from '../engine/types';
import { getPrefs, updatePrefs, memoryOf, remember, DEFAULT_FILTERS, DEFAULT_PREFS, type PlayerPrefs, type Bookmark, type TapAction } from './prefs';
import { parseCues, cuesAt, sniffFormat, decodeSubtitle, createAssRenderer, langOfTrack, cuesToSrt, type Cue, type AssRenderer } from './subs';
import { request } from '../http';
import { ktPlugin } from '../native';
import { siblingFiles, readLocal } from './files';
import { SoundGraph, EQ_FREQS, EQ_PRESETS, presetValues } from './audio';
import { Picture, FILTER_PRESETS, CROPS } from './vfx';
import { SeekPreview } from './thumbs';
import { mpvVideo, mpvDone, type MpvControl } from './mpv';
/** Two-letter language codes and the three-letter ones files often carry (mpv matches either). */
const ISO3: Record<string, string> = { ar: 'ara', en: 'eng', ja: 'jpn', fr: 'fre,fra', de: 'ger,deu', es: 'spa', it: 'ita', pt: 'por', ru: 'rus', zh: 'chi,zho', ko: 'kor', tr: 'tur', fa: 'per,fas', ur: 'urd', hi: 'hin', id: 'ind', ms: 'may,msa', th: 'tha', vi: 'vie', nl: 'dut,nld', pl: 'pol', uk: 'ukr', sv: 'swe', he: 'heb' };
/** The decoder's choices as mpv's options. */
export const mpvExtra = (P: PlayerPrefs): Record<string, string> => {
  // (hw: MediaCodec through the GPU (copy) — the safe path; direct: MediaCodec straight to the surface with the «embed» vo (no subtitles drawn by mpv, the fastest on weak phones); sw: software.)
  const o: Record<string, string> = { hwdec: P.hwdec === 'sw' ? 'no' : P.hwdec === 'direct' ? 'mediacodec' : 'mediacodec-copy', deband: P.deband ? 'yes' : 'no', 'audio-channels': P.audioChannels === 'stereo' ? 'stereo' : 'auto-safe', vo: P.hwdec === 'direct' ? 'mediacodec_embed' : P.gpuNext ? 'gpu-next' : 'gpu' };
  // (The reader's own mpv.conf lines, «key=value», last — they win over the choices above; comments and blanks skipped.)
  for (const line of (P.mpvConf ?? '').split('\n')) { const l = line.trim(); if (!l || l.startsWith('#')) continue; const i = l.indexOf('='); if (i <= 0) { o[l] = 'yes'; continue; } o[l.slice(0, i).trim()] = l.slice(i + 1).trim(); }
  return o;
};
const nativePlatformIs = (p: string): boolean => { const c = (window as unknown as { Capacitor?: { getPlatform?(): string } }).Capacitor; const k = (window as unknown as { kurokawaTools?: unknown }).kurokawaTools; return p === 'desktop' ? !!k : p === 'web' ? !k && (!c || c.getPlatform?.() === 'web') : c?.getPlatform?.() === p; };
const VIDEO_EXT = /\.(mkv|mp4|m4v|webm|avi|mov|wmv|flv|ts|m2ts|mpg|mpeg|ogv|3gp)$/i;

export interface PlayerSource { url: string; name: string; task?: Task; fileIndex?: number; localPath?: string; headers?: Record<string, string>; playlist?: PlayerSource[];
  /** Which engine plays it: mpv (the Player add-on's, on Android with its pack) or the web view's own. */
  engine?: 'mpv' | 'web';
  /** The show and episode when it is not a download's (an online source): for tracking, AniSkip, subtitles. */
  meta?: Task['meta'];
  /** Subtitles that come with an online source. */
  subtitles?: { url: string; name: string; lang?: string; isDefault?: boolean }[];
  /** Opened by another app (Android's «Kurokawa Player»): where it asked to start, and whether it wants the position back when the player closes. */
  startAt?: number; forCaller?: boolean }
interface SubTrack { id: string; name: string; lang?: string; cues: Cue[]; ass?: string; fmt: string }

const fmtTime = (s: number): string => { if (!isFinite(s)) return '–:––'; s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits((h ? `${h}:${String(m).padStart(2, '0')}:` : `${m}:`) + String(sec).padStart(2, '0')); };
/** «1:02:03», «62:03», «3723», «1h2m3s» → seconds. */
export function parseTime(s: string): number | null {
  const x = s.trim().replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))); if (!x) return null;
  const hms = /^(?:(\d+)h)?\s*(?:(\d+)m)?\s*(?:(\d+(?:\.\d+)?)s)?$/i.exec(x); if (hms && (hms[1] || hms[2] || hms[3])) return Number(hms[1] ?? 0) * 3600 + Number(hms[2] ?? 0) * 60 + Number(hms[3] ?? 0);
  const parts = x.split(':').map(Number); if (parts.some((n) => !isFinite(n))) return null;
  return parts.reduce((a, n) => a * 60 + n, 0);
}

export function openPlayer(src: PlayerSource): void {
  const P = getPrefs(); const key = src.localPath ?? src.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'stream:');
  // (mpv when it is here — every codec, the file's own subtitles —, else the web view's <video>; the player is the same.)
  const slang = (getSettings().subLangs ?? []).flatMap((l) => [l, ISO3[l] ?? '']).filter(Boolean).join(',');
  const video = (src.engine === 'mpv' ? mpvVideo(src.localPath ?? src.url, { start: src.startAt ? src.startAt : memoryOf(key)?.pos && P.resume === 'always' ? memoryOf(key)!.pos : 0, slang, alang: P.audioLangs.flatMap((l) => [l, ISO3[l] ?? '']).filter(Boolean).join(','), speed: P.defaultSpeed, headers: src.headers, extra: mpvExtra(P) }) : h('video', { playsinline: true, preload: 'auto', class: 'kt-video', crossorigin: 'anonymous' })) as HTMLVideoElement;
  const mpv: MpvControl | null = (video as HTMLVideoElement & { _mpv?: MpvControl })._mpv ?? null;
  const stage = h('div', { class: 'kt-stage' }, video, h('canvas', { class: 'kt-ass' }), h('div', { class: 'kt-subs' }), h('div', { class: 'kt-subs top' }));
  const assCanvas = stage.querySelector('.kt-ass') as HTMLCanvasElement; const subBox = stage.querySelector('.kt-subs:not(.top)') as HTMLElement; const subTop = stage.querySelector('.kt-subs.top') as HTMLElement;
  const mem = memoryOf(key);
  // ---- state
  let controlsOn = true; let hideTimer = 0; let locked = false; let speed = P.defaultSpeed; let zoom = 1; let panX = 0, panY = 0; let aspect = (P.rememberAspect !== false ? mem?.aspect : undefined) ?? P.aspect; let abA: number | null = null, abB: number | null = null;
  let repeat = P.repeat; let rotate = 0; let flipH = false, flipV = false; let crop = ''; let marks: Bookmark[] = mem?.marks ?? [];
  let tracks: SubTrack[] = []; let current: SubTrack | null = null; let secondary: SubTrack | null = null; let subDelay = P.subDelay; let ass: AssRenderer | null = null;
  let sound: SoundGraph | null = null; let preview: SeekPreview | null = null; let boost = 1; let brightness = P.rememberBrightness ? P.brightness : 1; let sleepAt = 0; let watchedSent = false; let fps = 0; let pictureOff = false;
  // ---- chrome
  const title = h('span', { class: 'kt-title grow', dir: 'auto' }, src.name);
  const clock = h('span', { class: 'kt-clock', hidden: !P.showClock });
  const topToolBox = h('span', { class: 'kt-tools kt-top-tools' });
  const top = h('div', { class: 'kt-top' }, iconButton('back', t('back'), () => close()), title, clock, topToolBox, iconButton('subtitles', t('navSubs'), () => subsSheet()), iconButton('music', t('audioSection'), () => audioSheet()), batchFiles().length > 1 ? iconButton('list', t('batchFiles'), () => batchSheet()) : null, iconButton('more', t('more'), () => moreSheet()));
  const timeNow = h('span', { class: 'kt-time' }, '0:00'); const timeEnd = h('button', { type: 'button', class: 'kt-time end', title: t('showRemaining'), onclick: () => { const p = getPrefs(); if (p.showRemaining && !endsAt) { endsAt = true; } else { endsAt = false; updatePrefs({ showRemaining: !p.showRemaining }); } onTime(); } }, '–:––'); let endsAt = false;
  const bar = h('div', { class: 'kt-seek', role: 'slider', tabindex: '0', 'aria-label': t('seekBar') }, h('div', { class: 'kt-buf' }), h('div', { class: 'kt-played' }), h('div', { class: 'kt-knob' }), h('i', { class: 'kt-mark a', hidden: true }), h('i', { class: 'kt-mark b', hidden: true }));
  const playBtn = iconButton('play', t('play'), () => toggle()); playBtn.classList.add('kt-play');
  const speedBtn = h('button', { type: 'button', class: 'kt-chip', onclick: () => speedSheet() }, `${localDigits(speed)}×`);
  const abBtn = h('button', { type: 'button', class: 'kt-chip', onclick: () => abPress() }, 'A/B');
  const aspectBtn = h('button', { type: 'button', class: 'kt-chip', onclick: () => cycleAspect() }, t('aspectFit'));
  const skipBtn = h('button', { type: 'button', class: 'kt-chip', title: t('skipAhead'), onclick: () => seekBy(getPrefs().skipAmount) }, `+${localDigits(P.skipAmount)}`);
  // Your own buttons (REX Player's custom buttons), before the built-in ones.
  const customBox = h('span', { class: 'kt-custom' }); const toolBox = h('span', { class: 'kt-tools' });
  const customLabel = (b: PlayerPrefs['customButtons'][number]) => (b.act === 'seek' ? `${(b.v ?? 0) > 0 ? '+' : '−'}${localDigits(Math.abs(b.v ?? 0))}s` : b.act === 'speed' ? `${localDigits(b.v ?? 1)}×` : b.act === 'jump' ? `→${fmtTime(b.v ?? 0)}` : b.act === 'ab' ? 'A/B' : b.act === 'shot' ? '📷' : b.act === 'sub' ? 'CC' : b.act === 'audio' ? '♪' : '⇥CC');
  const runCustom = (b: PlayerPrefs['customButtons'][number]) => { if (b.act === 'seek') seekBy(b.v ?? 10); else if (b.act === 'speed') { setSpeed(speed === (b.v ?? 1) ? 1 : (b.v ?? 1)); flashText(`${localDigits(speed)}×`); } else if (b.act === 'jump') seekTo(b.v ?? 0); else if (b.act === 'ab') abPress(); else if (b.act === 'shot') screenshot(); else if (b.act === 'sub') cycleSub(); else if (b.act === 'audio') cycleAudio(); else subLine(1); };
  const drawCustom = () => customBox.replaceChildren(...getPrefs().customButtons.map((b) => h('button', { type: 'button', class: 'kt-chip', onclick: () => runCustom(b) }, customLabel(b))));
  // The floating «Skip opening» button, shown while an opening/ending/recap is on screen.
  const skipOp = h('button', { type: 'button', class: 'kt-skip-op', hidden: true }) as HTMLButtonElement;
  const bottom = h('div', { class: 'kt-bottom' },
    h('div', { class: 'kt-row' }, timeNow, bar, timeEnd),
    h('div', { class: 'kt-row buttons' }, iconButton('lock', t('lockScreen'), () => lock(true)), src.playlist?.length ? iconButton('chevronLeft', t('previous'), () => neighbour(-1)) : null, iconButton('undo', t('frameBack'), () => frameStep(-1)), playBtn, iconButton('rotate', t('frameForward'), () => frameStep(1)), src.playlist?.length ? iconButton('chevronRight', t('next'), () => neighbour(1)) : null,
      h('span', { class: 'grow' }), customBox, toolBox, iconButton('grid', t('playerTools'), () => toolsSheet()), iconButton('fullscreen', t('fullscreen'), () => void fullscreen())));
  const centre = h('div', { class: 'kt-centre' }, h('div', { class: 'kt-flash' })); const flash = centre.firstChild as HTMLElement;
  const ripple = h('div', { class: 'kt-ripple', hidden: true });
  const unlockBtn = iconButton('lock', t('unlock'), () => lock(false)); unlockBtn.classList.add('kt-unlock'); unlockBtn.hidden = true;
  const root = h('div', { class: 'player-view kt-player', role: 'dialog', 'aria-label': src.name }, stage, centre, ripple, top, bottom, unlockBtn, skipOp);
  document.body.append(root);
  const pic = new Picture(video, root);
  const wake = navigator.wakeLock && P.keepScreenOn ? navigator.wakeLock.request('screen').catch(() => null) : null;
  // (The system bars away while the player is up, as chosen; back when it closes.)
  const barsPlug = ktPlugin() as unknown as { systemBars?(o: { mode: 'both' | 'status' | 'show' }): Promise<void> } | null; if (P.immersive !== 'none') void barsPlug?.systemBars?.({ mode: P.immersive === 'status' ? 'status' : 'both' }).catch(() => undefined);
  if (P.orientation !== 'auto') void (screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> }).lock?.(P.orientation === 'landscape' ? 'landscape' : 'landscape-primary').catch(() => undefined);
  const clockTick = () => { clock.textContent = new Date().toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }); };
  clockTick(); const clockTimer = window.setInterval(clockTick, 20000);

  // ---- playback
  if (src.headers && Object.keys(src.headers).length) toast(t('playerHeadersNote'));
  // (mpv that cannot start here — its libraries not loading on this phone, the file refused —: the browser's player
  // takes over at once, the same file at the same place.)
  if (mpv) { let started = false; video.addEventListener('loadedmetadata', () => { started = true; }, { once: true }); video.addEventListener('error', () => { if (started || playerGone) return; toast(t('mpvFailed'), 'error', 5000); const at = video.currentTime; close(); openPlayer({ ...src, engine: 'web' }); void at; }, { once: true }); }
  if (!mpv) video.src = src.url; video.preservesPitch = P.pitchCorrection; video.playbackRate = speed;
  video.addEventListener('loadedmetadata', () => {
    timeEnd.textContent = fmtTime(video.duration); applyAspect(); applyTransform(); drawMarks();
    if (src.startAt && !mpv) video.currentTime = src.startAt;
    else if (mem && mem.pos > 5 && mem.pos < video.duration - 10) { if (P.resume === 'always' && !mpv) video.currentTime = mem.pos; else if (P.resume === 'ask') askResume(mem.pos); }
    if (mem?.speed) setSpeed(mem.speed); if (mem?.subDelay) subDelay = mem.subDelay;
    // (This video's picture as it was left: zoom, turn, mirror, crop.)
    if (mem && (mem.zoom || mem.rotate || mem.flipH || mem.flipV || mem.crop)) { zoom = mem.zoom ?? 1; rotate = (mem.rotate ?? 0) as typeof rotate; flipH = !!mem.flipH; flipV = !!mem.flipV; crop = mem.crop ?? ''; applyTransform(); }
    void video.play().catch(() => undefined);
    measureFps(); void checkSound(); window.setTimeout(() => void autoSubs(), 4000);
  }, { once: true });
  video.addEventListener('timeupdate', onTime); video.addEventListener('progress', drawBuffer);
  video.addEventListener('play', () => { playBtn.replaceChildren(icon('pause')); playBtn.setAttribute('aria-label', t('pause')); scheduleHide(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'playing'; });
  video.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); playBtn.setAttribute('aria-label', t('play')); showControls(); if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused'; });
  video.addEventListener('ended', () => {
    if (sleepAtEnd) { sleepAtEnd = false; toast(t('sleepTimerDone')); close(); return; }
    if (repeat === 'one') { video.currentTime = 0; void video.play(); return; }
    markWatched(true);
    const list = src.playlist ?? []; const i = list.findIndex((x) => x.url === src.url);
    if (list.length && (getPrefs().autoplayNext || repeat === 'all') && (i + 1 < list.length || repeat === 'all' || getPrefs().shuffle)) { neighbour(1, true); return; }
    if (getPrefs().closeAtEnd) { close(); return; }
    showControls();
  });
  video.addEventListener('error', () => { const err = video.error; toast(err?.code === 4 || err?.code === 3 ? t('playerCantPlayOther') : t('stateFailed'), 'error', 7000); showControls(); });
  video.addEventListener('waiting', () => centre.classList.add('busy')); video.addEventListener('playing', () => centre.classList.remove('busy')); video.addEventListener('canplay', () => centre.classList.remove('busy'));
  let lastPosState = 0;
  function onTime() {
    const d = video.duration || 0, c = video.currentTime;
    if (abA !== null && abB !== null && c >= abB) video.currentTime = abA;
    timeNow.textContent = fmtTime(c); if (d) timeEnd.textContent = endsAt ? t('endsAt', { t: new Date(Date.now() + ((d - c) / (video.playbackRate || 1)) * 1000).toLocaleTimeString(document.documentElement.lang || undefined, { hour: 'numeric', minute: '2-digit' }) }) : getPrefs().showRemaining ? `−${fmtTime((d - c) / (video.playbackRate || 1))}` : fmtTime(d); skipCheck(c); if (d) (bar.querySelector('.kt-played') as HTMLElement).style.width = `${(c / d) * 100}%`; (bar.querySelector('.kt-knob') as HTMLElement).style.insetInlineStart = d ? `${(c / d) * 100}%` : '0';
    drawSubs(c);
    if (Math.floor(c) % 5 === 0) remember(key, { pos: c, duration: d, speed, sub: current?.id, subDelay });
    if (d && P.markWatched && !watchedSent && c / d * 100 >= P.watchedAt) markWatched(false);
    // (Halfway through an episode: the next one's best release starts coming — Seanime's and Hayase's preload.)
    if (d && !preloadSent && c / d >= 0.5) { preloadSent = true; const m = src.task?.meta ?? src.meta; if (m?.anilistId && m.episode && getSettings().animePreloadNext !== false) void import('../anime/watch').then((w) => w.preloadNext(m.anilistId!, m.episode!)).catch(() => undefined); }
    if (sleepAt && Date.now() >= sleepAt) { video.pause(); sleepAt = 0; toast(t('sleepTimerDone')); }
    if ('mediaSession' in navigator && d && Date.now() - lastPosState > 4000) { lastPosState = Date.now(); try { navigator.mediaSession.setPositionState({ duration: d, position: Math.min(c, d), playbackRate: video.playbackRate || 1 }); } catch { /* not supported */ } }
  }
  function drawBuffer() { const d = video.duration; if (!d) return; let end = 0; for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) > end) end = video.buffered.end(i); (bar.querySelector('.kt-buf') as HTMLElement).style.width = `${(end / d) * 100}%`; }
  const toggle = () => { if (video.paused) void video.play(); else video.pause(); };
  const setSpeed = (v: number) => { speed = Math.max(0.1, Math.min(8, Math.round(v * 100) / 100)); video.playbackRate = speed; speedBtn.textContent = `${localDigits(speed)}×`; };
  const seekTo = (s: number) => { video.currentTime = Math.max(0, Math.min(video.duration || Infinity, s)); };
  const seekBy = (dt: number, quiet = false) => { seekTo(video.currentTime + dt); if (!quiet) flashText(`${dt > 0 ? '+' : '−'}${localDigits(Math.abs(Math.round(dt)))}s`); };
  /** One frame on or back, at the video's own rate (measured as it plays; 30 until known). */
  const frameStep = (n: number) => { video.pause(); if (mpv) { mpv.command(n > 0 ? 'frame-step' : 'frame-back-step'); flashText(`${n > 0 ? '+' : '−'}1 ${t('frameShort')}`); return; } seekTo(video.currentTime + n / (fps || 30)); flashText(`${n > 0 ? '+' : '−'}1 ${t('frameShort')}`); };
  function measureFps() {
    const v = video as HTMLVideoElement & { requestVideoFrameCallback?(cb: (now: number, m: { mediaTime: number; presentedFrames: number }) => void): number };
    if (!v.requestVideoFrameCallback) return; let last: { t: number; f: number } | null = null; const rates: number[] = [];
    const cb = (_n: number, m: { mediaTime: number; presentedFrames: number }) => { if (last && m.presentedFrames > last.f && m.mediaTime > last.t) { const r = (m.presentedFrames - last.f) / (m.mediaTime - last.t); if (r > 5 && r < 145) rates.push(r); } last = { t: m.mediaTime, f: m.presentedFrames }; if (rates.length < 40 && root.isConnected) v.requestVideoFrameCallback!(cb); else if (rates.length) { rates.sort((a, b) => a - b); fps = Math.round(rates[rates.length >> 1] * 1000) / 1000; } };
    v.requestVideoFrameCallback(cb);
  }
  function flashText(s: string, long = false) { flash.textContent = s; flash.classList.add('on'); window.clearTimeout((flash as HTMLElement & { _t?: number })._t); (flash as HTMLElement & { _t?: number })._t = window.setTimeout(() => flash.classList.remove('on'), long ? 1400 : 700); }
  let preloadSent = false;
  function markWatched(end: boolean) { if (watchedSent) return; watchedSent = true; remember(key, { watched: true }); void import('../downloads/episodeCache').then((c) => c.noteWatched(src.task)); const m = src.task?.meta ?? src.meta; if (m?.anilistId && m.episode) void import('../anime/progress').then((p) => p.markWatched(m.anilistId!, m.episode!, m.title)); if (m?.imdbId) void import('../tv/library').then((l) => l.markWatched(m.imdbId!, m.season, m.episode)); void end; }
  function askResume(pos: number) { const sh = openSheet(t('resumeTitle'), t('close')); sh.body.append(h('p', null, t('resumeBody', { t: fmtTime(pos) }))); sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); } }, t('resumeFromStart')), h('button', { type: 'button', class: 'btn primary', onclick: () => { video.currentTime = pos; sh.close(); } }, t('resumeContinue'))); }
  function neighbour(dir: number, auto = false) {
    const list = src.playlist ?? []; const i = list.findIndex((x) => x.url === src.url);
    let nx = getPrefs().shuffle && dir > 0 && list.length > 1 ? list.filter((x) => x.url !== src.url)[Math.floor(Math.random() * (list.length - 1))] : list[i + dir];
    if (!nx && repeat === 'all' && list.length) nx = dir > 0 ? list[0] : list[list.length - 1];
    if (!nx) { if (!auto) toast(t(dir > 0 ? 'noNextFile' : 'noPreviousFile')); else showControls(); return; }
    close(); openPlayer({ ...nx, playlist: list });
  }
  const playAt = (item: PlayerSource) => { close(); openPlayer({ ...item, playlist: src.playlist }); };

  // ---- the system's media controls (desktop keys, a notification where the browser shows one)
  if ('mediaSession' in navigator) {
    const ms = navigator.mediaSession; const m = src.task?.meta ?? src.meta;
    try { ms.metadata = new MediaMetadata({ title: src.name, artist: m?.title ?? '', album: m?.episode ? t('episodeN', { n: m.episode }) : '' }); } catch { /* old */ }
    const on = (a: MediaSessionAction, fn: MediaSessionActionHandler) => { try { ms.setActionHandler(a, fn); } catch { /* not supported */ } };
    on('play', () => void video.play()); on('pause', () => video.pause()); on('seekbackward', (d) => seekBy(-(d.seekOffset ?? P.doubleTapSeek))); on('seekforward', (d) => seekBy(d.seekOffset ?? P.doubleTapSeek)); on('seekto', (d) => { if (d.seekTime !== undefined) seekTo(d.seekTime); });
    if (src.playlist?.length) { on('previoustrack', () => neighbour(-1)); on('nexttrack', () => neighbour(1)); }
  }
  // (Away from the app: paused, unless playing on in the background was chosen or the picture floats.)
  const onHidden = () => { if (document.visibilityState === 'hidden' && !getPrefs().backgroundPlay && !document.pictureInPictureElement && !video.paused) video.pause(); };
  document.addEventListener('visibilitychange', onHidden);

  // ---- controls visibility
  function showControls() { controlsOn = true; root.classList.remove('hide-ui'); scheduleHide(); }
  function hideControls() { if (video.paused || locked) return; controlsOn = false; root.classList.add('hide-ui'); preview?.hide(); }
  function scheduleHide() { window.clearTimeout(hideTimer); hideTimer = window.setTimeout(hideControls, Math.max(1, getPrefs().controlsTimeout) * 1000); }
  function lock(on: boolean) { locked = on; root.classList.toggle('locked', on); unlockBtn.hidden = !on; if (on) { root.classList.add('hide-ui'); setTimeout(() => { unlockBtn.classList.add('faded'); }, 2500); } else { unlockBtn.classList.remove('faded'); showControls(); } }
  scheduleHide();

  // ---- seek bar (with previews of the time under the finger)
  const canPreview = () => getPrefs().seekPreview && !(src.headers && Object.keys(src.headers).length) && (!!src.localPath || /^(http:\/\/127\.0\.0\.1|blob:|file:|https?:\/\/localhost)/.test(src.url));
  const previewAt = (clientX: number) => { if (!canPreview() || !video.duration) return; if (!preview) { preview = new SeekPreview(video.currentSrc || src.url, fmtTime); bar.parentElement!.append(preview.el); } const rr = bar.parentElement!.getBoundingClientRect(); const f = fracAt(clientX); preview.show(f * video.duration, clientX - rr.left, rr.width); };
  const fracAt = (clientX: number) => { const r = bar.getBoundingClientRect(); const rtl = getComputedStyle(bar).direction === 'rtl'; let f = (clientX - r.left) / r.width; if (rtl) f = 1 - f; return Math.max(0, Math.min(1, f)); };
  const seekToX = (clientX: number) => { if (video.duration) seekTo(fracAt(clientX) * video.duration); };
  let scrubbing = false;
  bar.addEventListener('pointerdown', (e) => { if (locked) return; scrubbing = true; bar.setPointerCapture(e.pointerId); seekToX(e.clientX); previewAt(e.clientX); e.stopPropagation(); showControls(); });
  bar.addEventListener('pointermove', (e) => { if (scrubbing) { seekToX(e.clientX); flashText(fmtTime(video.currentTime)); previewAt(e.clientX); scheduleHide(); } else if (e.pointerType === 'mouse') previewAt(e.clientX); });
  const endScrub = () => { scrubbing = false; preview?.hide(); };
  bar.addEventListener('pointerup', endScrub); bar.addEventListener('pointercancel', endScrub); bar.addEventListener('pointerleave', () => { if (!scrubbing) preview?.hide(); });
  bar.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') seekBy(5); else if (e.key === 'ArrowLeft') seekBy(-5); });
  // A and B dragged along the bar (the frame shown as they move); a long press on «A/B» opens the clip sheet.
  for (const which of ['a', 'b'] as const) {
    const mk = bar.querySelector(`.kt-mark.${which}`) as HTMLElement;
    mk.addEventListener('pointerdown', (e) => { if (locked) return; e.stopPropagation(); e.preventDefault(); mk.setPointerCapture(e.pointerId); video.pause();
      const mv = (ev: PointerEvent) => { if (!video.duration) return; const v = fracAt(ev.clientX) * video.duration; if (which === 'a' && abB !== null) abA = Math.min(v, abB - 0.2); else if (which === 'a') abA = v; else if (abA !== null) abB = Math.max(v, abA + 0.2); seekTo(which === 'a' ? abA! : abB!); flashText(`${which.toUpperCase()} ${fmtTime(which === 'a' ? abA! : abB!)}`); drawMarks(); };
      const up = () => { mk.removeEventListener('pointermove', mv); mk.removeEventListener('pointerup', up); mk.removeEventListener('pointercancel', up); };
      mk.addEventListener('pointermove', mv); mk.addEventListener('pointerup', up); mk.addEventListener('pointercancel', up); });
  }
  onLongPress(abBtn, () => void cutSheet());

  // ---- gestures on the stage
  let tapTimer = 0; let lastTap = 0; let lastTapZone = -1; let pressTimer = 0; let pressing = false; let heldSpeed = 0; let gesture: 'none' | 'seek' | 'volume' | 'bright' | 'pinch' = 'none'; let start = { x: 0, y: 0, t: 0, vol: 1, br: 1 }; const pts = new Map<number, { x: number; y: number }>(); let pinchStart = 0; let zoomStart = 1; let moved = false;
  let seekAcc = { side: 0, total: 0, timer: 0 };
  stage.addEventListener('pointerdown', (e) => {
    if (locked) { unlockBtn.classList.remove('faded'); setTimeout(() => unlockBtn.classList.add('faded'), 2500); return; }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); stage.setPointerCapture(e.pointerId); moved = false;
    if (pts.size === 2 && P.pinchZoom) { const [a, b] = [...pts.values()]; pinchStart = Math.hypot(a.x - b.x, a.y - b.y); zoomStart = zoom; gesture = 'pinch'; window.clearTimeout(pressTimer); return; }
    start = { x: e.clientX, y: e.clientY, t: video.currentTime, vol: video.volume * boost, br: brightness }; gesture = 'none';
    pressTimer = window.setTimeout(() => { if (moved || pts.size !== 1) return; pressing = true; heldSpeed = speed * getPrefs().longPressSpeed; video.playbackRate = heldSpeed; flashText(`${localDigits(heldSpeed)}× ${getPrefs().holdSwipeSpeed ? '⇆' : ''}`, true); root.classList.add('holding'); if (navigator.vibrate) navigator.vibrate(10); }, 450);
  });
  stage.addEventListener('pointermove', (e) => {
    if (locked) return; const p = pts.get(e.pointerId); if (!p) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture === 'pinch' && pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); zoom = Math.max(1, Math.min(6, zoomStart * (d / pinchStart))); applyTransform(); flashText(`${localDigits(Math.round(zoom * 100))}%`); return; }
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    // Held for speed: a swipe sideways changes it (a quarter for each 40 px), REX Player's way.
    if (pressing) { if (getPrefs().holdSwipeSpeed && Math.abs(dx) > 20) { const v = Math.max(0.25, Math.min(8, Math.round((speed * getPrefs().longPressSpeed + Math.trunc(dx / 40) * 0.25) * 100) / 100)); if (v !== heldSpeed) { heldSpeed = v; video.playbackRate = v; flashText(`${localDigits(v)}×`, true); } } return; }
    if (!moved && Math.hypot(dx, dy) > 18) { moved = true; window.clearTimeout(pressTimer); }
    if (!moved) return;
    const r = stage.getBoundingClientRect(); const left = start.x < r.left + r.width / 2; const volSide = getPrefs().swapSides ? left : !left;
    if (gesture === 'none') { if (zoom > 1 && e.pointerType === 'touch') gesture = 'pinch'; else if (Math.abs(dx) > Math.abs(dy)) gesture = P.swipeSeek ? 'seek' : 'none'; else gesture = volSide ? (P.swipeVolume ? 'volume' : 'none') : (P.swipeBrightness ? 'bright' : 'none'); }
    if (gesture === 'pinch' && getPrefs().panZoomed !== false) { panX += e.movementX; panY += e.movementY; applyTransform(); }
    else if (gesture === 'seek') { const dt = (dx / r.width) * Math.min(video.duration || 600, 600) * (getPrefs().swipeSensitivity / 100); const to = Math.max(0, Math.min(video.duration || 0, start.t + dt)); flashText(`${fmtTime(to)}  (${dt >= 0 ? '+' : '−'}${fmtTime(Math.abs(dt))})`, true); (stage as HTMLElement & { _seekTo?: number })._seekTo = to; if (canPreview()) { if (!preview) { preview = new SeekPreview(video.currentSrc || src.url, fmtTime); bar.parentElement!.append(preview.el); } showControls(); const rr = bar.parentElement!.getBoundingClientRect(); const br = bar.getBoundingClientRect(); const f = video.duration ? to / video.duration : 0; const rtl = getComputedStyle(bar).direction === 'rtl'; preview.show(to, (br.left - rr.left) + (rtl ? 1 - f : f) * br.width, rr.width); } }
    else if (gesture === 'volume') { const v = Math.max(0, Math.min(1 + P.volumeBoost / 100, start.vol - dy / (r.height * 0.6) * 1.5)); setVolume(v); flashText(`🔊 ${localDigits(Math.round(v * 100))}%`); }
    else if (gesture === 'bright') { brightness = Math.max(0.2, Math.min(1.6, start.br - dy / (r.height * 0.6) * 1.2)); applyFilters(); flashText(`☀ ${localDigits(Math.round(brightness * 100))}%`); if (getPrefs().rememberBrightness) updatePrefs({ brightness }); }
  });
  const runTap = (a: TapAction, side: number) => {
    if (a === 'playpause') { toggle(); flashText(video.paused ? '❚❚' : '▶'); return; }
    if (a === 'chapter') { chapterStep(side < 0 ? -1 : 1); return; }
    if (a !== 'seek') return;
    // Seeks add up while the same side is tapped again (+10, +20, +30…), shown in a ripple on that side.
    const step = (getPrefs().doubleTapSeek) * (side < 0 ? -1 : 1);
    if (seekAcc.side !== side) seekAcc = { side, total: 0, timer: 0 };
    seekAcc.total += step; seekBy(step, true);
    ripple.hidden = false; ripple.className = `kt-ripple ${side < 0 ? 'left' : 'right'}`; ripple.textContent = `${seekAcc.total > 0 ? '+' : '−'}${localDigits(Math.abs(seekAcc.total))}s`;
    window.clearTimeout(seekAcc.timer); seekAcc.timer = window.setTimeout(() => { ripple.hidden = true; seekAcc = { side: 0, total: 0, timer: 0 }; }, 800);
  };
  const endPointer = (e: PointerEvent) => {
    pts.delete(e.pointerId); window.clearTimeout(pressTimer);
    if (pressing) { pressing = false; root.classList.remove('holding'); if (getPrefs().rememberHoldSpeed && heldSpeed && speed) updatePrefs({ longPressSpeed: Math.round((heldSpeed / speed) * 100) / 100 }); video.playbackRate = speed; flashText(`${localDigits(speed)}×`); return; }
    if (gesture === 'seek') { const to = (stage as HTMLElement & { _seekTo?: number })._seekTo; if (to !== undefined) seekTo(to); gesture = 'none'; preview?.hide(); return; }
    if (gesture === 'pinch') { if (pts.size === 0) gesture = 'none'; return; }
    if (gesture !== 'none') { gesture = 'none'; return; }
    if (moved || locked) return;
    // Taps: one toggles the controls; two do what each zone was given (a third, fourth… keep seeking).
    const now = Date.now(); const r = stage.getBoundingClientRect(); const x = (e.clientX - r.left) / r.width; const w = getPrefs().doubleTapArea / 100;
    // (Sides as seen: the left one goes back, the right one on — in Arabic too, as players do.)
    const zone = x < w ? -1 : x > 1 - w ? 1 : 0; const side = zone;
    const action = (z: number): TapAction => (z < 0 ? getPrefs().tapLeft : z > 0 ? getPrefs().tapRight : getPrefs().tapCentre);
    if (seekAcc.total && zone === seekAcc.side && action(zone) === 'seek') { window.clearTimeout(tapTimer); lastTap = now; runTap('seek', side); return; }
    if (now - lastTap < 300 && zone === lastTapZone) { window.clearTimeout(tapTimer); lastTap = now; runTap(action(zone), zone === 0 ? 0 : side); return; }
    lastTap = now; lastTapZone = zone; tapTimer = window.setTimeout(() => { if (getPrefs().singleTap === 'playpause' && zone === 0) { if (video.paused) void video.play(); else video.pause(); return; } if (controlsOn) hideControls(); else showControls(); }, 280);
  };
  stage.addEventListener('pointerup', endPointer); stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('wheel', (e) => { if (locked) return; e.preventDefault(); if (e.ctrlKey) { zoom = Math.max(1, Math.min(6, zoom - e.deltaY / 500)); applyTransform(); } else setVolume(Math.max(0, Math.min(1 + P.volumeBoost / 100, (video.volume * boost) - e.deltaY / 1000))); showControls(); }, { passive: false });

  // ---- picture: aspect, crop, rotation, mirroring, zoom, filters
  function applyTransform() { if (zoom <= 1.001) { zoom = 1; panX = 0; panY = 0; } assCanvas.style.transform = pic.transform({ rotate, flipH, flipV, zoom, panX, panY, crop }); remember(key, { zoom, rotate, flipH, flipV, crop }); }
  function applyFilters() { pic.apply(getPrefs().filters, brightness, getPrefs().filterPreset); }
  applyFilters();
  // ---- sound: volume past 100%, the equaliser and the rest (the audio graph made when first needed)
  const soundNeeded = () => { const p = getPrefs(); return boost > 1 || p.eqOn || p.normalize || p.mono || p.balance !== 0 || p.audioDelay > 0; };
  function applySound() { if (!sound && !soundNeeded()) return; try { sound ??= new SoundGraph(video); const p = getPrefs(); sound.apply({ eqOn: p.eqOn, eq: p.eq, eqPreamp: p.eqPreamp, normalize: p.normalize, mono: p.mono, balance: p.balance, audioDelay: p.audioDelay, gain: boost }); } catch { sound = null; } }
  function setVolume(v: number) { if (v > 1) { video.volume = 1; boost = v; } else { video.volume = v; boost = 1; } applySound(); }
  applySound();

  // ---- keyboard (desktop): YouTube's and VLC's keys
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return; if ((e.target as HTMLElement).closest('.sheet, input, textarea')) return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); }
    else if (e.ctrlKey && (k === 'ArrowRight' || k === 'ArrowLeft')) subLine(k === 'ArrowRight' ? 1 : -1);
    else if (k === 'ArrowRight' || k === 'l') seekBy(e.shiftKey ? 60 : P.doubleTapSeek); else if (k === 'ArrowLeft' || k === 'j') seekBy(e.shiftKey ? -60 : -P.doubleTapSeek);
    else if (k === 'ArrowUp') setVolume(Math.min(1 + P.volumeBoost / 100, video.volume * boost + 0.05)); else if (k === 'ArrowDown') setVolume(Math.max(0, video.volume * boost - 0.05));
    else if (k === 'f') void fullscreen(); else if (k === 'm') { video.muted = !video.muted; flashText(video.muted ? '🔇' : '🔊'); } else if (k === '.' || k === 'e') frameStep(1); else if (k === ',') frameStep(-1);
    else if (k === '>' || k === ']' || k === '+') setSpeed(speed + (k === '+' ? 0.05 : 0.1)); else if (k === '<' || k === '[' || k === '-') setSpeed(speed - (k === '-' ? 0.05 : 0.1)); else if (k === '=') setSpeed(1);
    else if (k === 'Escape') { if (document.fullscreenElement) void document.exitFullscreen(); else close(); }
    else if (k === 'a') abPress(); else if (k === 's' || k === 'S') screenshot(); else if (k === 'v') cycleSub(); else if (k === 'b') cycleAudio(); else if (k === 'c') cycleCrop(); else if (k === 'r') { rotate = ((rotate + 90) % 360) as 0; applyTransform(); flashText(`${localDigits(rotate)}°`); }
    else if (k === 'z' || k === 'g') nudgeSub(-0.1); else if (k === 'x' || k === 'h') nudgeSub(0.1); else if (k === 'H') syncMark('heard'); else if (k === 'J') syncMark('seen');
    else if (k === 'n') neighbour(1); else if (k === 'p') neighbour(-1); else if (k === 't') flashText(`${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`, true); else if (k === 'i') infoSheet(); else if (k === 'B') addBookmark();
    else if (k === '?') shortcutsSheet(); else if (k === 'Home') seekTo(0); else if (k === 'End') seekTo((video.duration || 1) - 1); else if (/^[0-9]$/.test(k) && video.duration) seekTo(video.duration * Number(k) / 10);
    else return;
    showControls();
  };
  window.addEventListener('keydown', onKey);

  // ---- A/B, aspect, screenshot, pip, fullscreen
  function abPress() { if (abA === null) { abA = video.currentTime; flashText(`A ${fmtTime(abA)}`); } else if (abB === null) { abB = Math.max(abA + 0.5, video.currentTime); flashText(`B ${fmtTime(abB)}`); abBtn.classList.add('on'); } else { abA = abB = null; abBtn.classList.remove('on'); flashText(t('abOff')); } drawMarks(); }
  function drawMarks() {
    const d = video.duration || 1; const a = bar.querySelector('.kt-mark.a') as HTMLElement, b = bar.querySelector('.kt-mark.b') as HTMLElement; a.hidden = abA === null; b.hidden = abB === null; if (abA !== null) a.style.insetInlineStart = `${(abA / d) * 100}%`; if (abB !== null) b.style.insetInlineStart = `${(abB / d) * 100}%`;
    bar.querySelectorAll('.kt-bm').forEach((x) => x.remove()); if (video.duration) for (const m of marks) bar.append(h('i', { class: 'kt-bm', title: m.label, style: { insetInlineStart: `${(m.t / d) * 100}%` } }));
  }
  const ASPECTS: PlayerPrefs['aspect'][] = ['fit', 'fill', 'stretch', '16:9', '4:3', '21:9'];
  function cycleAspect() { aspect = ASPECTS[(ASPECTS.indexOf(aspect) + 1) % ASPECTS.length]; applyAspect(); flashText(aspectName(aspect)); remember(key, { aspect }); }
  const aspectName = (a: PlayerPrefs['aspect']) => (a === 'fit' ? t('aspectFit') : a === 'fill' ? t('aspectFill') : a === 'stretch' ? t('aspectStretch') : localDigits(a));
  function applyAspectMpv(): boolean { if (!mpv) return false; mpv.set('keepaspect', aspect !== 'stretch'); mpv.set('panscan', aspect === 'fill' ? 1 : 0); mpv.set('video-aspect-override', /^\d/.test(aspect) ? aspect : 'no'); return true; }
  function applyAspect() { if (applyAspectMpv()) return; video.style.objectFit = aspect === 'fill' ? 'cover' : aspect === 'stretch' ? 'fill' : 'contain'; video.style.aspectRatio = ''; video.style.width = video.style.height = ''; if (/^\d/.test(aspect)) { const [w, hh] = aspect.split(':').map(Number); const r = stage.getBoundingClientRect(); const stageR = r.width / r.height, want = w / hh; if (want > stageR) { video.style.width = '100%'; video.style.height = `${(stageR / want) * 100}%`; } else { video.style.height = '100%'; video.style.width = `${(want / stageR) * 100}%`; } video.style.objectFit = 'fill'; } aspectBtn.textContent = aspectName(aspect); }
  function cycleCrop() { crop = CROPS[(CROPS.indexOf(crop) + 1) % CROPS.length]; applyTransform(); flashText(crop ? `${t('cropTo')} ${localDigits(crop)}` : t('cropOff')); }
  function screenshotMpv(): boolean { if (!mpv) return false; mpv.screenshot(); toast(t('screenshotSaved')); return true; }
  function screenshot() { if (screenshotMpv()) return; try { const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight; const g = c.getContext('2d')!; g.filter = video.style.filter.replace(/url\([^)]*\)/g, '') || 'none'; g.drawImage(video, 0, 0); if (ass) g.drawImage(assCanvas, 0, 0, c.width, c.height); else if (getPrefs().shotSubs !== false) drawCuesOn(g, c.width, c.height); c.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${src.name.replace(/\.[^.]+$/, '')} ${fmtTime(video.currentTime).replace(/:/g, '.')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast(t('screenshotSaved')); }, 'image/png'); } catch { toast(t('screenshotFailed'), 'error'); } }
  /** The lines on screen now (an SRT/VTT the page draws) painted onto a saved frame in the player's style. */
  function drawCuesOn(g: CanvasRenderingContext2D, w: number, hh: number): void {
    if (!current || current.ass) return; const now = cuesAt(current.cues, (video.currentTime - subDelay) * getPrefs().subSpeed); if (!now.length) return;
    const P = getPrefs(); const size = Math.round((hh / 18) * (P.subSize / 100)); g.save();
    g.font = `${P.subItalic ? 'italic ' : ''}${P.subBold ? '700' : '500'} ${size}px ${P.subFont ? `"${P.subFont}", ` : ''}sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    const lines = now.filter((c) => !c.top).flatMap((c) => plain(c.text).split('\n')); const topLines = now.filter((c) => c.top).flatMap((c) => plain(c.text).split('\n'));
    const paint = (ls: string[], y0: number, up: boolean) => { let y = y0; for (const ln of up ? [...ls].reverse() : ls) { if (P.subBackground === 'box') { const m = g.measureText(ln); g.fillStyle = 'rgba(0,0,0,.6)'; g.fillRect(w / 2 - m.width / 2 - size * 0.3, y - size * 1.1, m.width + size * 0.6, size * 1.25); } g.lineWidth = Math.max(1, P.subOutlineWidth * (hh / 720) * 2); g.strokeStyle = P.subOutline; g.lineJoin = 'round'; if (P.subBackground !== 'none') g.strokeText(ln, w / 2, y); g.fillStyle = P.subColor; g.fillText(ln, w / 2, y); y += up ? -size * 1.25 : size * 1.25; } };
    paint(lines, hh - hh * 0.04 - (hh * 0.9 * (100 - P.subPos)) / 100, true); paint(topLines, size * 1.3 + hh * 0.03, false);
    g.restore();
  }
  async function pip() { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch { toast(t('pipFailed'), 'error'); } }
  async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.requestFullscreen(); } catch { /* not allowed */ } }
  const remote = (video as HTMLVideoElement & { remote?: { prompt(): Promise<void>; state: string } }).remote;
  async function cast() { try { await remote!.prompt(); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }

  // ---- subtitles
  const subTime = (c: number) => (c - subDelay) / (getPrefs().subSpeed || 1);
  function drawSubs(c: number) {
    const tm = subTime(c);
    const render = (box: HTMLElement, tr: SubTrack | null, topOnly: boolean | null) => { if (!tr || (tr.ass && ass && tr === current)) { box.replaceChildren(); delete box.dataset.last; return; } const cs = cuesAt(tr.cues, tm).filter((x) => topOnly === null || !!x.top === topOnly); const html = cs.map((x) => x.text).join('\n'); if (box.dataset.last === html) return; box.dataset.last = html; box.replaceChildren(...cs.map((x) => h('span', { class: 'kt-cue', dir: getPrefs().subForceLtr ? 'ltr' : 'auto' }, ...x.text.split('\n').flatMap((l, i) => (i ? [h('br'), l] : [l]))))); };
    render(subBox, current, secondary ? null : false); if (secondary) render(subTop, secondary, null); else render(subTop, current, true);
    root.classList.toggle('has-sub2', !!secondary);
  }
  function applySubStyle() {
    const p = getPrefs(); const st = root.style;
    st.setProperty('--sub-size', `${p.subSize}%`); st.setProperty('--sub-color', p.subColor); st.setProperty('--sub-pos', `${100 - p.subPos}%`); st.setProperty('--sub-font', p.subFont ? `"${p.subFont}", ` : '');
    st.setProperty('--sub-outline', p.subOutline); st.setProperty('--sub-outline-w', `${p.subOutlineWidth}px`); st.setProperty('--sub-bg-a', String(p.subBgOpacity / 100)); st.setProperty('--sub2-pos', `${p.sub2Pos}%`); st.setProperty('--sub2-size', `${p.sub2Size}%`);
    root.classList.toggle('sub-bold', p.subBold); root.classList.toggle('sub-italic', p.subItalic); root.dataset.subBg = p.subBackground;
    // (Appearance: the accent, the seek bar, the shade, the title, the marks, the size — REX Player's page.)
    if (p.accent) st.setProperty('--kt-accent', p.accent); else st.removeProperty('--kt-accent');
    st.setProperty('--kt-dim', String(p.controlsDim / 100)); root.dataset.seek = p.seekStyle; root.dataset.size = p.controlSize;
    title.hidden = !p.showTitle; root.classList.toggle('no-chapter-marks', !p.chapterMarks);
  }
  applySubStyle(); drawCustom();
  const nudgeSub = (d: number) => { subDelay = Math.round((subDelay + d) * 100) / 100; ass?.setOffset(-subDelay); remember(key, { subDelay }); flashText(t('subDelayNow', { s: subDelay.toFixed(1) })); };
  /** The line before or after the one on screen (REX Player's subtitle seek; mpv's Ctrl+arrows). */
  function subLine(dir: number) {
    const tr = current ?? secondary; if (!tr?.cues.length) { toast(t('subsNone')); return; }
    const tm = subTime(video.currentTime); const sp = getPrefs().subSpeed || 1;
    const c = dir > 0 ? tr.cues.find((x) => x.start > tm + 0.05) : [...tr.cues].reverse().find((x) => x.start < tm - 0.6);
    if (!c) return; seekTo(c.start * sp + subDelay); flashText(c.text.split('\n')[0].slice(0, 60), true);
  }
  /* ---------- subtitles translated (Google, DeepL or an AI model: the translator of Translate on screen) ---------- */
  let playerGone = false; let translating: string | null = null; let sleepAtEnd = false;
  const plain = (s: string) => s.replace(/<\/?(b|i|u)>/gi, '');
  /** The track translated into `target` as a new track, shown at once — the lines from here on first, then the rest
   *  — with the original kept above it when asked. */
  async function translateTrack(src: SubTrack, target: string, keepOriginal: boolean, status: HTMLElement): Promise<void> {
    const { loadScreen, SCREEN_LANGS, engineReady } = await import('../screen/config'); const { translateTexts } = await import('../screen/translate');
    const cfg = loadScreen(); cfg.target = target; if (!engineReady(cfg)) cfg.engine = 'google';
    const id = `${src.id}→${target}`; if (translating === id) return; translating = id;
    const label = SCREEN_LANGS.find(([c]) => c === target)?.[1] ?? target;
    let tr = tracks.find((x) => x.id === id);
    if (!tr) { tr = { id, name: `${src.name} → ${label}`, lang: target, cues: src.cues.map((c) => ({ ...c, text: '' })), fmt: 'srt' }; tracks = [...tracks, tr]; }
    // (What was translated before — of this very subtitle — is kept on the device and taken up where it stopped.)
    const { loadSaved, saveTranslation } = await import('./subtr'); const saved = await loadSaved(src, target); if (saved) saved.forEach((tx, i) => { if (tx && tr!.cues[i] && !tr!.cues[i].text) tr!.cues[i].text = tx; });
    secondary = keepOriginal ? src : null; await useTrack(tr);
    const now = video.currentTime; const order = src.cues.map((_, i) => i).filter((i) => !tr!.cues[i].text).sort((a, b) => { const fa = src.cues[a].end >= now, fb = src.cues[b].end >= now; return fa === fb ? src.cues[a].start - src.cues[b].start : fa ? -1 : 1; });
    let done = src.cues.length - order.length;
    try {
      for (let k = 0; k < order.length && !playerGone && translating === id; k += 30) {
        const part = order.slice(k, k + 30); const out = await translateTexts(part.map((i) => plain(src.cues[i].text)), cfg);
        part.forEach((i, j) => { tr!.cues[i].text = out[j] ?? ''; }); done += part.length; void saveTranslation(src, target, tr!.cues.map((c) => c.text));
        status.textContent = t('subTrProgress', { n: localDigits(done), total: localDigits(src.cues.length) }); delete subBox.dataset.last; delete subTop.dataset.last; drawSubs(video.currentTime);
      }
      if (!playerGone) { status.textContent = t('subTrDone', { lang: label }); flashText(t('subTrDone', { lang: label })); void saveTranslation(src, target, tr.cues.map((c) => c.text)); }
    } catch (e) { status.textContent = /deeplKey/.test(String((e as Error).message)) ? t('scrNeedEngine') : String((e as Error).message ?? e); }
    finally { if (translating === id) translating = null; }
  }
  // VLC's sync: press when a line is heard, then when its subtitle shows — the delay is the difference.
  let heardAt: number | null = null;
  function syncMark(which: 'heard' | 'seen') {
    if (which === 'heard') { heardAt = video.currentTime; flashText(t('subSyncHeard')); return; }
    if (heardAt === null) { flashText(t('subSyncFirst')); return; }
    subDelay = Math.round((subDelay + heardAt - video.currentTime) * 100) / 100; heardAt = null; ass?.setOffset(-subDelay); remember(key, { subDelay }); flashText(t('subDelayNow', { s: subDelay.toFixed(2) }), true);
  }
  async function useTrack(tr: SubTrack | null) {
    current = tr; ass?.free(); ass = null; subBox.replaceChildren(); subTop.replaceChildren(); delete subBox.dataset.last; delete subTop.dataset.last;
    if (mpv) { mpv.setTrack('sub', 'no'); if (tr?.ass && !getPrefs().subAssOverride) { mpv.addSub(tr.ass, tr.name, true); assCanvas.hidden = true; remember(key, { sub: tr.id }); return; } }
    if (tr?.ass && !getPrefs().subAssOverride) { const own = await import('./fonts').then((m) => m.availableFor(tr.ass!)).catch(() => ({})); ass = await createAssRenderer(video, assCanvas, tr.ass, [], own); if (ass) { ass.setOffset(-subDelay); assCanvas.hidden = false; } } else assCanvas.hidden = true;
    remember(key, { sub: tr?.id });
  }
  function cycleSub() { chosenByHand = true; if (!tracks.length) { void subsSheet(); return; } const i = current ? tracks.indexOf(current) : -1; const nx = tracks[i + 1] ?? null; void useTrack(nx); flashText(nx ? nx.name : t('subsOff')); }
  // (The subtitle in the first of the preferred languages that came is the one shown — unless one was chosen by
  // hand, or this video's own choice was remembered.)
  let chosenByHand = false;
  const langRank = (tr: SubTrack): number => { const l = langOfTrack(tr); const i = l ? getSettings().subLangs.indexOf(l) : -1; return i < 0 ? 999 : i; };
  function offer(tr: SubTrack, fallback: boolean): void {
    if (chosenByHand) return;
    if (mem?.sub && current?.id === mem.sub) return;
    if (mem?.sub === tr.id) { void useTrack(tr); return; }
    if (!current ? langRank(tr) < 999 || fallback : langRank(tr) < langRank(current)) void useTrack(tr);
  }
  async function addTrackFromBytes(name: string, bytes: Uint8Array, lang?: string): Promise<SubTrack | null> {
    const text = decodeSubtitle(bytes, getPrefs().subCodepage || undefined); const fmt = sniffFormat(name, text);
    if (fmt === 'unknown') { toast(t('subsUnknownFormat', { name }), 'error'); return null; }
    const tr: SubTrack = { id: `${name}:${bytes.length}`, name, lang, cues: parseCues(text, fmt), fmt, ass: fmt === 'ass' ? text : undefined };
    tracks = [...tracks.filter((x) => x.id !== tr.id), tr];
    // (Its translations made before, kept on the device: tracks of their own, there without a connection.)
    void import('./subtr').then(async ({ savedTargets, loadSaved }) => { const { SCREEN_LANGS } = await import('../screen/config'); for (const target of await savedTargets(tr)) { const texts = await loadSaved(tr, target); if (!texts || tracks.some((x) => x.id === `${tr.id}→${target}`)) continue; const label = SCREEN_LANGS.find(([c]) => c === target)?.[1] ?? target; tracks = [...tracks, { id: `${tr.id}→${target}`, name: `${tr.name} → ${label}`, lang: target, cues: tr.cues.map((c, i) => ({ ...c, text: texts[i] ?? '' })), fmt: 'srt' }]; } });
    return tr;
  }
  async function loadSubtitleUrl(url: string, name: string, lang?: string) { try { const r = await request(url, { binary: true }); if (r.status >= 400) throw new Error(`HTTP ${r.status}`); const bytes = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)); const tr = await addTrackFromBytes(name, bytes, lang); if (tr) { await useTrack(tr); toast(t('subsLoaded', { name })); } } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }
  // Subtitles that came with an online source: the default one (or the only one) turned on.
  void (async () => { const subs = src.subtitles ?? []; for (const sb of subs.slice(0, 12)) { try { const r = await request(sb.url, { binary: true }); if (r.status >= 400) continue; const tr = await addTrackFromBytes(sb.name, Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)), sb.lang); if (tr) offer(tr, !!sb.isDefault || subs.length === 1); } catch { /* one missing */ } } })();
  // The subtitles inside the file itself (a Matroska's SRT/ASS tracks), read out by ffmpeg for the page's player.
  void (async () => { if (mpv || !src.localPath) return; const { canReadEmbedded, embeddedSubs } = await import('./embedded'); if (!canReadEmbedded()) return; let n = 0; await embeddedSubs(src.localPath, (e) => { void addTrackFromBytes(e.name, e.bytes, e.lang).then((tr) => { if (tr && !playerGone) { n++; offer(tr, e.isDefault || n === 1); } }); }); })();
  // Subtitles beside a local file (same base name) are offered first.
  void (async () => { if (!src.localPath) return; const list = (await siblingFiles(src.localPath)).filter((x) => /\.(srt|ass|ssa|vtt)$/i.test(x)).slice(0, 8); for (const f of list) { const b = await readLocal(f); if (b) { const tr = await addTrackFromBytes(f.split(/[\\/]/).pop()!, b); if (tr) offer(tr, list.length === 1); } } })();

  async function subsSheet() {
    const sh = openSheet(t('navSubs'), t('close')); const p = getPrefs();
    const list = h('div', { class: 'dest-list' }, h('label', { class: 'dest-row' + (!current ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-sub', checked: !current, onchange: () => { chosenByHand = true; void useTrack(null); } }), icon('close'), h('span', { class: 'name' }, t('subsOff'))),
      ...tracks.map((tr) => h('label', { class: 'dest-row' + (current === tr ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-sub', checked: current === tr, onchange: () => { chosenByHand = true; void useTrack(tr); } }), icon('subtitles'), h('span', { class: 'name', dir: 'auto' }, tr.name), h('small', { class: 'src' }, `${tr.fmt.toUpperCase()}${tr.lang ? ` · ${tr.lang}` : ''}`), iconButton(secondary === tr ? 'bookmark' : 'bookmarkAdd', t('subsSecondary'), () => { secondary = secondary === tr ? null : tr; toast(secondary ? t('subsSecondaryOn', { name: tr.name }) : t('subsSecondaryOff')); drawSubs(video.currentTime); }))));
    // (mpv: the subtitles inside the file — every one it carries, text or picture —, chosen here; the preferred
    // languages are picked by themselves when the file opens.)
    if (mpv) { const inFile = mpv.tracks().filter((x) => x.type === 'sub' && !x.external); if (inFile.length) list.append(h('h4', null, t('subsInVideo')), ...inFile.map((x) => h('label', { class: 'dest-row' + (x.selected && !current ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-sub', checked: x.selected && !current, onchange: () => { chosenByHand = true; void useTrack(null).then(() => mpv.setTrack('sub', x.id)); } }), icon('subtitles'), h('span', { class: 'name', dir: 'auto' }, x.title || x.lang || `#${x.id}`), h('small', { class: 'src' }, [(x.codec ?? '').toUpperCase(), x.lang].filter(Boolean).join(' · '))))); }
    const fileIn = h('input', { type: 'file', accept: '.srt,.ass,.ssa,.vtt,.sub,.txt', hidden: true, onchange: async () => { const f = fileIn.files?.[0]; if (!f) return; const tr = await addTrackFromBytes(f.name, new Uint8Array(await f.arrayBuffer())); if (tr) { await useTrack(tr); sh.close(); } } }) as HTMLInputElement;
    const actions = h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn tonal small', onclick: () => fileIn.click() }, icon('upload'), t('subsFromFile')),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void findSubs(); } }, icon('search'), t('subsFind')),
      ...(ktPlugin() ? [h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void localSubs(); } }, icon('folder'), t('subsOnPhone'))] : []));
    const delay = h('input', { type: 'number', step: '0.05', value: subDelay.toFixed(2), style: { width: '6em' }, onchange: () => { subDelay = Number(delay.value) || 0; ass?.setOffset(-subDelay); remember(key, { subDelay }); } }) as HTMLInputElement;
    const nudge = (d: number) => { nudgeSub(d); delay.value = subDelay.toFixed(2); };
    const size = h('input', { type: 'range', min: '40', max: '250', step: '5', value: String(p.subSize), oninput: () => { updatePrefs({ subSize: Number(size.value) }); applySubStyle(); } });
    const pos = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(p.subPos), oninput: () => { updatePrefs({ subPos: Number(pos.value) }); applySubStyle(); } });
    const color = h('input', { type: 'color', value: p.subColor, oninput: () => { updatePrefs({ subColor: color.value }); applySubStyle(); } });
    const outline = h('input', { type: 'color', value: p.subOutline, oninput: () => { updatePrefs({ subOutline: outline.value }); applySubStyle(); } });
    const sw = (label: string, k: 'subBold' | 'subItalic' | 'subForceLtr', after?: () => void) => h('label', { class: 'row switch-row' }, h('span', null, label), h('input', { type: 'checkbox', checked: p[k], onchange: (e: Event) => { updatePrefs({ [k]: (e.target as HTMLInputElement).checked }); applySubStyle(); after?.(); } }));
    // (A second line above — another track, or the original of a translation — and the translation itself.)
    const second = current ? h('div', { class: 'row' }, h('span', null, t('subSecond'), h('small', { class: 'src' }, t('subSecondHint'))), pickButton(t('subSecond'), [['', t('subsOff')], ...tracks.filter((x) => x !== current).map((x) => [x.id, x.name] as [string, string])], secondary?.id ?? '', (v) => { secondary = tracks.find((x) => x.id === v) ?? null; delete subTop.dataset.last; delete subBox.dataset.last; drawSubs(video.currentTime); }, t('close'))) : null;
    // (The track as a file of its own — a translation kept, or a file's inner subtitle taken out —, and the
    // translation shown with its original or by itself, or the original alone, in one tap.)
    const exportRow = current?.cues.length ? h('div', { class: 'row-actions wrap' },
      h('button', { type: 'button', class: 'btn tonal small', onclick: async () => { const { saveText } = await import('../native'); const nm = `${current!.name.replace(/\.(srt|ass|ssa|vtt)$/i, '')}.srt`; await saveText(nm, cuesToSrt(current!.cues), 'application/x-subrip'); toast(t('subSaved', { name: nm })); } }, icon('download'), t('subExport')),
      ...(current!.id.includes('→') ? [h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const orig = tracks.find((x) => current!.id.startsWith(x.id + '→')); if (!orig) return; if (secondary === orig) { secondary = null; } else { secondary = orig; } delete subTop.dataset.last; delete subBox.dataset.last; drawSubs(video.currentTime); sh.close(); } }, icon('subtitles'), secondary && current!.id.startsWith(secondary.id + '→') ? t('subTrOnlyTranslation') : t('subTrWithOriginal')),
        h('button', { type: 'button', class: 'btn tonal small', onclick: () => { const orig = tracks.find((x) => current!.id.startsWith(x.id + '→')); if (orig) { chosenByHand = true; secondary = null; void useTrack(orig); sh.close(); } } }, icon('undo'), t('subTrShowOriginal'))] : [])) : null;
    const trBox = h('div', { class: 'sub-tr' });
    if (current?.cues.length) void (async () => {
      const { loadScreen, saveScreen, SCREEN_LANGS } = await import('../screen/config'); const cfg = loadScreen(); const status = h('small', { class: 'src sub-tr-status', 'aria-live': 'polite' });
      let target = cfg.target; let keep = true; const src = current!;
      trBox.append(h('h4', null, t('subTr')), h('p', { class: 'hint' }, t('subTrHint', { engine: cfg.engine === 'deepl' ? 'DeepL' : cfg.engine === 'ai' ? t('scrEngineAi') : 'Google' }), ' ', t('subTrSavedNote')),
        h('div', { class: 'row' }, h('span', null, t('scrTo')), pickButton(t('scrTo'), SCREEN_LANGS, target, (v) => { target = v; const c = loadScreen(); c.target = v; saveScreen(c); }, t('close'))),
        h('label', { class: 'row switch-row' }, h('span', null, t('subTrKeep')), h('input', { type: 'checkbox', checked: true, onchange: (e: Event) => { keep = (e.target as HTMLInputElement).checked; } })),
        h('button', { type: 'button', class: 'btn tonal', onclick: () => void translateTrack(src.id.includes('→') ? (tracks.find((x) => src.id.startsWith(x.id + '→')) ?? src) : src, target, keep, status) }, icon('translate'), t('subTrGo')), status);
    })();
    sh.body.append(list, fileIn, actions, ...(exportRow ? [exportRow] : []), ...(second ? [second] : []), trBox,
      h('h4', null, t('subTiming')),
      h('div', { class: 'row' }, h('span', null, t('subDelay'), h('small', { class: 'src' }, t('subDelayHint'))), h('div', { class: 'progress-ctl' }, iconButton('minus', t('less'), () => nudge(-0.1)), delay, iconButton('plus', t('more'), () => nudge(0.1)))),
      h('div', { class: 'row' }, h('span', null, t('subSync'), h('small', { class: 'src' }, t('subSyncHint'))), h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal small', onclick: () => syncMark('heard') }, icon('speak'), t('subSyncHeardBtn')), h('button', { type: 'button', class: 'btn tonal small', onclick: () => { syncMark('seen'); delay.value = subDelay.toFixed(2); } }, icon('eye'), t('subSyncSeenBtn')))),
      h('div', { class: 'row' }, h('span', null, t('subLineSeek')), h('div', { class: 'row-actions' }, iconButton('chevronLeft', t('subPrevLine'), () => subLine(-1)), iconButton('chevronRight', t('subNextLine'), () => subLine(1)))),
      h('div', { class: 'row' }, h('span', null, t('subSpeed'), h('small', { class: 'src' }, t('subSpeedHint'))), pickButton(t('subSpeed'), [['1', '1×'], ['0.959', '25 → 23.976'], ['1.043', '23.976 → 25'], ['0.96', '25 → 24'], ['1.042', '24 → 25'], ['0.999', '24 → 23.976'], ['1.001', '23.976 → 24']], String(p.subSpeed), (v) => { updatePrefs({ subSpeed: Number(v) }); drawSubs(video.currentTime); }, t('close'))),
      h('h4', null, t('subsStyle')),
      h('label', { class: 'field' }, h('span', null, t('subSize')), size), h('label', { class: 'field' }, h('span', null, t('subPosition')), pos),
      h('div', { class: 'row' }, h('span', null, t('subColor')), color), h('div', { class: 'row' }, h('span', null, t('subOutlineColor')), outline),
      h('div', { class: 'row' }, h('span', null, t('subBackground')), pickButton(t('subBackground'), [['none', t('subBgNone')], ['shadow', t('subBgShadow')], ['box', t('subBgBox')]], p.subBackground, (v) => { updatePrefs({ subBackground: v }); applySubStyle(); }, t('close'))),
      sw(t('subBold'), 'subBold'), sw(t('subItalic'), 'subItalic'), sw(t('subForceLtr'), 'subForceLtr', () => { delete subBox.dataset.last; delete subTop.dataset.last; drawSubs(video.currentTime); }),
      h('label', { class: 'row switch-row' }, h('span', null, t('subAssOverride'), h('small', { class: 'src' }, t('subAssOverrideHint'))), h('input', { type: 'checkbox', checked: p.subAssOverride, onchange: (e: Event) => { updatePrefs({ subAssOverride: (e.target as HTMLInputElement).checked }); void useTrack(current); } })),
      h('div', { class: 'row' }, h('span', null, t('subCodepage')), pickButton(t('subCodepage'), [['', t('subCodepageAuto')], ['windows-1256', 'Windows-1256 (Arabic)'], ['utf-8', 'UTF-8'], ['windows-1252', 'Windows-1252'], ['windows-1251', 'Windows-1251'], ['shift_jis', 'Shift_JIS'], ['euc-kr', 'EUC-KR'], ['gbk', 'GBK'], ['big5', 'Big5'], ['windows-1254', 'Windows-1254']], p.subCodepage, (v) => updatePrefs({ subCodepage: v }), t('close'))));
  }
  /** Subtitle files already on the phone for this series — beside the video, in Downloads, in any folder searched
   *  by the series' name, and inside subtitle packs (.zip) — ranked by the episode, loaded in one tap. */
  async function localSubs() {
    const pl = ktPlugin() as unknown as { filesRoots(): Promise<{ roots: { path: string; readable: boolean }[] }>; filesSearch(o: { path: string; q: string; hidden?: boolean }): Promise<{ entries: { name: string; path: string; dir: boolean; size: number; mtime: number }[] }>; filesList(o: { path: string }): Promise<{ entries: { name: string; path: string; dir: boolean; size: number; mtime: number }[] }> } | null; if (!pl) return;
    const { parseFilename } = await import('../anime/anitomy'); const m = src.task?.meta ?? src.meta; const parsed = parseFilename(src.name); const ep = m?.episode ?? parsed.episode; const title = (m?.title ?? parsed.title ?? '').trim();
    const sh = openSheet(t('subsOnPhone'), t('close')); const q = h('input', { type: 'search', value: title, dir: 'auto', placeholder: t('subsOnPhoneHint') }) as HTMLInputElement; const list = h('div', { class: 'sub-list' }); const status = h('p', { class: 'src' });
    sh.body.append(h('div', { class: 'row' }, q, h('button', { type: 'button', class: 'btn tonal small', onclick: () => void run() }, icon('search'), t('search'))), status, list);
    const isSub = (n: string) => /\.(ass|ssa|srt|vtt|sub)$/i.test(n); const isPack = (n: string) => /\.(zip|7z|rar)$/i.test(n);
    const epOf = (n: string) => parseFilename(n).episode; const words = (x: string) => x.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    type Hit = { name: string; path: string; inside?: string; score: number; mtime: number };
    const score = (name: string, path: string): number => { const w = words(q.value); const hay = (path + '/' + name).toLowerCase(); let sc = w.filter((x) => hay.includes(x)).length * 2; if (ep !== undefined && epOf(name) === ep) sc += 10; if (src.localPath && path.startsWith(src.localPath.replace(/\/[^/]*$/, ''))) sc += 3; if (/\.ass$/i.test(name)) sc += 1; return sc; };
    const run = async () => {
      status.textContent = t('loading'); list.replaceChildren(); const hits: Hit[] = []; const seen = new Set<string>();
      try {
        const roots = (await pl.filesRoots()).roots.filter((r) => r.readable); const dirs = new Set<string>(); if (src.localPath) dirs.add(src.localPath.replace(/\/[^/]*$/, ''));
        for (const r of roots) { dirs.add(r.path); }
        // (The video's own folder first, whole; then every root searched by each word of the name and by the subtitle extensions.)
        if (src.localPath) { try { for (const e of (await pl.filesList({ path: src.localPath.replace(/\/[^/]*$/, '') })).entries) if (!e.dir && (isSub(e.name) || isPack(e.name)) && seen.add(e.path)) hits.push({ name: e.name, path: e.path, score: score(e.name, e.path) + 2, mtime: e.mtime }); } catch { /* none */ } }
        const needles = [...new Set([...words(q.value).slice(0, 3), '.ass', '.srt'])];
        for (const r of roots) for (const n of needles) { try { for (const e of (await pl.filesSearch({ path: r.path, q: n })).entries) if (!e.dir && (isSub(e.name) || (isPack(e.name) && /sub|ass|srt/i.test(e.name))) && seen.add(e.path)) hits.push({ name: e.name, path: e.path, score: score(e.name, e.path), mtime: e.mtime }); } catch { /* a root we cannot read */ } }
        // (Subtitle packs opened: their files listed as hits too, each taken out when chosen.)
        const { listArchive } = await import('../archives');
        for (const hmm of hits.filter((x) => isPack(x.name)).slice(0, 8)) { try { const info = await listArchive(hmm.path); for (const e of info.entries) if (!e.dir && isSub(e.path)) hits.push({ name: e.path.split('/').pop() ?? e.path, path: hmm.path, inside: e.path, score: score(e.path, hmm.path), mtime: hmm.mtime }); } catch { /* not readable */ } }
        const shown = hits.filter((x) => !isPack(x.name) || x.inside).sort((a, b) => b.score - a.score || b.mtime - a.mtime).slice(0, 80);
        status.textContent = shown.length ? '' : t('noResults');
        list.replaceChildren(...shown.map((x) => h('button', { type: 'button', class: 'result-row sub-row', onclick: async () => {
          try {
            let bytes: Uint8Array | null;
            if (x.inside) { const { extractArchiveJob } = await import('../archives'); const job = extractArchiveJob({ path: x.path, dest: 'cache:', only: [x.inside], replace: 'replace' }); const r = await job.done; bytes = await readLocal(`${r.dest.replace(/[\\/]$/, '')}/${x.inside}`); }
            else bytes = await readLocal(x.path);
            if (!bytes) throw new Error(t('subsCantRead')); const tr = await addTrackFromBytes(x.name, bytes); if (tr) { chosenByHand = true; await useTrack(tr); sh.close(); toast(t('subsLoaded', { name: x.name })); }
          } catch (e) { toast(String((e as Error).message ?? e), 'error'); }
        } }, icon(x.inside ? 'archive' : 'subtitles'), h('span', { class: 'grow files-main' }, h('span', { class: 'name', dir: 'auto' }, x.name), h('small', { class: 'src', dir: 'ltr' }, (x.inside ? `${x.path.split('/').pop()} › ` : '') + x.path.replace(/\/[^/]*$/, ''))), epOf(x.name) !== undefined ? h('span', { class: 'chip small' + (epOf(x.name) === ep ? ' on' : '') }, t('episodeN', { n: epOf(x.name)! })) : null)));
      } catch (e) { status.textContent = String((e as Error).message ?? e); }
    };
    void run();
  }
  /** Subtitles for this very episode through the Subtitles add-on, loaded straight into the player. */
  async function findSubs() {
    const { getSettings } = await import('../settings'); if (!getSettings().addons.includes('subtitles')) { toast(t('subsNoSources')); return; }
    const { lookup, enrich } = await import('../subs/lookup'); const { searchSubtitles, queryFor, rankSubs, resolveLink } = await import('../subs/search'); const { parseFilename } = await import('../anime/anitomy');
    const m = src.task?.meta ?? src.meta; const parsed = parseFilename(src.name); const q = m?.title ?? parsed.title; const ep = m?.episode ?? parsed.episode;
    const sh = openSheet(t('subsFind'), t('close')); sh.body.append(h('p', { class: 'src' }, `${q}${ep ? ` · ${t('episodeN', { n: ep })}` : ''}`), h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    try {
      const cards = m?.anilistId ? await lookup(`anilist:${m.anilistId}`) : await lookup(q); if (!cards.length) { sh.body.replaceChildren(h('p', { class: 'empty small' }, t('noResults'))); return; }
      const c = await enrich(cards[0]); const query = queryFor(c, parsed.season, ep, getSettings().subLangs); const list = h('div', { class: 'sub-list' }); sh.body.replaceChildren(h('p', { class: 'src', dir: 'auto' }, `${c.title}${ep ? ` · ${t('episodeN', { n: ep })}` : ''}`), list);
      let all: Awaited<ReturnType<typeof searchSubtitles>> = [];
      await searchSubtitles(query, (_a, res) => { if (!(res instanceof Error)) all = all.concat(res); list.replaceChildren(...rankSubs(all, getSettings().subLangs, ep).slice(0, 60).map((r) => h('button', { type: 'button', class: 'result-row sub-row', onclick: async () => { try { const { url, name } = await resolveLink(r, query); if (r.archive) { toast(t('subsArchiveNote')); } sh.close(); await loadSubtitleUrl(url, name ?? `${r.title}.${r.archive ?? 'srt'}`, r.language); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, h('span', { class: 'lang-badge' }, (r.language ?? '?').toUpperCase()), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, [r.site, r.hi ? t('subsHI') : '', r.archive ?? ''].filter(Boolean).join(' · ')))))); });
      if (!all.length) list.append(h('p', { class: 'empty small' }, t('noResults')));
    } catch (e) { sh.body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  }

  /** Subtitles fetched by themselves (the Subtitles add-on, the preferred languages) when the video has none of
   *  its own in them after a few seconds: the best-ranked one loaded, quietly. */
  async function autoSubs() {
    const { getSettings } = await import('../settings'); if (!getPrefs().autoSubs || !getSettings().addons.includes('subtitles') || playerGone) return;
    const langs = getSettings().subLangs ?? []; const inFile = mpv ? mpv.tracks().filter((x) => x.type === 'sub') : [];
    if (current || inFile.some((x) => !langs.length || langs.some((l) => (x.lang ?? '').startsWith(l) || (ISO3[l] ?? '').split(',').includes(x.lang ?? '')))) return;
    try {
      const { lookup, enrich } = await import('../subs/lookup'); const { searchSubtitles, queryFor, rankSubs, resolveLink } = await import('../subs/search'); const { parseFilename } = await import('../anime/anitomy');
      const m = src.task?.meta ?? src.meta; const parsed = parseFilename(src.name); const q = m?.title ?? parsed.title; const ep = m?.episode ?? parsed.episode;
      const cards = m?.anilistId ? await lookup(`anilist:${m.anilistId}`) : await lookup(q); if (!cards.length || playerGone || current) return;
      const c = await enrich(cards[0]); const query = queryFor(c, parsed.season, ep, langs); let all: Awaited<ReturnType<typeof searchSubtitles>> = [];
      await searchSubtitles(query, (_a, res) => { if (!(res instanceof Error)) all = all.concat(res); });
      const best = rankSubs(all, langs, ep).find((r) => !r.archive); if (!best || playerGone || current) return;
      const { url, name } = await resolveLink(best, query); await loadSubtitleUrl(url, name ?? `${best.title}.srt`, best.language);
    } catch { /* none found: left as it is */ }
  }
  // ---- sound sheet: tracks, volume, the equaliser, evening out, mono, balance, delay
  type AT = { length: number; [i: number]: { enabled: boolean; label: string; language: string; id: string } };
  const audioTracks = () => (video as HTMLVideoElement & { audioTracks?: AT }).audioTracks;
  function cycleAudio() { const a = audioTracks(); if (!a || a.length < 2) { flashText(t('audioOneTrack')); return; } let i = 0; for (let k = 0; k < a.length; k++) if (a[k].enabled) i = k; const n = (i + 1) % a.length; for (let k = 0; k < a.length; k++) a[k].enabled = k === n; flashText(a[n].label || a[n].language || `#${n + 1}`); }
  // ---- sound the decoder cannot play: turned into AAC by ffmpeg and played beside the video (./compat)
  let beside: import('./compat').SoundBeside | null = null; let tracksFound: import('./compat').Probe | null = null;
  async function checkSound() {
    const c = await import('./compat'); if (mpv || !c.compatHere() || playerGone) return;
    tracksFound = await c.probe(src.url).catch(() => null); if (playerGone) return;
    if (tracksFound?.audio.length) {
      const pick = tracksFound.audio.find((a) => a.isDefault) ?? tracksFound.audio[0];
      if (!c.audioPlayable(pick.codec)) await startBeside(pick.index, pick.codec);
      return;
    }
    // (No answer from ffprobe: a video playing for a few seconds with no sound decoded is taken as one.)
    const check = () => { if (playerGone || beside) return; const n = (video as HTMLVideoElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount; if (n === 0 && video.currentTime > 3 && !video.paused) void startBeside(0, ''); };
    window.setTimeout(check, 6000); window.setTimeout(check, 12000);
  }
  async function startBeside(track: number, codec: string) {
    const c = await import('./compat'); const packs = await import('../packs');
    if (packs.packsHere() && !(await packs.ensurePacks(['ffmpeg'], t('packWhyPlayerSound')))) { toast(t('playerNoSound', { codec: codec.toUpperCase() }), 'error', 6000); return; }
    let base: string | null = null; try { base = await c.audioBase(); } catch { base = null; }
    if (!base || playerGone) return;
    beside?.stop(); beside = new c.SoundBeside(video, src.url, track, base);
    flashText(t('playerSoundBeside', { codec: (codec || '?').toUpperCase() }), true);
  }
  function audioSheet() {
    const sh = openSheet(t('audioSection'), t('close')); const p = getPrefs();
    const a = audioTracks();
    // (The tracks ffprobe found, when the browser does not list them or one is played beside the video: each one
    // either played by the browser or turned into AAC beside it.)
    if (tracksFound && tracksFound.audio.length > 1 && (beside || !a || a.length < 2)) { const pr = tracksFound; sh.body.append(h('h4', null, t('audioTracks')), h('div', { class: 'dest-list' }, ...pr.audio.map((x) => h('label', { class: 'dest-row' + ((beside ? beside.track === x.index : x.isDefault) ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-pt', checked: beside ? beside.track === x.index : !!x.isDefault, onchange: () => { void import('./compat').then((c) => { if (c.audioPlayable(x.codec) && !beside && a && a.length > x.index) { for (let k = 0; k < a.length; k++) a[k].enabled = k === x.index; } else if (beside) beside.restart(x.index); else void startBeside(x.index, x.codec); }); } }), icon('music'), h('span', { class: 'grow', dir: 'auto' }, [x.title, x.lang, `${x.codec.toUpperCase()}${x.channels ? ` ${localDigits(x.channels)}ch` : ''}`].filter(Boolean).join(' · ')))))); }
    else if (a && a.length > 1) sh.body.append(h('h4', null, t('audioTracks')), h('div', { class: 'dest-list' }, ...Array.from({ length: a.length }, (_x, i) => h('label', { class: 'dest-row' + (a[i].enabled ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-at', checked: a[i].enabled, onchange: () => { for (let k = 0; k < a.length; k++) a[k].enabled = k === i; } }), icon('music'), h('span', { class: 'name', dir: 'auto' }, a[i].label || `${t('audioTrack')} ${localDigits(i + 1)}`), h('small', { class: 'src' }, a[i].language || '')))));
    else sh.body.append(h('p', { class: 'src' }, a ? t('audioOneTrack') : t('audioTracksNote')));
    const vol = h('input', { type: 'range', min: '0', max: String(100 + p.volumeBoost), step: '1', value: String(Math.round(video.volume * boost * 100)), oninput: () => { setVolume(Number(vol.value) / 100); volOut.textContent = `${localDigits(vol.value)}%`; } }) as HTMLInputElement;
    const volOut = h('b', null, `${localDigits(Math.round(video.volume * boost * 100))}%`);
    // The equaliser: ten sliders (−20…+20 dB), a preamp, VLC's presets.
    const eqBox = h('div', { class: 'kt-eq' });
    const drawEq = () => { const q = getPrefs(); eqBox.replaceChildren(...EQ_FREQS.map((f, i) => { const r = h('input', { type: 'range', min: '-20', max: '20', step: '0.5', value: String(q.eq[i]), 'aria-label': `${f} Hz`, oninput: (e: Event) => { const eq = [...getPrefs().eq] as PlayerPrefs['eq']; eq[i] = Number((e.target as HTMLInputElement).value); updatePrefs({ eq, eqOn: true, eqPreset: 'custom' }); onSw.checked = true; presetBtn.setValue('custom'); applySound(); } }); return h('label', { class: 'kt-eq-band' }, r, h('small', null, f >= 1000 ? `${localDigits(f / 1000)}k` : localDigits(f))); })); };
    const onSw = h('input', { type: 'checkbox', checked: p.eqOn, onchange: () => { updatePrefs({ eqOn: onSw.checked }); applySound(); } }) as HTMLInputElement;
    const presetNames: [string, string][] = [...Object.keys(EQ_PRESETS).map((k) => [k, t(`eq_${k}` as 'eq_flat')] as [string, string]), ['custom', t('eqCustom')]];
    const presetBtn = pickButton(t('eqPreset'), presetNames, p.eqPreset, (v) => { const pv = presetValues(v); if (pv) { updatePrefs({ ...pv, eqOn: true, eqPreset: v }); onSw.checked = true; pre.value = String(pv.eqPreamp); drawEq(); applySound(); } }, t('close'));
    const pre = h('input', { type: 'range', min: '-20', max: '20', step: '0.5', value: String(p.eqPreamp), oninput: () => { updatePrefs({ eqPreamp: Number(pre.value) }); applySound(); } }) as HTMLInputElement;
    drawEq();
    const sw = (label: string, k: 'normalize' | 'mono', hint?: string) => h('label', { class: 'row switch-row' }, h('span', null, label, hint ? h('small', { class: 'src' }, hint) : null), h('input', { type: 'checkbox', checked: p[k], onchange: (e: Event) => { updatePrefs({ [k]: (e.target as HTMLInputElement).checked }); applySound(); } }));
    const bal = h('input', { type: 'range', min: '-100', max: '100', step: '5', value: String(p.balance), oninput: () => { updatePrefs({ balance: Number(bal.value) }); applySound(); } }) as HTMLInputElement;
    const del = h('input', { type: 'number', min: '0', max: '5', step: '0.05', value: String(p.audioDelay), style: { width: '6em' }, onchange: () => { updatePrefs({ audioDelay: Math.max(0, Math.min(5, Number(del.value) || 0)) }); applySound(); } }) as HTMLInputElement;
    sh.body.append(h('label', { class: 'field' }, h('span', { class: 'row' }, h('span', null, t('volume')), volOut), vol),
      h('h4', null, t('equalizer')), h('label', { class: 'row switch-row' }, h('span', null, t('eqOn')), onSw), h('div', { class: 'row' }, h('span', null, t('eqPreset')), presetBtn), h('label', { class: 'field' }, h('span', null, t('eqPreamp')), pre), eqBox,
      sw(t('normalizeAudio'), 'normalize', t('normalizeAudioHint')), sw(t('monoAudio'), 'mono'),
      h('label', { class: 'field' }, h('span', null, t('audioBalance')), bal),
      h('div', { class: 'row' }, h('span', null, t('audioDelay'), h('small', { class: 'src' }, t('audioDelayHint'))), del));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { updatePrefs({ eqOn: false, eq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], eqPreamp: 0, eqPreset: 'flat', normalize: false, mono: false, balance: 0, audioDelay: 0 }); applySound(); sh.close(); } }, t('reset')));
  }

  // ---- picture sheet: rotation, mirroring, crop, zoom, filters and their presets
  function videoSheet() {
    const sh = openSheet(t('videoSection'), t('close'));
    const chips = <T extends string | number>(items: [T, string][], cur: () => T, set: (v: T) => void) => { const box = h('div', { class: 'chips' }); const draw = () => box.replaceChildren(...items.map(([v, l]) => h('button', { type: 'button', class: 'chip small' + (cur() === v ? ' on' : ''), onclick: () => { set(v); draw(); } }, l))); draw(); return box; };
    const zoomR = h('input', { type: 'range', min: '100', max: '400', step: '5', value: String(Math.round(zoom * 100)), oninput: () => { zoom = Number(zoomR.value) / 100; applyTransform(); } }) as HTMLInputElement;
    const sliders = h('div');
    const drawSliders = () => { const f = getPrefs().filters; const s = (label: string, k: keyof PlayerPrefs['filters'], min: number, max: number) => { const out = h('b', null, localDigits(f[k])); return h('label', { class: 'field' }, h('span', { class: 'row' }, h('span', null, label), out), h('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(f[k]), oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); updatePrefs({ filters: { ...getPrefs().filters, [k]: v } }); out.textContent = localDigits(v); applyFilters(); } })); };
      sliders.replaceChildren(s(t('filterBrightness'), 'brightness', 30, 200), s(t('filterContrast'), 'contrast', 30, 200), s(t('filterSaturation'), 'saturation', 0, 300), s(t('filterHue'), 'hue', -180, 180), s(t('filterGamma'), 'gamma', 30, 300), s(t('filterSharpness'), 'sharpness', 0, 100), s(t('filterTemperature'), 'temperature', -100, 100)); };
    drawSliders();
    const presetItems: [string, string][] = [['', t('filterNone')], ...Object.keys(FILTER_PRESETS).map((k) => [k, t(`fx_${k}` as 'fx_vivid')] as [string, string])];
    sh.body.append(
      h('h4', null, t('rotation')), chips<number>([[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']].map(([v, l]) => [v as number, localDigits(l as string)]), () => rotate, (v) => { rotate = v as 0; applyTransform(); }),
      h('div', { class: 'chips' }, h('button', { type: 'button', class: 'chip small' + (flipH ? ' on' : ''), onclick: (e: Event) => { flipH = !flipH; (e.currentTarget as HTMLElement).classList.toggle('on', flipH); applyTransform(); } }, t('flipH')), h('button', { type: 'button', class: 'chip small' + (flipV ? ' on' : ''), onclick: (e: Event) => { flipV = !flipV; (e.currentTarget as HTMLElement).classList.toggle('on', flipV); applyTransform(); } }, t('flipV'))),
      h('h4', null, t('aspectRatio')), chips<PlayerPrefs['aspect']>(ASPECTS.map((a) => [a, aspectName(a)]), () => aspect, (v) => { aspect = v; applyAspect(); remember(key, { aspect }); }),
      h('h4', null, t('cropTo')), chips<string>(CROPS.map((c) => [c, c ? localDigits(c) : t('cropOff')]), () => crop, (v) => { crop = v; applyTransform(); }),
      h('label', { class: 'field' }, h('span', null, t('zoomLevel')), zoomR),
      h('h4', null, t('filterPresets')), chips<string>(presetItems, () => getPrefs().filterPreset, (v) => { updatePrefs({ filterPreset: v }); applyFilters(); }),
      h('h4', null, t('videoFilters')), sliders);
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { updatePrefs({ filters: { ...DEFAULT_FILTERS }, filterPreset: '' }); brightness = 1; rotate = 0; flipH = flipV = false; crop = ''; zoom = 1; panX = panY = 0; applyFilters(); applyTransform(); sh.close(); } }, t('reset')));
  }

  // ---- speed, bookmarks, jump, playlist, more
  function speedSheet() {
    const sh = openSheet(t('speed'), t('close')); const p = getPrefs(); const out = h('b', { class: 'speed-out' }, `${localDigits(speed)}×`);
    const range = h('input', { type: 'range', min: '0.25', max: '4', step: '0.05', value: String(speed), oninput: () => { setSpeed(Number(range.value)); out.textContent = `${localDigits(speed)}×`; } }) as HTMLInputElement;
    const step = (d: number) => { setSpeed(speed + d); range.value = String(speed); out.textContent = `${localDigits(speed)}×`; };
    sh.body.append(h('div', { class: 'chips' }, ...p.speedPresets.map((v) => h('button', { type: 'button', class: 'chip' + (v === speed ? ' on' : ''), onclick: () => { setSpeed(v); sh.close(); } }, `${localDigits(v)}×`))),
      h('div', { class: 'score-row' }, iconButton('minus', '−0.05', () => step(-0.05)), range, iconButton('plus', '+0.05', () => step(0.05)), out),
      h('label', { class: 'row switch-row' }, h('span', null, t('pitchCorrection')), h('input', { type: 'checkbox', checked: p.pitchCorrection, onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; updatePrefs({ pitchCorrection: on }); video.preservesPitch = on; } })));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { updatePrefs({ defaultSpeed: speed }); toast(t('speedDefaultSet', { s: localDigits(speed) })); } }, t('speedMakeDefault')));
  }
  function addBookmark() { const tm = video.currentTime; marks = [...marks.filter((m) => Math.abs(m.t - tm) > 1), { t: tm, label: fmtTime(tm) }].sort((a, b) => a.t - b.t); remember(key, { marks }); drawMarks(); flashText(`🔖 ${fmtTime(tm)}`); }
  function bookmarksSheet() {
    const sh = openSheet(t('bookmarks'), t('close')); const list = h('div', { class: 'dest-list' });
    const draw = () => list.replaceChildren(...(marks.length ? marks.map((m, i) => h('div', { class: 'dest-row' }, h('button', { type: 'button', class: 'grow plain', onclick: () => { seekTo(m.t); sh.close(); } }, h('span', { class: 'ep-num' }, localDigits(i + 1)), h('span', { class: 'name', dir: 'auto' }, m.label), h('small', { class: 'src' }, fmtTime(m.t))),
      iconButton('pen', t('rename'), () => { const v = prompt(t('rename'), m.label); if (v !== null) { m.label = v.trim() || fmtTime(m.t); remember(key, { marks }); draw(); drawMarks(); } }), iconButton('trash', t('delete'), () => { marks = marks.filter((x) => x !== m); remember(key, { marks }); draw(); drawMarks(); }))) : [h('p', { class: 'src' }, t('bookmarksNone'))]));
    draw(); sh.body.append(list); sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { addBookmark(); draw(); } }, icon('bookmarkAdd'), t('bookmarkHere', { t: fmtTime(video.currentTime) })));
  }
  function jumpSheet() {
    const sh = openSheet(t('jumpToTime'), t('close')); const input = h('input', { type: 'text', dir: 'ltr', inputmode: 'numeric', placeholder: '1:23:45', value: fmtTime(video.currentTime).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))) }) as HTMLInputElement;
    const go = () => { const s = parseTime(input.value); if (s === null || !(s >= 0)) { toast(t('jumpBad'), 'error'); return; } seekTo(s); sh.close(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
    sh.body.append(h('p', { class: 'src' }, t('jumpHint', { d: fmtTime(video.duration) })), input); sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: go }, t('jumpGo'))); setTimeout(() => input.select(), 50);
  }
  function playlistSheet() {
    const list = src.playlist ?? []; const sh = openSheet(t('playlist'), t('close'));
    sh.body.append(h('div', { class: 'dest-list' }, ...list.map((it, i) => { const seen = memoryOf(it.localPath ?? it.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'stream:')); return h('button', { type: 'button', class: 'dest-row' + (it.url === src.url ? ' on' : ''), onclick: () => { sh.close(); if (it.url !== src.url) playAt(it); } }, h('span', { class: 'ep-num' }, localDigits(i + 1)), h('span', { class: 'name grow', dir: 'auto' }, it.name), seen?.watched ? icon('check') : seen?.pos && seen.duration ? h('small', { class: 'src' }, `${localDigits(Math.round((seen.pos / seen.duration) * 100))}%`) : null); })));
  }
  const repeatName = () => (repeat === 'one' ? t('repeatOne') : repeat === 'all' ? t('repeatAll') : t('repeatOff'));
  // ---- the other files of a torrent (Hayase's picker): when the file chosen for an episode was the wrong one, any
  // video of the release played instead — it is fetched first, the one left behind stops downloading.
  function batchFiles(): Task['files'] {
    const tk = src.task; if (!tk || tk.kind !== 'torrent') return [];
    return tk.files.filter((f) => VIDEO_EXT.test(f.path));
  }
  function batchSheet() {
    const tk0 = src.task; if (!tk0) return; const sh = openSheet(t('batchFiles'), t('close'));
    sh.body.append(h('p', { class: 'hint' }, t('batchFilesHint')));
    const rows = h('div', { class: 'dest-list' });
    void Promise.all([import('../views/pickFiles'), import('../engine').then((E) => E.getEngine().list()).catch(() => [] as Task[])]).then(([{ guess }, ts]) => {
      const tk = ts.find((x) => x.id === tk0.id) ?? tk0; const files = tk.files.filter((f) => VIDEO_EXT.test(f.path));
      const g = new Map(guess({ name: tk.name, files: files.map((f) => ({ index: f.index, path: f.path, size: f.size })) } as never).map((x) => [x.index, x]));
      const ordered = [...files].sort((a, b) => (g.get(a.index)?.episode ?? 1e9) - (g.get(b.index)?.episode ?? 1e9) || a.path.localeCompare(b.path, undefined, { numeric: true }));
      rows.replaceChildren(...ordered.map((f) => { const x = g.get(f.index); const cur = f.index === src.fileIndex; const done = f.size > 0 && f.done >= f.size;
        const tags = [x?.episode !== undefined ? t('episodeN', { n: localDigits(x.episode) }) : '', x?.extra ? t('pickExtra') : '', formatBytes(f.size), done ? t('fileFinished') : f.done ? `${Math.floor((f.done / f.size) * 100)}%` : ''].filter(Boolean).join(' · ');
        return h('button', { type: 'button', class: 'dest-row' + (cur ? ' on' : ''), 'aria-current': cur ? 'true' : undefined, onclick: () => { sh.close(); if (!cur) void switchTo(f.index); } }, icon(cur ? 'play' : 'film'), h('span', { class: 'grow' }, h('span', { dir: 'auto', class: 'pick-name' }, f.path.split('/').pop()), h('small', { class: 'src' }, tags)));
      }));
    });
    sh.body.append(rows);
  }
  async function switchTo(index: number) {
    const tk = src.task; if (!tk) return; const { getEngine } = await import('../engine'); const eng = getEngine();
    const live = (await eng.list().catch(() => [] as Task[])).find((x) => x.id === tk.id) ?? tk;
    if (eng.setFiles) await eng.setFiles(live.id, live.files.map((f) => (f.index === index ? 2 : f.priority === 2 && f.done < f.size ? 0 : f.priority) as 0 | 1 | 2)).catch(() => undefined);
    const fresh = (await eng.list().catch(() => [] as Task[])).find((x) => x.id === tk.id) ?? live;
    close(); const { playTaskFile } = await import('../views/player'); await playTaskFile({ ...fresh, files: fresh.files.map((f) => (f.index === index ? { ...f, priority: 2 as const } : f)) }, index);
  }
  // ---- REX Player's tools: every button of its legend, those chosen on the bar (in their order), all in the grid
  type Tool = { id: string; icon: string; label: string; run: () => void; text?: string; on?: () => boolean; show?: () => boolean };
  const TOOLS: Tool[] = [
    { id: 'chapters', icon: 'chapters', label: t('toolChaptersBookmarks'), run: () => (chapters.length ? chaptersSheet() : bookmarksSheet()) },
    { id: 'speed', icon: 'gauge', label: t('playbackSpeed'), run: () => speedSheet() },
    { id: 'decoder', icon: 'chip', label: t('toolDecoder'), run: () => decoderSheet() },
    { id: 'rotation', icon: 'screenRotate', label: t('toolScreenRotation'), run: () => cycleOrientation() },
    { id: 'frames', icon: 'aperture', label: t('toolFrames'), run: () => frameSheet() },
    { id: 'zoom', icon: 'zoomIn', label: t('toolZoom'), run: () => zoomSheet() },
    { id: 'pip', icon: 'mini', label: t('pip'), run: () => void pip(), show: () => 'pictureInPictureEnabled' in document && !mpv },
    { id: 'aspect', icon: 'aspect', label: t('toolAspect'), run: () => cycleAspect() },
    { id: 'lock', icon: 'lock', label: t('lockScreen'), run: () => lock(true) },
    { id: 'audio', icon: 'music', label: t('audioTracks'), run: () => audioSheet() },
    { id: 'subs', icon: 'subtitles', label: t('navSubs'), run: () => void subsSheet() },
    { id: 'chapter', icon: 'bookmark', label: t('toolCurrentChapter'), run: () => { const c = chapters.find((x) => video.currentTime >= x.start && video.currentTime < x.end); if (c) flashText(c.title || fmtTime(c.start), true); if (chapters.length) chaptersSheet(); else flashText(t('noChapters')); } },
    { id: 'repeat', icon: 'repeat', label: t('repeatMode'), run: () => { repeat = repeat === 'off' ? 'one' : repeat === 'one' ? 'all' : 'off'; updatePrefs({ repeat }); flashText(repeatName()); drawTools(); }, on: () => repeat !== 'off' },
    { id: 'shuffle', icon: 'shuffle', label: t('toolShuffle'), run: () => { updatePrefs({ shuffle: !getPrefs().shuffle }); flashText(getPrefs().shuffle ? t('shuffleOn') : t('shuffleOff')); drawTools(); }, on: () => getPrefs().shuffle },
    { id: 'flipH', icon: 'flipH', label: t('toolFlipH'), run: () => { flipH = !flipH; applyTransform(); drawTools(); }, on: () => flipH },
    { id: 'flipV', icon: 'flipV', label: t('toolFlipV'), run: () => { flipV = !flipV; applyTransform(); drawTools(); }, on: () => flipV },
    { id: 'ab', icon: '', text: 'AB', label: t('toolAbLoop'), run: () => abPress(), on: () => abA !== null && abB !== null },
    { id: 'skip', icon: 'skipFwd', label: t('toolCustomSkip'), run: () => seekBy(getPrefs().skipAmount) },
    { id: 'background', icon: 'headphones', label: t('backgroundPlay'), run: () => { updatePrefs({ backgroundPlay: !getPrefs().backgroundPlay }); flashText(getPrefs().backgroundPlay ? t('backgroundOn') : t('backgroundOff')); drawTools(); }, on: () => getPrefs().backgroundPlay },
    { id: 'ambient', icon: 'ambience', label: t('ambientMode'), run: () => { updatePrefs({ ambient: !getPrefs().ambient }); ambientTick(); drawTools(); }, on: () => getPrefs().ambient },
    { id: 'sleep', icon: 'timer', label: t('sleepTimer'), run: () => sleepSheet(), on: () => !!sleepAt },
    { id: 'quality', icon: 'hq', label: t('toolQuality'), run: () => qualitySheet() },
    { id: 'cut', icon: 'scissors', label: t('toolCut'), run: () => void cutSheet() },
    { id: 'shot', icon: 'camera', label: t('screenshot'), run: () => screenshot() },
    { id: 'bookmark', icon: 'bookmarkAdd', label: t('addBookmark'), run: () => addBookmark() },
    { id: 'jump', icon: 'clock', label: t('jumpToTime'), run: () => jumpSheet() },
    { id: 'info', icon: 'info', label: t('mediaInfo'), run: () => infoSheet() },
    { id: 'stats', icon: 'chart', label: t('statsOverlay'), run: () => toggleStats(), on: () => !!statsBox },
    { id: 'copyTime', icon: 'copy', label: t('copyTime'), run: () => { const at = fmtTime(video.currentTime); void navigator.clipboard?.writeText(`${src.name} — ${at}`).then(() => flashText(t('copiedTime', { t: at }))); } },
    { id: 'keys', icon: 'keyboard', label: t('shortcutsTitle'), run: () => shortcutsSheet(), show: () => nativePlatformIs('desktop') || nativePlatformIs('web') },
  ];
  const toolsHere = () => TOOLS.filter((x) => !x.show || x.show());
  function toolButton(x: Tool, withLabel = false): HTMLElement {
    // (The bar's own speed, A/B, aspect and skip buttons kept: their labels follow what they set.)
    if (!withLabel && x.id === 'speed') return speedBtn; if (!withLabel && x.id === 'ab') return abBtn; if (!withLabel && x.id === 'aspect') return aspectBtn; if (!withLabel && x.id === 'skip') return skipBtn;
    const b = h('button', { type: 'button', class: (withLabel ? 'kt-tool' : 'icon-btn') + (x.on?.() ? ' on' : ''), title: x.label, 'aria-label': x.label, 'aria-pressed': x.on ? String(!!x.on()) : null, onclick: () => x.run() }, x.text ? h('b', { class: 'kt-tool-text' }, x.text) : icon(x.icon), withLabel ? h('span', null, x.label) : null);
    return b;
  }
  function drawTools() {
    const P2 = getPrefs(); const portrait = window.innerHeight > window.innerWidth; const ids = [...P2.bar, ...(portrait ? (P2.portraitTools ?? []) : [])];
    toolBox.replaceChildren(...ids.map((id) => toolsHere().find((x) => x.id === id)).filter((x): x is Tool => !!x).map((x) => toolButton(x)));
    topToolBox.replaceChildren(...(P2.topTools ?? []).map((id) => toolsHere().find((x) => x.id === id)).filter((x): x is Tool => !!x).map((x) => toolButton(x)));
    root.classList.toggle('seek-below', !!P2.seekBelowButtons); root.classList.toggle('glass', !!P2.glassControls); root.classList.toggle('reduce-motion', !!P2.reduceMotion); root.classList.toggle('always-dark', P2.alwaysDark !== false);
  }
  window.addEventListener('resize', drawTools);
  // (The subtitles lifted over the control bar by its real height, whatever the layout gives it.)
  const barRo = new ResizeObserver(() => { root.style.setProperty('--kt-bottom-h', `${bottom.getBoundingClientRect().height}px`); }); barRo.observe(bottom);
  /** The grid of every tool, as REX Player's legend shows them; and the bar's layout, chosen there. */
  function toolsSheet() {
    const sh = openSheet(t('playerTools'), t('close'));
    sh.body.append(h('div', { class: 'kt-tool-grid' }, ...toolsHere().map((x) => { const b = toolButton(x, true); b.addEventListener('click', () => sh.close()); return b; })),
      h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); layoutSheet(); } }, icon('layout'), t('playerLayout'))));
  }
  function layoutSheet() {
    const sh = openSheet(t('playerLayout'), t('close')); const list = h('div', { class: 'dest-list' });
    const draw = () => { const bar = getPrefs().bar; const all = [...bar.map((id) => toolsHere().find((x) => x.id === id)).filter((x): x is Tool => !!x), ...toolsHere().filter((x) => !bar.includes(x.id))];
      list.replaceChildren(...all.map((x) => { const on = bar.includes(x.id); const i = bar.indexOf(x.id);
        return h('div', { class: 'dest-row' + (on ? ' on' : '') }, h('input', { type: 'checkbox', checked: on, 'aria-label': x.label, onchange: () => { updatePrefs({ bar: on ? bar.filter((y) => y !== x.id) : [...bar, x.id] }); draw(); drawTools(); } }), x.text ? h('b', { class: 'kt-tool-text' }, x.text) : icon(x.icon), h('span', { class: 'grow' }, x.label),
          on ? iconButton('arrowUp', t('moveUp'), () => { if (i <= 0) return; const b2 = [...bar]; [b2[i - 1], b2[i]] = [b2[i], b2[i - 1]]; updatePrefs({ bar: b2 }); draw(); drawTools(); }) : null,
          on ? iconButton('arrowDown', t('moveDown'), () => { if (i >= bar.length - 1) return; const b2 = [...bar]; [b2[i + 1], b2[i]] = [b2[i], b2[i + 1]]; updatePrefs({ bar: b2 }); draw(); drawTools(); }) : null); })); };
    draw(); sh.body.prepend(h('p', { class: 'hint' }, t('playerLayoutHint'))); sh.body.append(list);
    sh.actions.append(h('button', { type: 'button', class: 'btn text', onclick: () => { updatePrefs({ bar: [...DEFAULT_PREFS.bar] }); draw(); drawTools(); } }, t('reset')));
  }
  /** Frame by frame (REX Player's frame navigation): a frame back or on, ten at a time, the frame's number and time,
   *  saved as a picture, made A or B of the cut. */
  function frameSheet() {
    video.pause(); const sh = openSheet(t('toolFrames'), t('close')); const rate = () => fps || 30;
    const info = h('p', { class: 'kt-frame-info', dir: 'ltr' }); const paint = () => { info.textContent = `${fmtTime(video.currentTime)}.${String(Math.floor((video.currentTime % 1) * 1000)).padStart(3, '0')} · ${t('frameShort')} ${localDigits(Math.round(video.currentTime * rate()))} · ${localDigits(Math.round(rate() * 100) / 100)} fps`; };
    const step = (n: number) => { if (mpv && Math.abs(n) === 1) { mpv.command(n > 0 ? 'frame-step' : 'frame-back-step'); window.setTimeout(paint, 250); return; } seekTo(Math.max(0, video.currentTime + n / rate())); window.setTimeout(paint, 200); };
    const b = (label: string, fn: () => void, cls = 'chip') => h('button', { type: 'button', class: cls, onclick: fn }, label);
    sh.body.append(info, h('div', { class: 'kt-frame-row', dir: 'ltr' }, b('−10', () => step(-10)), b('−1', () => step(-1)), b('+1', () => step(1)), b('+10', () => step(10))),
      h('div', { class: 'row-actions wrap' },
        h('button', { type: 'button', class: 'btn tonal small', onclick: () => screenshot() }, icon('camera'), t('frameSave')),
        h('label', { class: 'row switch-row' }, h('span', null, t('frameWithSubs')), h('input', { type: 'checkbox', checked: getPrefs().shotSubs !== false, onchange: (e: Event) => updatePrefs({ shotSubs: (e.target as HTMLInputElement).checked }) })),
        h('button', { type: 'button', class: 'btn tonal small', onclick: () => { abA = video.currentTime; flashText(`A ${fmtTime(abA)}`); drawMarks(); } }, t('framePointA')),
        h('button', { type: 'button', class: 'btn tonal small', onclick: () => { abB = Math.max((abA ?? 0) + 0.04, video.currentTime); flashText(`B ${fmtTime(abB)}`); abBtn.classList.add('on'); drawMarks(); } }, t('framePointB')),
        h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void cutSheet(); } }, icon('scissors'), t('toolCut'))));
    paint(); video.addEventListener('seeked', paint);
  }
  /** The decoder (mpv): hardware, hardware with copying, software — the file opened again at the same place. */
  function decoderSheet() {
    const sh = openSheet(t('toolDecoder'), t('close'));
    if (!mpv) { sh.body.append(h('p', { class: 'hint' }, t('decoderWebOnly'))); return; }
    const now = h('small', { class: 'src' }); void (ktPluginMpvGet('hwdec-current')).then((v) => { now.textContent = `${t('decoderNow')}: ${v && v !== 'no' ? v : t('decoderSoftware')}`; });
    const choose = (v: PlayerPrefs['hwdec']) => { updatePrefs({ hwdec: v }); const ex = mpvExtra(getPrefs()); mpv.set('vo', ex.vo); mpv.set('hwdec', ex.hwdec); sh.close(); flashText(v === 'sw' ? t('decoderSoftware') : v === 'direct' ? t('decoderDirect') : t('decoderHw')); };
    sh.body.append(now, h('div', { class: 'dest-list' }, ...([['hw', t('decoderHw'), t('decoderHwHint')], ['direct', t('decoderDirect'), t('decoderDirectHint')], ['sw', t('decoderSoftware'), t('decoderSoftwareHint')]] as [PlayerPrefs['hwdec'], string, string][]).map(([v, l, d]) => h('button', { type: 'button', class: 'dest-row' + (getPrefs().hwdec === v ? ' on' : ''), onclick: () => choose(v) }, icon('chip'), h('span', { class: 'grow' }, h('span', null, l), h('small', { class: 'src', style: { display: 'block' } }, d))))));
  }
  const ktPluginMpvGet = async (name: string): Promise<string | null> => { const { ktPlugin } = await import('../native'); const kp = ktPlugin() as unknown as { mpvGet?(o: { name: string }): Promise<{ value: string | null }> } | null; try { return (await kp?.mpvGet?.({ name }))?.value ?? null; } catch { return null; } };
  /** The screen's turn: as the phone is held, landscape, portrait — kept locked so. */
  function cycleOrientation() {
    const o = screen.orientation as ScreenOrientation & { lock?(x: string): Promise<void>; unlock?(): void };
    const next = orientLock === 'any' ? 'landscape' : orientLock === 'landscape' ? 'portrait' : 'any'; orientLock = next;
    if (next === 'any') o.unlock?.(); else void o.lock?.(next).catch(() => toast(t('rotationUnavailable'), 'error'));
    flashText(next === 'any' ? t('orientationAuto') : next === 'landscape' ? t('orientationLandscape') : t('orientationPortrait'));
  }
  let orientLock: 'any' | 'landscape' | 'portrait' = 'any';
  /** The picture's zoom (and its pan put back). */
  function zoomSheet() {
    const sh = openSheet(t('toolZoom'), t('close')); const out = h('b', null, `${localDigits(Math.round(zoom * 100))}%`);
    const r = h('input', { type: 'range', min: '50', max: '400', step: '5', value: String(Math.round(zoom * 100)), oninput: () => { zoom = Number(r.value) / 100; out.textContent = `${localDigits(Math.round(zoom * 100))}%`; applyTransform(); } }) as HTMLInputElement;
    sh.body.append(h('div', { class: 'row' }, h('span', null, t('toolZoom')), out), r, h('div', { class: 'row-actions' }, h('button', { type: 'button', class: 'btn text small', onclick: () => { zoom = 1; panX = panY = 0; r.value = '100'; out.textContent = `${localDigits(100)}%`; applyTransform(); } }, t('reset'))));
  }
  /** The stream's qualities (an online stream's variants, as mpv lists them), or that there is only one. */
  function qualitySheet() {
    const sh = openSheet(t('toolQuality'), t('close'));
    const vids = mpv ? mpv.tracks().filter((x) => x.type === 'video') : [];
    if (vids.length < 2) { sh.body.append(h('p', { class: 'hint' }, video.videoHeight ? t('qualityOnly', { q: `${localDigits(video.videoWidth)}×${localDigits(video.videoHeight)}` }) : t('qualityOnlyUnknown'))); return; }
    sh.body.append(h('div', { class: 'dest-list' }, ...vids.map((x) => h('button', { type: 'button', class: 'dest-row' + (x.selected ? ' on' : ''), onclick: () => { mpv!.set('vid', x.id); sh.close(); } }, icon('hq'), h('span', { class: 'grow' }, x.title || `#${x.id}`), h('small', { class: 'src' }, (x.codec ?? '').toUpperCase())))));
  }
  // ---- stats for nerds: the picture, the decoder, frames dropped, the buffer ahead (mpv's own numbers with mpv)
  let statsBox: HTMLElement | null = null; let statsTimer = 0;
  function toggleStats() {
    if (statsBox) { statsBox.remove(); statsBox = null; window.clearInterval(statsTimer); drawTools(); return; }
    statsBox = h('pre', { class: 'kt-stats', dir: 'ltr' }); root.append(statsBox); drawTools();
    const tick = async () => {
      if (!statsBox) return; const lines: string[] = [];
      lines.push(`${video.videoWidth}×${video.videoHeight}  ${fps ? `${Math.round(fps * 100) / 100} fps` : ''}  ×${video.playbackRate}`);
      let ahead = 0; for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.1) ahead = Math.max(ahead, video.buffered.end(i) - video.currentTime);
      lines.push(`${t('statsBuffered')}: ${ahead.toFixed(1)} s`);
      if (mpv) { const g = async (n: string) => (await ktPluginMpvGet(n)) ?? '–';
        const [vc, hw, vf, drop, vbr, ac, abr] = await Promise.all(['video-codec', 'hwdec-current', 'estimated-vf-fps', 'frame-drop-count', 'video-bitrate', 'audio-codec-name', 'audio-bitrate'].map(g));
        lines.push(`video: ${vc}`, `hwdec: ${hw}  out fps: ${vf === '–' ? '–' : Number(vf).toFixed(2)}  dropped: ${drop}`, `bitrate: ${vbr === '–' ? '–' : `${Math.round(Number(vbr) / 1000)} kb/s`}`, `audio: ${ac}  ${abr === '–' ? '' : `${Math.round(Number(abr) / 1000)} kb/s`}`, 'engine: mpv');
      } else { const q = (video as HTMLVideoElement & { getVideoPlaybackQuality?(): { totalVideoFrames: number; droppedVideoFrames: number } }).getVideoPlaybackQuality?.(); if (q) lines.push(`frames: ${q.totalVideoFrames}  dropped: ${q.droppedVideoFrames}`); lines.push(`engine: ${beside ? 'web + ffmpeg sound' : 'web'}`); }
      if (statsBox) statsBox.textContent = lines.join('\n');
    };
    void tick(); statsTimer = window.setInterval(() => void tick(), 1000);
  }
  /** The keys, as a list (a computer's keyboard). */
  function shortcutsSheet() {
    const sh = openSheet(t('shortcutsTitle'), t('close'));
    const keys: [string, string][] = [['Space / K', t('play') + ' / ' + t('pause')], ['← →', t('scSeek')], ['↑ ↓', t('scVolume')], ['F', t('fullscreen')], ['M', t('scMute')], [', .', t('frameBack') + ' / ' + t('frameForward')], ['A', t('toolAbLoop')], ['S', t('screenshot')], ['V', t('scNextSub')], ['B', t('scNextAudio')], ['C', t('scCrop')], ['R', t('scRotate')], ['Z X', t('scSubDelay')], ['N P', t('next') + ' / ' + t('previous')], ['T', t('scShowTime')], ['I', t('mediaInfo')], ['0–9', t('scJumpPct')], ['Home / End', t('scStartEnd')], ['Esc', t('close')], ['?', t('shortcutsTitle')]];
    sh.body.append(h('div', { class: 'info-list' }, ...keys.map(([k, v]) => h('div', { class: 'row' }, h('kbd', { dir: 'ltr' }, k), h('span', null, v)))));
  }
  drawTools();
  function moreSheet() {
    const sh = openSheet(src.name, t('close'));
    const row = (ic: string, label: string, fn: () => void, extra?: string) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label), extra ? h('small', { class: 'src' }, extra) : null);
    sh.body.append(h('div', { class: 'dest-list' },
      row('film', t('videoSection'), () => videoSheet(), [rotate ? `${localDigits(rotate)}°` : '', crop ? localDigits(crop) : '', getPrefs().filterPreset ? t(`fx_${getPrefs().filterPreset}` as 'fx_vivid') : ''].filter(Boolean).join(' · ') || undefined),
      row('music', t('audioSection'), () => audioSheet(), getPrefs().eqOn ? t('equalizer') : undefined),
      ...(src.playlist && src.playlist.length > 1 ? [row('list', t('playlist'), () => playlistSheet(), localDigits(src.playlist.length))] : []),
      ...(batchFiles().length > 1 ? [row('folder', t('batchFiles'), () => batchSheet(), localDigits(batchFiles().length))] : []),
      row('bookmark', t('bookmarks'), () => bookmarksSheet(), marks.length ? localDigits(marks.length) : undefined),
      row('clock', t('jumpToTime'), () => jumpSheet()),
      row('refresh', t('repeatMode'), () => { repeat = repeat === 'off' ? 'one' : repeat === 'one' ? 'all' : 'off'; updatePrefs({ repeat }); toast(repeatName()); }, repeatName()),
      ...(src.playlist && src.playlist.length > 1 ? [row('sort', getPrefs().shuffle ? t('shuffleOff') : t('shuffleOn'), () => { updatePrefs({ shuffle: !getPrefs().shuffle }); toast(getPrefs().shuffle ? t('shuffleOn') : t('shuffleOff')); })] : []),
      row('scroll', t('cutClip'), () => void cutSheet(), abA !== null && abB !== null ? `${fmtTime(abA)} – ${fmtTime(abB)}` : t('cutClipHint')),
      row('moon', t('sleepTimer'), () => sleepSheet(), sleepAt ? fmtTime((sleepAt - Date.now()) / 1000) : undefined),
      ...(chapters.length ? [row('toc', t('chapters'), () => chaptersSheet(), localDigits(chapters.length))] : []),
      row(pictureOff ? 'eye' : 'music', pictureOff ? t('pictureOn') : t('pictureOff'), () => { pictureOff = !pictureOff; root.classList.toggle('picture-off', pictureOff); }),
      row('heart', getPrefs().ambient ? t('ambientOff') : t('ambientOn'), () => { updatePrefs({ ambient: !getPrefs().ambient }); ambientTick(); }),
      ...(remote && !video.disableRemotePlayback ? [row('tv', t('castTo'), () => void cast())] : []),
      ...(canOpenWith() ? [row('external', t('openWithPlayer'), () => void openWith())] : []),
      row('plus', t('customButtons'), () => customSheet(), getPrefs().customButtons.length ? localDigits(getPrefs().customButtons.length) : undefined),
      row('info', t('mediaInfo'), () => infoSheet()),
      row('external', t('openWithSystem'), () => void import('../native').then((n) => n.openExternal(src.localPath ? `file://${src.localPath}` : src.url))),
      row('settings', t('playerSettings'), () => playerSettingsSheet())));
  }
  function customSheet() {
    const sh = openSheet(t('customButtons'), t('close')); const list = h('div', { class: 'dest-list' });
    const acts: [PlayerPrefs['customButtons'][number]['act'], string][] = [['seek', t('cbSeek')], ['speed', t('cbSpeed')], ['jump', t('cbJump')], ['ab', t('cbAb')], ['shot', t('screenshot')], ['sub', t('cbSub')], ['audio', t('cbAudio')], ['subline', t('subNextLine')]];
    const draw = () => list.replaceChildren(...(getPrefs().customButtons.length ? getPrefs().customButtons.map((b, i) => h('div', { class: 'dest-row' }, h('b', { class: 'kt-chip' }, customLabel(b)), h('span', { class: 'grow' }, acts.find((a) => a[0] === b.act)?.[1] ?? b.act), iconButton('trash', t('delete'), () => { const l = [...getPrefs().customButtons]; l.splice(i, 1); updatePrefs({ customButtons: l }); draw(); drawCustom(); }))) : [h('p', { class: 'src' }, t('cbNone'))]));
    let act: PlayerPrefs['customButtons'][number]['act'] = 'seek';
    const val = h('input', { type: 'text', dir: 'ltr', value: '85', style: { width: '7em' } }) as HTMLInputElement;
    const hint = h('small', { class: 'src' }, t('cbSeekHint'));
    const pick = pickButton(t('cbAction'), acts, act, (v) => { act = v; val.hidden = !['seek', 'speed', 'jump'].includes(v); val.value = v === 'seek' ? '85' : v === 'speed' ? '1.5' : v === 'jump' ? fmtTime(video.currentTime).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d))) : ''; hint.textContent = v === 'seek' ? t('cbSeekHint') : v === 'speed' ? t('cbSpeedHint') : v === 'jump' ? t('cbJumpHint') : ''; }, t('close'));
    draw();
    sh.body.append(list, h('h4', null, t('cbAdd')), h('div', { class: 'row' }, h('span', null, t('cbAction')), pick), h('div', { class: 'row' }, h('span', null, t('cbValue'), hint), val));
    sh.actions.append(h('button', { type: 'button', class: 'btn primary', onclick: () => { let v: number | undefined; if (act === 'seek' || act === 'speed') v = Number(val.value.replace(',', '.')); else if (act === 'jump') v = parseTime(val.value) ?? undefined; if (['seek', 'speed', 'jump'].includes(act) && (v === undefined || !isFinite(v) || (act === 'speed' && (v <= 0 || v > 8)))) { toast(t('cbBad'), 'error'); return; } updatePrefs({ customButtons: [...getPrefs().customButtons, { act, v }].slice(0, 8) }); draw(); drawCustom(); } }, icon('plus'), t('cbAdd')));
  }
  function sleepSheet() { const sh = openSheet(t('sleepTimer'), t('close')); sh.body.append(h('div', { class: 'chips' }, h('button', { type: 'button', class: 'chip' + (sleepAtEnd ? ' on' : ''), onclick: () => { sleepAtEnd = !sleepAtEnd; sleepAt = 0; toast(sleepAtEnd ? t('sleepAtEndSet') : t('sleepTimerOff')); sh.close(); } }, t('sleepAtEnd')), ...[0, 5, 10, 15, 30, 45, 60, 90, 120].map((m) => h('button', { type: 'button', class: 'chip', onclick: () => { sleepAt = m ? Date.now() + m * 60000 : 0; toast(m ? t('sleepTimerSet', { n: m }) : t('sleepTimerOff')); sh.close(); } }, m ? t('minutesN', { n: m }) : t('sleepTimerOff'))), h('button', { type: 'button', class: 'chip', onclick: () => { sleepAt = Date.now() + Math.max(1, (video.duration - video.currentTime) / speed) * 1000; toast(t('sleepTimerEnd')); sh.close(); } }, t('sleepTimerEnd')))); }
  function infoSheet() {
    const sh = openSheet(t('mediaInfo'), t('close'));
    const rows: [string, string][] = [[t('fileName'), src.name], [t('resolution'), `${localDigits(video.videoWidth)}×${localDigits(video.videoHeight)}`], [t('duration'), fmtTime(video.duration)]];
    if (fps) rows.push([t('frameRate'), `${localDigits(fps)} fps`]);
    const a = audioTracks(); if (a) rows.push([t('audioTracks'), localDigits(a.length)]);
    rows.push([t('subtitlesCount'), localDigits(tracks.length)]);
    if (src.task?.total) rows.push([t('size'), formatBytes(src.task.total)]);
    const q = (video as HTMLVideoElement & { getVideoPlaybackQuality?(): { droppedVideoFrames: number; totalVideoFrames: number } }).getVideoPlaybackQuality?.(); if (q) rows.push([t('frames'), `${localDigits(q.totalVideoFrames)} (${t('dropped', { n: q.droppedVideoFrames })})`]);
    rows.push(['URL', src.localPath ?? src.url]);
    const dl = h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { dir: 'auto' }, v)]));
    sh.body.append(dl);
    // (Streams and codecs from ffprobe, where it is at hand.)
    void (async () => { if (!src.localPath) return; const pr = await probe(); const st = (pr as { streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number; channels?: number; sample_rate?: string; tags?: { language?: string; title?: string } }[] } | null)?.streams ?? []; if (!st.length) return; dl.append(h('dt', null, t('streams')), h('dd', { dir: 'ltr' }, st.map((s) => `${s.codec_type} · ${s.codec_name}${s.width ? ` ${s.width}×${s.height}` : ''}${s.channels ? ` ${s.channels}ch ${s.sample_rate ?? ''}` : ''}${s.tags?.language ? ` [${s.tags.language}]` : ''}`).join('\n'))); })();
  }
  function playerSettingsSheet() {
    const sh = openSheet(t('playerSettings'), t('close'));
    void import('./panel').then((m) => sh.body.append(m.playerPrefsPanel((keys) => {
      if (keys.some((k) => /^sub/.test(k))) { applySubStyle(); delete subBox.dataset.last; drawSubs(video.currentTime); }
      if (keys.some((k) => ['normalize', 'mono', 'balance', 'audioDelay', 'volumeBoost'].includes(k))) applySound();
      if (keys.includes('aspect')) { aspect = getPrefs().aspect; applyAspect(); }
      if (keys.includes('showClock')) clock.hidden = !getPrefs().showClock;
      if (keys.some((k) => ['accent', 'seekStyle', 'controlsDim', 'showTitle', 'chapterMarks', 'controlSize'].includes(k))) applySubStyle();
      if (keys.includes('bar')) drawTools();
      if (keys.includes('showRemaining')) onTime();
      if (keys.includes('repeat')) repeat = getPrefs().repeat;
      if (keys.includes('ambient')) ambientTick();
      if (keys.includes('pitchCorrection')) video.preservesPitch = getPrefs().pitchCorrection;
    })));
  }
  async function cutSheet() { const { cutClipSheet } = await import('./cut'); await cutClipSheet({ src, a: abA ?? Math.max(0, video.currentTime - 30), b: abB ?? video.currentTime, duration: video.duration, subtitle: current ? { name: current.name, ass: current.ass, cues: current.cues, delay: subDelay , style: { font: getPrefs().subFont, size: getPrefs().subSize, color: getPrefs().subColor, outline: getPrefs().subOutline, outlineWidth: getPrefs().subOutlineWidth, bold: getPrefs().subBold, italic: getPrefs().subItalic, pos: getPrefs().subPos, background: getPrefs().subBackground } } : undefined, video, fps: fps || undefined, setRange: (x, y) => { abA = x; abB = y; abBtn.classList.add('on'); drawMarks(); } }); }

  // ---- REX Player's extras: the ambient glow, chapters, skipping openings (AniSkip), another player
  // The ambient glow: the picture's average colour spilled around it, a few times a second.
  const amb = document.createElement('canvas'); amb.width = 8; amb.height = 5; let ambTimer = 0;
  function ambientTick() { window.clearInterval(ambTimer); root.classList.toggle('ambient', getPrefs().ambient); if (!getPrefs().ambient) return; const g = amb.getContext('2d', { willReadFrequently: true }); ambTimer = window.setInterval(() => { if (!g || video.paused || !video.videoWidth) return; try { g.drawImage(video, 0, 0, 8, 5); const d = g.getImageData(0, 0, 8, 5).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; root.style.setProperty('--ambient', `rgb(${Math.round(r / n)} ${Math.round(gg / n)} ${Math.round(b / n)})`); } catch { /* a protected stream */ } }, 350); }
  ambientTick();
  // Chapters of a local file (ffprobe), marked on the bar; openings and endings among them become skips.
  let chapters: { start: number; end: number; title: string }[] = [];
  const skips: { start: number; end: number; kind: 'op' | 'ed' | 'recap' | 'sponsor' | 'silence'; label?: string }[] = [];
  let probed: Promise<unknown> | null = null;
  const probe = () => (probed ??= (async () => {
    if (!src.localPath) return null;
    const d = window.kurokawaTools as unknown as { ffprobe?(p: string): Promise<unknown> } | undefined;
    const { ktPlugin } = await import('../native'); const kp = ktPlugin() as unknown as { ffprobe?(o: { path: string }): Promise<{ json: string }> } | null;
    try { return d?.ffprobe ? await d.ffprobe(src.localPath) : kp?.ffprobe ? JSON.parse((await kp.ffprobe({ path: src.localPath })).json) : null; } catch { return null; }
  })());
  void (async () => {
    const pr = await probe() as { chapters?: { start_time: string; end_time: string; tags?: { title?: string } }[] } | null;
    chapters = (pr?.chapters ?? []).map((c) => ({ start: Number(c.start_time), end: Number(c.end_time), title: c.tags?.title ?? '' })).filter((c) => isFinite(c.start) && c.end > c.start);
    for (const c of chapters) { const sb = /^\[SponsorBlock\]:?\s*(.*)$/i.exec(c.title); if (sb) { skips.push({ start: c.start, end: c.end, kind: 'sponsor', label: sb[1] }); continue; } const k = /^(op|opening|intro)\b/i.test(c.title) ? 'op' : /^(ed|ending|outro|credits)\b/i.test(c.title) ? 'ed' : /recap|previously/i.test(c.title) ? 'recap' : null; if (k) skips.push({ start: c.start, end: c.end, kind: k }); }
    chapters = chapters.filter((c) => !/^\[SponsorBlock\]/i.test(c.title));
    // (The SponsorBlock stretches drawn on the bar as coloured spans; the replay heatmap above it, from yt-dlp's info.json beside the file.)
    const drawSegs = () => { const dur = video.duration || 0; if (!dur) return; bar.querySelectorAll('.kt-sb').forEach((x) => x.remove()); for (const s of skips) if (s.kind === 'sponsor') bar.append(h('i', { class: 'kt-sb', title: s.label ?? '', style: { insetInlineStart: `${(s.start / dur) * 100}%`, width: `${((s.end - s.start) / dur) * 100}%` } })); };
    if (video.duration) drawSegs(); else video.addEventListener('loadedmetadata', drawSegs, { once: true });
    if (src.localPath && getPrefs().heatmap) { void (async () => { const { readSidecar } = await import('../downloads/sidecars'); const raw = await readSidecar(src.localPath!.replace(/\.[^./]+$/, '') + '.info.json'); if (!raw) return; let hm: { start_time: number; end_time: number; value: number }[] = []; try { hm = (JSON.parse(raw) as { heatmap?: typeof hm }).heatmap ?? []; } catch { return; } if (!hm.length) return; const draw = () => { const dur = video.duration || 0; if (!dur) return; let heat = bar.querySelector('.kt-heat') as HTMLElement | null; if (!heat) { heat = h('div', { class: 'kt-heat' }); bar.append(heat); } heat.replaceChildren(...hm.map((x) => h('i', { style: { insetInlineStart: `${(x.start_time / dur) * 100}%`, width: `${((x.end_time - x.start_time) / dur) * 100}%`, height: `${Math.round(Math.max(0.08, Math.min(1, x.value)) * 100)}%` } }))); }; if (video.duration) draw(); else video.addEventListener('loadedmetadata', draw, { once: true }); })(); }
    if (src.localPath && getPrefs().skipSilence) { void (async () => { const { silenceMap, canMapSilence } = await import('./silence'); if (!canMapSilence()) return; for (const s of await silenceMap(src.localPath!)) if (s.end - s.start >= 1.2) skips.push({ start: s.start, end: s.end, kind: 'silence' }); })(); }
    const draw = () => { const dur = video.duration || 0; if (!dur) return; bar.querySelectorAll('.kt-chapter').forEach((x) => x.remove()); for (const c of chapters.slice(1)) bar.append(h('i', { class: 'kt-chapter', style: { insetInlineStart: `${(c.start / dur) * 100}%` } })); };
    if (video.duration) draw(); else video.addEventListener('loadedmetadata', draw, { once: true });
  })();
  function chapterStep(dir: number) { if (!chapters.length) { seekBy(dir * getPrefs().doubleTapSeek); return; } const c = video.currentTime; const i = chapters.findIndex((x) => c >= x.start && c < x.end); const nx = chapters[(i < 0 ? 0 : i) + dir]; if (nx) { seekTo(nx.start); flashText(nx.title || t('chapterN', { n: chapters.indexOf(nx) + 1 })); } }
  function chaptersSheet() { const sh = openSheet(t('chapters'), t('close')); sh.body.append(h('div', { class: 'dest-list' }, ...chapters.map((c, i) => h('button', { type: 'button', class: 'dest-row' + (video.currentTime >= c.start && video.currentTime < c.end ? ' on' : ''), onclick: () => { video.currentTime = c.start; sh.close(); } }, h('span', { class: 'ep-num' }, localDigits(i + 1)), h('span', { class: 'name grow', dir: 'auto' }, c.title || t('chapterN', { n: i + 1 })), h('small', { class: 'src' }, fmtTime(c.start)))))); }
  // AniSkip: an anime episode's opening and ending times, shared by its viewers (by MyAnimeList id and episode).
  void (async () => {
    const m = (src.task?.meta ?? src.meta) as { anilistId?: number; episode?: number } | undefined; if (!m?.anilistId || !m.episode || getPrefs().autoSkip === 'off') return;
    const { idsOf } = await import('../anilist'); const ids = await idsOf(m.anilistId).catch(() => ({} as { mal?: number })); if (!ids.mal) return;
    const len = await new Promise<number>((res) => { if (video.duration) res(video.duration); else video.addEventListener('loadedmetadata', () => res(video.duration), { once: true }); });
    try {
      const r = await request(`https://api.aniskip.com/v2/skip-times/${ids.mal}/${m.episode}?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&types[]=recap&episodeLength=${Math.round(len)}`);
      if (r.status !== 200) return; const j = JSON.parse(r.body) as { found?: boolean; results?: { interval: { startTime: number; endTime: number }; skipType: string }[] };
      for (const x of j.results ?? []) skips.push({ start: x.interval.startTime, end: x.interval.endTime, kind: /ed/.test(x.skipType) ? 'ed' : x.skipType === 'recap' ? 'recap' : 'op' });
    } catch { /* offline */ }
  })();
  const skipped = new Set<number>();
  function skipCheck(c: number) {
    const pp = getPrefs(); const modeOf = (k: typeof skips[number]['kind']) => (k === 'sponsor' ? pp.skipSponsor : k === 'silence' ? (pp.skipSilence ? 'auto' : 'off') : pp.autoSkip);
    const sk = skips.find((x) => modeOf(x.kind) !== 'off' && c >= x.start && c < x.end - (x.kind === 'silence' ? 0.3 : 1));
    if (!sk) { skipOp.hidden = true; return; }
    const i = skips.indexOf(sk); const mode = modeOf(sk.kind);
    if (sk.kind === 'silence') { if (!skipped.has(i)) { skipped.add(i); video.currentTime = sk.end - 0.2; } return; }
    const label = (did: boolean) => (sk.kind === 'sponsor' ? (did ? t('skippedSponsor') : t('skipSponsorBtn')) + (sk.label ? ` · ${sk.label}` : '') : t(did ? (sk.kind === 'op' ? 'skippedOpening' : sk.kind === 'ed' ? 'skippedEnding' : 'skippedRecap') : (sk.kind === 'op' ? 'skipOpening' : sk.kind === 'ed' ? 'skipEnding' : 'skipRecap')));
    if (mode === 'auto' && !skipped.has(i)) { skipped.add(i); video.currentTime = sk.end; flashText(label(true)); return; }
    skipOp.hidden = false; skipOp.textContent = label(false); skipOp.onclick = () => { video.currentTime = sk.end; skipOp.hidden = true; };
  }
  // Dragging the subtitles up or down moves them (REX Player's way); the position is kept. A pinch on them
  // resizes them.
  // (A swipe sideways on them goes to the next or the previous line; two fingers pinching them change their size.)
  const subPointers = new Map<number, { x: number; y: number }>(); let pinch0 = 0; let size0 = 0;
  for (const box of [subBox, subTop]) box.addEventListener('pointerdown', (e) => {
    if (locked || !(e.target as HTMLElement).closest('.kt-cue')) return; e.stopPropagation(); const r = stage.getBoundingClientRect(); const x0 = e.clientX, y0 = e.clientY; const top = box === subTop && !!secondary; const p0 = top ? getPrefs().sub2Pos : getPrefs().subPos; box.setPointerCapture(e.pointerId);
    subPointers.set(e.pointerId, { x: e.clientX, y: e.clientY }); let moved = false; let swiped = false;
    if (subPointers.size === 2) { const [a, b] = [...subPointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); size0 = top ? getPrefs().sub2Size : getPrefs().subSize; }
    const mv = (ev: PointerEvent) => {
      subPointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      if (subPointers.size >= 2 && pinch0 > 0) { const [a, b] = [...subPointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); const sz = Math.max(40, Math.min(250, Math.round((size0 * d) / pinch0 / 5) * 5)); if (top) updatePrefs({ sub2Size: sz }); else updatePrefs({ subSize: sz }); applySubStyle(); flashText(`${localDigits(sz)}%`, true); moved = true; return; }
      const dx = ev.clientX - x0, dy = ev.clientY - y0; if (!moved && Math.abs(dx) < 8 && Math.abs(dy) < 8) return; moved = true;
      if (Math.abs(dx) > Math.abs(dy) * 1.5) { if (!swiped && Math.abs(dx) > 48 && getPrefs().subtitleSwipe !== false) { swiped = true; subLine(dx > 0 !== (document.documentElement.dir === 'rtl') ? 1 : -1); } return; }
      if (swiped) return; const d = ((y0 - ev.clientY) / r.height) * 100; if (top) updatePrefs({ sub2Pos: Math.max(0, Math.min(90, Math.round(p0 - d))) }); else updatePrefs({ subPos: Math.max(5, Math.min(100, Math.round(p0 - d))) }); applySubStyle(); };
    const up = (ev: PointerEvent) => { subPointers.delete(ev.pointerId); if (subPointers.size < 2) pinch0 = 0; box.removeEventListener('pointermove', mv); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up); };
    box.addEventListener('pointermove', mv); box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
  });
  // Another player (VLC, MX, mpv…) through Android's chooser.
  function canOpenWith() { return !!(window as unknown as { Capacitor?: { isNativePlatform?(): boolean } }).Capacitor?.isNativePlatform?.(); }
  async function openWith() { const { ktPlugin } = await import('../native'); const kp = ktPlugin() as unknown as { openWith?(o: { url?: string; path?: string; mime: string; title: string }): Promise<void> } | null; try { video.pause(); await kp?.openWith?.({ url: src.localPath ? undefined : src.url, path: src.localPath, mime: 'video/*', title: src.name }); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }

  // ---- closing
  function close() {
    barRo.disconnect();
    playerGone = true;
    remember(key, { pos: video.currentTime, duration: video.duration, speed, sub: current?.id, subDelay });
    // (Opened by another app: the position and the length handed back to it, and the app steps aside.)
    if (src.forCaller) void import('../native').then(({ ktPlugin }) => (ktPlugin() as unknown as { playerDone?(o: { position: number; duration: number; endBy: string }): Promise<void> } | null)?.playerDone?.({ position: Math.round(video.currentTime * 1000), duration: Math.round((video.duration || 0) * 1000), endBy: video.ended ? 'playback_completion' : 'user' })).catch(() => undefined);
    // (A watched episode let go now, when that is the choice — once the player has let go of its file.)
    if (watchedSent && src.task) { const tk = src.task; setTimeout(() => void import('../downloads/episodeCache').then((c) => c.afterPlayback(tk)).then((gone) => { if (gone) toast(t('episodeDeletedWatched')); }), 800); }
    window.clearInterval(ambTimer); window.clearInterval(clockTimer); video.pause(); window.clearInterval(statsTimer); beside?.stop(); ass?.free(); sound?.close(); if (mpv) { mpv.close(); mpvDone(); } preview?.dispose(); pic.dispose(); video.removeAttribute('src'); video.load(); root.remove(); window.removeEventListener('keydown', onKey); document.removeEventListener('visibilitychange', onHidden);
    if ('mediaSession' in navigator) { try { navigator.mediaSession.metadata = null; for (const a of ['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'] as MediaSessionAction[]) navigator.mediaSession.setActionHandler(a, null); } catch { /* old */ } }
    void barsPlug?.systemBars?.({ mode: 'show' }).catch(() => undefined);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); void wake?.then((w) => w?.release()); void (screen.orientation as ScreenOrientation & { unlock?(): void }).unlock?.();
  }
  root.addEventListener('kt-close', close);
  (root as HTMLElement & { _kt?: unknown })._kt = { setVolume, applySound, subLine, syncMark, get subDelay() { return subDelay; }, get boost() { return boost; }, addBookmark, cycleCrop };
}
