// «A folder of frames»: any sprite set, whatever engine it was made for. Pictures are grouped by their folder or by
// their name without its number (walk_1.png, walk_2.png → «walk»; idle-02.png → «idle»; sitting/01.png → «sitting»),
// GIFs give their frames and a strip (a picture several frames wide or tall) is cut into square cells; each group gets
// a suggested state from its name. The mapping screen lets the user assign groups to states, and the choice becomes a
// pack of our own format.
import { CHOSEN, LIMITS, dict, checkPack, newReport, type PetPack, type PetState, type PetChoice } from './model';
import { FrameList, PackError, checkFrameBudget, picInfo, type FrameSrc, type ImportResult, type PackFile, type PicInfo } from './source';

export interface FrameGroup { key: string; label: string; frames: FrameSrc[]; suggested: PetState | null; fps: number }
export const MAP_STATES: PetState[] = ['idle', 'walk', 'sit', 'sleep', 'fall', 'dragged', 'click'];

const WORDS: [RegExp, PetState][] = [
  [/walk|run|move|step|stroll/, 'walk'],
  [/sleep|nap|lie|lying|rest|zz/, 'sleep'],
  [/sit/, 'sit'],
  [/fall|drop|jump|air/, 'fall'],
  [/drag|hold|grab|pinch|carr|lift|hang/, 'dragged'],
  [/click|touch|poke|pet|happy|wave|react/, 'click'],
  [/idle|stand|wait|breath|default|still/, 'idle'],
];
export function suggestState(name: string): PetState | null {
  const n = name.toLowerCase(); for (const [re, s] of WORDS) if (re.test(n)) return s; return null;
}
/** A file's group key and its number in the group (a name without number: 0). */
export function groupKey(path: string): { key: string; label: string; n: number } {
  const parts = path.split('/'); const file = parts.pop()!; const dir = parts.join('/');
  const base = file.replace(/\.[^.]+$/, '');
  const m = /^(.*?)[\s_.-]*\(?(\d+)\)?$/.exec(base);
  const stem = (m ? m[1] : base).replace(/[\s_.-]+$/, '');
  const n = m ? Number(m[2]) : 0;
  // (In a folder of its own, a picture named by its number only belongs to the folder.)
  if (dir && (!stem || /^(frame|img|image|sprite|f)$/i.test(stem))) { const label = parts[parts.length - 1]; return { key: dir.toLowerCase(), label, n }; }
  const label = stem || base; return { key: `${dir.toLowerCase()}|${label.toLowerCase()}`, label: dir ? `${parts[parts.length - 1]}/${label}` : label, n };
}

