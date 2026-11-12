// A novel moved to another source (Mihon's and LNReader's migration): when its site dies, is blocked, or another
// translates it better, the same novel from another extension takes its place — the book in the library stays
// the same book (its tags, rating, tracking, notes), its chapters become the new source's, and what was read
// follows chapter for chapter: the place reached, the chapters marked read or starred, the bookmarks, the
// chapters already kept offline.
import { db, type Book, type Locator } from '../db';
import { extHandle, fetchNovel, readNovelFile, MIME, type WebNovel } from './ext/source';

export { chapterNumber, chapterMap } from './chaptermap';
import { chapterMap } from './chaptermap';

export interface Moved { mapped: number; total: number; at?: string; kept: number }

/** The library's novel `book` moved to the novel at `path` in the source `srcId`. */
export async function migrateNovel(book: Book, srcId: string, path: string): Promise<Moved> {
  const old = await readNovelFile(book.id);
  if (!old) throw new Error('parse');
  const h = await extHandle(srcId);
  const fresh = await fetchNovel(h, path, true);
  const map = chapterMap(old.chapters, fresh.chapters);
  // (The chapters kept offline go with it, under the new source's addresses.)
  const content: Record<string, { html: string; at: number }> = {};
  let kept = 0;
  old.chapters.forEach((c, i) => { const j = map(i); const had = old.content?.[c.path]; if (j !== undefined && had && !content[fresh.chapters[j].path]) { content[fresh.chapters[j].path] = had; kept++; } });
  const next: WebNovel = { ...fresh, content: Object.keys(content).length ? content : null, fetchedAt: undefined };
  const file = new File([JSON.stringify(next)], book.fileName || `${next.title}.webnovel.json`, { type: MIME });
  // (Contents indexes: the novel's card first, then its chapters — a chapter's entry is its index + 1.)
  const tocMap = (t: number | undefined): number | undefined => (t === undefined ? undefined : t < 1 ? t : ((j) => (j === undefined ? undefined : j + 1))(map(t - 1)));
  const anchorMap = (a: string | undefined): string | undefined => { const m = a ? new RegExp(`^${book.id}-([ct])(\\d+)$`).exec(a) : null; if (!m) return a; const j = map(Number(m[2])); return j === undefined ? undefined : `${book.id}-${m[1]}${j}`; };
  const locMap = (l: Locator): Locator => {
    const toc = tocMap(l.toc); const chapter = l.chapter !== undefined ? map(l.chapter) : toc !== undefined && toc >= 1 ? toc - 1 : undefined;
    const anchor = chapter !== undefined ? `${book.id}-c${chapter}` : anchorMap(l.anchor);
    return { bookId: l.bookId, pct: chapter !== undefined && fresh.chapters.length ? Math.min(1, (chapter + 1) / fresh.chapters.length) : l.pct, ...(toc !== undefined ? { toc } : {}), ...(chapter !== undefined ? { chapter } : {}), ...(anchor ? { anchor } : {}) };
  };
  const keys = <T>(r: Record<string, T> | undefined) => { if (!r) return r; const o: Record<string, T> = {}; for (const [k, v] of Object.entries(r)) { const t = tocMap(Number(k)); if (t !== undefined) o[String(t)] = v; } return o; };
  let mapped = 0; old.chapters.forEach((_, i) => { if (map(i) !== undefined) mapped++; });
  const at = book.progress?.toc !== undefined && book.progress.toc >= 1 ? fresh.chapters[(tocMap(book.progress.toc) ?? 0) - 1]?.name : undefined;
  await db.putFile(book.id, file);
  await db.updateBook(book.id, (b) => {
    b.size = file.size; b.pageCount = fresh.chapters.length; b.chapters = fresh.chapters.length; b.fileName = file.name;
    b.remote = { source: fresh.src, id: fresh.path, online: kept < fresh.chapters.length, chapterCount: fresh.chapters.length, checkedAt: Date.now(), newChapters: 0 };
    if (b.progress) b.progress = locMap(b.progress);
    if (b.readToc !== undefined) { const t = tocMap(b.readToc); if (t !== undefined) b.readToc = t; else delete b.readToc; }
    b.chapterMarks = keys(b.chapterMarks) as Book['chapterMarks']; b.chapterStars = keys(b.chapterStars) as Book['chapterStars'];
    b.bookmarks = b.bookmarks.map((x) => ({ ...x, locator: locMap(x.locator) }));
    b.highlights = b.highlights.map((x) => ({ ...x, anchor: anchorMap(x.anchor) ?? x.anchor }));
    if (!b.description && fresh.summary) b.description = fresh.summary;
  });
  return { mapped, total: old.chapters.length, at, kept };
}
