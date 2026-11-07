// An ASS subtitle's styles put in another font (the player's main subtitle font, when asked): pure text work.
/** An ASS subtitle with every style's font made `family` (the lines' own \fn — signs, typesetting — left as they are). */
export function assWithFont(ass: string, family: string): string {
  if (!family) return ass; const fam = family.replace(/,/g, ' ');
  let fmt: string[] = [];
  return ass.split(/\r?\n/).map((line) => {
    if (/^Format:/i.test(line) && !fmt.length && /Fontname/i.test(line)) { fmt = line.slice(7).split(',').map((x) => x.trim().toLowerCase()); return line; }
    if (!/^Style:/i.test(line)) return line;
    const parts = line.slice(6).split(','); const i = fmt.indexOf('fontname'); const at = i >= 0 ? i : 1; if (at >= parts.length) return line;
    parts[at] = (parts[at].startsWith(' ') ? ' ' : '') + fam; return 'Style:' + parts.join(',');
  }).join('\n');
}
