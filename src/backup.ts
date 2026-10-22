// Backup & restore. A "notes" backup is a small JSON file: settings, folders,
// custom-font list, and every book's bookmarks, highlights, notes and reading
// position (keyed by file name + size so they re-attach to the same files). A
// "full" backup is a ZIP with that JSON plus the book files and covers.
import JSZip from 'jszip';
import { db, type Book, type Folder } from './db';
import { getSettings, updateSettings, type VisualSettings } from './settings';
import { listFonts, type CustomFont } from './fonts';
import { shareFile } from './ui/share';
import { importFiles } from './library';
import { t } from './i18n';

interface BookRecord {
  key: string; title: string; author?: string; fileName: string; size: number; format: string; folderName?: string; tags?: string[]; tagsAt?: number;
  addedAt: number; lastOpenedAt?: number; progress?: Book['progress']; bookmarks: Book['bookmarks']; highlights: Book['highlights']; pins?: Book['pins']; pdfHighlights?: Book['pdfHighlights']; prefs?: Book['prefs']; stats?: Book['stats'];
  id?: string;
}
interface Manifest {
  app: 'KurokawaReader'; version: 1; createdAt: number; full: boolean;
  settings: VisualSettings; local: Record<string, string>; folders: Folder[]; fonts: CustomFont[]; books: BookRecord[];
}

const LOCAL_KEYS = ['kr.lang', 'kr.dir', 'kr.sort', 'kr.translateTo'];
const keyOf = (b: { fileName: string; size: number }) => `${b.fileName}:${b.size}`;

async function manifest(full: boolean): Promise<Manifest> {
  const books = await db.allBooks();
  const folders = (await db.getMeta<Folder[]>('folders')) ?? [];
  const local: Record<string, string> = {};
  for (const k of LOCAL_KEYS) { const v = localStorage.getItem(k); if (v) local[k] = v; }
  return {
    app: 'KurokawaReader', version: 1, createdAt: Date.now(), full,
    settings: { ...getSettings(), aiKey: '', syncDropboxRefresh: '', syncWebdavPass: '' }, local, folders, fonts: await listFonts(),
    books: books.map((b) => ({
      key: keyOf(b), id: b.id, title: b.title, author: b.author, fileName: b.fileName, size: b.size, format: b.format,
      folderName: folders.find((f) => f.id === b.folderId)?.name, tags: b.tags, tagsAt: b.tagsAt, addedAt: b.addedAt, lastOpenedAt: b.lastOpenedAt,
      progress: b.progress, bookmarks: b.bookmarks, highlights: b.highlights, pins: b.pins, pdfHighlights: b.pdfHighlights, prefs: b.prefs, stats: b.stats,
    })),
  };
}

