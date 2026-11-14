// A hold (touch) or a right-click (mouse) on an element (src/ui/tags.ts re-exports it): the library's cards and chips.
// After a hold: the click on letting go, and a phone's «contextmenu» for the same hold, belong to the hold — dropped
// wherever they land, since what the hold did (a selection, a sheet) often redraws the very element held.
let heldAt = 0; let heldUp = false; let watching = false;
function swallowAfterHold(): void {
  if (watching) return; watching = true;
  const recent = () => heldAt && performance.now() - heldAt < 1500;
  document.addEventListener('pointerup', () => { if (recent()) heldUp = true; }, true);
  document.addEventListener('click', (e) => { if (recent() && heldUp) { e.preventDefault(); e.stopImmediatePropagation(); heldAt = 0; heldUp = false; } }, true);
  document.addEventListener('contextmenu', (e) => { if (recent() && !heldUp) { e.preventDefault(); e.stopImmediatePropagation(); } }, true);
  document.addEventListener('pointerdown', () => { heldAt = 0; heldUp = false; }, true);
}

/** Hold (touch) or right-click (mouse) on an element to run `fn`; a plain tap is left alone. */
export function onHoldOrContext(el: HTMLElement, fn: () => void): void {
  // (One hold, one call: the timer's end or a «contextmenu», whichever comes first.)
  swallowAfterHold();
  let timer = 0;
  const cancel = () => { window.clearTimeout(timer); timer = 0; };
  const fire = () => { cancel(); heldAt = performance.now(); heldUp = false; fn(); };
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse' && e.button !== 0) return; cancel(); timer = window.setTimeout(() => { navigator.vibrate?.(15); fire(); }, 480); });
  el.addEventListener('pointerup', cancel); el.addEventListener('pointerleave', cancel); el.addEventListener('pointercancel', cancel);
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fire(); });
  el.addEventListener('keydown', (e) => { if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) { e.preventDefault(); fn(); } });
}
