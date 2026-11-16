// Our own pack format: a folder (or zip) with pet.json and its pictures (PNG, WebP or GIF; single frames, strips or
// sheets). Read strictly: every value's type and range checked, every picture named must be there, nothing in it is
// ever run. Example:
//   { "format": "kurokawa-pet", "version": 1, "name": "Box", "credit": "…", "licence": "…",
//     "anchor": [32, 64], "scale": 1, "facing": "right",
//     "sheets": { "w": { "file": "walk.png", "columns": 4, "rows": 1 } },
//     "animations": { "idle": { "frames": ["idle_1.png", "idle_2.png"], "fps": 4 },
//                     "walk": { "frames": ["w:0", "w:1", "w:2", "w:3"], "fps": 8, "speed": 40 },
//                     "wave": { "frames": ["wave.gif"], "fps": 10, "loop": false } },
//     "states": { "idle": [{ "animation": "idle", "weight": 3, "duration": [2, 6] }], "walk": ["walk"], "click": ["wave"] },
//     "speech": ["Hello"] }
// A frame is a picture's path, "sheet:index" for a cell of a sheet, or "file.gif#n" for one frame of a GIF (a GIF
// named alone gives all its frames).
import { LIMITS, STATES, checkPack, dict, own, reservedName, newReport, type PetAnim, type PetChoice, type PetPack, type PetState } from './model';
import { FrameList, PackError, checkFrameBudget, cleanText, picInfo, textOf, type ImportResult, type PackFile, type PicInfo } from './source';

const KNOWN = new Set(['format', 'version', 'name', 'credit', 'licence', 'license', 'frameSize', 'anchor', 'scale', 'facing', 'sheets', 'animations', 'states', 'speech']);
const bad = (what: string): never => { throw new PackError(`petJson:${what}`); };
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown, lo: number, hi: number, what: string): number => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : bad(what));
const pair = (v: unknown, lo: number, hi: number, what: string): [number, number] => (Array.isArray(v) && v.length === 2 ? [num(v[0], lo, hi, what), num(v[1], lo, hi, what)] : bad(what));
const SAFE_KEY = /^[A-Za-z0-9_.-]{1,40}$/;

export function findPetJson(files: PackFile[]): PackFile | undefined {
  return files.find((f) => f.path.toLowerCase() === 'pet.json');
}

