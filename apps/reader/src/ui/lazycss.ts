// Styles that only a lazy view needs: kept out of app.css (which blocks the first paint), put in the page, once, by
// the code that draws that view — the text comes in minified through the build's *.lazy.css rule (scripts/build.mjs).
// The style goes to the end of the head, where app.css's own rules before it stay below it, as they were.
export function ensureStyle(id: string, css: string): void {
  if (document.getElementById(id)) return;
  const s = document.createElement('style'); s.id = id; s.textContent = css; document.head.append(s);
}
