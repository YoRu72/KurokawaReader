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

const cell = (s: string) => s.replace(/[\t\r\n]+/g, ' ').trim();
const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
/** The book's highlights as Anki cards (tab-separated, as Anki's Import reads): the highlighted passage on the
 *  front, the note (or the book and place) on the back, the book as a tag. */
export function notesAnkiTsv(book: Book): string {
  const tag = 'kurokawa ' + book.title.replace(/\s+/g, '_').slice(0, 40);
  const lines = ['#separator:tab', '#html:true', '#tags column:3'];
  for (const hl of [...book.highlights].sort((a, b) => a.createdAt - b.createdAt)) {
    const back = [hl.note ? esc(hl.note) : '', `<small>${esc(book.title)}</small>`].filter(Boolean).join('<br>');
    lines.push([cell(esc(hl.text)), cell(back), tag].join('\t'));
  }
  for (const hl of [...(book.pdfHighlights ?? [])].sort((a, b) => a.createdAt - b.createdAt)) {
    const back = [hl.note ? esc(hl.note) : '', `<small>${esc(book.title)} · ${esc(t('pageOf', { n: hl.page, total: book.pageCount ?? hl.page }))}</small>`].filter(Boolean).join('<br>');
    lines.push([cell(esc(hl.text)), cell(back), tag].join('\t'));
  }
  return lines.join('\n') + '\n';
}

export async function exportNotesAnki(book: Book): Promise<void> {
  const blob = new Blob([notesAnkiTsv(book)], { type: 'text/tab-separated-values' });
  await shareFile(blob, `${book.title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40)} - anki.txt`, book.title);
}
