// One owner per touch: the phone's gestures (a row swiped aside, the drawer from the side, a list pulled to refresh, the
// page swiped to the next place, the fast scroller's handle) each claim the finger once their own rule is met; the
// others then leave that touch alone until every finger is up. Without it two could act on one move — the drawer
// opening while a strip of chips scrolls, a row deleted by a diagonal scroll.
//
// The rules, each gesture's own (slop: how far the finger moves before its direction is read):
//   row swipe        12 px slop, then at least twice as much sideways as down (under ~27°); taken back if it then
//                    drifts 40 px down; past a third of the row to act.
//   drawer           from the start side's 40% of the width, not on a strip that scrolls sideways; 64 px toward the
//                    middle at under ~27°; 32 px down first cancels it; never with two fingers.
//   pull to refresh  at the very top, 10 px slop, then mostly down (1.5 : 1).
//   page swipe       12 px slop, then 1.6 : 1 sideways; never over a row that swipes or a sideways strip.
//   fast scroller    its handle only, at once.
let owner = ''; let wired = false;
const wire = () => {
  if (wired) return; wired = true;
  const end = (e: TouchEvent) => { if (!e.touches.length) owner = ''; };
  document.addEventListener('touchend', end, true); document.addEventListener('touchcancel', end, true);
  // (A new touch is a new sequence: the first finger down — its pointerdown comes before its touchstart — clears the owner.)
  document.addEventListener('pointerdown', (e) => { if (e.isPrimary) owner = ''; }, true);
};
/** `who` takes this touch; false when another gesture already has it. */
export function claimTouch(who: string): boolean { wire(); if (owner && owner !== who) return false; owner = who; return true; }
/** Another gesture has this touch (not `who`). */
export function touchTaken(who: string): boolean { wire(); return !!owner && owner !== who; }
/** The element under the finger, or one above it up to `stop`, scrolls sideways (a strip of chips, the way here). */
export function inSideScroller(from: Element | null, stop: Element | null = null): boolean {
  for (let e = from as HTMLElement | null; e && e !== stop && e !== document.body; e = e.parentElement) {
    if (e.dataset?.noEdge !== undefined) return true;
    const ov = getComputedStyle(e).overflowX; if ((ov === 'auto' || ov === 'scroll') && e.scrollWidth > e.clientWidth + 2) return true;
  }
  return false;
}
