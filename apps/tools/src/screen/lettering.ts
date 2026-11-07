// What a translated block is and how it is lettered (the screen translator, and the comic reader after it): the
// reader's glossary kept through any translator, the kind of each block told apart — a balloon's words, a thought, a
// box, a sound effect, a sign —, and the font chosen for that kind. The phone's floating translator does the same in
// Java (KtLettering.java); the rules here and there are the same.
import type { GlossaryEntry, ScreenConfig, TextKind } from './config';

/** The glossary's entries for this target language (one for «any» language counts too), the longest first. */
export function glossaryFor(c: ScreenConfig): GlossaryEntry[] {
  if (!c.glossary?.on) return [];
  return c.glossary.entries.filter((e) => e.from.trim() && (e.to.trim() || e.kind) && (!e.lang || e.lang === c.target)).sort((a, b) => b.from.length - a.from.length);
}
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const LATIN = /^[\p{Script=Latin}\p{N}\s'’.-]+$/u;
/** A term's pattern: whole words for Latin-script terms (so «Ken» is not found in «Kenji»), anywhere for others. */
const patternOf = (from: string) => new RegExp(LATIN.test(from) ? `(?<![\\p{L}\\p{N}])${esc(from.trim())}(?![\\p{L}\\p{N}])` : esc(from.trim()), 'giu');

/**
 * The texts with each glossary term put out of the translator's reach: replaced by a marker the translators keep as
 * it is ([[1]]), turned back into the reader's own translation by `restore`. Terms with no translation (only a kind)
 * are left in place.
 */
export function protect(texts: string[], g: GlossaryEntry[]): { texts: string[]; used: Map<number, string> } {
  const used = new Map<number, string>(); if (!g.length) return { texts, used };
  const out = texts.map((tx) => { let s = tx; g.forEach((e, i) => { if (!e.to.trim()) return; s = s.replace(patternOf(e.from), () => { used.set(i, e.to.trim()); return `[[${i}]]`; }); }); return s; });
  return { texts: out, used };
}
/** The markers back as the reader's translations (the spaces a translator put inside or around them forgiven). */
export function restore(texts: string[], used: Map<number, string>): string[] {
  if (!used.size) return texts;
  return texts.map((s) => s.replace(/\[\s*\[\s*(\d+)\s*\]\s*\]/g, (m, n) => used.get(Number(n)) ?? m));
}
/** The glossary as an AI model is told it (a model keeps terms better when told than when masked). */
export function glossaryPrompt(g: GlossaryEntry[]): string {
  const rows = g.filter((e) => e.to.trim()).slice(0, 200).map((e) => `${e.from.trim()} → ${e.to.trim()}`);
  return rows.length ? `\n\nGlossary — always translate these terms exactly this way:\n${rows.join('\n')}` : '';
}

export interface BlockLook { text: string; height: number; bg?: { r: number; g: number; b: number } | null }
/**
 * The kind of each block, from the glossary (a term with a kind decides) or from how it looks: in parentheses, a
 * thought; a few letters far taller than the page's other lines, with no balloon behind them, a sound effect; on a dark
 * or coloured ground, a box (narration, captions); else a balloon's words.
 */
export function kindsOf(blocks: BlockLook[], g: GlossaryEntry[]): TextKind[] {
  const hs = blocks.map((b) => b.height).filter((x) => x > 0).sort((a, b) => a - b); const median = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  return blocks.map((b) => {
    for (const e of g) if (e.kind && patternOf(e.from).test(b.text)) return e.kind as TextKind;
    const s = b.text.trim();
    if (/^[(（〔［[].*[)）〕］\]]$/su.test(s)) return 'thought';
    const letters = [...s].filter((ch) => /\p{L}/u.test(ch)).length;
    const light = !b.bg || lum(b.bg) > 0.82 && sat(b.bg) < 0.18;
    if (letters > 0 && letters <= 6 && median > 0 && b.height > median * 1.7 && (!b.bg || !light)) return 'sfx';
    if (b.bg && (lum(b.bg) < 0.55 || sat(b.bg) > 0.25)) return 'box';
    return 'dialogue';
  });
}
const lum = (c: { r: number; g: number; b: number }) => (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
const sat = (c: { r: number; g: number; b: number }) => { const mx = Math.max(c.r, c.g, c.b), mn = Math.min(c.r, c.g, c.b); return mx ? (mx - mn) / mx : 0; };

/** The font chosen for a kind (its own, else the default one), as the file it is in; '' for the system's. */
export function fontFor(c: ScreenConfig, kind: TextKind): string {
  const id = (c.letter?.kinds !== false ? c.letter?.fonts?.[kind] : '') || c.letter?.fonts?.default || '';
  return c.letter?.lib?.find((f) => f.id === id)?.path ?? '';
}

/** The reader's font files loaded into the page (once each), as the family names to letter with. */
const loaded = new Map<string, Promise<string>>();
export function fontFamily(path: string): Promise<string> {
  if (!path) return Promise.resolve('');
  let p = loaded.get(path);
  if (!p) {
    p = (async () => {
      const { readLocal } = await import('../player/files'); const b = await readLocal(path); if (!b) return '';
      const fam = `kt-letter-${loaded.size}`; const f = new FontFace(fam, b.slice().buffer as ArrayBuffer); await f.load(); document.fonts.add(f); return fam;
    })().catch(() => '');
    loaded.set(path, p);
  }
  return p;
}


/** Terms pasted one a line — «original = translation», «original → translation» or a tab between —, a kind in
 *  brackets after it if wanted («Boom = بوم [sfx]»). */
export function parseTerms(text: string, lang: string): GlossaryEntry[] {
  const kinds = new Set<string>(['dialogue', 'thought', 'box', 'sfx', 'sign']); const out: GlossaryEntry[] = [];
  for (const raw of text.split(/\r?\n/)) { const m = /^(.+?)\s*(?:=|→|->|\t)\s*(.*?)\s*(?:\[(\w+)\])?\s*$/.exec(raw.trim()); if (!m || !m[1].trim()) continue; const kind = m[3] && kinds.has(m[3]) ? (m[3] as TextKind) : ''; if (!m[2].trim() && !kind) continue; out.push({ from: m[1].trim(), to: m[2].trim(), kind, lang }); }
  return out;
}
