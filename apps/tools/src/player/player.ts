// The video player (the Player add-on): the browser's decoder with the controls and gestures of REX Player and
// VLC around it — tap zones, swipe seek / volume / brightness, long-press speed, pinch zoom and pan, speed
// presets, frame steps, A/B loop, aspect modes, screenshots, picture-in-picture, a sleep timer, subtitles drawn
// by the app (SRT/VTT/ASS text, or libass when bundled) with size / colour / position / delay, subtitles found
// through the Subtitles add-on for the episode being watched, the position remembered, the episode marked
// watched on AniList near its end, and the A/B range cut to a file (with the subtitles burnt in) through ffmpeg.
import { h, icon, iconButton, toast, openSheet, pickButton } from '../ui/dom';
import { t, localDigits, formatBytes } from '../i18n';
import type { Task } from '../engine/types';
import { getPrefs, updatePrefs, memoryOf, remember, type PlayerPrefs } from './prefs';
import { parseCues, cuesAt, sniffFormat, decodeSubtitle, createAssRenderer, type Cue, type AssRenderer } from './subs';
import { request } from '../http';
import { siblingFiles, readLocal } from './files';

export interface PlayerSource { url: string; name: string; task?: Task; fileIndex?: number; localPath?: string; headers?: Record<string, string>; playlist?: PlayerSource[];
  /** The show and episode when it is not a download's (an online source): for tracking, AniSkip, subtitles. */
  meta?: Task['meta'];
  /** Subtitles that come with an online source. */
  subtitles?: { url: string; name: string; lang?: string; isDefault?: boolean }[] }
interface SubTrack { id: string; name: string; lang?: string; cues: Cue[]; ass?: string; fmt: string }

