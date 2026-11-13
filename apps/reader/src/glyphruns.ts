// The glyph runs the PDF → Word converter keeps of a document's embedded fonts (see UseStore in pdf2docx.ts), in
// a compact form: a module of its own, so that a lane (pdf2docx.lane.ts) has it before it loads the converter.
import type { GlyphUse } from './fontfix';

/**
 * The glyph runs of a UseStore, kept compact: a book of a thousand pages has some 800,000 glyph uses, and kept
 * as [font, use] pairs of arrays (their numbers boxed one by one) they were 140 MB of the app's memory until the
 * fonts were built. Here each use is a font number, its six numbers in one array of numbers, and its text (each
 * text kept once); a run is read back as the pairs it was given (at), equal to them in every value.
 */
export class GlyphRuns {
  private readonly names: string[] = []; private readonly ids = new Map<string, number>();
  private readonly start: number[] = [0]; private readonly rtls: (boolean | undefined)[] = [];
  private readonly font: number[] = []; private readonly num: number[] = []; private readonly text: string[] = [];
  private readonly texts = new Map<string, string>();
  // (A use whose values are not all what a use holds — numbers, a text, seven of them — is kept as it is.)
  private odd: Map<number, GlyphUse> | null = null;
  /** How many runs. */
  get length(): number { return this.rtls.length; }
  push(seq: readonly [string, GlyphUse][], rtl: boolean | undefined): void {
    for (const [f, u] of seq) {
      let id = this.ids.get(f); if (id === undefined) { id = this.names.length; this.names.push(f); this.ids.set(f, id); }
      const k = this.font.length; this.font.push(id);
      const ok = u.length === 7 && typeof u[1] === 'string' && typeof u[0] === 'number' && typeof u[2] === 'number' && typeof u[3] === 'number' && typeof u[4] === 'number' && typeof u[5] === 'number' && typeof u[6] === 'number';
      if (!ok) { (this.odd ??= new Map()).set(k, u); this.num.push(0, 0, 0, 0, 0, 0); this.text.push(''); continue; }
      this.num.push(u[0], u[2], u[3], u[4], u[5], u[6]!);
      let t = this.texts.get(u[1]); if (t === undefined) { t = u[1]; this.texts.set(t, t); } this.text.push(t);
    }
    this.start.push(this.font.length); this.rtls.push(rtl);
  }
  /** Run `si` as it was given: its [font, use] pairs, and whether it is right to left. */
  at(si: number): [string, GlyphUse][] & { rtl?: boolean } {
    const out: [string, GlyphUse][] = [];
    for (let k = this.start[si], e = this.start[si + 1]; k < e; k++) {
      const o = this.odd?.get(k);
      const n = this.num; const j = k * 6;
      out.push([this.names[this.font[k]], o ?? [n[j], this.text[k], n[j + 1], n[j + 2], n[j + 3], n[j + 4], n[j + 5]]]);
    }
    return Object.assign(out, { rtl: this.rtls[si] });
  }
  /** The fonts of run `si`'s uses, in order. */
  fontsAt(si: number): string[] { const out: string[] = []; for (let k = this.start[si], e = this.start[si + 1]; k < e; k++) out.push(this.names[this.font[k]]); return out; }
}
