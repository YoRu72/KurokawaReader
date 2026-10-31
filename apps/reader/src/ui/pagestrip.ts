// A strip of page thumbnails along the bottom of a PDF, the page in view marked; tapping one goes there.
import { h } from './dom';
import { t, localDigits } from '../i18n';
import type { PdfViewer } from '../formats/pdf';

export interface PageStrip { toggle(): void; sync(): void; dispose(): void }

export function pageStrip(viewer: PdfViewer, host: HTMLElement): PageStrip {
  const KEY = 'kr.pdfStrip';
  const el = h('div', { class: 'pdf-strip', hidden: true, role: 'listbox', 'aria-label': t('pageStrip') });
  let built = false; let on = false;
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      const cell = en.target as HTMLElement; io.unobserve(cell);
      void viewer.thumbnail(Number(cell.dataset.page), 120).then((url) => { const img = cell.querySelector('img'); if (img) img.src = url; });
    }
  }, { root: el, rootMargin: '0px 300px' });
  const build = () => {
    if (built) return; built = true;
    for (let n = 1; n <= viewer.total; n++) {
      const cell = h('button', { type: 'button', role: 'option', class: 'strip-cell', dataset: { page: String(n) }, 'aria-label': t('pageN', { n: localDigits(String(n)) }), onclick: () => viewer.goTo(n) }, h('img', { alt: '' }), h('span', null, localDigits(String(n))));
      el.append(cell); io.observe(cell);
    }
  };
  let marked: HTMLElement | null = null;
  const sync = () => {
    if (!on) return;
    const cell = el.querySelector<HTMLElement>(`.strip-cell[data-page="${viewer.current}"]`);
    if (cell === marked) return;
    marked?.classList.remove('current'); marked?.setAttribute('aria-selected', 'false');
    marked = cell; cell?.classList.add('current'); cell?.setAttribute('aria-selected', 'true');
    cell?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  };
  // Above the page bar when that runs along the bottom.
  const place = () => {
    const bar = host.parentElement?.querySelector<HTMLElement>('.pdf-bar');
    const hh = bar && bar.dataset.layout !== 'side' && bar.dataset.row !== 'top' ? bar.offsetHeight : 0;
    el.style.bottom = `${hh}px`;
  };
  const ro = new ResizeObserver(() => place());
  const show = (v: boolean) => {
    on = v; el.hidden = !v; host.classList.toggle('has-strip', v);
    if (v) { place(); const bar = host.parentElement?.querySelector<HTMLElement>('.pdf-bar'); if (bar) ro.observe(bar); } else ro.disconnect();
    try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* private mode */ }
    if (v) { build(); marked = null; sync(); }
  };
  host.append(el);
  let follow = 0;
  const onScroll = () => { window.clearTimeout(follow); follow = window.setTimeout(sync, 150); };
  viewer.scroll.addEventListener('scroll', onScroll, { passive: true });
  let wanted = false; try { wanted = localStorage.getItem(KEY) === '1'; } catch { /* fine */ }
  if (wanted) show(true);
  return { toggle: () => show(!on), sync, dispose: () => { io.disconnect(); ro.disconnect(); viewer.scroll.removeEventListener('scroll', onScroll); el.remove(); } };
}
