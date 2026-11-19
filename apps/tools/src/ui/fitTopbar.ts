// A phone's top bar with more buttons than its title leaves room for (larger system text, an add-on's extra button):
// instead of the title cut to «Dowr…», the bar takes two lines, as Material's medium top app bar — the buttons on
// the first, the title on its own line below. Watched for every view's bar, and again when the window or the
// buttons change.
let pen: CanvasRenderingContext2D | null = null;
/** The width the title's words need on one line (measured, not by laying the bar out twice). */
const wordsWidth = (word: HTMLElement): number => {
  const cs = getComputedStyle(word); pen ??= document.createElement('canvas').getContext('2d');
  const text = (word.textContent ?? '').trim(); if (!pen) return word.scrollWidth;
  pen.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  const ls = parseFloat(cs.letterSpacing) || 0;
  return pen.measureText(text).width + ls * text.length;
};
// (Decided from the bar's width and the buttons' own widths — the same answer whichever way the bar is laid out now —,
// and the classes changed only when the answer changes: toggling them off and on to measure made the bar flicker
// between layouts, and a frame could show the title after the buttons, on the far side.)
const fit = (bar: HTMLElement) => {
  const title = bar.querySelector<HTMLElement>(':scope > .title'); if (!title) return;
  const word = title.querySelector<HTMLElement>(':scope > span, :scope > bdi') ?? title;
  const bs = getComputedStyle(bar); const gap = parseFloat(bs.columnGap) || 0;
  let others = 0; let n = 0;
  for (const c of Array.from(bar.children) as HTMLElement[]) { if (c === title || getComputedStyle(c).display === 'none') continue; others += c.scrollWidth; n++; }
  const ts = getComputedStyle(title);
  const room = bar.clientWidth - (parseFloat(bs.paddingLeft) || 0) - (parseFloat(bs.paddingRight) || 0) - others - gap * n - (parseFloat(ts.paddingLeft) || 0) - (parseFloat(ts.paddingRight) || 0);
  const on = wordsWidth(word) > room + 1 || room < 96;
  if (bar.classList.contains('stacked') === on && title.classList.contains('tb-stacked') === on) return;
  bar.classList.toggle('stacked', on); title.classList.toggle('tb-stacked', on); bar.querySelector(':scope > .topbar-actions')?.classList.toggle('tb-stacked', on);
};
/** Measure one bar again (a button shown or hidden changes the room without changing the bar's own size). */
export const refitTopbar = (bar: HTMLElement | null) => { if (bar?.isConnected && !document.documentElement.classList.contains('pc')) fit(bar); };
export function startFitTopbar(): void {
  if (document.documentElement.classList.contains('pc')) return;
  // (Measured in the next frame, not inside the observer's own call: changing the bar's height there would ask it for
  // another round in the same frame.)
  const due = new Set<HTMLElement>(); let raf = 0;
  const ro = new ResizeObserver((es) => {
    for (const e of es) { const bar = (e.target as HTMLElement).closest<HTMLElement>('.topbar'); if (bar) due.add(bar); }
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; const bs = [...due]; due.clear(); for (const b of bs) if (b.isConnected) fit(b); });
  });
  const seen = new WeakSet<HTMLElement>();
  const scan = () => { for (const bar of Array.from(document.querySelectorAll<HTMLElement>('.view > .topbar'))) { if (seen.has(bar)) continue; seen.add(bar); ro.observe(bar); const a = bar.querySelector('.topbar-actions'); if (a) ro.observe(a); requestAnimationFrame(() => fit(bar)); } };
  new MutationObserver(scan).observe(document.getElementById('app') ?? document.body, { childList: true, subtree: true }); scan();
}
