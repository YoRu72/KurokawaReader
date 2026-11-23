// TranslateGemma (Google's translation models built on Gemma 3; Ollama: translategemma:4b / :12b / :27b).
// It answers only to its own prompt: ONE user message, no system message. Pure functions, no imports.

/** Whether a model's name is a TranslateGemma. */
export const isTranslateGemma = (name: string): boolean => /translategemma/i.test(name);

/** The model's name from the list, TranslateGemma first (the recommendation for translation). */
export const pickTranslationModel = (names: string[]): string => names.find(isTranslateGemma) ?? '';

/** English names of the languages the app translates into or from (code → name); the rest by Intl. */
const NAMES: Record<string, string> = { ar: 'Arabic', en: 'English', fr: 'French', tr: 'Turkish', ur: 'Urdu', fa: 'Persian', de: 'German', es: 'Spanish', id: 'Indonesian', ja: 'Japanese', ko: 'Korean', 'zh-CN': 'Chinese', zh: 'Chinese', ru: 'Russian' };
export function gemmaLang(code: string): { name: string; code: string } {
  let name = NAMES[code] ?? '';
  if (!name) { try { name = new Intl.DisplayNames(['en'], { type: 'language' }).of(code) ?? code; } catch { name = code; } }
  return { name, code: code === 'zh-CN' ? 'zh' : code };
}

/** The source language when it is «auto»: read from the script of the text itself (kana → Japanese, Hangul →
 *  Korean, Han → Chinese, Arabic letters → Arabic, Cyrillic → Russian), else English. */
export function detectSource(text: string): string {
  if (/[぀-ヿ]/.test(text)) return 'ja';
  if (/[가-힯]/.test(text)) return 'ko';
  if (/[一-鿿]/.test(text)) return 'zh';
  if (/[؀-ۿ]/.test(text)) return 'ar';
  if (/[Ѐ-ӿ]/.test(text)) return 'ru';
  return 'en';
}

/** The one user message TranslateGemma is given (two blank lines before the text). */
export function translateGemmaPrompt(text: string, source: string, target: string): string {
  const s = gemmaLang(!source || source === 'auto' ? detectSource(text) : source), t = gemmaLang(target);
  return `You are a professional ${s.name} (${s.code}) to ${t.name} (${t.code}) translator. Your goal is to accurately convey the meaning and nuances of the original ${s.name} text while adhering to ${t.name} grammar, vocabulary, and cultural sensitivities.\nProduce only the ${t.name} translation, without any additional explanations or commentary. Please translate the following ${s.name} text into ${t.name}:\n\n\n${text}`;
}

/** The request body for a translation (an OpenAI-style chat: one user message, no system message). */
export function translateGemmaBody(model: string, text: string, source: string, target: string): { model: string; temperature: number; stream: false; messages: { role: 'user'; content: string }[] } {
  return { model, temperature: 0.2, stream: false, messages: [{ role: 'user', content: translateGemmaPrompt(text, source, target) }] };
}

/** On-device models, in the order offered. A computer: Gemma 2 2B (a step up), then Gemma 3 1B, then the rest; the
 *  first is the one recommended for translation. A phone: no Gemma is put forward and Gemma 3 1B is not offered
 *  (the list as it is, nothing recommended). */
export function deviceOrder<T extends { id: string }>(list: T[], phone: boolean): T[] {
  if (phone) return list.filter((m) => m.id !== 'gemma-3-1b');
  const first = ['gemma-2-2b', 'gemma-3-1b'];
  const at = (id: string) => { const i = first.indexOf(id); return i < 0 ? first.length : i; };
  return list.map((m, i) => ({ m, i })).sort((a, b) => at(a.m.id) - at(b.m.id) || a.i - b.i).map((x) => x.m);
}
/** The on-device model recommended for translation: on a computer only. */
export const recommendedDevice = (phone: boolean): string => (phone ? '' : 'gemma-2-2b');
