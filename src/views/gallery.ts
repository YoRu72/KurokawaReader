// Image gallery: every picture from the open books, with a lightbox.
import { h, icon, iconButton, clear } from '../ui/dom';
import { t } from '../i18n';
import type { ImageRef } from '../formats/types';

export function openGallery(images: ImageRef[], onJump: (anchor: string) => void): () => void {
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
  function lightbox(i: number) {
    current = i;
    const img = images[i];
    const render = () => {
      const im = images[current];
      clear(lb!);
      lb!.append(
        h('div', { class: 'lb-img', onclick: () => { lb?.remove(); lb = null; } }, h('img', { src: im.src, alt: im.alt ?? '' })),
        h('div', { class: 'lb-bar' },
          iconButton('chevronLeft', t('previousPage'), () => { current = (current - 1 + images.length) % images.length; render(); }),
          h('span', { class: 'cap', dir: 'auto' }, `${current + 1} / ${images.length} · ${im.alt || t('imageFrom', { title: im.bookTitle })}`),
          iconButton('target', t('jumpToImage'), () => { lb?.remove(); lb = null; close(); onJump(im.anchor); }),
          h('a', { class: 'icon-btn', href: im.src, download: `image-${current + 1}`, title: t('saveImage'), 'aria-label': t('saveImage') }, icon('download')),
          iconButton('chevronRight', t('nextPage'), () => { current = (current + 1) % images.length; render(); }),
          iconButton('close', t('close'), () => { lb?.remove(); lb = null; }),
        ));
    };
    lb = h('div', { class: 'lightbox', role: 'dialog' });
    document.body.append(lb);
    render();
    void img;
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { if (lb) { lb.remove(); lb = null; } else close(); }
    else if (lb && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { current = (current + (e.key === 'ArrowRight' ? 1 : -1) + images.length) % images.length; lightbox(current); lb?.previousElementSibling?.remove(); document.querySelectorAll('.lightbox').forEach((x, j, all) => { if (j < all.length - 1) x.remove(); }); }
  };
  window.addEventListener('keydown', onKey);
  document.body.append(root);
  return close;
}