const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`; };

export async function backupNotes(): Promise<void> {
  const m = await manifest(false);
  await shareFile(new Blob([JSON.stringify(m, null, 1)], { type: 'application/json' }), `KurokawaReader-backup-${stamp()}.json`, t('backup'));
}

export async function backupFull(onProgress?: (done: number, total: number) => void): Promise<void> {
  const m = await manifest(true);
  const zip = new JSZip();
  zip.file('kurokawa-backup.json', JSON.stringify(m, null, 1));
  const books = await db.allBooks();
  let i = 0;
  for (const b of books) {
    const file = await db.getFile(b.id);
    if (file) zip.file(`books/${b.id}/${b.fileName}`, file);
    if (b.cover) zip.file(`books/${b.id}/cover`, b.cover);
    onProgress?.(++i, books.length);
  }
  for (const f of m.fonts) { const blob = await db.getFile(`font:${f.id}`); if (blob) zip.file(`fonts/${f.id}`, blob); }
  const blob = await zip.generateAsync({ type: 'blob', compression: 'STORE' });
  await shareFile(blob, `KurokawaReader-full-backup-${stamp()}.zip`, t('backup'));
}

/** Restores a backup file (JSON or ZIP). Returns how many books/notes were applied. */
export async function restoreBackup(file: File, onProgress?: (msg: string) => void): Promise<number> {
  let m: Manifest; let zip: JSZip | null = null;
  if (/\.zip$/i.test(file.name) || file.type.includes('zip')) {
    zip = await JSZip.loadAsync(file);
    const entry = zip.file('kurokawa-backup.json');
    if (!entry) throw new Error('manifest missing');
    m = JSON.parse(await entry.async('string')) as Manifest;
  } else m = JSON.parse(await file.text()) as Manifest;
  if (m.app !== 'KurokawaReader' || !Array.isArray(m.books)) throw new Error('not a KurokawaReader backup');

  // settings
  const cur = getSettings(); updateSettings({ ...m.settings, aiKey: m.settings.aiKey || cur.aiKey, syncDropboxRefresh: cur.syncDropboxRefresh, syncWebdavPass: cur.syncWebdavPass });
  for (const [k, v] of Object.entries(m.local ?? {})) localStorage.setItem(k, v);

  // folders: merge by name
  const folders = (await db.getMeta<Folder[]>('folders')) ?? [];
  for (const f of m.folders ?? []) if (!folders.some((x) => x.name === f.name)) folders.push({ ...f });
  await db.setMeta('folders', folders);
  const folderId = (name?: string) => (name ? folders.find((f) => f.name === name)?.id : undefined);

  // fonts (full backups carry the files)
  if (zip && m.fonts?.length) {
    const have = await listFonts();
    const merged = [...have];
    for (const f of m.fonts) {
      const blob = await zip.file(`fonts/${f.id}`)?.async('blob');
      if (!blob || have.some((x) => x.id === f.id)) continue;
      await db.putFile(`font:${f.id}`, blob); merged.push(f);
    }
    await db.setMeta('fonts', merged);
  }

  // books
  const existing = await db.allBooks();
  const byKey = new Map(existing.map((b) => [keyOf(b), b]));
  let applied = 0;
  for (const rec of m.books) {
    onProgress?.(rec.title);
    let book = byKey.get(rec.key);
    if (!book && zip) {
      const entry = zip.file(`books/${rec.id}/${rec.fileName}`);
      if (entry) {
        const blob = await entry.async('blob');
        const [added] = await importFiles([new File([blob], rec.fileName)]);
        if (added) { book = added; const cover = await zip.file(`books/${rec.id}/cover`)?.async('blob'); if (cover) await db.updateBook(added.id, (b) => { b.cover = cover; }); }
      }
    }
    if (!book) continue;
    await db.updateBook(book.id, (b) => {
      const ids = new Set(b.bookmarks.map((x) => x.id));
      b.bookmarks.push(...(rec.bookmarks ?? []).filter((x) => !ids.has(x.id)));
      const hids = new Set(b.highlights.map((x) => x.id));
      b.highlights.push(...(rec.highlights ?? []).filter((x) => !hids.has(x.id)));
      const pids = new Set((b.pins ?? []).map((x) => x.id));
      b.pins = [...(b.pins ?? []), ...(rec.pins ?? []).filter((x) => !pids.has(x.id))];
      const phids = new Set((b.pdfHighlights ?? []).map((x) => x.id));
      b.pdfHighlights = [...(b.pdfHighlights ?? []), ...(rec.pdfHighlights ?? []).filter((x) => !phids.has(x.id))];
      if (rec.progress && (!b.lastOpenedAt || (rec.lastOpenedAt ?? 0) >= b.lastOpenedAt)) { b.progress = rec.progress; b.lastOpenedAt = rec.lastOpenedAt ?? b.lastOpenedAt; }
      if (rec.prefs) b.prefs = { ...b.prefs, ...rec.prefs };
      if (rec.stats && (rec.stats.sessionAt ?? 0) > (b.stats?.sessionAt ?? 0)) b.stats = rec.stats;
      const fid = folderId(rec.folderName); if (fid && !b.folderId) b.folderId = fid;
      if (rec.tags?.length) { b.tags = [...new Set([...(b.tags ?? []), ...rec.tags])]; b.tagsAt = Date.now(); }
    });
    applied++;
  }
  return applied;
}
