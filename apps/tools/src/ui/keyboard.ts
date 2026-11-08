// The on-screen keyboard: while it is up (the page much shorter than it was, a field being typed in), the bottom bar
// steps aside — on a phone it would otherwise ride on top of the keyboard and hide half of what is being searched.
let tallest = 0; let wide = 0;
function check(): void {
  const h = window.visualViewport?.height ?? window.innerHeight; const w = window.innerWidth;
  if (Math.abs(w - wide) > 80) { wide = w; tallest = h; }   // (turned: a new height to compare with)
  tallest = Math.max(tallest, h);
  const a = document.activeElement as HTMLElement | null; const typing = !!a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !/^(checkbox|radio|range|button|submit|file|color)$/i.test((a as HTMLInputElement).type)) || a.isContentEditable);
  document.documentElement.classList.toggle('kb-open', typing && h < tallest * 0.78);
}
let watching = false;
export function watchKeyboard(): void {
  if (watching) return; watching = true;
  wide = window.innerWidth; tallest = window.visualViewport?.height ?? window.innerHeight;
  window.addEventListener('resize', check); window.visualViewport?.addEventListener('resize', check);
  document.addEventListener('focusin', () => setTimeout(check, 250)); document.addEventListener('focusout', () => setTimeout(check, 50));
}
