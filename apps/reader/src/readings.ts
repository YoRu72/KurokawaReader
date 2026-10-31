// Readings for CJK text: furigana for Japanese (kuromoji, see furigana.ts) and
// pinyin for Chinese (pinyin-pro, fetched once from a CDN and kept by the service
// worker). Used by the selection toolbar ("Reading") and the auto-reading option.
import { ensureTokenizer, annotate, isJapanese } from './furigana';

const PINYIN_JS = 'https://cdn.jsdelivr.net/npm/pinyin-pro@3.26.0/dist/index.js';
interface PinyinPro { pinyin(text: string, o: { type: 'array'; toneType?: 'symbol' | 'num' | 'none'; nonZh?: 'consecutive' | 'removed' | 'spaced' }): string[] }

let pinyinPromise: Promise<PinyinPro> | null = null;
export function ensurePinyin(): Promise<PinyinPro> {
  pinyinPromise ??= new Promise<PinyinPro>((res, rej) => {
    const w = window as unknown as { pinyinPro?: PinyinPro };
    if (w.pinyinPro) { res(w.pinyinPro); return; }
    const sc = document.createElement('script'); sc.src = PINYIN_JS;
    sc.onload = () => (w.pinyinPro ? res(w.pinyinPro) : rej(new Error('pinyin-pro')));
    sc.onerror = () => rej(new Error('pinyin-pro script')); document.head.appendChild(sc);
  });
  pinyinPromise.catch(() => { pinyinPromise = null; });
  return pinyinPromise;
}

const HAN = /[㐀-鿿豈-﫿]/;
export const hasHan = (s: string) => HAN.test(s);
export const hasKana = (s: string) => /[぀-ヿ]/.test(s);

/** Which reading system fits this text: kana present → furigana; Han only → pinyin (unless the book says Japanese). */
export function readingKind(text: string, lang?: string): 'furigana' | 'pinyin' | null {
  if (hasKana(text) || (lang && /^ja/i.test(lang) && hasHan(text))) return 'furigana';
  if (hasHan(text)) return isJapanese(text, lang) && hasKana(text) ? 'furigana' : 'pinyin';
  return null;
}

/** Wrap every Han character of the text nodes under `root` in <ruby> with its pinyin. */
export async function annotatePinyin(root: HTMLElement): Promise<void> {
  if (root.dataset.pinyin) return;
  const py = await ensurePinyin();
  root.dataset.pinyin = '1';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (HAN.test(n.textContent ?? '') && !n.parentElement?.closest('ruby, rt, rp, code, pre') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const nodes: Text[] = []; let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.textContent ?? '';
    // One reading per Han character, in order (everything else removed), so a word's context still decides heteronyms.
    const readings = py.pinyin(text, { type: 'array', toneType: 'symbol', nonZh: 'removed' });
    const frag = document.createDocumentFragment();
    let ri = 0; let buf = '';
    for (const ch of text) {
      if (HAN.test(ch)) {
        if (buf) { frag.appendChild(document.createTextNode(buf)); buf = ''; }
        const ruby = document.createElement('ruby'); ruby.appendChild(document.createTextNode(ch));
        const rt = document.createElement('rt'); rt.textContent = readings[ri++] ?? ''; ruby.appendChild(rt);
        frag.appendChild(ruby);
      } else buf += ch;
    }
    if (buf) frag.appendChild(document.createTextNode(buf));
    node.replaceWith(frag);
  }
}

/** Add readings (furigana or pinyin) to a block, picking the system from its text. */
export async function annotateReadings(block: HTMLElement, lang?: string): Promise<'furigana' | 'pinyin' | null> {
  const kind = readingKind(block.textContent ?? '', lang);
  if (kind === 'furigana') { annotate(block, await ensureTokenizer()); return kind; }
  if (kind === 'pinyin') { await annotatePinyin(block); return kind; }
  return null;
}

/** Readings for a plain string (used for the selection popover). Returns HTML with <ruby>. */
export async function readingsHtml(text: string, lang?: string): Promise<string | null> {
  const kind = readingKind(text, lang);
  if (!kind) return null;
  const div = document.createElement('div'); div.textContent = text;
  await annotateReadings(div, lang);
  return div.innerHTML;
}

/** Pinyin for a Chinese book: blocks are annotated as they come into view; returns a disposer with refresh(). */
export function attachPinyin(scroll: HTMLElement, blocks: () => HTMLElement[], onError?: (e: Error) => void): (() => void) & { refresh?: () => void } {
  let ready = false; let disposed = false;
  const io = new IntersectionObserver((entries) => { if (!ready) return; for (const e of entries) if (e.isIntersecting) { void annotatePinyin(e.target as HTMLElement); io.unobserve(e.target); } }, { root: scroll, rootMargin: '120% 0px' });
  ensurePinyin().then(() => { if (disposed) return; ready = true; blocks().forEach((b) => { if (!b.dataset.pinyin) io.observe(b); }); }).catch((e) => onError?.(e as Error));
  const refresh = () => { if (ready) blocks().forEach((b) => { if (!b.dataset.pinyin) io.observe(b); }); };
  return Object.assign(() => { disposed = true; io.disconnect(); }, { refresh });
}
