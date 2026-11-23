/* Keeps the filled part of every M3 slider (CSS var --p) in step with its value, wherever the
   slider was made, and however its value changes (drag, keyboard, script, min/max change). */
function paint(el: HTMLInputElement): void {
  if (el.type !== 'range') return;
  const min = Number(el.min || 0), max = Number(el.max || 100);
  const p = max > min ? Math.min(1, Math.max(0, (Number(el.value) - min) / (max - min))) : 0;
  const v = `${(p * 100).toFixed(3)}%`;
  if (el.style.getPropertyValue('--p') !== v) el.style.setProperty('--p', v);
}

export function startRangeFill(): void {
  const all = (root: ParentNode) => root.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach(paint);
  document.addEventListener('input', (e) => { const t = e.target; if (t instanceof HTMLInputElement) paint(t); }, true);
  const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  if (desc?.set && desc.get) {
    const { get, set } = desc;
    Object.defineProperty(HTMLInputElement.prototype, 'value', { configurable: true, enumerable: desc.enumerable, get() { return get.call(this); }, set(v: string) { set.call(this, v); paint(this as HTMLInputElement); } });
  }
  new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'attributes') { if (m.target instanceof HTMLInputElement) paint(m.target); continue; }
      m.addedNodes.forEach((n) => { if (n instanceof HTMLInputElement) paint(n); else if (n instanceof Element) all(n); });
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['min', 'max', 'value', 'type'] });
  all(document);
}
