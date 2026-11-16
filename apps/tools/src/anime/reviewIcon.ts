// The «review» mark (a speech bubble with a star in it), in the house's line style: on each episode's row and on the
// «Review it?» bar. Kept out of ui/dom.ts's icon table so the start does not carry it. Filled (the star solid) when
// the episode has a note or a review — by the `.on` of what holds it (styles/anime.css).
export function reviewIcon(): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true'); svg.classList.add('review-ic');
  svg.innerHTML = '<path d="M5 3.5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-7.5L7 21v-3.5H5a2 2 0 0 1-2-2v-10a2 2 0 0 1 2-2z"/><path class="rv-star" d="M12 6.9l.94 2.41 2.58.15-2 1.63.65 2.5L12 12.2l-2.17 1.39.65-2.5-2-1.63 2.58-.15z"/>';
  return svg;
}
