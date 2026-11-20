import { icon } from '../ui/dom';
/** Small strokes of our own, drawn inside the folder icon for the well-known folders (24-box, scaled into its body). */
const G: Record<string, string> = {
  dl: 'M12 4v11M7 11l5 5 5-5M5 20h14', cam: 'M3 8h4l2-3h6l2 3h4v11H3zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z', pic: 'M3 4h18v16H3zM3 17l5-5 5 5 3-3 5 5',
  mus: 'M9 18V5l11-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0', mov: 'M3 5h18v14H3zM10 9l5 3-5 3z', doc: 'M6 3h9l4 4v14H6zM9 12h7M9 16h7',
  and: 'M5 18a7 7 0 0 1 14 0zM8 5l2 3M16 5l-2 3', bell: 'M6 17v-6a6 6 0 0 1 12 0v6l2 2H4zM10 21h4', book: 'M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4zM20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z',
  pod: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4', rec: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  up: 'M12 18V9M8 12.5l4-4 4 4',
};
const NAMES: [RegExp, string][] = [[/^downloads?$/i, 'dl'], [/^(dcim|camera)$/i, 'cam'], [/^pictures$/i, 'pic'], [/^music$/i, 'mus'], [/^movies$/i, 'mov'], [/^documents$/i, 'doc'], [/^android$/i, 'and'], [/^(alarms|notifications|ringtones)$/i, 'bell'], [/^books$/i, 'book'], [/^podcasts$/i, 'pod'], [/^recordings$/i, 'rec']];
/** The folder icon, with its glyph when the name is a well-known one (`up`: the «..» row's arrow). */
export function folderIcon(name: string, up = false): SVGElement {
  const g = up ? 'up' : NAMES.find(([r]) => r.test(name))?.[1]; const s = icon('folder');
  if (g) s.insertAdjacentHTML('beforeend', `<path transform="translate(7 8.2) scale(.42)" stroke-width="3" d="${G[g]}"/>`);
  return s;
}
