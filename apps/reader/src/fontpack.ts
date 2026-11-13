// The lines a font sets (fontfix.ts Use: glyph, text, place, size, advance, cluster), packed into flat arrays to
// be sent to the font worker (src/pdf2docx.fonts.worker.ts) and unpacked there exactly as they were.
import type { buildFont, Use } from './fontfix';

export type FontJob = {
  id: number;
  /** The font files of the sources, in the order of the uses' glyph ids (id = source × 65536 + glyph). */
  datas: Uint8Array[];
  /** Each line: its uses' count, then per use gid, x, y, em, width, span (NaN: none). */
  nums: Float64Array;
  /** The uses' texts, one after another, and each one's length. */
  texts: string; lens: Uint32Array;
  /** Each line's direction: 0 left to right, 1 right to left, 2 not said. */
  rtl: Uint8Array;
  meta: Parameters<typeof buildFont>[2]; spaceGid?: number;
};
export type FontDone = { id: number; built: Uint8Array | null; error?: string };

/** The lines packed as they are made, one by one (see FontJob): never all of them as arrays of arrays at once. */
export class LinePack {
  private nums = new Float64Array(4096); private at = 0;
  private readonly texts: string[] = []; private readonly lens: number[] = []; private readonly rtl: number[] = [];
  get lines(): number { return this.rtl.length; }
  add(line: readonly Use[], rtl: boolean | undefined): void {
    const need = this.at + 1 + line.length * 6;
    if (need > this.nums.length) { const n = new Float64Array(Math.max(need, this.nums.length * 2)); n.set(this.nums.subarray(0, this.at)); this.nums = n; }
    const v = this.nums; let at = this.at;
    this.rtl.push(rtl === undefined ? 2 : rtl ? 1 : 0); v[at++] = line.length;
    for (const u of line) { v[at++] = u[0]; v[at++] = u[2]; v[at++] = u[3]; v[at++] = u[4]; v[at++] = u[5]; v[at++] = u[6] === undefined ? NaN : u[6]; this.texts.push(u[1]); this.lens.push(u[1].length); }
    this.at = at;
  }
  done(): Pick<FontJob, 'nums' | 'texts' | 'lens' | 'rtl'> {
    return { nums: this.nums.slice(0, this.at), texts: this.texts.join(''), lens: Uint32Array.from(this.lens), rtl: Uint8Array.from(this.rtl) };
  }
}

/** The lines as they were (see LinePack). */
export function unpackLines(j: Pick<FontJob, 'nums' | 'texts' | 'lens' | 'rtl'>): Use[][] {
  const out: Use[][] = []; let at = 0, k = 0, tp = 0;
  for (let li = 0; li < j.rtl.length; li++) {
    const n = j.nums[at++]; const l: Use[] = [];
    for (let i = 0; i < n; i++) {
      const len = j.lens[k++]; const text = j.texts.slice(tp, tp + len); tp += len;
      const span = j.nums[at + 5];
      l.push([j.nums[at], text, j.nums[at + 1], j.nums[at + 2], j.nums[at + 3], j.nums[at + 4], Number.isNaN(span) ? undefined : span]); at += 6;
    }
    out.push(j.rtl[li] === 2 ? l : Object.assign(l, { rtl: j.rtl[li] === 1 }));
  }
  return out;
}
