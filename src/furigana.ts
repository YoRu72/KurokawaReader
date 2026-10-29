// Furigana for ordinary Japanese books: readings come from the kuromoji
// morphological analyser and its IPADIC dictionary (~6 MB), fetched once from a
// CDN when the reader first asks for them and kept by the browser cache.
// Paragraphs are annotated lazily as they scroll into view; a setting hides or
// shows the readings instantly (the ruby stays in the DOM).

const KUROMOJI_JS = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/build/kuromoji.js';
const KUROMOJI_DICT = 'https://cdn.jsdelivr.net/npm/kuromoji@0.1.2/dict/';

interface Token { surface_form: string; reading?: string; word_type: string }
interface Tokenizer { tokenize(text: string): Token[] }
interface KuromojiGlobal { builder(o: { dicPath: string }): { build(cb: (err: Error | null, tk: Tokenizer) => void): void } }

let tokenizerPromise: Promise<Tokenizer> | null = null;
export function furiganaReady(): boolean { return !!tokenizerPromise; }

/** Loads the analyser + dictionary (once). Rejects offline. */
export function ensureTokenizer(onStatus?: (s: string) => void): Promise<Tokenizer> {
  tokenizerPromise ??= (async () => {
    onStatus?.('script');
    await new Promise<void>((res, rej) => {
      if ((window as unknown as { kuromoji?: unknown }).kuromoji) { res(); return; }
      const sc = document.createElement('script'); sc.src = KUROMOJI_JS; sc.onload = () => res(); sc.onerror = () => rej(new Error('kuromoji script')); document.head.appendChild(sc);
    });
    onStatus?.('dict');
    const k = (window as unknown as { kuromoji: KuromojiGlobal }).kuromoji;
    return new Promise<Tokenizer>((res, rej) => k.builder({ dicPath: KUROMOJI_DICT }).build((err, tk) => (err ? rej(err) : res(tk))));
  })();
  tokenizerPromise.catch(() => { tokenizerPromise = null; });
  return tokenizerPromise;
}

const KANJI = /[㐀-鿿豈-﫿々]/;
const kataToHira = (s: string) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

/** Looks like Japanese: kana present, or kanji without Chinese-only punctuation. */
export function isJapanese(text: string, lang?: string): boolean {
  if (lang && /^ja/i.test(lang)) return true;
  if (lang && /^zh/i.test(lang)) return false;
  return /[぀-ヿ]/.test(text);
}

/** Wrap the kanji of a token in <ruby>, each run of kanji with its own reading: the kana between and around
 *  them (okurigana: 取り扱い → 取[と]り扱[あつか]い) stay outside, matched against the reading; a token the
 *  reading cannot be split along is given one reading over its kanji part, as before. */
function rubyFor(surface: string, readingKata: string): Node {
  const reading = kataToHira(readingKata);
  if (!KANJI.test(surface) || !reading || reading === kataToHira(surface)) return document.createTextNode(surface);
  // The token in runs: kanji, and the rest (kana, signs).
  const runs = surface.match(new RegExp(`${KANJI.source}+|[^${KANJI.source.slice(1, -1)}]+`, 'g')) ?? [surface];
  if (runs.length > 1) {
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`^${runs.map((r) => (KANJI.test(r) ? '(.+?)' : `(${esc(kataToHira(r))})`)).join('')}$`);
    const m = re.exec(reading);
    if (m) {
      const frag = document.createDocumentFragment();
      runs.forEach((r, i) => {
        if (!KANJI.test(r)) { frag.appendChild(document.createTextNode(r)); return; }
        const ruby = document.createElement('ruby'); ruby.appendChild(document.createTextNode(r));
        const rt = document.createElement('rt'); rt.textContent = m[i + 1]; ruby.appendChild(rt);
        frag.appendChild(ruby);
      });
      return frag;
    }
  }
  // common trailing kana (okurigana) and leading kana stay outside the ruby
  let head = 0; while (head < surface.length && !KANJI.test(surface[head]) && reading[head] === kataToHira(surface[head])) head++;
  let tail = 0; while (tail < surface.length - head && !KANJI.test(surface[surface.length - 1 - tail]) && reading[reading.length - 1 - tail] === kataToHira(surface[surface.length - 1 - tail])) tail++;
  const base = surface.slice(head, surface.length - tail);
  const rt = reading.slice(head, reading.length - tail);
  if (!base || !rt) return document.createTextNode(surface);
  const frag = document.createDocumentFragment();
  if (head) frag.appendChild(document.createTextNode(surface.slice(0, head)));
  const ruby = document.createElement('ruby');
  ruby.appendChild(document.createTextNode(base));
  const rtEl = document.createElement('rt'); rtEl.textContent = rt; ruby.appendChild(rtEl);
  frag.appendChild(ruby);
  if (tail) frag.appendChild(document.createTextNode(surface.slice(surface.length - tail)));
  return frag;
}

/** Annotate every kanji-bearing text node under `root` that is not already inside <ruby>. */
export function annotate(root: HTMLElement, tk: Tokenizer): void {
  if (root.dataset.furi) return;
  root.dataset.furi = '1';
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (KANJI.test(n.textContent ?? '') && !(n.parentElement?.closest('ruby, rt, rp, code, pre')) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT) });
  const nodes: Text[] = []; let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);
  for (const node of nodes) {
    const text = node.textContent ?? '';
    const frag = document.createDocumentFragment();
    for (const tok of tk.tokenize(text)) frag.appendChild(tok.reading ? rubyFor(tok.surface_form, tok.reading) : document.createTextNode(tok.surface_form));
    node.replaceWith(frag);
  }
}

/** Annotates blocks as they come into view; returns a disposer. */
export function attachFurigana(scroll: HTMLElement, blocks: () => HTMLElement[], onError?: (e: Error) => void): () => void {
  let tk: Tokenizer | null = null; let disposed = false;
  const io = new IntersectionObserver((entries) => { if (!tk) return; for (const e of entries) if (e.isIntersecting) { annotate(e.target as HTMLElement, tk); io.unobserve(e.target); } }, { root: scroll, rootMargin: '120% 0px' });
  ensureTokenizer().then((t) => { if (disposed) return; tk = t; blocks().forEach((b) => { if (!b.dataset.furi) io.observe(b); }); }).catch((e) => onError?.(e as Error));
  const refresh = () => { if (tk) blocks().forEach((b) => { if (!b.dataset.furi) io.observe(b); }); };
  return Object.assign(() => { disposed = true; io.disconnect(); }, { refresh });
}
