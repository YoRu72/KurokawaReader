// Audiobook player: cover, chapters (from the file's tags, or one per file when
// several are opened together), position remembered per book, speed, skip,
// sleep timer, and lock-screen / headset controls through the Media Session API.
import { h, icon, iconButton, toast, clear, pickSheet } from '../ui/dom';
import { t, localDigits } from '../i18n';
import { db, type Book } from '../db';
import { navigate, back } from '../router';
import { coverUrl } from '../library';
import { scheduleSync } from '../sync';
import { keepAwake } from '../native';
import { readAudioMeta, type AudioChapter } from '../formats/audio';
import { ReadingTracker } from '../stats';

interface Track { book: Book; url: string; chapters: AudioChapter[]; duration: number }

/** A playable URL without loading the whole file: Android streams linked files straight from storage. */
async function srcFor(book: Book): Promise<{ url: string; revoke: boolean; file?: Blob }> {
  const cap = (window as unknown as { Capacitor?: { convertFileSrc?(u: string): string; getPlatform?(): string } }).Capacitor;
  if (book.source?.uri && cap?.convertFileSrc && cap.getPlatform?.() === 'android') return { url: cap.convertFileSrc(book.source.uri), revoke: false };
  const file = await db.getFile(book.id);
  if (!file) throw new Error(t('linkedFileMissing', { title: book.title }));
  return { url: URL.createObjectURL(file), revoke: true, file };
}

