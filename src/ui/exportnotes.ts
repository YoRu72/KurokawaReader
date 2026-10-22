// Export a book's highlights, notes and bookmarks as a Markdown file (share or save).
import type { Book } from '../db';
import { shareFile } from './share';
import { t, formatDate } from '../i18n';

export function notesMarkdown(book: Book): string {
  const out: string[] = [`# ${book.title}`];
  if (book.author) out.push(`*${book.author}*`);
  out.push('');
  if (book.highlights.length) {
    out.push(`## ${t('highlights')}`, '');
    for (const hl of [...book.highlights].sort((a, b) => a.createdAt - b.createdAt)) {
      out.push(`> ${hl.text.replace(/\n+/g, '\n> ')}`);
      if (hl.note) out.push('', `${hl.note}`);
      out.push('', `<sub>${formatDate(hl.createdAt)}</sub>`, '');
    }
  }
  const pdf = [...(book.pdfHighlights ?? [])].sort((a, b) => a.createdAt - b.createdAt);
  if (pdf.length) {
    out.push(`## ${t('highlights')} · PDF`, '');
    for (const hl of pdf) {
      out.push(`> ${hl.text.replace(/\n+/g, '\n> ')}`);
      if (hl.note) out.push('', `${hl.note}`);
      out.push('', `<sub>${t('pageOf', { n: hl.page, total: book.pageCount ?? hl.page })} · ${formatDate(hl.createdAt)}</sub>`, '');
    }
  }
  if (book.bookmarks.length) {
    out.push(`## ${t('bookmarks')}`, '');
    for (const bm of book.bookmarks) out.push(`- **${bm.label}**${bm.excerpt ? ` — ${bm.excerpt}` : ''}`);
    out.push('');
  }
  return out.join('\n');
}

export async function exportNotes(book: Book): Promise<void> {
  const md = notesMarkdown(book);
  const blob = new Blob([md], { type: 'text/markdown' });
  await shareFile(blob, `${book.title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40)} - ${t('notesFile')}.md`, book.title);
}