export function fromPetJson(files: PackFile[]): ImportResult {
  const report = newReport();
  const pj = findPetJson(files); if (!pj) return bad('missing');
  if (pj.bytes.length > 256 * 1024) bad('tooBig');
  let j: unknown; try { j = JSON.parse(textOf(pj)); } catch { return bad('notJson'); }
  if (!isObj(j)) return bad('notObject');
  if (j.format !== undefined && j.format !== 'kurokawa-pet') bad('format');
  if (j.version !== undefined && j.version !== 1) bad('version');
  for (const k of Object.keys(j)) if (!KNOWN.has(k)) report.notes.push(`ignored: ${k.slice(0, 40)}`);
  const byPath = new Map(files.map((f) => [f.path.toLowerCase(), f]));
  const infos = new Map<string, PicInfo | null>();
  const info = (p: string): PicInfo | null => { const k = p.toLowerCase(); if (!infos.has(k)) { const f = byPath.get(k); infos.set(k, f ? picInfo(f) : null); } return infos.get(k) ?? null; };
  const realPath = (p: string): string => byPath.get(p.toLowerCase())?.path ?? p;

  const name = cleanText(j.name, LIMITS.nameLen) || bad('name');
  // Sheets: a picture cut into columns × rows cells (count: how many are used, row by row).
  const sheets = new Map<string, { file: string; cols: number; rows: number; count: number; w: number; h: number }>();
  if (j.sheets !== undefined) {
    if (!isObj(j.sheets)) bad('sheets');
    for (const [id, s] of Object.entries(j.sheets as Record<string, unknown>)) {
      if (!SAFE_KEY.test(id) || reservedName(id) || !isObj(s) || typeof s.file !== 'string') bad(`sheet:${id}`);
      const sh = s as Record<string, unknown>; const file = sh.file as string; const pi = info(file); if (!pi || pi.kind === 'gif') bad(`sheetFile:${id}`);
      const cols = num(sh.columns ?? 1, 1, 256, `sheetCols:${id}`), rows = num(sh.rows ?? 1, 1, 256, `sheetRows:${id}`);
      if (!Number.isInteger(cols) || !Number.isInteger(rows)) bad(`sheet:${id}`);
      const count = num(sh.count ?? cols * rows, 1, cols * rows, `sheetCount:${id}`);
      sheets.set(id, { file: realPath(file), cols, rows, count, w: Math.floor(pi!.w / cols), h: Math.floor(pi!.h / rows) });
    }
  }
  const fl = new FrameList();
  const framesOf = (ref: unknown, what: string): number[] => {
    if (typeof ref !== 'string' || !ref || ref.length > 200) return bad(what);
    const m = /^([A-Za-z0-9_.-]{1,40}):(\d{1,4})$/.exec(ref);
    if (m && sheets.has(m[1])) { const s = sheets.get(m[1])!; const i = Number(m[2]); if (i >= s.count) bad(what); return [fl.add({ file: s.file, cell: [(i % s.cols) * s.w, Math.floor(i / s.cols) * s.h, s.w, s.h] })]; }
    const g = /^(.+\.gif)#(\d{1,4})$/i.exec(ref);
    if (g) { const pi = info(g[1]); if (!pi || pi.kind !== 'gif' || Number(g[2]) >= pi.gifFrames) bad(what); return [fl.add({ file: realPath(g[1]), gif: Number(g[2]) })]; }
    const pi = info(ref); if (!pi) return bad(`${what}:${ref.slice(0, 60)}`);
    if (pi.kind === 'gif') return Array.from({ length: pi.gifFrames }, (_, i) => fl.add({ file: realPath(ref), gif: i }));
    return [fl.add({ file: realPath(ref) })];
  };
  if (!isObj(j.animations)) bad('animations');
  const animations: Record<string, PetAnim> = dict<PetAnim>();
  for (const [an, a] of Object.entries(j.animations as Record<string, unknown>)) {
    if (!SAFE_KEY.test(an) || reservedName(an) || !isObj(a) || !Array.isArray(a.frames) || !a.frames.length || a.frames.length > 300) bad(`animation:${an}`);
    const aa = a as Record<string, unknown>;
    const frames = (aa.frames as unknown[]).flatMap((r) => framesOf(r, `frame:${an}`));
    if (Object.keys(animations).length >= LIMITS.animations) bad('tooManyAnimations');
    animations[an] = { frames, fps: num(aa.fps ?? 8, 0.5, 60, `fps:${an}`), loop: aa.loop === undefined ? true : aa.loop === true, speed: aa.speed === undefined ? undefined : num(aa.speed, 0, 2000, `speed:${an}`), mirror: aa.mirror === undefined ? undefined : aa.mirror === true };
  }
  if (!isObj(j.states)) bad('states');
  const states: Partial<Record<PetState, PetChoice[]>> = {};
  for (const [sn, list] of Object.entries(j.states as Record<string, unknown>)) {
    if (!(STATES as string[]).includes(sn)) { report.notes.push(`ignored state: ${sn.slice(0, 40)}`); continue; }
    const arr = Array.isArray(list) ? list : [list];
    if (arr.length > 32) bad(`state:${sn}`);
    states[sn as PetState] = arr.map((c) => {
      const o = typeof c === 'string' ? { animation: c } : isObj(c) ? c : bad(`state:${sn}`);
      const an = o.animation; if (typeof an !== 'string' || !own(animations, an)) return bad(`stateAnim:${sn}`);
      const dur = o.duration === undefined ? [2, 6] : typeof o.duration === 'number' ? [o.duration, o.duration] : pair(o.duration, 0.1, 600, `duration:${sn}`);
      num(dur[0], 0.1, 600, `duration:${sn}`); num(dur[1], 0.1, 600, `duration:${sn}`);
      return { steps: [{ anim: an, min: Math.min(dur[0], dur[1]), max: Math.max(dur[0], dur[1]) }], weight: num(o.weight ?? 1, 0, 1000, `weight:${sn}`) };
    });
  }
  checkFrameBudget(fl.list, info);
  let fw = 0, fh = 0; for (const f of fl.list) { const i = info(f.file)!; fw = Math.max(fw, f.cell ? f.cell[2] : i.w); fh = Math.max(fh, f.cell ? f.cell[3] : i.h); }
  if (j.frameSize !== undefined) { const fs = pair(j.frameSize, 1, LIMITS.framePx, 'frameSize'); fw = fs[0]; fh = fs[1]; }
  const speech = Array.isArray(j.speech) ? j.speech.slice(0, LIMITS.speech).map((s) => cleanText(s, 200)).filter(Boolean) : undefined;
  const pack: PetPack = {
    v: 1, name, credit: cleanText(j.credit, LIMITS.textLen), licence: cleanText(j.licence ?? j.license, LIMITS.textLen), source: 'pet',
    frameW: fw, frameH: fh, anchor: j.anchor === undefined ? [fw / 2, fh] : pair(j.anchor, -LIMITS.framePx, 2 * LIMITS.framePx, 'anchor'),
    scale: j.scale === undefined ? 1 : num(j.scale, 0.05, 8, 'scale'), facing: j.facing === 'left' ? 'left' : 'right',
    frames: fl.list.length, animations, states, speech: speech?.length ? speech : undefined,
  };
  try { checkPack(pack); } catch (e) { bad(String((e as Error).message)); }
  return { pack, frames: fl.list, report };
}