/** The groups of a folder of pictures (other files ignored), each frame listed in its number's order. */
export function groupFrames(files: PackFile[], cellsOf: (path: string, info: PicInfo) => number = autoCells): FrameGroup[] {
  const pics = files.map((f) => ({ f, i: picInfo(f) })).filter((x): x is { f: PackFile; i: PicInfo } => !!x.i);
  const groups = new Map<string, { label: string; items: { path: string; n: number; info: PicInfo }[] }>();
  for (const { f, i } of pics) {
    const g = groupKey(f.path);
    // (A GIF, or a strip, is a group by itself.)
    const key = i.kind === 'gif' || cellsOf(f.path, i) > 1 ? `one|${f.path.toLowerCase()}` : g.key;
    const label = key.startsWith('one|') ? f.path.split('/').pop()!.replace(/\.[^.]+$/, '') : g.label;
    let e = groups.get(key); if (!e) groups.set(key, (e = { label, items: [] })); e.items.push({ path: f.path, n: g.n, info: i });
  }
  const out: FrameGroup[] = [];
  for (const [key, g] of groups) {
    g.items.sort((a, b) => a.n - b.n || a.path.localeCompare(b.path, undefined, { numeric: true }));
    const frames: FrameSrc[] = []; let fps = 8;
    for (const it of g.items) {
      if (it.info.kind === 'gif') { for (let k = 0; k < it.info.gifFrames; k++) frames.push({ file: it.path, gif: k }); fps = 10; continue; }
      const cells = cellsOf(it.path, it.info);
      if (cells > 1) { const horiz = it.info.w >= it.info.h; const cw = horiz ? Math.floor(it.info.w / cells) : it.info.w, chh = horiz ? it.info.h : Math.floor(it.info.h / cells); for (let k = 0; k < cells; k++) frames.push({ file: it.path, cell: [horiz ? k * cw : 0, horiz ? 0 : k * chh, cw, chh] }); }
      else frames.push({ file: it.path });
    }
    out.push({ key, label: g.label, frames: frames.slice(0, LIMITS.frames), suggested: suggestState(g.label), fps });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
/** A strip's cells: square frames side by side (or one above another), 2 to 64 of them; else 1. */
export function autoCells(_p: string, i: PicInfo): number {
  if (i.kind === 'gif') return 1;
  if (i.w >= 2 * i.h && i.w % i.h === 0 && i.w / i.h <= 64) return i.w / i.h;
  if (i.h >= 2 * i.w && i.h % i.w === 0 && i.h / i.w <= 64) return i.h / i.w;
  return 1;
}
/** The mapping first offered: each state's suggested group (the first of its kind), idle at least something. */
export function suggestMapping(groups: FrameGroup[]): Partial<Record<PetState, string>> {
  const m: Partial<Record<PetState, string>> = {};
  for (const g of groups) if (g.suggested && !m[g.suggested]) m[g.suggested] = g.key;
  if (!m.idle && groups.length) m.idle = (groups.find((g) => !g.suggested) ?? groups[0]).key;
  return m;
}
export interface MappingOpts { name: string; credit?: string; licence?: string; fps?: Partial<Record<PetState, number>>; facing?: 'left' | 'right'; speed?: number }
/** The pack made from a mapping (state → group). */
export function buildFromMapping(files: PackFile[], groups: FrameGroup[], mapping: Partial<Record<PetState, string>>, o: MappingOpts): ImportResult {
  const report = newReport(); const fl = new FrameList(); const byKey = new Map(groups.map((g) => [g.key, g]));
  const byPath = new Map(files.map((f) => [f.path, f])); const infos = new Map<string, PicInfo | null>();
  const info = (p: string) => { if (!infos.has(p)) { const f = byPath.get(p); infos.set(p, f ? picInfo(f) : null); } return infos.get(p) ?? null; };
  const animations: PetPack['animations'] = dict<PetPack['animations'][string]>(); const states: Partial<Record<PetState, PetChoice[]>> = {};
  for (const st of MAP_STATES) {
    const g = mapping[st] ? byKey.get(mapping[st]!) : undefined; if (!g || !g.frames.length) continue;
    const fps = Math.min(60, Math.max(0.5, o.fps?.[st] ?? g.fps));
    animations[st] = { frames: g.frames.map((f) => fl.add(f)), fps, loop: st !== 'click', speed: st === 'walk' ? o.speed ?? 40 : undefined };
    const dur = (CHOSEN as string[]).includes(st) ? (st === 'walk' ? [2, 6] : st === 'sleep' ? [8, 20] : [3, 8]) : [1, 1];
    states[st] = [{ steps: [{ anim: st, min: dur[0], max: dur[1] }], weight: st === 'idle' ? 3 : 2 }];
  }
  if (!states.idle && !states.walk) throw new PackError('frames:noIdle');
  if (!states.thrown && states.fall) states.thrown = [{ steps: [{ anim: 'fall', min: 1, max: 1 }], weight: 1 }];
  checkFrameBudget(fl.list, info);
  let fw = 0, fh = 0; for (const f of fl.list) { const i = info(f.file)!; fw = Math.max(fw, f.cell ? f.cell[2] : i.w); fh = Math.max(fh, f.cell ? f.cell[3] : i.h); }
  const pack: PetPack = { v: 1, name: o.name.slice(0, LIMITS.nameLen) || 'Pet', credit: o.credit ?? '', licence: o.licence ?? '', source: 'frames', frameW: fw, frameH: fh, anchor: [fw / 2, fh], scale: 1, facing: o.facing ?? 'right', frames: fl.list.length, animations, states };
  checkPack(pack);
  return { pack, frames: fl.list, report };
}
