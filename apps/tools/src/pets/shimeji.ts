// Shimeji packs (the most common desktop-pet format): img/<Name>/shime1.png … shimeN.png, with conf/actions.xml and
// conf/behaviors.xml (or the same files in img/<Name>/conf/, or their Japanese-named originals). A tolerant SUBSET is
// converted into our model: Stay, Move, Animate, Sequence and Select actions, the embedded Fall and Dragged, poses with
// their picture, anchor, velocity and duration; behaviours with their frequency and simple conditions on the pet's
// place (floor, window top, wall, ceiling, screen edges), read by the small safe evaluator of ./expr.ts — never by
// JavaScript. Whatever is not understood is skipped and named in the report. Without the XML files, the standard
// meaning of the numbered pictures is assumed.
// NOT VERIFIED AGAINST A REAL PACK: written from the publicly documented format (the tests use made-up packs).
import { parseXml, findAll, type XNode } from './xml';
import { compile, evaluate, num, ExprError } from './expr';
import { COND_NAMES, LIMITS, dict, own, reservedName, checkPack, newReport, type PetAnim, type PetChoice, type PetPack, type PetState, type PetStep } from './model';
import { FrameList, PackError, checkFrameBudget, cleanText, picInfo, textOf, type ImportResult, type PackFile, type PicInfo } from './source';