const fmtTime = (s: number): string => { if (!isFinite(s)) return '–:––'; s = Math.max(0, Math.round(s)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60; return localDigits((h ? `${h}:${String(m).padStart(2, '0')}:` : `${m}:`) + String(sec).padStart(2, '0')); };

export function openPlayer(src: PlayerSource): void {
  const P = getPrefs(); const key = src.localPath ?? src.url.replace(/^http:\/\/127\.0\.0\.1:\d+/, 'stream:');
  const video = h('video', { playsinline: true, preload: 'auto', class: 'kt-video', crossorigin: 'anonymous' }) as HTMLVideoElement;
  const stage = h('div', { class: 'kt-stage' }, video, h('canvas', { class: 'kt-ass' }), h('div', { class: 'kt-subs' }), h('div', { class: 'kt-subs top' }));
  const assCanvas = stage.querySelector('.kt-ass') as HTMLCanvasElement; const subBox = stage.querySelector('.kt-subs:not(.top)') as HTMLElement; const subTop = stage.querySelector('.kt-subs.top') as HTMLElement;
  // ---- state
  let controlsOn = true; let hideTimer = 0; let locked = false; let speed = P.defaultSpeed; let zoom = 1; let panX = 0, panY = 0; let aspect = P.aspect; let abA: number | null = null, abB: number | null = null; let loopFile = false;
  let tracks: SubTrack[] = []; let current: SubTrack | null = null; let secondary: SubTrack | null = null; let subDelay = P.subDelay; let ass: AssRenderer | null = null; let boostGain: GainNode | null = null; let ctx: AudioContext | null = null; let brightness = 1; let sleepAt = 0; let watchedSent = false;
  // ---- chrome
  const title = h('span', { class: 'kt-title grow', dir: 'auto' }, src.name);
  const top = h('div', { class: 'kt-top' }, iconButton('back', t('back'), () => close()), title, iconButton('subtitles', t('navSubs'), () => subsSheet()), iconButton('more', t('more'), () => moreSheet()));
  const timeNow = h('span', { class: 'kt-time' }, '0:00'); const timeEnd = h('button', { type: 'button', class: 'kt-time end', title: t('showRemaining'), onclick: () => { updatePrefs({ showRemaining: !getPrefs().showRemaining }); onTime(); } }, '–:––');
  const bar = h('div', { class: 'kt-seek', role: 'slider', tabindex: '0' }, h('div', { class: 'kt-buf' }), h('div', { class: 'kt-played' }), h('div', { class: 'kt-knob' }), h('i', { class: 'kt-mark a', hidden: true }), h('i', { class: 'kt-mark b', hidden: true }));
  const playBtn = iconButton('play', t('play'), () => toggle()); playBtn.classList.add('kt-play');
  const speedBtn = h('button', { type: 'button', class: 'kt-chip', onclick: () => speedSheet() }, `${localDigits(speed)}×`);
  const abBtn = h('button', { type: 'button', class: 'kt-chip', onclick: () => abPress() }, 'A/B');
  const aspectBtn = h('button', { type: 'button', class: 'kt-chip', onclick: () => cycleAspect() }, t('aspectFit'));
  const skipBtn = h('button', { type: 'button', class: 'kt-chip', title: t('skipAhead'), onclick: () => seekBy(getPrefs().skipAmount) }, `+${localDigits(P.skipAmount)}`);
  // The floating «Skip opening» button, shown while an opening/ending/recap is on screen.
  const skipOp = h('button', { type: 'button', class: 'kt-skip-op', hidden: true }) as HTMLButtonElement;
  const bottom = h('div', { class: 'kt-bottom' },
    h('div', { class: 'kt-row' }, timeNow, bar, timeEnd),
    h('div', { class: 'kt-row buttons' }, iconButton('lock', t('lockScreen'), () => lock(true)), src.playlist?.length ? iconButton('chevronLeft', t('previous'), () => neighbour(-1)) : null, iconButton('rotate', t('frameBack'), () => frameStep(-1)), playBtn, iconButton('rotate', t('frameForward'), () => frameStep(1)), src.playlist?.length ? iconButton('chevronRight', t('next'), () => neighbour(1)) : null,
      h('span', { class: 'grow' }), skipBtn, speedBtn, abBtn, aspectBtn, iconButton('camera', t('screenshot'), () => screenshot()), 'pictureInPictureEnabled' in document ? iconButton('tv', t('pip'), () => void pip()) : null, iconButton('fullscreen', t('fullscreen'), () => void fullscreen())));
  const centre = h('div', { class: 'kt-centre' }, h('div', { class: 'kt-flash' })); const flash = centre.firstChild as HTMLElement;
  const unlockBtn = iconButton('lock', t('unlock'), () => lock(false)); unlockBtn.classList.add('kt-unlock'); unlockBtn.hidden = true;
  const root = h('div', { class: 'player-view kt-player', role: 'dialog', 'aria-label': src.name }, stage, centre, top, bottom, unlockBtn, skipOp);
  document.body.append(root);
  const wake = navigator.wakeLock && P.keepScreenOn ? navigator.wakeLock.request('screen').catch(() => null) : null;
  if (P.orientation !== 'auto') void (screen.orientation as ScreenOrientation & { lock?(o: string): Promise<void> }).lock?.(P.orientation === 'landscape' ? 'landscape' : 'landscape-primary').catch(() => undefined);

  // ---- playback
  if (src.headers && Object.keys(src.headers).length) toast(t('playerHeadersNote'));
  video.src = src.url; video.preservesPitch = P.pitchCorrection; video.playbackRate = speed;
  const mem = memoryOf(key);
  video.addEventListener('loadedmetadata', () => {
    timeEnd.textContent = fmtTime(video.duration); applyAspect();
    if (mem && mem.pos > 5 && mem.pos < video.duration - 10) { if (P.resume === 'always') video.currentTime = mem.pos; else if (P.resume === 'ask') askResume(mem.pos); }
    if (mem?.speed) setSpeed(mem.speed); if (mem?.subDelay) subDelay = mem.subDelay;
    void video.play().catch(() => undefined);
  }, { once: true });
  video.addEventListener('timeupdate', onTime); video.addEventListener('progress', drawBuffer);
  video.addEventListener('play', () => { playBtn.replaceChildren(icon('pause')); playBtn.setAttribute('aria-label', t('pause')); scheduleHide(); });
  video.addEventListener('pause', () => { playBtn.replaceChildren(icon('play')); playBtn.setAttribute('aria-label', t('play')); showControls(); });
  video.addEventListener('ended', () => { if (loopFile) { video.currentTime = 0; void video.play(); return; } markWatched(true); if (P.autoplayNext && src.playlist?.length) neighbour(1); else showControls(); });
  video.addEventListener('error', () => { const err = video.error; toast(err?.code === 4 ? t('playerCantPlay') : t('stateFailed'), 'error', 5000); showControls(); });
  video.addEventListener('waiting', () => centre.classList.add('busy')); video.addEventListener('playing', () => centre.classList.remove('busy')); video.addEventListener('canplay', () => centre.classList.remove('busy'));
  function onTime() {
    const d = video.duration || 0, c = video.currentTime;
    if (abA !== null && abB !== null && c >= abB) video.currentTime = abA;
    timeNow.textContent = fmtTime(c); if (d) timeEnd.textContent = getPrefs().showRemaining ? `−${fmtTime((d - c) / (video.playbackRate || 1))}` : fmtTime(d); skipCheck(c); if (d) (bar.querySelector('.kt-played') as HTMLElement).style.width = `${(c / d) * 100}%`; (bar.querySelector('.kt-knob') as HTMLElement).style.insetInlineStart = d ? `${(c / d) * 100}%` : '0';
    drawSubs(c);
    if (Math.floor(c) % 5 === 0) remember(key, { pos: c, duration: d, speed, sub: current?.id, subDelay });
    if (d && P.markWatched && !watchedSent && c / d * 100 >= P.watchedAt) markWatched(false);
    if (sleepAt && Date.now() >= sleepAt) { video.pause(); sleepAt = 0; toast(t('sleepTimerDone')); }
  }
  function drawBuffer() { const d = video.duration; if (!d) return; let end = 0; for (let i = 0; i < video.buffered.length; i++) if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) > end) end = video.buffered.end(i); (bar.querySelector('.kt-buf') as HTMLElement).style.width = `${(end / d) * 100}%`; }
  const toggle = () => { if (video.paused) void video.play(); else video.pause(); };
  const setSpeed = (v: number) => { speed = Math.max(0.1, Math.min(8, Math.round(v * 100) / 100)); video.playbackRate = speed; speedBtn.textContent = `${localDigits(speed)}×`; };
  const seekBy = (dt: number) => { video.currentTime = Math.max(0, Math.min(video.duration || Infinity, video.currentTime + dt)); flashText(`${dt > 0 ? '+' : '−'}${localDigits(Math.abs(Math.round(dt)))}s`); };
  const frameStep = (n: number) => { video.pause(); video.currentTime = Math.max(0, video.currentTime + n / 30); };
  function flashText(s: string, long = false) { flash.textContent = s; flash.classList.add('on'); window.clearTimeout((flash as HTMLElement & { _t?: number })._t); (flash as HTMLElement & { _t?: number })._t = window.setTimeout(() => flash.classList.remove('on'), long ? 1400 : 700); }
  function markWatched(end: boolean) { if (watchedSent) return; watchedSent = true; remember(key, { watched: true }); const m = src.task?.meta ?? src.meta; if (m?.anilistId && m.episode) void import('../anime/progress').then((p) => p.markWatched(m.anilistId!, m.episode!, m.title)); void end; }
  function askResume(pos: number) { const sh = openSheet(t('resumeTitle'), t('close')); sh.body.append(h('p', null, t('resumeBody', { t: fmtTime(pos) }))); sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { sh.close(); } }, t('resumeFromStart')), h('button', { type: 'button', class: 'btn primary', onclick: () => { video.currentTime = pos; sh.close(); } }, t('resumeContinue'))); }
  function neighbour(dir: number) { const list = src.playlist ?? []; const i = list.findIndex((x) => x.url === src.url); const nx = getPrefs().shuffle && dir > 0 && list.length > 1 ? list.filter((x) => x.url !== src.url)[Math.floor(Math.random() * (list.length - 1))] : list[i + dir]; if (!nx) { toast(t(dir > 0 ? 'noNextFile' : 'noPreviousFile')); return; } close(); openPlayer({ ...nx, playlist: list }); }

  // ---- controls visibility
  function showControls() { controlsOn = true; root.classList.remove('hide-ui'); scheduleHide(); }
  function hideControls() { if (video.paused || locked) return; controlsOn = false; root.classList.add('hide-ui'); }
  function scheduleHide() { window.clearTimeout(hideTimer); hideTimer = window.setTimeout(hideControls, 3200); }
  function lock(on: boolean) { locked = on; root.classList.toggle('locked', on); unlockBtn.hidden = !on; if (on) { root.classList.add('hide-ui'); setTimeout(() => { unlockBtn.classList.add('faded'); }, 2500); } else { unlockBtn.classList.remove('faded'); showControls(); } }
  scheduleHide();

  // ---- seek bar
  const seekTo = (clientX: number) => { const r = bar.getBoundingClientRect(); const rtl = getComputedStyle(bar).direction === 'rtl'; let f = (clientX - r.left) / r.width; if (rtl) f = 1 - f; f = Math.max(0, Math.min(1, f)); if (video.duration) video.currentTime = f * video.duration; };
  let scrubbing = false;
  bar.addEventListener('pointerdown', (e) => { if (locked) return; scrubbing = true; bar.setPointerCapture(e.pointerId); seekTo(e.clientX); e.stopPropagation(); });
  bar.addEventListener('pointermove', (e) => { if (scrubbing) { seekTo(e.clientX); flashText(fmtTime(video.currentTime)); } });
  bar.addEventListener('pointerup', () => { scrubbing = false; }); bar.addEventListener('pointercancel', () => { scrubbing = false; });
  bar.addEventListener('keydown', (e) => { if (e.key === 'ArrowRight') seekBy(5); else if (e.key === 'ArrowLeft') seekBy(-5); });

  // ---- gestures on the stage
  let tapTimer = 0; let lastTap = 0; let pressTimer = 0; let pressing = false; let gesture: 'none' | 'seek' | 'volume' | 'bright' | 'pinch' = 'none'; let start = { x: 0, y: 0, t: 0, vol: 1, br: 1 }; const pts = new Map<number, { x: number; y: number }>(); let pinchStart = 0; let zoomStart = 1; let moved = false;
  stage.addEventListener('pointerdown', (e) => {
    if (locked) { unlockBtn.classList.remove('faded'); setTimeout(() => unlockBtn.classList.add('faded'), 2500); return; }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY }); stage.setPointerCapture(e.pointerId); moved = false;
    if (pts.size === 2 && P.pinchZoom) { const [a, b] = [...pts.values()]; pinchStart = Math.hypot(a.x - b.x, a.y - b.y); zoomStart = zoom; gesture = 'pinch'; window.clearTimeout(pressTimer); return; }
    start = { x: e.clientX, y: e.clientY, t: video.currentTime, vol: video.volume * (boostGain ? boostGain.gain.value : 1), br: brightness }; gesture = 'none';
    pressTimer = window.setTimeout(() => { if (moved || pts.size !== 1) return; pressing = true; video.playbackRate = speed * P.longPressSpeed; flashText(`${localDigits(speed * P.longPressSpeed)}×`, true); if (navigator.vibrate) navigator.vibrate(10); }, 450);
  });
  stage.addEventListener('pointermove', (e) => {
    if (locked) return; const p = pts.get(e.pointerId); if (!p) return; pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (gesture === 'pinch' && pts.size === 2) { const [a, b] = [...pts.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y); zoom = Math.max(1, Math.min(4, zoomStart * (d / pinchStart))); applyZoom(); flashText(`${localDigits(Math.round(zoom * 100))}%`); return; }
    const dx = e.clientX - start.x, dy = e.clientY - start.y; if (!moved && Math.hypot(dx, dy) > 18) { moved = true; window.clearTimeout(pressTimer); }
    if (!moved || pressing) return;
    const r = stage.getBoundingClientRect();
    if (gesture === 'none') { if (zoom > 1 && e.pointerType === 'touch') gesture = 'pinch'; else if (Math.abs(dx) > Math.abs(dy)) gesture = P.swipeSeek ? 'seek' : 'none'; else gesture = start.x < r.left + r.width / 2 ? (P.swipeBrightness ? 'bright' : 'none') : (P.swipeVolume ? 'volume' : 'none'); }
    if (gesture === 'pinch') { panX += e.movementX; panY += e.movementY; applyZoom(); }
    else if (gesture === 'seek') { const dt = (dx / r.width) * Math.min(video.duration || 600, 600); const to = Math.max(0, Math.min(video.duration || 0, start.t + dt)); flashText(`${fmtTime(to)}  (${dt >= 0 ? '+' : '−'}${fmtTime(Math.abs(dt))})`, true); (stage as HTMLElement & { _seekTo?: number })._seekTo = to; }
    else if (gesture === 'volume') { const v = Math.max(0, Math.min(1 + P.volumeBoost / 100, start.vol - dy / (r.height * 0.6) * 1.5)); setVolume(v); flashText(`${icon('speak') && '🔊'} ${localDigits(Math.round(v * 100))}%`); }
    else if (gesture === 'bright') { brightness = Math.max(0.2, Math.min(1.6, start.br - dy / (r.height * 0.6) * 1.2)); applyFilters(); flashText(`☀ ${localDigits(Math.round(brightness * 100))}%`); }
  });
  const endPointer = (e: PointerEvent) => {
    pts.delete(e.pointerId); window.clearTimeout(pressTimer);
    if (pressing) { pressing = false; video.playbackRate = speed; flashText(`${localDigits(speed)}×`); return; }
    if (gesture === 'seek') { const to = (stage as HTMLElement & { _seekTo?: number })._seekTo; if (to !== undefined) video.currentTime = to; gesture = 'none'; return; }
    if (gesture === 'pinch') { if (pts.size === 0) gesture = 'none'; return; }
    if (gesture !== 'none') { gesture = 'none'; return; }
    if (moved || locked) return;
    // Taps: one toggles the controls; two seek on the sides, play/pause in the middle.
    const now = Date.now(); const r = stage.getBoundingClientRect(); const zone = (e.clientX - r.left) / r.width;
    if (now - lastTap < 300) { window.clearTimeout(tapTimer); lastTap = 0; const w = getPrefs().doubleTapArea / 100; if (zone < w) seekBy(-P.doubleTapSeek); else if (zone > 1 - w) seekBy(P.doubleTapSeek); else toggle(); return; }
    lastTap = now; tapTimer = window.setTimeout(() => { if (controlsOn) hideControls(); else showControls(); }, 280);
  };
  stage.addEventListener('pointerup', endPointer); stage.addEventListener('pointercancel', endPointer);
  stage.addEventListener('wheel', (e) => { if (locked) return; e.preventDefault(); if (e.ctrlKey) { zoom = Math.max(1, Math.min(4, zoom - e.deltaY / 500)); applyZoom(); } else setVolume(Math.max(0, Math.min(1 + P.volumeBoost / 100, (video.volume * (boostGain?.gain.value ?? 1)) - e.deltaY / 1000))); showControls(); }, { passive: false });
  function applyZoom() { if (zoom <= 1.001) { zoom = 1; panX = 0; panY = 0; } video.style.transform = zoom === 1 ? '' : `translate(${panX}px, ${panY}px) scale(${zoom})`; assCanvas.style.transform = video.style.transform; }
  function setVolume(v: number) { if (v > 1) { ensureBoost(); video.volume = 1; boostGain!.gain.value = v; } else { video.volume = v; if (boostGain) boostGain.gain.value = 1; } }
  function ensureBoost() { if (boostGain) return; try { ctx = new AudioContext(); const node = ctx.createMediaElementSource(video); boostGain = ctx.createGain(); node.connect(boostGain).connect(ctx.destination); } catch { boostGain = null; } }

  // ---- keyboard (desktop)
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return; if ((e.target as HTMLElement).closest('.sheet, input, textarea')) return;
    const k = e.key; if (k === ' ' || k === 'k') { e.preventDefault(); toggle(); } else if (k === 'ArrowRight' || k === 'l') seekBy(e.shiftKey ? 60 : P.doubleTapSeek); else if (k === 'ArrowLeft' || k === 'j') seekBy(e.shiftKey ? -60 : -P.doubleTapSeek); else if (k === 'ArrowUp') setVolume(Math.min(1 + P.volumeBoost / 100, video.volume * (boostGain?.gain.value ?? 1) + 0.05)); else if (k === 'ArrowDown') setVolume(Math.max(0, video.volume * (boostGain?.gain.value ?? 1) - 0.05));
    else if (k === 'f') void fullscreen(); else if (k === 'm') { video.muted = !video.muted; flashText(video.muted ? '🔇' : '🔊'); } else if (k === '.') frameStep(1); else if (k === ',') frameStep(-1); else if (k === '>' || k === ']') setSpeed(speed + 0.1); else if (k === '<' || k === '[') setSpeed(speed - 0.1); else if (k === 'Escape') { if (document.fullscreenElement) void document.exitFullscreen(); else close(); } else if (k === 'a') abPress(); else if (k === 's') screenshot(); else if (k === 'v') cycleSub(); else if (k === 'z') { subDelay -= 0.1; flashText(t('subDelayNow', { s: subDelay.toFixed(1) })); } else if (k === 'x') { subDelay += 0.1; flashText(t('subDelayNow', { s: subDelay.toFixed(1) })); } else return;
    showControls();
  };
  window.addEventListener('keydown', onKey);

  // ---- A/B, aspect, screenshot, pip, fullscreen
  function abPress() { if (abA === null) { abA = video.currentTime; flashText(`A ${fmtTime(abA)}`); } else if (abB === null) { abB = Math.max(abA + 0.5, video.currentTime); flashText(`B ${fmtTime(abB)}`); abBtn.classList.add('on'); } else { abA = abB = null; abBtn.classList.remove('on'); flashText(t('abOff')); } drawMarks(); }
  function drawMarks() { const d = video.duration || 1; const a = bar.querySelector('.kt-mark.a') as HTMLElement, b = bar.querySelector('.kt-mark.b') as HTMLElement; a.hidden = abA === null; b.hidden = abB === null; if (abA !== null) a.style.insetInlineStart = `${(abA / d) * 100}%`; if (abB !== null) b.style.insetInlineStart = `${(abB / d) * 100}%`; }
  const ASPECTS: PlayerPrefs['aspect'][] = ['fit', 'fill', 'stretch', '16:9', '4:3', '21:9'];
  function cycleAspect() { aspect = ASPECTS[(ASPECTS.indexOf(aspect) + 1) % ASPECTS.length]; applyAspect(); flashText(aspectName(aspect)); }
  const aspectName = (a: PlayerPrefs['aspect']) => (a === 'fit' ? t('aspectFit') : a === 'fill' ? t('aspectFill') : a === 'stretch' ? t('aspectStretch') : a);
  function applyAspect() { video.style.objectFit = aspect === 'fill' ? 'cover' : aspect === 'stretch' ? 'fill' : 'contain'; video.style.aspectRatio = ''; video.style.width = video.style.height = ''; if (/^\d/.test(aspect)) { const [w, hh] = aspect.split(':').map(Number); const r = stage.getBoundingClientRect(); const stageR = r.width / r.height, want = w / hh; if (want > stageR) { video.style.width = '100%'; video.style.height = `${(stageR / want) * 100}%`; } else { video.style.height = '100%'; video.style.width = `${(want / stageR) * 100}%`; } video.style.objectFit = 'fill'; } aspectBtn.textContent = aspectName(aspect); }
  function screenshot() { try { const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight; const g = c.getContext('2d')!; g.drawImage(video, 0, 0); if (ass) g.drawImage(assCanvas, 0, 0, c.width, c.height); c.toBlob((b) => { if (!b) return; const a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `${src.name.replace(/\.[^.]+$/, '')} ${fmtTime(video.currentTime).replace(/:/g, '.')}.png`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); toast(t('screenshotSaved')); }, 'image/png'); } catch { toast(t('screenshotFailed'), 'error'); } }
  async function pip() { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch { toast(t('pipFailed'), 'error'); } }
  async function fullscreen() { try { if (document.fullscreenElement) await document.exitFullscreen(); else await root.requestFullscreen(); } catch { /* not allowed */ } }

  // ---- subtitles
  function drawSubs(c: number) {
    const tm = c - subDelay;
    const render = (box: HTMLElement, tr: SubTrack | null, topOnly: boolean | null) => { if (!tr || (tr.ass && ass)) { box.replaceChildren(); return; } const cs = cuesAt(tr.cues, tm).filter((x) => topOnly === null || !!x.top === topOnly); const html = cs.map((x) => x.text).join('\n'); if (box.dataset.last === html) return; box.dataset.last = html; box.replaceChildren(...cs.map((x) => h('span', { class: 'kt-cue', dir: 'auto' }, ...x.text.split('\n').flatMap((l, i) => (i ? [h('br'), l] : [l]))))); };
    render(subBox, current, false); if (secondary) render(subTop, secondary, null); else render(subTop, current, true);
  }
  function applySubStyle() { const p = getPrefs(); root.style.setProperty('--sub-size', `${p.subSize}%`); root.style.setProperty('--sub-color', p.subColor); root.style.setProperty('--sub-pos', `${100 - p.subPos}%`); root.style.setProperty('--sub-font', p.subFont ? `"${p.subFont}", ` : ''); root.classList.toggle('sub-bold', p.subBold); root.dataset.subBg = p.subBackground; }
  applySubStyle();
  async function useTrack(tr: SubTrack | null) {
    current = tr; ass?.free(); ass = null; subBox.replaceChildren(); subTop.replaceChildren(); delete subBox.dataset.last;
    if (tr?.ass && !getPrefs().subAssOverride) { ass = await createAssRenderer(video, assCanvas, tr.ass, []); if (ass) { ass.setOffset(-subDelay); assCanvas.hidden = false; } } else assCanvas.hidden = true;
    remember(key, { sub: tr?.id });
  }
  function cycleSub() { if (!tracks.length) { void subsSheet(); return; } const i = current ? tracks.indexOf(current) : -1; const nx = tracks[i + 1] ?? null; void useTrack(nx); flashText(nx ? nx.name : t('subsOff')); }
  async function addTrackFromBytes(name: string, bytes: Uint8Array, lang?: string): Promise<SubTrack | null> {
    const text = decodeSubtitle(bytes, getPrefs().subCodepage || undefined); const fmt = sniffFormat(name, text);
    if (fmt === 'unknown') { toast(t('subsUnknownFormat', { name }), 'error'); return null; }
    const tr: SubTrack = { id: `${name}:${bytes.length}`, name, lang, cues: parseCues(text, fmt), fmt, ass: fmt === 'ass' ? text : undefined };
    tracks = [...tracks.filter((x) => x.id !== tr.id), tr]; return tr;
  }
  async function loadSubtitleUrl(url: string, name: string, lang?: string) { try { const r = await request(url, { binary: true }); if (r.status >= 400) throw new Error(`HTTP ${r.status}`); const bytes = Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)); const tr = await addTrackFromBytes(name, bytes, lang); if (tr) { await useTrack(tr); toast(t('subsLoaded', { name })); } } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }
  // Subtitles that came with an online source: the default one (or the only one) turned on.
  void (async () => { const subs = src.subtitles ?? []; for (const sb of subs.slice(0, 12)) { try { const r = await request(sb.url, { binary: true }); if (r.status >= 400) continue; const tr = await addTrackFromBytes(sb.name, Uint8Array.from(atob(r.body), (c) => c.charCodeAt(0)), sb.lang); if (tr && !current && (sb.isDefault || subs.length === 1)) void useTrack(tr); } catch { /* one missing */ } } })();
  // Subtitles beside a local file (same base name) are offered first.
  void (async () => { if (!src.localPath) return; const list = (await siblingFiles(src.localPath)).filter((x) => /\.(srt|ass|ssa|vtt)$/i.test(x)).slice(0, 8); for (const f of list) { const b = await readLocal(f); if (b) { const tr = await addTrackFromBytes(f.split(/[\\/]/).pop()!, b); if (tr && !current && (mem?.sub === tr.id || list.length === 1)) void useTrack(tr); } } })();

  async function subsSheet() {
    const sh = openSheet(t('navSubs'), t('close')); const p = getPrefs();
    const list = h('div', { class: 'dest-list' }, h('label', { class: 'dest-row' + (!current ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-sub', checked: !current, onchange: () => void useTrack(null) }), icon('close'), h('span', { class: 'name' }, t('subsOff'))),
      ...tracks.map((tr) => h('label', { class: 'dest-row' + (current === tr ? ' on' : '') }, h('input', { type: 'radio', name: 'kt-sub', checked: current === tr, onchange: () => void useTrack(tr) }), icon('subtitles'), h('span', { class: 'name', dir: 'auto' }, tr.name), h('small', { class: 'src' }, `${tr.fmt.toUpperCase()}${tr.lang ? ` · ${tr.lang}` : ''}`), iconButton('bookmark', t('subsSecondary'), () => { secondary = secondary === tr ? null : tr; toast(secondary ? t('subsSecondaryOn', { name: tr.name }) : t('subsSecondaryOff')); }))));
    const fileIn = h('input', { type: 'file', accept: '.srt,.ass,.ssa,.vtt,.sub,.txt', hidden: true, onchange: async () => { const f = fileIn.files?.[0]; if (!f) return; const tr = await addTrackFromBytes(f.name, new Uint8Array(await f.arrayBuffer())); if (tr) { await useTrack(tr); sh.close(); } } }) as HTMLInputElement;
    const actions = h('div', { class: 'row-actions wrap' }, h('button', { type: 'button', class: 'btn tonal small', onclick: () => fileIn.click() }, icon('upload'), t('subsFromFile')),
      h('button', { type: 'button', class: 'btn tonal small', onclick: () => { sh.close(); void findSubs(); } }, icon('search'), t('subsFind')));
    const delay = h('input', { type: 'number', step: '0.1', value: subDelay.toFixed(1), style: { width: '6em' }, onchange: () => { subDelay = Number(delay.value) || 0; ass?.setOffset(-subDelay); remember(key, { subDelay }); } }) as HTMLInputElement;
    const size = h('input', { type: 'range', min: '50', max: '200', step: '5', value: String(p.subSize), oninput: () => { updatePrefs({ subSize: Number(size.value) }); applySubStyle(); } });
    const pos = h('input', { type: 'range', min: '0', max: '100', step: '1', value: String(p.subPos), oninput: () => { updatePrefs({ subPos: Number(pos.value) }); applySubStyle(); } });
    const color = h('input', { type: 'color', value: p.subColor, oninput: () => { updatePrefs({ subColor: color.value }); applySubStyle(); } });
    sh.body.append(list, fileIn, actions, h('h4', null, t('subsStyle')),
      h('div', { class: 'row' }, h('span', null, t('subDelay'), h('small', { class: 'src' }, t('subDelayHint'))), h('div', { class: 'progress-ctl' }, iconButton('minus', t('less'), () => { subDelay = Math.round((subDelay - 0.1) * 10) / 10; delay.value = subDelay.toFixed(1); ass?.setOffset(-subDelay); }), delay, iconButton('plus', t('more'), () => { subDelay = Math.round((subDelay + 0.1) * 10) / 10; delay.value = subDelay.toFixed(1); ass?.setOffset(-subDelay); }))),
      h('label', { class: 'field' }, h('span', null, t('subSize')), size), h('label', { class: 'field' }, h('span', null, t('subPosition')), pos),
      h('div', { class: 'row' }, h('span', null, t('subColor')), color),
      h('div', { class: 'row' }, h('span', null, t('subBackground')), pickButton(t('subBackground'), [['none', t('subBgNone')], ['shadow', t('subBgShadow')], ['box', t('subBgBox')]], p.subBackground, (v) => { updatePrefs({ subBackground: v }); applySubStyle(); }, t('close'))),
      h('label', { class: 'row switch-row' }, h('span', null, t('subBold')), h('input', { type: 'checkbox', checked: p.subBold, onchange: (e: Event) => { updatePrefs({ subBold: (e.target as HTMLInputElement).checked }); applySubStyle(); } })),
      h('label', { class: 'row switch-row' }, h('span', null, t('subAssOverride'), h('small', { class: 'src' }, t('subAssOverrideHint'))), h('input', { type: 'checkbox', checked: p.subAssOverride, onchange: (e: Event) => { updatePrefs({ subAssOverride: (e.target as HTMLInputElement).checked }); void useTrack(current); } })),
      h('div', { class: 'row' }, h('span', null, t('subCodepage')), pickButton(t('subCodepage'), [['', t('subCodepageAuto')], ['windows-1256', 'Windows-1256 (Arabic)'], ['utf-8', 'UTF-8'], ['windows-1252', 'Windows-1252'], ['windows-1251', 'Windows-1251'], ['shift_jis', 'Shift_JIS'], ['euc-kr', 'EUC-KR'], ['gbk', 'GBK'], ['big5', 'Big5'], ['windows-1254', 'Windows-1254']], p.subCodepage, (v) => updatePrefs({ subCodepage: v }), t('close'))));
  }
  /** Subtitles for this very episode through the Subtitles add-on, loaded straight into the player. */
  async function findSubs() {
    const { getSettings } = await import('../settings'); if (!getSettings().addons.includes('subtitles')) { toast(t('subsNoSources')); return; }
    const { lookup, enrich } = await import('../subs/lookup'); const { searchSubtitles, queryFor, rankSubs, resolveLink } = await import('../subs/search'); const { parseFilename } = await import('../anime/anitomy');
    const m = src.task?.meta ?? src.meta; const parsed = parseFilename(src.name); const q = m?.title ?? parsed.title; const ep = m?.episode ?? parsed.episode;
    const sh = openSheet(t('subsFind'), t('close')); sh.body.append(h('p', { class: 'src' }, `${q}${ep ? ` · ${t('episodeN', { n: ep })}` : ''}`), h('div', { class: 'center' }, h('div', { class: 'spinner' })));
    try {
      let cards = m?.anilistId ? await lookup(`anilist:${m.anilistId}`) : await lookup(q); if (!cards.length) { sh.body.replaceChildren(h('p', { class: 'empty small' }, t('noResults'))); return; }
      const c = await enrich(cards[0]); const query = queryFor(c, parsed.season, ep, getSettings().subLangs); const list = h('div', { class: 'sub-list' }); sh.body.replaceChildren(h('p', { class: 'src', dir: 'auto' }, `${c.title}${ep ? ` · ${t('episodeN', { n: ep })}` : ''}`), list);
      let all: Awaited<ReturnType<typeof searchSubtitles>> = [];
      await searchSubtitles(query, (_a, res) => { if (!(res instanceof Error)) all = all.concat(res); list.replaceChildren(...rankSubs(all, getSettings().subLangs, ep).slice(0, 60).map((r) => h('button', { type: 'button', class: 'result-row sub-row', onclick: async () => { try { const { url, name } = await resolveLink(r, query); if (r.archive) { toast(t('subsArchiveNote')); } sh.close(); await loadSubtitleUrl(url, name ?? `${r.title}.${r.archive ?? 'srt'}`, r.language); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } } }, h('span', { class: 'lang-badge' }, (r.language ?? '?').toUpperCase()), h('span', { class: 'grow', dir: 'auto' }, h('span', { class: 'result-title' }, r.title), h('small', { class: 'src' }, [r.site, r.hi ? t('subsHI') : '', r.archive ?? ''].filter(Boolean).join(' · ')))))); });
      if (!all.length) list.append(h('p', { class: 'empty small' }, t('noResults')));
    } catch (e) { sh.body.replaceChildren(h('p', { class: 'empty small' }, String((e as Error).message ?? e))); }
  }

  // ---- speed, more
  function speedSheet() { const sh = openSheet(t('speed'), t('close')); const p = getPrefs(); const out = h('b', { class: 'speed-out' }, `${localDigits(speed)}×`); const range = h('input', { type: 'range', min: '0.25', max: '4', step: '0.05', value: String(speed), oninput: () => { setSpeed(Number(range.value)); out.textContent = `${localDigits(speed)}×`; } }); sh.body.append(h('div', { class: 'chips' }, ...p.speedPresets.map((v) => h('button', { type: 'button', class: 'chip' + (v === speed ? ' on' : ''), onclick: () => { setSpeed(v); sh.close(); } }, `${localDigits(v)}×`))), h('div', { class: 'score-row' }, range, out), h('label', { class: 'row switch-row' }, h('span', null, t('pitchCorrection')), h('input', { type: 'checkbox', checked: p.pitchCorrection, onchange: (e: Event) => { const on = (e.target as HTMLInputElement).checked; updatePrefs({ pitchCorrection: on }); video.preservesPitch = on; } }))); }
  function moreSheet() {
    const sh = openSheet(src.name, t('close')); const p = getPrefs();
    const row = (ic: string, label: string, fn: () => void, extra?: string) => h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); fn(); } }, icon(ic), h('span', { class: 'grow' }, label), extra ? h('small', { class: 'src' }, extra) : null);
    sh.body.append(h('div', { class: 'dest-list' },
      row('scroll', t('cutClip'), () => void cutSheet(), abA !== null && abB !== null ? `${fmtTime(abA)} – ${fmtTime(abB)}` : t('cutClipHint')),
      row('refresh', loopFile ? t('loopOff') : t('loopFile'), () => { loopFile = !loopFile; toast(loopFile ? t('loopFile') : t('loopOff')); }),
      row('clock', t('sleepTimer'), () => sleepSheet(), sleepAt ? fmtTime((sleepAt - Date.now()) / 1000) : undefined),
      row('zoomIn', t('resetZoom'), () => { zoom = 1; panX = panY = 0; applyZoom(); brightness = 1; applyFilters(); }),
      row('settings', t('videoFilters'), () => filtersSheet()),
      ...(chapters.length ? [row('list', t('chapters'), () => chaptersSheet(), localDigits(chapters.length))] : []),
      ...(src.playlist && src.playlist.length > 1 ? [row('refresh', getPrefs().shuffle ? t('shuffleOff') : t('shuffleOn'), () => { updatePrefs({ shuffle: !getPrefs().shuffle }); toast(getPrefs().shuffle ? t('shuffleOn') : t('shuffleOff')); })] : []),
      row('heart', getPrefs().ambient ? t('ambientOff') : t('ambientOn'), () => { updatePrefs({ ambient: !getPrefs().ambient }); ambientTick(); }),
      ...(canOpenWith() ? [row('external', t('openWithPlayer'), () => void openWith())] : []),
      row('info', t('mediaInfo'), () => infoSheet()),
      row('external', t('openWithSystem'), () => void import('../native').then((n) => n.openExternal(src.localPath ? `file://${src.localPath}` : src.url))),
      row('settings', t('playerSettings'), () => playerSettingsSheet())));
    void p;
  }
  function sleepSheet() { const sh = openSheet(t('sleepTimer'), t('close')); sh.body.append(h('div', { class: 'chips' }, ...[0, 15, 30, 45, 60, 90].map((m) => h('button', { type: 'button', class: 'chip', onclick: () => { sleepAt = m ? Date.now() + m * 60000 : 0; toast(m ? t('sleepTimerSet', { n: m }) : t('sleepTimerOff')); sh.close(); } }, m ? t('minutesN', { n: m }) : t('sleepTimerOff'))), h('button', { type: 'button', class: 'chip', onclick: () => { sleepAt = Date.now() + Math.max(1, (video.duration - video.currentTime) / speed) * 1000; toast(t('sleepTimerEnd')); sh.close(); } }, t('sleepTimerEnd')))); }
  function infoSheet() { const sh = openSheet(t('mediaInfo'), t('close')); const rows: [string, string][] = [[t('fileName'), src.name], [t('resolution'), `${localDigits(video.videoWidth)}×${localDigits(video.videoHeight)}`], [t('duration'), fmtTime(video.duration)], ['URL', src.url]]; if (src.task?.total) rows.push([t('size'), formatBytes(src.task.total)]); const q = (video as HTMLVideoElement & { getVideoPlaybackQuality?(): { droppedVideoFrames: number; totalVideoFrames: number } }).getVideoPlaybackQuality?.(); if (q) rows.push([t('frames'), `${localDigits(q.totalVideoFrames)} (${t('dropped', { n: q.droppedVideoFrames })})`]); sh.body.append(h('dl', { class: 'kv' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', { dir: 'auto' }, v)]))); }
  function playerSettingsSheet() {
    const sh = openSheet(t('playerSettings'), t('close')); const p = getPrefs();
    const num = (label: string, key: keyof PlayerPrefs, min: number, max: number, step = 1) => h('div', { class: 'row' }, h('span', null, label), h('input', { type: 'number', min: String(min), max: String(max), step: String(step), value: String(p[key]), style: { width: '6em' }, onchange: (e: Event) => updatePrefs({ [key]: Number((e.target as HTMLInputElement).value) } as Partial<PlayerPrefs>) }));
    const sw = (label: string, key: keyof PlayerPrefs) => h('label', { class: 'row switch-row' }, h('span', null, label), h('input', { type: 'checkbox', checked: !!p[key], onchange: (e: Event) => updatePrefs({ [key]: (e.target as HTMLInputElement).checked } as Partial<PlayerPrefs>) }));
    sh.body.append(num(t('doubleTapSeek'), 'doubleTapSeek', 3, 60), num(t('longPressSpeed'), 'longPressSpeed', 1.25, 4, 0.25), num(t('volumeBoost'), 'volumeBoost', 0, 200, 10), sw(t('swipeSeek'), 'swipeSeek'), sw(t('swipeVolume'), 'swipeVolume'), sw(t('swipeBrightness'), 'swipeBrightness'), sw(t('pinchZoom'), 'pinchZoom'),
      h('div', { class: 'row' }, h('span', null, t('resumePlayback')), pickButton(t('resumePlayback'), [['always', t('resumeAlways')], ['ask', t('resumeAsk')], ['never', t('resumeNever')]], p.resume, (v) => updatePrefs({ resume: v }), t('close'))),
      num(t('skipAhead'), 'skipAmount', 5, 300, 5), h('div', { class: 'row' }, h('span', null, t('autoSkip'), h('small', { class: 'src' }, t('autoSkipHint'))), pickButton(t('autoSkip'), [['button', t('autoSkipButton')], ['auto', t('autoSkipAuto')], ['off', t('autoSkipOff')]], p.autoSkip, (v) => updatePrefs({ autoSkip: v }), t('close'))), num(t('doubleTapArea'), 'doubleTapArea', 15, 45, 5),
      num(t('watchedAt'), 'watchedAt', 50, 100, 5), sw(t('markWatchedAuto'), 'markWatched'), sw(t('autoplayNext'), 'autoplayNext'), sw(t('keepScreenOn'), 'keepScreenOn'),
      h('div', { class: 'row' }, h('span', null, t('orientation')), pickButton(t('orientation'), [['auto', t('orientationAuto')], ['landscape', t('orientationLandscape')], ['sensor', t('orientationSensor')]], p.orientation, (v) => updatePrefs({ orientation: v }), t('close'))),
      h('div', { class: 'row' }, h('span', null, t('defaultAspect')), pickButton(t('defaultAspect'), ASPECTS.map((a) => [a, aspectName(a)] as [typeof a, string]), p.aspect, (v) => { updatePrefs({ aspect: v }); aspect = v; applyAspect(); }, t('close'))));
  }
  async function cutSheet() { const { cutClipSheet } = await import('./cut'); await cutClipSheet({ src, a: abA ?? Math.max(0, video.currentTime - 30), b: abB ?? video.currentTime, duration: video.duration, subtitle: current ? { name: current.name, ass: current.ass, cues: current.cues, delay: subDelay } : undefined, video }); }

  // ---- REX Player's extras: filters, ambient glow, chapters, skipping openings (AniSkip), another player
  function applyFilters() { const f = getPrefs().filters; const parts = [brightness !== 1 || f.brightness !== 100 ? `brightness(${(brightness * f.brightness) / 100})` : '', f.contrast !== 100 ? `contrast(${f.contrast / 100})` : '', f.saturation !== 100 ? `saturate(${f.saturation / 100})` : '', f.hue ? `hue-rotate(${f.hue}deg)` : ''].filter(Boolean); video.style.filter = parts.join(' '); }
  applyFilters();
  function filtersSheet() {
    const sh = openSheet(t('videoFilters'), t('close'));
    const slider = (label: string, k: keyof PlayerPrefs['filters'], min: number, max: number) => { const out = h('b', null, localDigits(getPrefs().filters[k])); const r = h('input', { type: 'range', min: String(min), max: String(max), step: '1', value: String(getPrefs().filters[k]), oninput: (e: Event) => { const v = Number((e.target as HTMLInputElement).value); updatePrefs({ filters: { ...getPrefs().filters, [k]: v } }); out.textContent = localDigits(v); applyFilters(); } }); return h('label', { class: 'field' }, h('span', { class: 'row' }, h('span', null, label), out), r); };
    sh.body.append(slider(t('filterBrightness'), 'brightness', 30, 200), slider(t('filterContrast'), 'contrast', 30, 200), slider(t('filterSaturation'), 'saturation', 0, 300), slider(t('filterHue'), 'hue', -180, 180));
    sh.actions.append(h('button', { type: 'button', class: 'btn tonal', onclick: () => { updatePrefs({ filters: { brightness: 100, contrast: 100, saturation: 100, hue: 0 } }); brightness = 1; applyFilters(); sh.close(); } }, t('reset')));
  }
  // The ambient glow: the picture's average colour spilled around it, a few times a second.
  const amb = document.createElement('canvas'); amb.width = 8; amb.height = 5; let ambTimer = 0;
  function ambientTick() { window.clearInterval(ambTimer); root.classList.toggle('ambient', getPrefs().ambient); if (!getPrefs().ambient) return; const g = amb.getContext('2d', { willReadFrequently: true }); ambTimer = window.setInterval(() => { if (!g || video.paused || !video.videoWidth) return; try { g.drawImage(video, 0, 0, 8, 5); const d = g.getImageData(0, 0, 8, 5).data; let r = 0, gg = 0, b = 0; for (let i = 0; i < d.length; i += 4) { r += d[i]; gg += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; root.style.setProperty('--ambient', `rgb(${Math.round(r / n)} ${Math.round(gg / n)} ${Math.round(b / n)})`); } catch { /* a protected stream */ } }, 350); }
  ambientTick();
  // Chapters of a local file (ffprobe), marked on the bar; openings and endings among them become skips.
  let chapters: { start: number; end: number; title: string }[] = [];
  let skips: { start: number; end: number; kind: 'op' | 'ed' | 'recap' }[] = [];
  void (async () => {
    if (!src.localPath) return;
    const d = window.kurokawaTools as unknown as { ffprobe?(p: string): Promise<{ chapters?: { start_time: string; end_time: string; tags?: { title?: string } }[] } | null> } | undefined;
    const { ktPlugin } = await import('../native'); const kp = ktPlugin() as unknown as { ffprobe?(o: { path: string }): Promise<{ json: string }> } | null;
    let probe: { chapters?: { start_time: string; end_time: string; tags?: { title?: string } }[] } | null = null;
    try { probe = d?.ffprobe ? await d.ffprobe(src.localPath) : kp?.ffprobe ? JSON.parse((await kp.ffprobe({ path: src.localPath })).json) : null; } catch { probe = null; }
    chapters = (probe?.chapters ?? []).map((c) => ({ start: Number(c.start_time), end: Number(c.end_time), title: c.tags?.title ?? '' })).filter((c) => isFinite(c.start) && c.end > c.start);
    for (const c of chapters) { const k = /^(op|opening|intro)\b/i.test(c.title) ? 'op' : /^(ed|ending|outro|credits)\b/i.test(c.title) ? 'ed' : /recap|previously/i.test(c.title) ? 'recap' : null; if (k) skips.push({ start: c.start, end: c.end, kind: k }); }
    const draw = () => { const dur = video.duration || 0; if (!dur) return; bar.querySelectorAll('.kt-chapter').forEach((x) => x.remove()); for (const c of chapters.slice(1)) bar.append(h('i', { class: 'kt-chapter', style: { insetInlineStart: `${(c.start / dur) * 100}%` } })); };
    if (video.duration) draw(); else video.addEventListener('loadedmetadata', draw, { once: true });
  })();
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
  let skipped = new Set<number>();
  function skipCheck(c: number) {
    const mode = getPrefs().autoSkip; const sk = mode === 'off' ? undefined : skips.find((x) => c >= x.start && c < x.end - 1);
    if (!sk) { skipOp.hidden = true; return; }
    const i = skips.indexOf(sk);
    if (mode === 'auto' && !skipped.has(i)) { skipped.add(i); video.currentTime = sk.end; flashText(t(sk.kind === 'op' ? 'skippedOpening' : sk.kind === 'ed' ? 'skippedEnding' : 'skippedRecap')); return; }
    skipOp.hidden = false; skipOp.textContent = t(sk.kind === 'op' ? 'skipOpening' : sk.kind === 'ed' ? 'skipEnding' : 'skipRecap'); skipOp.onclick = () => { video.currentTime = sk.end; skipOp.hidden = true; };
  }
  // Dragging the subtitles up or down moves them (REX Player's way); the position is kept.
  for (const box of [subBox, subTop]) box.addEventListener('pointerdown', (e) => {
    if (locked || !(e.target as HTMLElement).closest('.kt-cue')) return; e.stopPropagation(); const r = stage.getBoundingClientRect(); const y0 = e.clientY; const p0 = getPrefs().subPos; box.setPointerCapture(e.pointerId);
    const mv = (ev: PointerEvent) => { updatePrefs({ subPos: Math.max(5, Math.min(100, Math.round(p0 - ((y0 - ev.clientY) / r.height) * 100))) }); applySubStyle(); };
    const up = () => { box.removeEventListener('pointermove', mv); box.removeEventListener('pointerup', up); box.removeEventListener('pointercancel', up); };
    box.addEventListener('pointermove', mv); box.addEventListener('pointerup', up); box.addEventListener('pointercancel', up);
  });
  // Another player (VLC, MX, mpv…) through Android's chooser.
  function canOpenWith() { return !!(window as unknown as { Capacitor?: { isNativePlatform?(): boolean } }).Capacitor?.isNativePlatform?.(); }
  async function openWith() { const { ktPlugin } = await import('../native'); const kp = ktPlugin() as unknown as { openWith?(o: { url?: string; path?: string; mime: string; title: string }): Promise<void> } | null; try { video.pause(); await kp?.openWith?.({ url: src.localPath ? undefined : src.url, path: src.localPath, mime: 'video/*', title: src.name }); } catch (e) { toast(String((e as Error).message ?? e), 'error'); } }

  // ---- closing
  function close() {
    remember(key, { pos: video.currentTime, duration: video.duration, speed, sub: current?.id, subDelay });
    window.clearInterval(ambTimer); video.pause(); ass?.free(); try { ctx?.close(); } catch { /* ignore */ } video.removeAttribute('src'); video.load(); root.remove(); window.removeEventListener('keydown', onKey);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined); void wake?.then((w) => w?.release()); void (screen.orientation as ScreenOrientation & { unlock?(): void }).unlock?.();
  }
  root.addEventListener('kt-close', close);
}
