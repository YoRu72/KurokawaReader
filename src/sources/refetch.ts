// A library book whose file came broken (cut short, or a web page in its place, before downloads were looked
// at) fetched again from where it came — a web folder, archive.org, a link — into the same book, its reading
// kept: the place, the notes, the highlights stay with it.
import type { Book } from '../db';
import type { Source, SourceFile } from './types';

async function sourceOf(id: string): Promise<Source | null> {
  if (id.startsWith('dir:')) {
    const { listRepos } = await import('./repos'); const { folderSource } = await import('./folder');
    const repo = (await listRepos()).find((r) => r.kind === 'folder' && `dir:${r.key}` === id);
    return repo ? folderSource(repo) : null;
  }
  const { archiveSource } = await import('./archive');
  return id === archiveSource.id ? archiveSource : null;
}

/** Whether the book can be fetched again (it came as a file, from a folder, archive.org or a link). */
export function canRefetch(book: Book): boolean {
  const r = book.remote; if (!r) return false;
  return r.source === 'link' || r.source.startsWith('dir:') || r.source === 'archive';
}

/** Fetches the book's file again into the same book; resolves once it is there. */
export async function refetchBook(book: Book, onProgress?: (pct: number) => void): Promise<void> {
  const r = book.remote; if (!r) throw new Error('notFound');
  const { startDownload, onDownloads, downloadOf } = await import('../downloads');
  const then = { srcId: r.source, itemId: r.id, title: book.title, replace: book.id };
  if (r.source === 'link') { await startDownload({ url: r.id, name: book.fileName, title: book.title, then }); return; }
  const src = await sourceOf(r.source); if (!src) throw new Error('notFound');
  const d = await src.details(r.id);
  const want = (f: SourceFile) => (f.name ?? '').toLowerCase() === book.fileName.toLowerCase();
  const file = d.files.find(want) ?? d.files.find((f) => f.ext === book.format) ?? d.files[0];
  if (!file) throw new Error('notFound');
  const info = src.downloadInfo?.(file);
  if (info) {
    const off = onDownloads(() => { const x = downloadOf(r.source, r.id, info.url); if (x && x.state === 'running') onProgress?.(x.pct); });
    try { await startDownload({ url: info.url, headers: info.headers, name: file.name ?? book.fileName, mime: file.mime, size: file.size, title: book.title, then }); }
    finally { off(); }
    return;
  }
  const got = await src.fetchFile!({ id: r.id, title: book.title, tags: [], files: [file] }, file, (p) => onProgress?.(p.pct));
  const { fileFault } = await import('../filecheck');
  if (await fileFault(got, got.name || book.fileName, file.size)) throw new Error('cut');
  const { db } = await import('../db');
  await db.putFile(book.id, got); await db.updateBook(book.id, (b) => { b.size = got.size; });
}
