// The converter sheet: pick a target, watch the progress, then save / share /
// add the result to the library or send it to a Kindle.
import { h, icon, openSheet, toast, pickSheet } from './dom';
import { t, formatBytes } from '../i18n';
import { TARGETS, convertBook, type Target } from '../convert';
import { db, type Book } from '../db';
import { importFiles } from '../library';
import { shareFile, downloadBlob } from './share';

/** Choose which book to convert (library tools button), then open the sheet for it. */
export async function convertPicker(books: Book[], pickFile: () => void): Promise<void> {
  const eligible = books.filter((b) => b.format !== 'image' && b.format !== 'cbz');
  if (!eligible.length) { pickFile(); return; }
  pickSheet(t('convertFile'), [...eligible.map((b): [string, string, string?] => [b.id, `${b.title} · ${b.format.toUpperCase()}`, 'books']), ['__file', t('pickAFile'), 'folder']], '', (id) => {
    if (id === '__file') { pickFile(); return; }
    const book = eligible.find((b) => b.id === id); if (book) convertSheet(book);
  }, t('close'));
}

export function convertSheet(book: Book, onDone?: () => void): void {
  const sh = openSheet(t('convertFile'), t('close'));
  sh.body.style.fontFamily = 'var(--font-ui)';
  const targets = TARGETS.filter((x) => x.from(book.format) && !(x.id === 'epub' && book.format === 'epub'));
  const status = h('p', { class: 'src' }, t('convertBody', { title: book.title, format: book.format.toUpperCase() }));
  const bar = h('span'); const track = h('div', { class: 'progress-bar', hidden: true }, bar);
  const result = h('div', { class: 'convert-result', hidden: true });
  const grid = h('div', { class: 'convert-targets' });
  let busy = false;
  const run = async (target: Target, password?: string) => {
    if (busy) return; busy = true;
    grid.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    track.hidden = false; result.hidden = true;
    const progress = (msg: string, pct?: number) => { status.textContent = t(`conv_${msg}` as 'loading') || msg; if (pct !== undefined) bar.style.width = `${pct}%`; };
    try {
      const { blob, name } = await convertBook(book, target, progress, password);
      status.textContent = t('convertDone', { name, size: formatBytes(blob.size) });
      result.replaceChildren(
        h('button', { class: 'btn small primary', type: 'button', onclick: () => void shareFile(blob, name, book.title) }, icon('external'), target === 'kindle' ? t('sendToKindle') : t('shareFile')),
        h('button', { class: 'btn small', type: 'button', onclick: () => downloadBlob(blob, name) }, icon('download'), t('saveFile')),
        h('button', { class: 'btn small tonal', type: 'button', onclick: async (e: Event) => { (e.currentTarget as HTMLButtonElement).disabled = true; const file = new File([blob], name, { type: blob.type }); const added = await importFiles([file]); if (added.length) { const folder = (await db.getBook(book.id))?.folderId; if (folder) await db.updateBook(added[0].id, (b) => { b.folderId = folder; }); } toast(t('addedToLibrary')); onDone?.(); } }, icon('import'), t('addToLibrary')),
      );
      result.hidden = false;
      if (target === 'kindle') result.append(h('p', { class: 'hint', style: { marginTop: '8px' } }, t('kindleHint')));
    } catch (err) {
      const msg = String((err as Error).message ?? err);
      if (msg === 'password') {
        const pw = prompt(t('pdfPasswordPrompt')) ?? '';
        busy = false; grid.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        if (pw) { void run(target, pw); return; }
        status.textContent = t('cancelled');
      } else if (msg === 'unsupported') status.textContent = t('convertUnsupported');
      else { status.textContent = `${t('convertFailed')} — ${msg}`; console.error(err); }
    } finally { busy = false; grid.querySelectorAll('button').forEach((b) => { b.disabled = false; }); }
  };
  for (const tg of targets) {
    grid.append(h('button', { class: 'convert-target', type: 'button', onclick: () => void run(tg.id) },
      icon(tg.id === 'pdf' ? 'file' : tg.id === 'kindle' ? 'books' : tg.id === 'docx' ? 'note' : tg.id === 'epub' ? 'library' : 'type'),
      h('b', null, tg.label),
      h('small', null, `.${tg.ext}`)));
  }
  sh.body.append(status, track, grid, result);
  if (book.format === 'pdf') sh.body.append(h('p', { class: 'hint', style: { marginTop: '10px' } }, t('pdfConvertHint')));
  if (!('kurokawaDesktop' in window) && targets.some((x) => x.id === 'pdf')) sh.body.append(h('p', { class: 'hint' }, t('pdfImageHint')));
}
