// The page's own menu in the comic reader (src/views/comic.ts): a long press on a page, or a right click on a computer.
// Save the page (the app's own save: Pictures on Android, a file on a computer), Share (a phone), Copy (where the
// browser copies pictures), Set as the book's cover (asked first; the library shows it; Undo through the snackbar). A page
// split or cropped or turned also offers the choice: the whole page, or the page as it is shown.
import { h, icon, openSheet, toast, stackWhenCramped } from '../ui/dom';
import { t } from '../i18n';
import { db, type Book } from '../db';
import { fits } from '../platform';
import { shareFile, saveImage, copyImage, canvasToBlob } from '../ui/share';
import { offerUndo } from '../ui/undo';
import { scheduleSync } from '../sync';
import type { PageSource } from './pages';
import type { Pressed } from './viewer';

/** Whether a piece shows less than, or other than, the whole page. */
export const differs = (piece: Pressed['piece']): boolean => piece.rotate !== 0 || piece.crop.some((v, i) => Math.abs(v - (i < 2 ? 0 : 1)) > 0.0005);

/** The picture as the reader shows it: the page's crop rectangle, turned. */
export async function shownBlob(blob: Blob, piece: Pressed['piece']): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  try {
    const [cx, cy, cw, ch] = piece.crop; const sx = Math.round(cx * bmp.width), sy = Math.round(cy * bmp.height);
    const sw = Math.max(1, Math.round(cw * bmp.width)), sh = Math.max(1, Math.round(ch * bmp.height));
    const c = document.createElement('canvas'); const odd = piece.rotate % 2 === 1; c.width = odd ? sh : sw; c.height = odd ? sw : sh;
    const g = c.getContext('2d')!; g.translate(c.width / 2, c.height / 2); g.rotate((piece.rotate * Math.PI) / 2); g.drawImage(bmp, sx, sy, sw, sh, -sw / 2, -sh / 2, sw, sh);
    const out = await canvasToBlob(c, 'image/png'); c.width = c.height = 0; return out;
  } finally { bmp.close(); }
}

export interface MenuHost {
  book: Book; source: PageSource; hit: Pressed;
  /** The library's cover picture for the book changed (its cache let go). */
  coverChanged: () => void;
}

/** Open the page's menu. */
export function pageMenu(o: MenuHost): void {
  const { book, source, hit } = o; const page = source.pages[hit.page]; if (!page) return;
  let which: 'whole' | 'shown' = differs(hit.piece) ? 'shown' : 'whole';
  const sh = openSheet(t('comicPageMenu', { n: hit.page + 1 }), t('close'), { at: { x: hit.x, y: hit.y } });
  sh.el.classList.add('cm-page-menu'); sh.body.style.fontFamily = 'var(--font-ui)';
  const picture = async (): Promise<{ blob: Blob; name: string }> => {
    const raw = await page.blob(); const base = `${book.title.replace(/[\\/:*?"<>|]/g, ' ').trim().slice(0, 40)} - p${hit.page + 1}`;
    if (which === 'shown' && differs(hit.piece)) return { blob: await shownBlob(raw, hit.piece), name: `${base}.png` };
    return { blob: raw, name: `${base}.${(page.name.split('.').pop() || 'png').toLowerCase()}` };
  };
  const run = (fn: (p: { blob: Blob; name: string }) => Promise<unknown>) => async () => {
    try { const p = await picture(); sh.close(); await fn(p); } catch (err) { toast(String((err as Error).message ?? err), 'error'); }
  };
  const item = (cls: string, ic: string, label: string, fn: () => unknown): HTMLElement => h('button', { type: 'button', class: `btn tonal cm-menu-item ${cls}`, onclick: () => void fn() }, icon(ic), h('span', null, label));
  const list = h('div', { class: 'cm-menu-list' });
  if (differs(hit.piece)) {
    // (The page as shown differs from the whole page: which of the two the actions below use.)
    const seg = h('div', { class: 'segmented cm-which', role: 'group', 'aria-label': t('comicWhichPicture') });
    const mk = (id: 'shown' | 'whole', label: string) => h('button', { type: 'button', 'aria-pressed': String(which === id), dataset: { which: id }, onclick: () => { which = id; seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.which === which))); } }, label);
    seg.append(mk('shown', t('comicAsShown')), mk('whole', t('comicWhole')));
    list.append(seg);
  }
  list.append(item('cm-save', 'download', t('comicSavePage'), run(({ blob, name }) => saveImage(blob, name))));
  // (Sharing is a phone's; copying a picture where the browser lets a page do it.)
  if (fits('phone')) list.append(item('cm-share', 'share', t('comicSharePage'), run(({ blob, name }) => shareFile(blob, name, book.title))));
  if (typeof ClipboardItem !== 'undefined' && !!navigator.clipboard && 'write' in navigator.clipboard) list.append(item('cm-copy', 'copy', t('comicCopyPage'), run(async ({ blob }) => { if (await copyImage(blob)) toast(t('copied')); })));
  list.append(item('cm-cover', 'images', t('comicSetCover'), async () => {
    const { blob } = await picture().catch(() => ({ blob: null as Blob | null })); if (!blob) return;
    sh.close();
    if (await askCover(t('comicSetCover'), t('comicCoverAsk', { n: hit.page + 1, title: book.title }))) await setCover(book, blob, o.coverChanged);
  }));
  sh.body.append(list);
}

