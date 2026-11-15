// "Back", the same everywhere — one stack every layer registers with. This part is the small register the first
// screen carries; the dispatcher that walks it (Android's back, the in-page arrows, a mouse's back button, Alt+←,
// Esc on a computer) is ui/backnav.ts, loaded once the app has started.
//   Modal layers (a sheet, a menu, a dialog, the player, its full screen, an editor) close first, the newest first;
//   then what a view keeps inside itself (a selection, a search, a folder drilled into, a sub-page), the newest
//   first; then the view's own arrow; then, at a tab's top, the tab the reader came from — else the downloads.
export type LayerKind = 'sheet' | 'menu' | 'dialog' | 'overlay' | 'player' | 'fullscreen' | 'editor' | 'selection' | 'search' | 'drill' | 'subpage' | 'view';
export interface Layer {
  kind: LayerKind;
  /** A step back: true when it went back (false lets the next layer take it). */
  back: () => boolean;
  /** Whether it is there at all (a view kept out of the page answers false). */
  on?: () => boolean;
  /** A name for the tests and the audit. */
  name?: string;
}
export const layers: Layer[] = [];
/** A layer on the stack; the returned function takes it away (closed, left). */
export function pushLayer(l: Layer): () => void {
  layers.push(l);
  return () => { const i = layers.lastIndexOf(l); if (i >= 0) layers.splice(i, 1); };
}
/** A view's own step back (a place inside it): `fn` returns true when it went back. */
export const onBack = (fn: () => boolean, kind: LayerKind = 'view', name?: string): (() => void) => pushLayer({ kind, back: fn, name });

/** The tabs in the order last visited (each once) and where each one was — for Back at a tab's top. */
export const tabTrail: string[] = [];
export const tabPath = new Map<string, string>();
export function noteTab(sec: string, path: string): void {
  const i = tabTrail.indexOf(sec); if (i >= 0) tabTrail.splice(i, 1); tabTrail.push(sec); tabPath.set(sec, path);
}
