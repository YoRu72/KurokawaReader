// A book's cover on its own, as Mihon shows it: the whole screen, black around it, pinch or double-tap to look
// closer, and in the top bar the ways out — close, share, save to the device, and (for a book in the library)
// a picture of one's own in its place, or the original back.
import { h, iconButton, openSheet, toast, icon } from './dom';
import { t } from '../i18n';

export interface CoverEdit {
  /** Put this picture in place of the cover; resolves to the new cover's URL. */
  set(picture: Blob): Promise<string>;
  /** Whether a cover of one's own is in place (and the original can be had back). */
  custom(): boolean;
  /** The original back; resolves to its URL, or null for a book that had none. */
  restore(): Promise<string | null>;
}

export interface CoverViewOpts {
  /** The picture to show. */
  url: string;
  title: string;
  /** The picture's bytes, for sharing and saving (fetched only when asked). */
  bytes(): Promise<Blob>;
  /** The picture at full size, when what is shown is a small copy of it (a shelf's cover): shown in its place
   *  once it comes, and what is shared and saved. */
  full?(): Promise<Blob | null>;
  edit?: CoverEdit;
}

const extOf = (type: string) => (/png/.test(type) ? 'png' : /webp/.test(type) ? 'webp' : /gif/.test(type) ? 'gif' : 'jpg');
const fileName = (title: string, type: string) => `${(title.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').trim().slice(0, 80) || 'cover')}.${extOf(type)}`;

/** Bytes from a cover's address: a local object URL straight, a remote one through the app's fetcher (the
 *  source's headers — some image hosts refuse a request without its referer). */
export async function coverBytes(url: string, headers?: Record<string, string>): Promise<Blob> {
  if (/^(blob|data):/.test(url)) return (await fetch(url)).blob();
  const { fetchBytes } = await import('../sources/http');
  const bytes = await fetchBytes(url, undefined, headers ? { headers } : undefined);
  const b = new Uint8Array(bytes.buffer as ArrayBuffer, bytes.byteOffset, bytes.byteLength);
  const type = b[0] === 0x89 && b[1] === 0x50 ? 'image/png' : b[0] === 0x52 && b[8] === 0x57 ? 'image/webp' : b[0] === 0x47 ? 'image/gif' : 'image/jpeg';
  return new Blob([b.slice() as BlobPart], { type });
}

/** A picture chosen from the device (null when the chooser was closed). */
export function pickPicture(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } }) as HTMLInputElement;
    let done = false;
    const finish = (f: File | null) => { if (done) return; done = true; input.remove(); resolve(f); };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.append(input); input.click();
  });
}

/** The sheet of a cover's own: a picture of one's own, or the original back. */
export function editCoverSheet(edit: CoverEdit, changed: (url: string | null) => void): void {
  const sh = openSheet(t('editCover'), t('close'), { stack: true });
  const list = h('div', { class: 'dest-list' });
  const row = (ic: string, label: string, fn: () => Promise<void>) => list.append(h('button', { type: 'button', class: 'dest-row', onclick: () => { sh.close(); void fn().catch((e) => toast(String((e as Error)?.message ?? e), 'error')); } }, icon(ic), h('span', { class: 'grow' }, label)));
  row('images', t('chooseImage'), async () => {
    const f = await pickPicture(); if (!f) return;
    if (!f.type.startsWith('image/')) { toast(t('saveFailed'), 'error'); return; }
    changed(await edit.set(f)); toast(t('coverChanged'));
  });
  if (edit.custom()) row('undo', t('restoreCover'), async () => { changed(await edit.restore()); toast(t('coverRestored')); });
  sh.body.append(list);
}