const fmt = (s: number) => { s = Math.max(0, Math.floor(s)); const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60; return localDigits(hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`); };

export async function mountAudio(root: HTMLElement, books: Book[], onDispose: (fn: () => void) => void): Promise<void> {
  root.classList.add('audio-view');
  const tracks: Track[] = [];
  const revokes: string[] = [];
  for (const b of books) {
    try {
      const s = await srcFor(b);
      if (s.revoke) revokes.push(s.url);
      let chapters: AudioChapter[] = [];
      if (s.file) chapters = (await readAudioMeta(s.file, b.fileName)).chapters;
      else {
        const saved = await db.getMeta<AudioChapter[]>(`audioch:${b.id}`); chapters = saved ?? [];
        if (!saved) void fetch(s.url).then((r) => r.blob()).then((blob) => readAudioMeta(blob, b.fileName)).then((m) => { void db.setMeta(`audioch:${b.id}`, m.chapters); const tr = tracks.find((x) => x.book.id === b.id); if (tr) tr.chapters = m.chapters; }).catch(() => {});
      }
      tracks.push({ book: b, url: s.url, chapters, duration: 0 });
    } catch (err) { toast(String((err as Error).message ?? err), 'error', 5000); }
  }
  if (!tracks.length) { navigate('/', true); return; }
  onDispose(() => revokes.forEach((u) => URL.revokeObjectURL(u)));

  const audio = new Audio(); audio.preload = 'metadata';
  // Listening time counts in the reading statistics (sessions, daily goal, streak).
  const tracker = new ReadingTracker(books[0], () => !audio.paused);
  tracker.start();
  onDispose(() => void tracker.stop());
  let ti = 0;
  const saved = await db.getMeta<{ track: number; time: number; rate: number }>(`audio:${books[0].id}`);
  if (saved && saved.track < tracks.length) ti = saved.track;
  audio.playbackRate = saved?.rate ?? 1;

  const cover = h('div', { class: 'audio-cover' });
  const titleEl = h('h2', { dir: 'auto' }); const authorEl = h('p', { class: 'audio-author', dir: 'auto' });
  const chapterEl = h('p', { class: 'audio-chapter', dir: 'auto' });
  const seek = h('input', { type: 'range', min: '0', max: '1000', value: '0', class: 'audio-seek', 'aria-label': t('progress') }) as HTMLInputElement;
  const cur = h('span'), dur = h('span');
  const playBtn = h('button', { class: 'audio-play', type: 'button', 'aria-label': t('play') }, icon('play'));
  const rateBtn = h('button', { class: 'btn small', type: 'button' });
  const sleepBtn = h('button', { class: 'btn small', type: 'button' }, icon('clock'), t('sleepTimer'));
  const topbar = h('header', { class: 'topbar' }, iconButton('back', t('back'), () => back('/')), h('div', { class: 'title', dir: 'auto' }, t('audiobooks')), iconButton('toc', t('contents'), () => chaptersSheet()));
  root.append(topbar, h('div', { class: 'audio-main' },
    cover, titleEl, authorEl, chapterEl,
    h('div', { class: 'audio-seek-row' }, seek, h('div', { class: 'audio-times' }, cur, dur)),
    h('div', { class: 'audio-controls' },
      iconButton('chevronLeft', t('prevChapter'), () => jumpChapter(-1)),
      h('button', { class: 'audio-skip', type: 'button', 'aria-label': '−15', onclick: () => { audio.currentTime = Math.max(0, audio.currentTime - 15); } }, '−15'),
      playBtn,
      h('button', { class: 'audio-skip', type: 'button', 'aria-label': '+30', onclick: () => { audio.currentTime = Math.min(audio.duration || Infinity, audio.currentTime + 30); } }, '+30'),
      iconButton('chevronRight', t('nextChapter'), () => jumpChapter(1))),
    h('div', { class: 'audio-extra' }, rateBtn, sleepBtn)));

  const track = () => tracks[ti];
  const chapterAt = (tm: number) => { const ch = track().chapters; let k = -1; for (let i = 0; i < ch.length; i++) if (ch[i].start <= tm + 0.5) k = i; return k; };
  const paintRate = () => { rateBtn.textContent = `${localDigits(audio.playbackRate.toFixed(2).replace(/0$/, ''))}×`; };
  rateBtn.addEventListener('click', () => pickSheet(t('speechRate'), ['0.75', '0.9', '1', '1.1', '1.25', '1.5', '1.75', '2', '2.5', '3'].map((v): [string, string] => [v, `${localDigits(v)}×`]), String(audio.playbackRate), (v) => { audio.playbackRate = Number(v); paintRate(); save(); }, t('close')));
  const load = (i: number, at = 0, autoplay = false) => {
    ti = i; const tr = track();
    audio.src = tr.url;
    const u = coverUrl(tr.book);
    clear(cover); if (u) cover.append(h('img', { src: u, alt: '' })); else cover.append(icon('speak'));
    titleEl.textContent = tr.book.title; authorEl.textContent = tr.book.author ?? '';
    audio.addEventListener('loadedmetadata', () => { tr.duration = audio.duration || 0; if (at) audio.currentTime = Math.min(at, Math.max(0, tr.duration - 2)); dur.textContent = fmt(tr.duration); if (autoplay) void audio.play(); paint(); }, { once: true });
    media();
    paint();
  };
  const paint = () => {
    const tr = track(); const d = audio.duration || tr.duration || 0;
    if (document.activeElement !== seek) seek.value = String(d ? Math.round((audio.currentTime / d) * 1000) : 0);
    seek.style.setProperty('--p', `${Number(seek.value) / 10}%`);
    cur.textContent = fmt(audio.currentTime);
    const k = chapterAt(audio.currentTime);
    chapterEl.textContent = k >= 0 ? tr.chapters[k].title : tracks.length > 1 ? `${localDigits(ti + 1)} / ${localDigits(tracks.length)}` : '';
    playBtn.replaceChildren(icon(audio.paused ? 'play' : 'pause'));
  };
  let lastSave = 0;
  const save = () => {
    const now = Date.now(); if (now - lastSave < 3000) return; lastSave = now;
    const total = tracks.reduce((a, x) => a + (x.duration || 0), 0);
    const before = tracks.slice(0, ti).reduce((a, x) => a + (x.duration || 0), 0);
    const pct = total ? Math.min(1, (before + audio.currentTime) / total) : 0;
    tracker.advance(0, pct);
    void db.setMeta(`audio:${books[0].id}`, { track: ti, time: audio.currentTime, rate: audio.playbackRate });
    void db.updateBook(track().book.id, (b) => { b.progress = { bookId: b.id, pct: (audio.duration ? audio.currentTime / audio.duration : 0) }; b.progressAt = now; b.lastOpenedAt = now; });
    if (books.length > 1) void db.updateBook(books[0].id, (b) => { b.progress = { bookId: b.id, pct }; });
    scheduleSync();
  };
  const jumpChapter = (dir: number) => {
    const ch = track().chapters; const k = chapterAt(audio.currentTime);
    if (ch.length) {
      if (dir < 0 && k >= 0 && audio.currentTime - ch[k].start > 3) { audio.currentTime = ch[k].start; return; }
      const n = k + dir;
      if (n >= 0 && n < ch.length) { audio.currentTime = ch[n].start; return; }
    }
    const nt = ti + dir; if (nt >= 0 && nt < tracks.length) load(nt, 0, !audio.paused);
  };
  function chaptersSheet() {
    const items: [string, string, string?][] = [];
    tracks.forEach((tr, i) => { if (tr.chapters.length) tr.chapters.forEach((c, k) => items.push([`${i}:${k}`, `${c.title} · ${fmt(c.start)}`])); else items.push([`${i}:-1`, tr.book.title]); });
    const k = chapterAt(audio.currentTime);
    pickSheet(t('contents'), items, `${ti}:${k}`, (v) => { const [i, c] = v.split(':').map(Number); const go = () => { if (c >= 0) audio.currentTime = tracks[i].chapters[c].start; void audio.play(); }; if (i !== ti) { load(i, c >= 0 ? tracks[i].chapters[c].start : 0, true); } else go(); }, t('close'));
  }
  // Sleep timer: minutes, or the end of the current chapter.
  let sleepT = 0; let sleepAtChapterEnd = false;
  sleepBtn.addEventListener('click', () => pickSheet(t('sleepTimer'), [['0', t('goalOff')], ['10', t('minutes', { n: 10 })], ['15', t('minutes', { n: 15 })], ['30', t('minutes', { n: 30 })], ['45', t('minutes', { n: 45 })], ['60', t('minutes', { n: 60 })], ['ch', t('sleepEndOfChapter')]], sleepAtChapterEnd ? 'ch' : sleepT ? 'set' : '0', (v) => {
    window.clearTimeout(sleepT); sleepT = 0; sleepAtChapterEnd = false;
    if (v === 'ch') { sleepAtChapterEnd = true; toast(t('sleepEndOfChapter')); }
    else if (v !== '0') { sleepT = window.setTimeout(() => { audio.pause(); sleepT = 0; toast(t('sleepTimerDone')); }, Number(v) * 60_000); toast(t('sleepTimerSet', { n: Number(v) })); }
  }, t('close')));
  let lastChapter = -1;
  audio.addEventListener('timeupdate', () => {
    paint(); save();
    const k = chapterAt(audio.currentTime);
    if (sleepAtChapterEnd && lastChapter >= 0 && k !== lastChapter) { audio.pause(); sleepAtChapterEnd = false; toast(t('sleepTimerDone')); }
    lastChapter = k;
  });
  audio.addEventListener('play', () => { paint(); keepAwake(false); navigator.mediaSession && (navigator.mediaSession.playbackState = 'playing'); });
  audio.addEventListener('pause', () => { paint(); lastSave = 0; save(); navigator.mediaSession && (navigator.mediaSession.playbackState = 'paused'); });
  audio.addEventListener('ended', () => { if (ti + 1 < tracks.length) load(ti + 1, 0, true); else { lastSave = 0; save(); } });
  audio.addEventListener('error', () => toast(t('audioError'), 'error', 5000));
  playBtn.addEventListener('click', () => { if (audio.paused) void audio.play(); else audio.pause(); });
  seek.addEventListener('input', () => { const d = audio.duration || 0; if (d) cur.textContent = fmt((Number(seek.value) / 1000) * d); });
  seek.addEventListener('change', () => { const d = audio.duration || 0; if (d) audio.currentTime = (Number(seek.value) / 1000) * d; });
  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).matches('input, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); if (audio.paused) void audio.play(); else audio.pause(); }
    else if (e.key === 'ArrowLeft') audio.currentTime = Math.max(0, audio.currentTime - 15);
    else if (e.key === 'ArrowRight') audio.currentTime += 30;
  };
  window.addEventListener('keydown', onKey);
  function media() {
    const ms = navigator.mediaSession; if (!ms) return;
    const tr = track(); const u = coverUrl(tr.book);
    try {
      ms.metadata = new MediaMetadata({ title: tr.book.title, artist: tr.book.author ?? '', album: t('audiobooks'), artwork: u ? [{ src: u, sizes: '512x512' }] : [] });
      ms.setActionHandler('play', () => void audio.play());
      ms.setActionHandler('pause', () => audio.pause());
      ms.setActionHandler('seekbackward', () => { audio.currentTime = Math.max(0, audio.currentTime - 15); });
      ms.setActionHandler('seekforward', () => { audio.currentTime += 30; });
      ms.setActionHandler('previoustrack', () => jumpChapter(-1));
      ms.setActionHandler('nexttrack', () => jumpChapter(1));
    } catch { /* partial support */ }
  }
  onDispose(() => { lastSave = 0; save(); audio.pause(); audio.removeAttribute('src'); window.removeEventListener('keydown', onKey); window.clearTimeout(sleepT); });
  paintRate();
  load(ti, saved?.time ?? 0);
}
