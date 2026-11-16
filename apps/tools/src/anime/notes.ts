// The user's notes on episodes and on a show, and a show's full review: kept on the device first (IndexedDB, one
// record a show), editable and deletable offline, and sent only when the user presses Send for that text — to where
// the services really take it:
//   AniList — an episode's note as a text activity (SaveTextActivity, public on the profile and the feed) or as a
//     line in the list entry's notes (SaveMediaListEntry notes, seen with the list); a full review of the show with
//     SaveReview (body at least 2,200 characters, summary 20–120, a score out of 100, public or private).
//   MyAnimeList — no reviews and nothing per episode in its API: one «comments» text on the list entry, where the
//     notes go as lines, as in AniList's list notes.
import { db, uid } from '../db';
import * as al from '../anilist';

export type NoteMode = 'local' | 'activity' | 'notes';
export interface ShowNote {
  id: string; show: number; /** 0: the whole show. */ ep: number; text: string; /** Out of 10 for a note, of 100 for a review. */ score?: number;
  at: number; edited: number;
  /** A full review (on the show only): its summary and whether AniList keeps it private. */ review?: { summary: string; private: boolean };
  /** What AniList has: how it went there, its id there, the text sent. */ al?: { how: 'activity' | 'notes' | 'review'; id?: number; at: number; text: string };
  mal?: { at: number; text: string };
  /** The last send that failed (the text is kept; it can be sent again). */ fail?: { to: 'anilist' | 'mal'; msg: string; wait?: number; at: number };
}
export const REVIEW_MIN = 2200; export const SUMMARY_MIN = 20; export const SUMMARY_MAX = 120;
/** Characters as AniList's rule counts them (each letter once, whatever its bytes). */
export const chars = (s: string): number => [...s.trim()].length;

const key = (show: number) => `anime-notes:${show}`;
export async function notesOf(show: number): Promise<ShowNote[]> { try { return ((await db.getMeta<ShowNote[]>(key(show))) ?? []).slice().sort((a, b) => (a.review ? -1 : 0) - (b.review ? -1 : 0) || a.ep - b.ep || a.at - b.at); } catch { return []; } }
async function keepAll(show: number, xs: ShowNote[]): Promise<void> { if (xs.length) await db.setMeta(key(show), xs); else await db.deleteMeta(key(show)); }
/** A note written or changed (saved here only). */
export async function saveNote(n: Omit<ShowNote, 'id' | 'at' | 'edited'> & { id?: string }): Promise<ShowNote> {
  const all = await notesOf(n.show); const had = n.id ? all.find((x) => x.id === n.id) : undefined;
  const next: ShowNote = { ...(had ?? {}), ...n, id: had?.id ?? uid(), at: had?.at ?? Date.now(), edited: Date.now() } as ShowNote;
  await keepAll(n.show, [...all.filter((x) => x.id !== next.id), next]); return next;
}
export async function deleteNote(show: number, id: string): Promise<void> { const all = await notesOf(show); await keepAll(show, all.filter((x) => x.id !== id)); }
async function patch(n: ShowNote, ch: Partial<ShowNote>): Promise<ShowNote> {
  const all = await notesOf(n.show); const cur = all.find((x) => x.id === n.id) ?? n; const next = { ...cur, ...ch } as ShowNote;
  for (const k of Object.keys(ch) as (keyof ShowNote)[]) if (ch[k] === undefined) delete next[k];
  await keepAll(n.show, [...all.filter((x) => x.id !== n.id), next]); return next;
}
/** Changed since it was last sent there. */
export const changedSince = (n: ShowNote, sent?: { text: string }): boolean => !!sent && sent.text !== n.text;

/* ---------- the lines in a list's notes (AniList) or comments (MyAnimeList) ---------- */
const TAG = /^\[(?:Ep (\d+)|Show)\] /;
/** One note as one line of the list's notes: «[Ep 5] text (8/10)», «[Show] text». */
export function noteLine(n: Pick<ShowNote, 'ep' | 'text' | 'score'>): string {
  return `${n.ep ? `[Ep ${n.ep}]` : '[Show]'} ${n.text.replace(/\s*\n+\s*/g, ' ').trim()}${n.score ? ` (${n.score}/10)` : ''}`;
}
/** The list's notes with this episode's line put in (or taken out, when `line` is null): the user's own text kept as
 *  it is, above; the app's lines below it, by episode. */
export function mergeLines(current: string, ep: number, line: string | null): string {
  const mine: [number, string][] = []; const other: string[] = [];
  for (const l of (current ?? '').split('\n')) { const m = TAG.exec(l); if (m) mine.push([m[1] ? Number(m[1]) : 0, l]); else other.push(l); }
  const rest = mine.filter(([e]) => e !== ep); if (line) rest.push([ep, line]); rest.sort((a, b) => a[0] - b[0]);
  while (other.length && !other[other.length - 1].trim()) other.pop();
  return [...other, ...rest.map(([, l]) => l)].join('\n');
}

