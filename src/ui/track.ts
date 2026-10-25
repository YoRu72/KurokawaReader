// The AniList entry of a book: found by searching the catalogue, then its status, progress, score and dates,
// written to the list as they are changed. The score is the one truth shared with the app's stars: a rating
// given here or in the library goes to AniList, and what AniList has comes back into the stars.
import { h, icon, openSheet, toast } from './dom';
import { t, localDigits } from '../i18n';
import { db, type Book } from '../db';
import * as al from '../anilist';
import { getSettings } from '../settings';

/** Stars (1–5) from an AniList score in the account's format, and back. */
export const starsOf = (score: number, f: al.ScoreFormat): number => (score > 0 ? Math.max(1, Math.min(5, Math.round((score / al.scoreMax(f)) * 5))) : 0);
export const scoreOf = (stars: number, f: al.ScoreFormat): number => (stars > 0 ? Math.round(((stars / 5) * al.scoreMax(f)) * 10) / 10 : 0);

async function persist(book: Book, track: al.Track | undefined, rating?: number): Promise<void> {
  const at = Date.now();
  if (track) track.updatedAt = at;
  book.track = track;
  if (rating !== undefined) { if (rating) book.rating = rating; else delete book.rating; book.ratingAt = at; }
  await db.updateBook(book.id, (b) => { b.track = track; if (rating !== undefined) { if (rating) b.rating = rating; else delete b.rating; b.ratingAt = at; } });
  void import('../sync').then((m) => m.scheduleSync()).catch(() => undefined);
}

/** The app's stars sent to AniList, when the book is tracked (called by the review sheet). */
export async function pushStars(book: Book, stars: number): Promise<void> {
  const u = al.user(); if (!book.track || !u || !al.anilistOn()) return;
  const score = scoreOf(stars, u.scoreFormat);
  if (score === book.track.entry.score) return;
  try { const e = await al.save(book.track.media.id, { ...book.track.entry, score }); await persist(book, { ...book.track, entry: e }); }
  catch (e) { toast(`AniList: ${(e as Error).message}`, 'error'); }
}

/** Chapters read in the app sent on as progress (when turned on), never moving it backwards. */
export async function pushProgress(book: Book, chaptersRead: number): Promise<void> {
  const u = al.user(); if (!book.track || !u || !al.anilistOn() || !getSettings().anilistAutoProgress) return;
  if (chaptersRead <= book.track.entry.progress) return;
  const max = book.track.media.chapters ?? Infinity; const progress = Math.min(max, chaptersRead);
  const entry: al.AlEntry = { ...book.track.entry, progress };
  if (entry.status === 'PLANNING') { entry.status = 'CURRENT'; entry.startedAt = entry.startedAt?.year ? entry.startedAt : al.today(); }
  if (max !== Infinity && progress >= max) { entry.status = 'COMPLETED'; entry.completedAt = entry.completedAt?.year ? entry.completedAt : al.today(); }
  try { const e = await al.save(book.track.media.id, entry); await persist(book, { ...book.track, entry: e }); } catch { /* next time */ }
}