/** «Use this as the cover?» — the app's own sheet, the two buttons of one width. */
function askCover(title: string, line: string): Promise<boolean> {
  return new Promise((resolve) => {
    let yes = false; const sh = openSheet(title, t('close'), { stack: true, onClose: () => resolve(yes) });
    sh.el.classList.add('confirm-sheet', 'cm-cover-ask'); sh.body.style.fontFamily = 'var(--font-ui)';
    sh.body.append(h('p', { class: 'confirm-line', dir: 'auto' }, line));
    sh.actions.append(h('button', { type: 'button', class: 'btn text confirm-cancel', onclick: () => sh.close() }, t('cancel')), h('button', { type: 'button', class: 'btn confirm-ok', onclick: () => { yes = true; sh.close(); } }, t('comicCoverOk')));
    stackWhenCramped(sh.actions);
  });
}

/** The page as the book's own cover (as Book details sets one: the file's own kept to restore); Undo puts the old back. */
async function setCover(book: Book, picture: Blob, changed: () => void): Promise<void> {
  const { shrinkCover } = await import('../library');
  const small = await shrinkCover(picture); if (!small) { toast(t('openError', { title: book.title, error: '' }), 'error'); return; }
  type Was = { cover?: Blob; coverOrig?: Blob | null; had: boolean };
  let was: Was = { had: false };
  const keep = (b: Book): Was => ({ cover: b.cover, coverOrig: b.coverOrig, had: 'coverOrig' in b && b.coverOrig !== undefined });
  const put = (b: Book, w: Was) => { if (w.cover) b.cover = w.cover; else delete b.cover; if (w.had) b.coverOrig = w.coverOrig ?? null; else delete b.coverOrig; };
  const after = (b: Book | undefined) => { if (b) { Object.assign(book, { cover: b.cover }); if ('coverOrig' in b) book.coverOrig = b.coverOrig; else delete book.coverOrig; } changed(); scheduleSync(); };
  const now = await db.updateBook(book.id, (b) => { was = keep(b); if (b.coverOrig === undefined) b.coverOrig = b.cover ?? null; b.cover = small; });
  after(now);
  const mine = { cover: small, had: true, coverOrig: was.had ? was.coverOrig : was.cover ?? null } as Was;
  offerUndo(t('comicCoverDone'), async () => after(await db.updateBook(book.id, (b) => { put(b, was); })), async () => after(await db.updateBook(book.id, (b) => { put(b, mine); })));
}
