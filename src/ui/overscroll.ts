// Scrolling on at the very end of a book: a wheel turned or a finger pushed further when there is nothing
// below opens what comes next (the next book in the reading order). A small push is ignored; a deliberate
// one — two wheel notches, or a swipe of a hand's width — goes on.
import { navigate } from '../router';

export function overscrollNext(scroll: HTMLElement, nextId: () => string | null): () => void {
  let wheel = 0, lastWheel = 0, touchY = 0, pushed = 0, going = false;
  const atEnd = () => scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 2;
  const go = () => { const id = nextId(); if (!id || going) return; going = true; navigate(`/read/${id}`); };
  const onWheel = (e: WheelEvent) => { if (e.deltaY <= 0 || !atEnd()) { wheel = 0; return; } const now = performance.now(); wheel = now - lastWheel < 900 ? wheel + 1 : 1; lastWheel = now; if (wheel >= 2) go(); };
  const onStart = (e: TouchEvent) => { touchY = e.touches[0]?.clientY ?? 0; pushed = 0; };
  const onMove = (e: TouchEvent) => { if (!atEnd()) { pushed = 0; touchY = e.touches[0]?.clientY ?? touchY; return; } const y = e.touches[0]?.clientY ?? touchY; pushed += Math.max(0, touchY - y); touchY = y; if (pushed > 110) go(); };
  scroll.addEventListener('wheel', onWheel, { passive: true });
  scroll.addEventListener('touchstart', onStart, { passive: true });
  scroll.addEventListener('touchmove', onMove, { passive: true });
  return () => { scroll.removeEventListener('wheel', onWheel); scroll.removeEventListener('touchstart', onStart); scroll.removeEventListener('touchmove', onMove); };
}