export function showCover(o: CoverViewOpts): () => void {
  const img = h('img', { src: o.url, alt: o.title, draggable: 'false' }) as HTMLImageElement;
  const stage = h('div', { class: 'cv-stage' }, img);
  let blob: Promise<Blob> | null = null;
  // (After a picture of one's own is put in: that picture is what is shared and saved.)
  let edited: string | null = null;
  const bytes = () => (blob ??= (edited ? fetch(edited).then((r) => r.blob()) : o.bytes()).catch((e) => { blob = null; throw e; }));
  let fullUrl = '';
  const close = () => { if (fullUrl) setTimeout(() => URL.revokeObjectURL(fullUrl), 1000); root.remove(); document.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', onResize); clearTimeout(tapTimer); };
  const closeBtn = iconButton('close', t('close'), close); closeBtn.classList.add('lb-close');
  const busy = async (b: HTMLButtonElement, fn: () => Promise<void>) => { if (b.disabled) return; b.disabled = true; try { await fn(); } catch (e) { if ((e as Error)?.name !== 'AbortError') toast(t('saveFailed'), 'error'); } finally { b.disabled = false; } };
  const shareBtn = iconButton('share', t('shareImage'), () => void busy(shareBtn, async () => { const b = await bytes(); const { shareFile } = await import('./share'); await shareFile(b, fileName(o.title, b.type), o.title); }));
  const saveBtn = iconButton('download', t('saveImage'), () => void busy(saveBtn, async () => { const b = await bytes(); const { saveImage } = await import('./share'); await saveImage(b, fileName(o.title, b.type)); }));
  const editBtn = o.edit ? iconButton('pen', t('editCover'), () => editCoverSheet(o.edit!, (url) => { if (url) { img.src = url; edited = url; blob = null; reset(); } else close(); })) : null;
  const bar = h('div', { class: 'cv-bar' }, closeBtn, h('span', { class: 'spacer' }), shareBtn, saveBtn, editBtn);
  const root = h('div', { class: 'cover-view', role: 'dialog', 'aria-label': t('coverTitle') }, stage, bar);
  // (The small copy at once; the picture at full size in its place as soon as it is here — decoded first, so
  // the swap does not flash.)
  if (o.full) {
    root.classList.add('cv-loading');
    const fullJob = o.full().catch(() => null);
    void fullJob.then(async (b) => {
      root.classList.remove('cv-loading');
      if (!b || !root.isConnected || edited) return;
      const u = URL.createObjectURL(b);
      const probe = new Image(); probe.src = u;
      try { await probe.decode(); } catch { URL.revokeObjectURL(u); return; }
      if (!root.isConnected || edited) { URL.revokeObjectURL(u); return; }
      fullUrl = u; img.src = u; blob = Promise.resolve(b);
    });
    blob = fullJob.then((b) => b ?? o.bytes());
  }

  // Looking closer: two fingers to pinch, one to move about once zoomed, a double tap (or double click) to go
  // in at that spot and back out, the wheel on a PC; a single tap shows or hides the bar.
  let s = 1, tx = 0, ty = 0;
  const apply = () => { img.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`; root.classList.toggle('zoomed', s > 1.01); };
  const clampPan = () => {
    const w = img.offsetWidth * s, hgt = img.offsetHeight * s, W = stage.clientWidth, H = stage.clientHeight;
    const mx = Math.max(0, (w - W) / 2), my = Math.max(0, (hgt - H) / 2);
    tx = Math.min(mx, Math.max(-mx, tx)); ty = Math.min(my, Math.max(-my, ty));
  };
  /** Zoom to `to`, keeping the point (x, y) of the screen where it is. */
  const zoomAt = (to: number, x: number, y: number) => {
    const r = stage.getBoundingClientRect(); const px = x - (r.left + r.width / 2), py = y - (r.top + r.height / 2);
    to = Math.min(6, Math.max(1, to));
    tx = px - (px - tx) * (to / s); ty = py - (py - ty) * (to / s); s = to;
    if (s <= 1.01) { s = 1; tx = 0; ty = 0; }
    clampPan(); apply();
  };
  const reset = () => { s = 1; tx = 0; ty = 0; apply(); };
  const pts = new Map<number, { x: number; y: number }>();
  let pinch: { d: number; s: number } | null = null; let moved = false; let downAt = 0; let lastTap = { at: 0, x: 0, y: 0 }; let tapTimer = 0;
  const dist = () => { const [a, b] = [...pts.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
  const mid = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
  stage.addEventListener('pointerdown', (e) => {
    stage.setPointerCapture(e.pointerId); pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) { moved = false; downAt = performance.now(); }
    if (pts.size === 2) { pinch = { d: dist(), s }; moved = true; }
  });
  stage.addEventListener('pointermove', (e) => {
    const p = pts.get(e.pointerId); if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (pts.size >= 2 && pinch) { const m = mid(); zoomAt(pinch.s * (dist() / pinch.d), m.x, m.y); return; }
    if (Math.abs(dx) + Math.abs(dy) > 0.5) moved = moved || Math.hypot(dx, dy) > 3;
    if (s > 1) { tx += dx; ty += dy; clampPan(); apply(); }
  });
  const up = (e: PointerEvent) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (pts.size || moved || performance.now() - downAt > 400 || e.type === 'pointercancel') return;
    const now = performance.now();
    if (now - lastTap.at < 300 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 40) {
      clearTimeout(tapTimer); lastTap.at = 0;
      if (s > 1.01) { s = 1; tx = 0; ty = 0; apply(); } else zoomAt(2.5, e.clientX, e.clientY);
      return;
    }
    lastTap = { at: now, x: e.clientX, y: e.clientY };
    tapTimer = window.setTimeout(() => root.classList.toggle('bare'), 300);
  };
  stage.addEventListener('pointerup', up); stage.addEventListener('pointercancel', up);
  stage.addEventListener('wheel', (e) => { e.preventDefault(); zoomAt(s * Math.exp(-e.deltaY / 300), e.clientX, e.clientY); }, { passive: false });
  const onKey = (e: KeyboardEvent) => {
    if (!root.isConnected) return;
    if (document.querySelector('.sheet')) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    else if (e.key === '+' || e.key === '=') { const r = stage.getBoundingClientRect(); zoomAt(s * 1.4, r.left + r.width / 2, r.top + r.height / 2); }
    else if (e.key === '-') { const r = stage.getBoundingClientRect(); zoomAt(s / 1.4, r.left + r.width / 2, r.top + r.height / 2); }
  };
  document.addEventListener('keydown', onKey, true);
  const onResize = () => { clampPan(); apply(); };
  window.addEventListener('resize', onResize);
  document.body.append(root);
  closeBtn.focus({ preventScroll: true });
  return close;
}
