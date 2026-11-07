// A phone's top bar with more buttons than its title leaves room for (larger system text, an add-on's extra button):
// instead of the title cut to «Dowr…», the bar takes two lines, as Material's medium top app bar — the buttons on
// the first, the title on its own line below. Watched for every view's bar, and again when the window or the
// buttons change.
const fit = (bar: HTMLElement) => {
  const title = bar.querySelector<HTMLElement>(':scope > .title'); if (!title) return;
  const word = title.querySelector<HTMLElement>(':scope > span, :scope > bdi') ?? title;
  bar.classList.remove('stacked');
  // (Cut when the words are wider than the room left for them.)
  if (word.scrollWidth > word.clientWidth + 1 || title.clientWidth < 96) bar.classList.add('stacked');
};
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