/* ---------- AniList ---------- */
const Q_NOTES = 'query ($id: Int) { Media(id: $id, type: ANIME) { mediaListEntry { id notes } } }';
const M_ACTIVITY = 'mutation ($id: Int, $text: String) { SaveTextActivity(id: $id, text: $text) { id } }';
const M_NOTES = 'mutation ($mediaId: Int, $notes: String, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $mediaId, notes: $notes, status: $status) { id notes } }';
const M_REVIEW = 'mutation ($id: Int, $mediaId: Int, $body: String, $summary: String, $score: Int, $private: Boolean) { SaveReview(id: $id, mediaId: $mediaId, body: $body, summary: $summary, score: $score, private: $private) { id } }';
/** Whether the show is on the user's AniList list (a note put in its notes adds it, as «Watching», when it is not). */
export async function onAniListList(show: number): Promise<boolean> { const d = await al.gql<{ Media: { mediaListEntry: { id: number } | null } }>(Q_NOTES, { id: show }); return !!d.Media.mediaListEntry; }
/** Why a review cannot be sent yet (nothing when it can). */
export function reviewProblem(n: Pick<ShowNote, 'text' | 'score' | 'review'>): 'body' | 'summary' | 'score' | null {
  if (chars(n.text) < REVIEW_MIN) return 'body';
  const s = chars(n.review?.summary ?? ''); if (s < SUMMARY_MIN || s > SUMMARY_MAX) return 'summary';
  if (n.score === undefined || n.score < 1 || n.score > 100) return 'score';
  return null;
}
const failed = (n: ShowNote, to: 'anilist' | 'mal', e: unknown) => patch(n, { fail: { to, msg: String((e as Error)?.message ?? e), wait: al.retryAfterOf(e), at: Date.now() } });
/** The note sent to AniList, as `how` — `public` the exact text the user saw before pressing Send (an activity's). */
export async function sendAniList(n: ShowNote, how: 'activity' | 'notes' | 'review', publicText: string): Promise<ShowNote> {
  try {
    let id: number | undefined;
    if (how === 'review') {
      const p = reviewProblem(n); if (p) throw new Error(`review: ${p}`);
      const d = await al.gql<{ SaveReview: { id: number } }>(M_REVIEW, { id: n.al?.how === 'review' ? n.al.id : undefined, mediaId: n.show, body: n.text.trim(), summary: n.review!.summary.trim(), score: Math.round(n.score!), private: !!n.review!.private });
      id = d.SaveReview.id;
    } else if (how === 'activity') {
      const d = await al.gql<{ SaveTextActivity: { id: number } }>(M_ACTIVITY, { id: n.al?.how === 'activity' ? n.al.id : undefined, text: publicText });
      id = d.SaveTextActivity.id;
    } else {
      const d = await al.gql<{ Media: { mediaListEntry: { id: number; notes: string | null } | null } }>(Q_NOTES, { id: n.show });
      const cur = d.Media.mediaListEntry;
      const r = await al.gql<{ SaveMediaListEntry: { id: number } }>(M_NOTES, { mediaId: n.show, notes: mergeLines(cur?.notes ?? '', n.ep, publicText), status: cur ? undefined : 'CURRENT' });
      id = r.SaveMediaListEntry.id;
    }
    return await patch(n, { al: { how, id, at: Date.now(), text: n.text }, fail: undefined });
  } catch (e) { await failed(n, 'anilist', e); throw e; }
}
/** What AniList has of the note taken away (the activity or review deleted, the line taken out of the notes). */
export async function unsendAniList(n: ShowNote): Promise<void> {
  if (!n.al) return;
  if (n.al.how === 'activity' && n.al.id) await al.gql('mutation ($id: Int) { DeleteActivity(id: $id) { deleted } }', { id: n.al.id });
  else if (n.al.how === 'review' && n.al.id) await al.gql('mutation ($id: Int) { DeleteReview(id: $id) { deleted } }', { id: n.al.id });
  else if (n.al.how === 'notes') { const d = await al.gql<{ Media: { mediaListEntry: { notes: string | null } | null } }>(Q_NOTES, { id: n.show }); if (d.Media.mediaListEntry) await al.gql(M_NOTES, { mediaId: n.show, notes: mergeLines(d.Media.mediaListEntry.notes ?? '', n.ep, null) }); }
}

/* ---------- MyAnimeList ---------- */
export async function sendMal(n: ShowNote, idMal: number, line: string): Promise<ShowNote> {
  try { const m = await import('./mal'); const cur = await m.malComments(idMal); await m.malSetComments(idMal, mergeLines(cur ?? '', n.ep, line), cur === null); return await patch(n, { mal: { at: Date.now(), text: n.text }, fail: undefined }); }
  catch (e) { await failed(n, 'mal', e); throw e; }
}
export async function unsendMal(n: ShowNote, idMal: number): Promise<void> { if (!n.mal) return; const m = await import('./mal'); const cur = await m.malComments(idMal); if (cur !== null) await m.malSetComments(idMal, mergeLines(cur, n.ep, null)); }