export function trackSheet(book: Book, onChange: () => void): void {
  const sh = openSheet(t('tracking'), t('close'), { stack: true });
  sh.body.style.fontFamily = 'var(--font-ui)';
  const u = al.user()!;
  if (!book.track) searchView(); else entryView();

  function searchView(): void {
    const q = h('input', { type: 'search', value: book.title, placeholder: t('searchAnilist'), dir: 'auto', class: 'track-search' }) as HTMLInputElement;
    const results = h('div', { class: 'track-results' });
    const go = async () => {
      results.replaceChildren(h('div', { class: 'spinner small' }));
      try {
        const found = await al.search(q.value.trim());
        if (!found.length) { results.replaceChildren(h('p', { class: 'src' }, t('noResults'))); return; }
        results.replaceChildren(...found.map(({ media, entry }) => h('button', { type: 'button', class: 'track-hit', onclick: () => void bind(media, entry) },
          media.cover ? h('img', { src: media.cover, alt: '' }) : h('span', { class: 'track-nocover' }),
          h('div', null, h('b', { dir: 'auto' }, media.title), media.titleNative && media.titleNative !== media.title ? h('div', { class: 'src', dir: 'auto' }, media.titleNative) : null,
            h('div', { class: 'src' }, [media.format, media.status, media.year ? localDigits(String(media.year)) : '', media.score ? `${localDigits(String(media.score))}%` : '', entry ? t(`al_${entry.status}` as 'al_CURRENT') : ''].filter(Boolean).join(' · '))))));
      } catch (e) { results.replaceChildren(h('p', { class: 'src' }, `AniList: ${(e as Error).message}`)); }
    };
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void go(); } });
    sh.body.replaceChildren(h('div', { class: 'tool-bar' }, q, h('button', { type: 'button', class: 'btn small primary', onclick: () => void go() }, icon('search'), t('search'))), results);
    sh.actions.replaceChildren();
    void go();
  }

  async function bind(media: al.AlMedia, entry?: al.AlEntry): Promise<void> {
    const e: al.AlEntry = entry ?? { status: book.progress ? 'CURRENT' : 'PLANNING', progress: 0, score: scoreOf(book.rating ?? 0, u.scoreFormat), startedAt: book.progress ? al.today() : undefined };
    try {
      const saved = entry ?? await al.save(media.id, e);
      // The stars follow AniList's score when it has one; otherwise the app's stars go up to AniList.
      let rating: number | undefined;
      if (saved.score > 0) rating = starsOf(saved.score, u.scoreFormat);
      await persist(book, { service: 'anilist', media, entry: saved, updatedAt: Date.now() }, rating);
      if (!entry && !saved.score && book.rating) await pushStars(book, book.rating);
      onChange(); entryView(); toast(t('trackLinked'));
    } catch (err) { toast(`AniList: ${(err as Error).message}`, 'error'); }
  }

  function entryView(): void {
    const tr = book.track!; const e = { ...tr.entry }; const m = tr.media;
    const head = h('div', { class: 'track-head' }, m.cover ? h('img', { src: m.cover, alt: '' }) : null,
      h('div', null, h('b', { dir: 'auto' }, m.title), h('div', { class: 'src' }, [m.format, m.status, m.year ? localDigits(String(m.year)) : ''].filter(Boolean).join(' · ')),
        h('a', { href: m.url, target: '_blank', rel: 'noopener', class: 'src' }, 'anilist.co')));
    const field = (label: string, el: HTMLElement) => h('label', { class: 'track-field' }, h('span', null, label), el);
    const status = h('select', null, ...al.AL_STATUSES.map((s) => h('option', { value: s, selected: s === e.status }, t(`al_${s}` as 'al_CURRENT')))) as HTMLSelectElement;
    const progress = h('input', { type: 'number', min: '0', max: m.chapters ? String(m.chapters) : undefined, value: String(e.progress), inputmode: 'numeric' }) as HTMLInputElement;
    const score = h('input', { type: 'number', min: '0', max: String(al.scoreMax(u.scoreFormat)), step: String(al.scoreStep(u.scoreFormat)), value: String(e.score || ''), placeholder: '—', inputmode: 'decimal' }) as HTMLInputElement;
    const started = h('input', { type: 'date', value: al.dateOf(e.startedAt) }) as HTMLInputElement;
    const finished = h('input', { type: 'date', value: al.dateOf(e.completedAt) }) as HTMLInputElement;
    const plus = h('button', { type: 'button', class: 'btn small tonal', onclick: () => { progress.value = String((Number(progress.value) || 0) + 1); } }, '+١'.replace('١', localDigits('1')));
    sh.body.replaceChildren(head,
      h('div', { class: 'track-grid' },
        field(t('alStatus'), status),
        field(`${t('alProgress')}${m.chapters ? ' / ' + localDigits(String(m.chapters)) : ''}`, h('div', { class: 'row', style: { display: 'flex', gap: '6px' } }, progress, plus)),
        field(`${t('alScore')} (${t(`alFormat_${u.scoreFormat}` as 'alFormat_POINT_10')})`, score),
        field(t('alStarted'), started),
        field(t('alFinished'), finished)),
      h('p', { class: 'hint' }, t('trackStarsHint')));
    const saveBtn = h('button', { type: 'button', class: 'btn small primary', onclick: async () => {
      const next: al.AlEntry = { ...e, status: status.value as al.AlStatus, progress: Number(progress.value) || 0, score: Number(score.value) || 0, startedAt: al.toAlDate(started.value), completedAt: al.toAlDate(finished.value) };
      if (next.status === 'COMPLETED' && !next.completedAt) next.completedAt = al.today();
      saveBtn.disabled = true;
      try { const saved = await al.save(m.id, next); await persist(book, { ...tr, entry: saved }, starsOf(saved.score, u.scoreFormat)); onChange(); toast(t('trackSaved')); sh.close(); }
      catch (err) { toast(`AniList: ${(err as Error).message}`, 'error'); saveBtn.disabled = false; }
    } }, icon('check'), t('done')) as HTMLButtonElement;
    sh.actions.replaceChildren(
      h('button', { type: 'button', class: 'btn small', onclick: async () => { try { const r = await al.refresh(m.id); if (r.entry) { await persist(book, { ...tr, media: r.media, entry: r.entry }, starsOf(r.entry.score, u.scoreFormat)); onChange(); entryView(); toast(t('trackRefreshed')); } } catch (err) { toast(`AniList: ${(err as Error).message}`, 'error'); } } }, icon('cloud'), t('refresh')),
      h('button', { type: 'button', class: 'btn small', onclick: () => { void persist(book, undefined).then(() => { onChange(); searchView(); }); } }, icon('search'), t('trackChange')),
      h('button', { type: 'button', class: 'btn danger small', onclick: async () => { if (!confirm(t('trackRemoveConfirm'))) return; try { if (e.id) await al.remove(e.id); } catch { /* already gone */ } await persist(book, undefined); onChange(); sh.close(); } }, icon('trash'), t('trackRemove')),
      saveBtn);
  }
}
