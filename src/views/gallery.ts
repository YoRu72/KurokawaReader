// Image gallery: every picture from the open books, with a lightbox.
import { h, icon, iconButton, clear } from '../ui/dom';
import { t } from '../i18n';
import type { ImageRef } from '../formats/types';
import { shareFile, fetchAsBlob, saveImage, copyImage } from '../ui/share';
import { toast } from '../ui/dom';

/** `startAt` opens straight into the lightbox; with `lightboxOnly` the grid never shows and closing the picture closes everything. */
export function openGallery(images: ImageRef[], onJump: (anchor: string) => void, opts: { startAt?: number; lightboxOnly?: boolean } = {}): () => void {
  const grid = h('div', { class: 'gallery-grid' });
  const body = h('div', { class: 'gallery-body' }, grid);
  const close = () => { root.remove(); window.removeEventListener('keydown', onKey); };
  const root = h('div', { class: 'view', style: { position: 'fixed', inset: '0', zIndex: '45', background: 'var(--bg)' }, role: 'dialog', 'aria-label': t('galleryTitle') },
    h('header', { class: 'topbar' }, iconButton('back', t('back'), close), h('div', { class: 'title' }, t('galleryTitle'), h('small', null, t('galleryCount', { n: images.length })))),
    body);

  if (!images.length) body.append(h('div', { class: 'empty' }, icon('images'), h('p', null, t('galleryEmpty'))));
  images.forEach((img, i) => {
    grid.append(h('button', { type: 'button', onclick: () => lightbox(i) },
      h('img', { src: img.src, alt: img.alt ?? '', loading: 'lazy', decoding: 'async' }),
      h('span', { class: 'cap', dir: 'auto' }, img.alt || img.bookTitle)));
  });

  let lb: HTMLElement | null = null;
  let current = 0;
  const closeLb = () => { lb?.remove(); lb = null; if (opts.lightboxOnly) close(); };
  const blobOf = async (src: string) => { const blob = await fetchAsBlob(src); const ext = (blob.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg'); return { blob, ext }; };
  function lightbox(i: number) {
    current = i;
    const img = images[i];
    const render = () => {
      const im = images[current];
      clear(lb!);
      lb!.append(
        h('div', { class: 'lb-img', onclick: closeLb }, h('img', { src: im.src, alt: im.alt ?? '' })),
        h('div', { class: 'lb-bar' },
          iconButton('chevronLeft', t('previousPage'), () => { current = (current - 1 + images.length) % images.length; render(); }),
          h('span', { class: 'cap', dir: 'auto' }, `${current + 1} / ${images.length} · ${im.alt || t('imageFrom', { title: im.bookTitle })}`),
          opts.lightboxOnly ? null : iconButton('target', t('jumpToImage'), () => { lb?.remove(); lb = null; close(); onJump(im.anchor); }),
          iconButton('download', t('saveImage'), async () => { try { const { blob, ext } = await blobOf(im.src); await saveImage(blob, `${(im.bookTitle || 'image').slice(0, 30)}-${current + 1}.${ext}`); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } }),
          iconButton('copy', t('copyImage'), async () => { try { const { blob } = await blobOf(im.src); if (await copyImage(blob)) toast(t('copied')); } catch (err) { toast(String((err as Error).message ?? err), 'error'); } }),
          iconButton('external', t('shareImage'), async () => { try { const { blob, ext } = await blobOf(im.src); await shareFile(blob, `image-${current + 1}.${ext}`, im.bookTitle); } catch { /* ignore */ } }),
          iconButton('chevronRight', t('nextPage'), () => { current = (current + 1) % images.length; render(); }),
          (() => { const b = iconButton('close', t('close'), closeLb); b.classList.add('lb-close'); return b; })(),
        ));
    };
    lb = h('div', { class: 'lightbox', role: 'dialog' });
    document.body.append(lb);
    render();
    void img;
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (lb) closeLb(); else close(); }
    else if (lb && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { current = (current + (e.key === 'ArrowRight' ? 1 : -1) + images.length) % images.length; lightbox(current); lb?.previousElementSibling?.remove(); document.querySelectorAll('.lightbox').forEach((x, j, all) => { if (j < all.length - 1) x.remove(); }); }
  };
  window.addEventListener('keydown', onKey);
  if (opts.lightboxOnly) root.style.display = 'none';
  document.body.append(root);
  if (opts.startAt !== undefined && images[opts.startAt]) lightbox(opts.startAt);
  return close;
}