/** Shimeji's clock: one tick is 40 ms (25 a second). */
const TICK = 0.04;
export { COND_NAMES };
const TRANSLATE: [RegExp, string][] = [
  [/mascot\.environment\.(?:workArea|screen)\.leftBorder\.isOn\(\s*mascot\.anchor\s*\)/g, 'onAreaLeft'],
  [/mascot\.environment\.(?:workArea|screen)\.rightBorder\.isOn\(\s*mascot\.anchor\s*\)/g, 'onAreaRight'],
  [/mascot\.environment\.(?:workArea|screen)\.bottomBorder\.isOn\(\s*mascot\.anchor\s*\)/g, 'onFloor'],
  [/mascot\.environment\.(?:workArea|screen)\.topBorder\.isOn\(\s*mascot\.anchor\s*\)/g, 'onCeiling'],
  [/mascot\.environment\.floor\.isOn\(\s*mascot\.anchor\s*\)/g, 'onFloor'],
  [/mascot\.environment\.ceiling\.isOn\(\s*mascot\.anchor\s*\)/g, 'onCeiling'],
  [/mascot\.environment\.wall\.isOn\(\s*mascot\.anchor\s*\)/g, 'onWall'],
  [/mascot\.environment\.activeIE\.topBorder\.isOn\(\s*mascot\.anchor\s*\)/g, 'onWindowTop'],
  [/mascot\.environment\.activeIE\.bottomBorder\.isOn\(\s*mascot\.anchor\s*\)/g, 'onWindowBottom'],
  [/mascot\.environment\.activeIE\.(left|right)Border\.isOn\(\s*mascot\.anchor\s*\)/g, 'onWindowSide'],
  [/mascot\.environment\.activeIE\.visible/g, 'windowVisible'],
  [/mascot\.environment\.activeIE\.(left|right|top|bottom|width|height)/g, 'win.$1'],
  [/mascot\.environment\.(workArea|screen)\.(left|right|top|bottom|width|height)/g, (_m: string, a: string, k: string) => `${a === 'workArea' ? 'area' : 'screen'}.${k}`] as unknown as [RegExp, string],
  [/mascot\.environment\.cursor\.(x|y)/g, 'cursor.$1'],
  [/mascot\.anchor\.(x|y)/g, '$1'],
  [/mascot\.lookRight/g, 'lookRight'],
  [/mascot\.totalCount/g, 'count'],
];
/** A Shimeji expression (#{…} or ${…}) in our language, or the text unchanged when it is a plain number. */
export function translateExpr(src: string): string {
  let s = src.trim(); const m = /^[#$]\{([\s\S]*)\}$/.exec(s); if (m) s = m[1];
  for (const [re, to] of TRANSLATE) s = s.replace(re, to as string);
  return s;
}

/* ---------- the Japanese originals' names ---------- */
const JA_EL: Record<string, string> = { マスコット: 'Mascot', 動作リスト: 'ActionList', 動作: 'Action', アニメーション: 'Animation', ポーズ: 'Pose', 動作参照: 'ActionReference', 選択: 'Select', 行動リスト: 'BehaviorList', 行動: 'Behavior', 条件: 'Condition', 次の行動リスト: 'NextBehaviorList', 行動参照: 'BehaviorReference' };
const JA_AT: Record<string, string> = { 名前: 'Name', 種類: 'Type', クラス: 'Class', 画像: 'Image', 基準座標: 'ImageAnchor', 移動速度: 'Velocity', 長さ: 'Duration', 頻度: 'Frequency', 条件: 'Condition', 枠: 'BorderType', ループ: 'Loop', 動作: 'Action' };
const JA_VAL: Record<string, string> = { 静止: 'Stay', 移動: 'Move', 固定: 'Animate', 複合: 'Sequence', 選択: 'Select', 組み込み: 'Embedded', 地面: 'Floor', 壁: 'Wall', 天井: 'Ceiling' };
function english(n: XNode): XNode {
  const attrs: Record<string, string> = {};
  // (Own entries only: a value such as «toString» must stay the text it is.)
  for (const [k, v] of Object.entries(n.attrs)) attrs[own(JA_AT, k) ?? k] = own(JA_VAL, v) ?? v;
  return { name: own(JA_EL, n.name) ?? n.name, attrs, text: n.text, kids: n.kids.map(english) };
}

/* ---------- where things are ---------- */
const lower = (s: string) => s.toLowerCase();
/** The characters of a pack: the folders under img/ holding shime pictures ('' = the pictures are in img/ or at the top). */
export function shimejiCharacters(files: PackFile[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    // (img/unused/ holds the characters a Shimeji install has set aside: not offered.)
    const m = /^img\/([^/]+)\/shime\d+\.(png|gif|webp)$/i.exec(f.path); if (m) { if (!/^unused$/i.test(m[1]) && !reservedName(m[1])) out.add(m[1]); continue; }
    if (/^(img\/)?shime\d+\.(png|gif|webp)$/i.test(f.path)) out.add('');
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
export const isShimeji = (files: PackFile[]): boolean => shimejiCharacters(files).length > 0;

function confFile(files: PackFile[], character: string, kind: 'actions' | 'behaviors'): PackFile | undefined {
  const names = kind === 'actions' ? ['actions.xml', '動作.xml'] : ['behaviors.xml', 'behavior.xml', '行動.xml'];
  const dirs = character ? [`img/${lower(character)}/conf/`, 'conf/'] : ['conf/', 'img/conf/'];
  for (const d of dirs) for (const n of names) { const f = files.find((x) => lower(x.path) === d + lower(n)); if (f) return f; }
  return undefined;
}

/* ---------- the conversion ---------- */
interface ActInfo { el: XNode; type: string; cls: string; border: string }
const STANDARD: Record<string, { frames: number[]; fps: number; loop: boolean; speed?: number }> = {
  idle: { frames: [1], fps: 1, loop: true },
  walk: { frames: [1, 2, 1, 3], fps: 6, loop: true, speed: 50 },
  fall: { frames: [4], fps: 1, loop: true },
  dragged: { frames: [5, 6, 5, 7, 5, 8, 5, 9], fps: 8, loop: true },
  sit: { frames: [11], fps: 1, loop: true },
  climb: { frames: [12, 13, 14], fps: 4, loop: true },
  landing: { frames: [18, 19], fps: 5, loop: false },
  sleep: { frames: [21], fps: 1, loop: true },
};

export function fromShimeji(files: PackFile[], character?: string): ImportResult {
  const report = newReport();
  const chars = shimejiCharacters(files); if (!chars.length) throw new PackError('shimeji:noPictures');
  const ch = character !== undefined && chars.includes(character) ? character : chars[0];
  const byPath = new Map(files.map((f) => [lower(f.path), f]));
  const imgDir = ch ? `img/${ch}/` : byPath.has('img/shime1.png') || files.some((f) => /^img\/shime\d+\./i.test(f.path)) ? 'img/' : '';
  const infos = new Map<string, PicInfo | null>();
  const info = (p: string): PicInfo | null => { const k = lower(p); if (!infos.has(k)) { const f = byPath.get(k); infos.set(k, f ? picInfo(f) : null); } return infos.get(k) ?? null; };
  const picPath = (img: string): string | null => { const p = imgDir + img.replace(/^[/\\]+/, '').replace(/\\/g, '/'); if (p.includes('..')) return null; const f = byPath.get(lower(p)); return f && info(f.path) ? f.path : null; };
  const fl = new FrameList();
  const animations: Record<string, PetAnim> = dict<PetAnim>();
  const states: Partial<Record<PetState, PetChoice[]>> = {};
  const push = (s: PetState, c: PetChoice) => { (states[s] ??= []).push(c); };
  let anims = 0;

  const aFile = confFile(files, ch, 'actions'), bFile = confFile(files, ch, 'behaviors');
  let actionsDoc: XNode | null = null, behaviorsDoc: XNode | null = null;
  try { if (aFile) actionsDoc = english(parseXml(textOf(aFile))); } catch (e) { report.skipped.push(`actions.xml: ${(e as Error).message}`); }
  try { if (bFile) behaviorsDoc = english(parseXml(textOf(bFile))); } catch (e) { report.skipped.push(`behaviors.xml: ${(e as Error).message}`); }

  if (actionsDoc) {
    const acts = new Map<string, ActInfo>();
    for (const a of findAll(actionsDoc, 'Action')) {
      const n = a.attrs.Name; if (!n || acts.has(n)) continue;
      if (reservedName(n)) { report.skipped.push(`name: ${n.slice(0, 40)}`); continue; }
      acts.set(n, { el: a, type: a.attrs.Type ?? '', cls: (a.attrs.Class ?? '').split('.').pop() ?? '', border: a.attrs.BorderType ?? '' });
    }
    const condOk = (c: string): string | null => { const w = translateExpr(c); try { compile(w, COND_NAMES); return w; } catch { return null; } };
    // One <Animation>'s poses as an animation of ours (its pictures for walking right too, where given).
    const poseAnim = (key: string, an: XNode): string | null => {
      if (own(animations, key)) return key;
      const frames: number[] = [], durations: number[] = [], anchors: [number, number][] = [], right: number[] = []; let vSum = 0; let allRight = true;
      for (const p of an.kids.filter((k) => k.name === 'Pose')) {
        const fp = picPath(p.attrs.Image ?? ''); if (!fp) { report.skipped.push(`picture: ${String(p.attrs.Image).slice(0, 60)}`); continue; }
        frames.push(fl.add({ file: fp }));
        const rp = p.attrs.ImageRight ? picPath(p.attrs.ImageRight) : null; if (rp) right.push(fl.add({ file: rp })); else allRight = false;
        durations.push(Math.min(60, Math.max(TICK, (Number(p.attrs.Duration) || 1) * TICK)));
        const ia = (p.attrs.ImageAnchor ?? '').split(',').map(Number); const pi = info(fp)!;
        anchors.push(ia.length === 2 && ia.every(Number.isFinite) ? [ia[0], ia[1]] : [pi.w / 2, pi.h]);
        const v = (p.attrs.Velocity ?? '0,0').split(',').map(Number); if (Number.isFinite(v[0])) vSum += Math.abs(v[0]);
      }
      if (!frames.length) return null;
      if (++anims > LIMITS.animations) { report.skipped.push(`tooManyAnimations: ${key.slice(0, 60)}`); return null; }
      const speed = vSum / frames.length / TICK;
      // (Right-facing pictures mirror the anchor: x measured from the other side.)
      animations[key] = { frames, durations, anchors, fps: 25, loop: true, speed: speed > 0 ? Math.min(2000, speed) : undefined,
        ...(allRight && right.length === frames.length ? { framesRight: right, anchorsRight: anchors.map(([x, y], i) => { const w = info(fl.list[right[i]].file)?.w ?? 0; return [w - x, y] as [number, number]; }) } : {}) };
      return key;
    };
    /** An action's animation and the conditional ones used instead while their condition holds. */
    const animOf = (name: string): { anim: string; alts?: { when: string; anim: string }[] } | null => {
      const ai = acts.get(name); if (!ai) return null;
      const list = ai.el.kids.filter((k) => k.name === 'Animation'); if (!list.length) return null;
      const alts: { when: string; anim: string }[] = []; let base: string | null = null;
      for (const [i, an] of list.entries()) {
        const c = an.attrs.Condition;
        if (!c) { base = poseAnim(i ? `${name}#${i}` : name, an); break; }
        const w = condOk(c); if (!w) { report.skipped.push(`condition: ${name.slice(0, 40)} animation ${i + 1}`); continue; }
        const k = poseAnim(`${name}#${i}`, an); if (k) alts.push({ when: w, anim: k });
      }
      if (!base) { const last = alts.pop(); if (!last) return null; base = last.anim; }
      return { anim: base, alts: alts.length ? alts : undefined };
    };
    // Seconds from a Duration (ticks; an expression: its least and its most).
    const range = (d: string | undefined): [number, number] | null => {
      if (!d) return null;
      try { const tree = compile(translateExpr(d), COND_NAMES); const lo = num(evaluate(tree, {}, () => 0)), hi = num(evaluate(tree, {}, () => 0.999)); if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null; const a = Math.max(TICK, Math.min(lo, hi) * TICK), b = Math.max(TICK, Math.max(lo, hi) * TICK); return [Math.min(a, 600), Math.min(b, 600)]; }
      catch (e) { if (e instanceof ExprError) report.skipped.push(`duration: ${d.slice(0, 60)}`); return null; }
    };
    // What an action does, as alternatives (a Select gives several, each with its condition): memoised per action and
    // duration, cycles cut, and a budget on the whole walk — a pack that asks more is refused.
    type Alt = { steps: PetStep[]; w: number; when?: string };
    const memo = new Map<string, Alt[]>(); const visiting = new Set<string>(); let calls = 0;
    const MAX_ALTS = 8, MAX_STEPS = 8, BUDGET = 5000;
    const and = (a?: string, b?: string) => (a && b ? `(${a}) && (${b})` : a ?? b);
    const altsOf = (name: string, dur: string | undefined): Alt[] => {
      if (++calls > BUDGET) throw new PackError('shimeji:tooComplex');
      const key = `${name}\u0000${dur ?? ''}`; const m = memo.get(key); if (m) return m;
      if (visiting.has(name)) { report.skipped.push(`cycle: ${name.slice(0, 60)}`); return []; }
      const ai = acts.get(name); if (!ai) { report.skipped.push(`action: ${name.slice(0, 60)}`); memo.set(key, []); return []; }
      visiting.add(name);
      try {
        let out: Alt[];
        const t = ai.type;
        const childAlts = (k: XNode): Alt[] => {
          if ((k.name === 'ActionReference' || k.name === 'Action') && k.attrs.Name) {
            const got = altsOf(k.attrs.Name, k.attrs.Duration);
            const c = k.attrs.Condition; if (!c) return got;
            const w = condOk(c); if (!w) { report.skipped.push(`condition: ${k.attrs.Name.slice(0, 60)}`); return []; }
            return got.map((g) => ({ ...g, when: and(w, g.when) }));
          }
          if (k.name === 'Select') return selectAlts(k.kids);
          return [];
        };
        const selectAlts = (kids: XNode[]): Alt[] => { const all: Alt[] = []; for (const k of kids) all.push(...childAlts(k)); const sum = all.reduce((x, a) => x + a.w, 0) || 1; return all.slice(0, MAX_ALTS).map((a) => ({ ...a, w: a.w / sum })); };
        if (t === 'Select') out = selectAlts(ai.el.kids);
        else if (t === 'Sequence') {
          out = [{ steps: [], w: 1 }];
          for (const k of ai.el.kids) {
            const parts = childAlts(k); if (!parts.length) continue;
            const next: Alt[] = [];
            for (const a of out) for (const b of parts) { if (next.length >= MAX_ALTS) break; next.push({ steps: [...a.steps, ...b.steps].slice(0, MAX_STEPS), w: a.w * b.w, when: and(a.when, b.when) }); }
            out = next;
          }
          out = out.filter((a) => a.steps.length);
        } else if (t === 'Embedded' && !['Fall', 'Dragged', 'Thrown', 'Regist'].includes(ai.cls)) {
          if (!['Look', 'Offset'].includes(ai.cls)) report.skipped.push(`embedded: ${ai.cls || name}`);
          out = [];
        } else {
          const an = animOf(name);
          if (!an) out = [];
          else {
            const a = animations[an.anim]; const once = (a.durations ?? []).reduce((x, y) => x + y, 0) || 1;
            const r = range(dur) ?? range(ai.el.attrs.Duration) ?? (t === 'Animate' ? [once, once] : t === 'Move' ? [2, 6] : [3, 8]);
            if (t === 'Animate') a.loop = false;
            out = [{ steps: [{ anim: an.anim, min: r[0], max: r[1], ...(an.alts ? { alts: an.alts } : {}) }], w: 1 }];
          }
        }
        memo.set(key, out); return out;
      } finally { visiting.delete(name); }
    };
    const firstAnim = (name: string): string | null => { const a = altsOf(name, undefined)[0]; return a?.steps[0]?.anim ?? null; };
    const classify = (anim: string, beh: string): PetState => {
      const ai = acts.get(anim.split('#')[0]); const nm = `${beh} ${anim}`.toLowerCase();
      if (ai?.border === 'Wall' || ai?.border === 'Ceiling' || /climb|wall|ceiling/.test(nm)) return 'climb';
      if (ai?.type === 'Move' || /walk|run|dash|creep|chase/.test(nm)) return 'walk';
      if (/sleep|lie|lying|sprawl/.test(nm)) return 'sleep';
      if (/sit/.test(nm)) return 'sit';
      return 'idle';
    };
    // Special actions: the embedded classes, or their usual names.
    const special = (cls: string, names: RegExp): string | null => { for (const [n, ai] of acts) if (ai.cls === cls || names.test(n)) { const a = animOf(n); if (a) return a.anim; } return null; };
    const fall = special('Fall', /^falling$/i), drag = special('Dragged', /^(pinched|dragged)$/i), thrown = special('Thrown', /^thrown$/i), click = special('Regist', /^(resisting|regist|resist)$/i);
    if (fall) push('fall', { steps: [{ anim: fall, min: 1, max: 1 }], weight: 1 });
    if (drag) push('dragged', { steps: [{ anim: drag, min: 1, max: 1 }], weight: 1 });
    if (thrown || fall) push('thrown', { steps: [{ anim: (thrown ?? fall)!, min: 1, max: 1 }], weight: 1 });
    if (click) push('click', { steps: [{ anim: click, min: 0.6, max: 1.2 }], weight: 1 });
    if (behaviorsDoc) {
      const visit = (n: XNode, conds: string[]): void => {
        for (const k of n.kids) {
          if (k.name === 'Condition') { visit(k, k.attrs.Condition ? [...conds, k.attrs.Condition] : conds); continue; }
          if (k.name === 'BehaviorList') { visit(k, conds); continue; }
          if (k.name !== 'Behavior') continue;
          const name = k.attrs.Name ?? ''; const freq = Number(k.attrs.Frequency ?? 0);
          if (!name || !(freq > 0)) continue;
          if (reservedName(name)) { report.skipped.push(`name: ${name.slice(0, 40)}`); continue; }
          const all = k.attrs.Condition ? [...conds, k.attrs.Condition] : conds;
          let when: string | undefined;
          if (all.length) {
            when = all.map((c) => `(${translateExpr(c)})`).join(' && ');
            try { compile(when, COND_NAMES); } catch { report.skipped.push(`condition: ${name.slice(0, 60)}`); continue; }
          }
          if (/^chasemouse/i.test(name) || /^jump/i.test(name)) { report.skipped.push(`behaviour: ${name.slice(0, 60)}`); continue; }
          const alts = altsOf(k.attrs.Action ?? name, undefined);
          if (!alts.length) { report.skipped.push(`behaviour: ${name.slice(0, 60)}`); continue; }
          // (What may follow it: its NextBehaviorList — only those, or those added among the usual.)
          const nl = k.kids.find((x) => x.name === 'NextBehaviorList');
          const next = nl ? nl.kids.filter((x) => x.name === 'BehaviorReference' && x.attrs.Name && !reservedName(x.attrs.Name)).map((x) => ({ name: x.attrs.Name.slice(0, 60), weight: Math.max(0, Math.min(1000, Number(x.attrs.Frequency ?? 1) || 0)) })).filter((x) => x.weight > 0).slice(0, 16) : [];
          const sum = alts.reduce((x, a) => x + a.w, 0) || 1;
          for (const a of alts) {
            const w2 = a.when ? and(when, a.when) : when; if (w2 && w2.length > 480) { report.skipped.push(`condition: ${name.slice(0, 60)}`); continue; }
            push(classify(a.steps[0].anim, name), { steps: a.steps, weight: Math.min(1000, freq) * (a.w / sum), when: w2, name: name.slice(0, 60), ...(next.length ? { next, nextAdd: nl?.attrs.Add !== 'false' } : {}) });
          }
        }
      };
      visit(behaviorsDoc, []);
    } else report.notes.push('noBehaviors');
    // (A pack whose behaviours were all skipped still stands and walks: its Stand and Walk actions.)
    if (!states.idle?.length) { const a = firstAnim('Stand') ?? firstAnim('Standing'); if (a) push('idle', { steps: [{ anim: a, min: 3, max: 8 }], weight: 1 }); }
    if (!states.walk?.length) { const a = firstAnim('Walk') ?? firstAnim('Walking'); if (a) push('walk', { steps: [{ anim: a, min: 2, max: 6 }], weight: 1 }); }
  }
  if (!actionsDoc || (!states.idle?.length && !states.walk?.length)) {
    if (!aFile) report.notes.push('standardSlots');
    // The standard numbered pictures (assumed, as Shimeji's documentation describes them).
    const slot = (n: number): number | null => { const p = picPath(`shime${n}.png`) ?? picPath(`shime${n}.gif`) ?? picPath(`shime${n}.webp`); return p ? fl.add({ file: p }) : null; };
    for (const [nm, d] of Object.entries(STANDARD)) {
      const frames = d.frames.map(slot).filter((x): x is number => x !== null);
      if (!frames.length) continue;
      animations[`std-${nm}`] = { frames, fps: d.fps, loop: d.loop, speed: d.speed }; anims++;
      const st = (nm === 'landing' ? 'click' : nm) as PetState;
      if (!states[st]?.length) push(st, { steps: [{ anim: `std-${nm}`, min: st === 'walk' ? 2 : 3, max: st === 'walk' ? 6 : 8 }], weight: st === 'idle' ? 3 : 2 });
    }
    if (!states.thrown?.length && own(animations, 'std-fall')) push('thrown', { steps: [{ anim: 'std-fall', min: 1, max: 1 }], weight: 1 });
  }
  if (!fl.list.length) throw new PackError('shimeji:noFrames');
  checkFrameBudget(fl.list, info);
  let fw = 0, fh = 0; for (const f of fl.list) { const i = info(f.file)!; fw = Math.max(fw, i.w); fh = Math.max(fh, i.h); }
  const first = Object.values(animations).find((a) => a.anchors?.length)?.anchors?.[0];
  const notice = files.find((f) => /(^|\/)(read ?me|licen[cs]e|credits?)[^/]*\.(txt|md)$/i.test(f.path) && f.bytes.length < 64 * 1024);
  const pack: PetPack = {
    v: 1, name: cleanText(ch, LIMITS.nameLen) || 'Shimeji', credit: '', licence: notice ? cleanText(textOf(notice), LIMITS.textLen) : '', source: 'shimeji',
    frameW: fw, frameH: fh, anchor: first ?? [fw / 2, fh], scale: 1, facing: 'left', frames: fl.list.length, animations, states,
  };
  try { checkPack(pack); } catch (e) { throw new PackError(`shimeji:${(e as Error).message}`); }
  return { pack, frames: fl.list, report };
}
