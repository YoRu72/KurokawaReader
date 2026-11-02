// AI providers for chapter translation and read-aloud: Gemini, OpenAI and
// OpenAI-compatible endpoints (OpenRouter, local servers), Anthropic.
// Keys live in the visual settings (localStorage) and are excluded from backups.
import { REPO } from './repo';
import { termsIn, glossaryPrompt, applyGlossary, glossaryStamp, glossaryStampOf } from './glossary';
import { getSettings } from './settings';
import { t } from './i18n';

export type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'opencode' | 'custom' | 'local';
/** How a service is spoken to: OpenAI's chat completions (most services and local servers), Anthropic's
 *  messages, or Gemini's generateContent. */
export type ApiStyle = 'openai' | 'anthropic' | 'gemini';
export interface CustomApi { id: string; name: string; style: ApiStyle; base: string; key: string; model: string; headers?: string; service?: string; priceIn?: number; priceOut?: number; context?: number; free?: boolean }
/** Tokens used, by model: in all and today (requests, tokens in and out) — what the services count and bill. */
export type Usage = { req: number; in: number; out: number; day: string; dReq: number; dIn: number; dOut: number };
const today = () => new Date().toISOString().slice(0, 10);
export function usageOf(model: string): Usage { try { const u = (JSON.parse(localStorage.getItem('kr.aiUsage') ?? '{}') as Record<string, Usage>)[model]; if (!u) return { req: 0, in: 0, out: 0, day: today(), dReq: 0, dIn: 0, dOut: 0 }; return u.day === today() ? u : { ...u, day: today(), dReq: 0, dIn: 0, dOut: 0 }; } catch { return { req: 0, in: 0, out: 0, day: today(), dReq: 0, dIn: 0, dOut: 0 }; } }
function noteUsage(model: string, tin: number, tout: number): void {
  try { const all = JSON.parse(localStorage.getItem('kr.aiUsage') ?? '{}') as Record<string, Usage>; const u = usageOf(model); all[model] = { req: u.req + 1, in: u.in + tin, out: u.out + tout, day: today(), dReq: u.dReq + 1, dIn: u.dIn + tin, dOut: u.dOut + tout }; localStorage.setItem('kr.aiUsage', JSON.stringify(all)); } catch { /* full */ }
}

export const DEFAULT_PROMPT_AR = 'ترجم النصّ ترجمةً سليمةً صحيحةً غير حرفية إلى العربية الفصيحة، ملتزمًا قواعد النحو والصرف كما قرّرها ابن مالك في ألفيته: صحّة الإعراب، وسلامة التراكيب، وحسن اختيار اللفظ، مع الحفاظ على المعنى والنبرة. لا تشرح ولا تعلّق؛ أخرج الترجمة وحدها.';
export const DEFAULT_PROMPT_EN = 'Translate the text into natural, accurate, idiomatic {lang}. Preserve meaning and tone; do not explain or comment — output only the translation.';
/** Default instructions written in the target language itself. */
export const DEFAULT_PROMPTS: Record<string, string> = {
  ar: DEFAULT_PROMPT_AR,
  en: 'Translate the text into natural, accurate, idiomatic English — faithful to the meaning and tone, never word-for-word. Do not explain or comment; output only the translation.',
  fr: 'Traduisez le texte en un français naturel, exact et idiomatique — fidèle au sens et au ton, jamais mot à mot. N\'expliquez rien, ne commentez pas ; ne renvoyez que la traduction.',
  tr: 'Metni doğal, doğru ve deyimsel bir Türkçeye çevir — anlama ve tona sadık kal, kelimesi kelimesine çevirme. Açıklama ve yorum ekleme; yalnızca çeviriyi ver.',
  ur: 'متن کا فطری، درست اور بامحاورہ اردو میں ترجمہ کیجیے — معنی اور لہجے کے وفادار رہتے ہوئے، لفظ بہ لفظ نہیں۔ کوئی وضاحت یا تبصرہ نہ کیجیے؛ صرف ترجمہ دیجیے۔',
  fa: 'متن را به فارسی روان، دقیق و اصطلاحی ترجمه کن — وفادار به معنا و لحن، نه واژه‌به‌واژه. توضیح و تفسیر نده؛ فقط ترجمه را بنویس.',
  de: 'Übersetze den Text in natürliches, genaues, idiomatisches Deutsch – sinn- und tongetreu, nie Wort für Wort. Keine Erklärungen oder Kommentare; gib nur die Übersetzung aus.',
  es: 'Traduce el texto a un español natural, preciso e idiomático, fiel al sentido y al tono, nunca palabra por palabra. No expliques ni comentes; devuelve solo la traducción.',
  id: 'Terjemahkan teks ke dalam bahasa Indonesia yang alami, akurat, dan idiomatis — setia pada makna dan nada, bukan kata per kata. Jangan menjelaskan atau berkomentar; keluarkan terjemahannya saja.',
  ja: 'テキストを自然で正確、かつ慣用的な日本語に翻訳してください。意味と語調を忠実に保ち、逐語訳は避けること。説明や注釈は付けず、訳文のみを出力してください。',
  'zh-CN': '请将文本翻译成自然、准确、地道的中文，忠于原意与语气，切勿逐字直译。不要解释或评论，只输出译文。',
  ru: 'Переведите текст на естественный, точный и идиоматичный русский язык — верно передавая смысл и тон, не дословно. Без пояснений и комментариев; выведите только перевод.',
};
export const FURIGANA_PROMPT = 'You annotate Japanese text with furigana. Return the SAME text with every kanji word wrapped as <ruby>漢字<rt>かんじ</rt></ruby> (hiragana readings, one ruby per word or compound). Keep all other characters, punctuation and line breaks exactly; do not translate, explain or add anything.';

export const PROVIDERS: { id: AiProvider; label: string; model: string; baseUrl: string; keyUrl: string }[] = [
  { id: 'gemini', label: 'Google Gemini', model: 'gemini-3.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openai', label: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic Claude', model: 'claude-haiku-4-5', baseUrl: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter', model: 'google/gemini-3.5-flash', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'opencode', label: 'OpenCode Zen', model: '', baseUrl: 'https://opencode.ai/zen/v1', keyUrl: 'https://opencode.ai/zen' },
  { id: 'custom', label: 'Custom API', model: 'gpt-4o-mini', baseUrl: 'http://localhost:11434/v1', keyUrl: '' },
  { id: 'local', label: 'Local model (on this device or your computer)', model: '', baseUrl: '', keyUrl: '' },
];

export function providerInfo(id: AiProvider = getSettings().aiProvider) { return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]; }
export function aiReady(): boolean { const s = getSettings(); if (s.aiProvider === 'local') return localReadyCached(); const c = conn(); return s.aiProvider === 'custom' ? !!c.base && !!c.model : !!c.key; }
/** The custom APIs set up (several may be kept; one is in use). */
export const customApis = (): CustomApi[] => getSettings().aiCustomApis ?? [];
export const activeCustom = (): CustomApi | undefined => { const l = customApis(); return l.find((x) => x.id === getSettings().aiCustomId) ?? l[0]; };
/** What the requests go to now: the way of speaking, the address, the key, the model, extra headers. */
export function conn(): { style: ApiStyle; base: string; key: string; model: string; headers: Record<string, string>; label: string; viaApp: boolean } {
  const s = getSettings();
  if (trying || s.aiProvider === 'custom') {
    const c = trying ?? activeCustom();
    if (c) { let hd: Record<string, string> = {}; try { hd = c.headers?.trim() ? JSON.parse(c.headers) as Record<string, string> : {}; } catch { /* bad JSON: none */ } return { style: c.style, base: c.base.trim().replace(/\/+$/, ''), key: c.key.trim(), model: c.model.trim(), headers: hd, label: c.name || 'Custom API', viaApp: true }; }
    return { style: 'openai', base: (s.aiBaseUrl.trim() || providerInfo().baseUrl).replace(/\/+$/, ''), key: s.aiKey.trim(), model: s.aiModel.trim() || 'gpt-4o-mini', headers: {}, label: 'Custom API', viaApp: true };
  }
  const style: ApiStyle = s.aiProvider === 'gemini' ? 'gemini' : s.aiProvider === 'anthropic' ? 'anthropic' : 'openai';
  const headers: Record<string, string> = s.aiProvider === 'openrouter' ? { 'HTTP-Referer': `https://github.com/${REPO}`, 'X-Title': 'KurokawaReader' } : {};
  return { style, base: effectiveBaseUrl(), key: s.aiKey.trim(), model: s.aiModel.trim() || providerInfo().model, headers, label: providerInfo().label, viaApp: s.aiProvider === 'opencode' };
}
type Sent = { ok: boolean; status: number; text: string; retryAfter?: string | null };
/** A request to the service: straight from the page, or — for services that do not allow pages to call them
 *  (OpenCode, many custom ones) — through the app's own connection when there is one. */
async function send(url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }, viaApp: boolean): Promise<Sent> {
  const native = (window as unknown as { kurokawaDesktop?: { http?: unknown }; Capacitor?: { isNativePlatform?(): boolean } });
  if (viaApp && (native.kurokawaDesktop?.http || native.Capacitor?.isNativePlatform?.())) {
    const { localHttp } = await import('./localai'); const r = await localHttp(url, { method: init.method, headers: init.headers, body: init.body, timeoutMs: 90000 });
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: r.body };
  }
  const r = await fetch(url, { method: init.method, headers: init.headers, body: init.body, signal: init.signal });
  return { ok: r.ok, status: r.status, text: await r.text(), retryAfter: r.headers.get('retry-after') };
}
export function effectiveModel(): string {
  const s = getSettings();
  if (s.aiProvider === 'local') return s.localEngine === 'server' ? s.localServerModel || 'local' : s.localModel || 'local';
  if (s.aiProvider === 'custom') return conn().model || 'custom';
  return s.aiModel.trim() || providerInfo().model;
}
// (Whether a local model is set up, read without loading the local engine's module.)
function localReadyCached(): boolean {
  const s = getSettings();
  if (s.localEngine === 'server') return !!s.localServer;
  try { return !!s.localModel && (JSON.parse(localStorage.getItem('kr.localModels') ?? '[]') as { id: string }[]).some((m) => m.id === s.localModel); } catch { return false; }
}
export function effectiveBaseUrl(): string { return (getSettings().aiBaseUrl.trim() || providerInfo().baseUrl).replace(/\/+$/, ''); }
export function effectivePrompt(): string {
  const s = getSettings();
  if (s.aiTask === 'furigana') return FURIGANA_PROMPT;
  const p = s.aiPrompt.trim();
  if (p) return p;
  return defaultPrompt(s.aiTarget);
}
export function defaultPrompt(target: string): string { return DEFAULT_PROMPTS[target] ?? DEFAULT_PROMPT_EN.replace('{lang}', langName(target)); }
export function langName(code: string): string {
  const names: Record<string, string> = { ar: 'Arabic', en: 'English', fr: 'French', tr: 'Turkish', ur: 'Urdu', fa: 'Persian', de: 'German', es: 'Spanish', id: 'Indonesian', ja: 'Japanese', 'zh-CN': 'Chinese', ru: 'Russian' };
  return names[code] ?? code;
}

/** A stable key for caching: text + everything that changes the output. */
/** The key a paragraph's translation is kept under: what made it (provider, model, task, language, instructions)
 *  and the glossary terms the paragraph itself holds — a name added to the glossary makes again only the
 *  paragraphs it is in, not the whole book. */
export function translationKey(text: string, bookId?: string): string {
  const s = getSettings();
  const stamp = s.aiTask === 'furigana' ? '' : glossaryStampOf(termsIn([text.replace(/<[^>]+>/g, '')], bookId));
  return hash(`${s.aiProvider}|${effectiveModel()}|${s.aiTask}|${s.aiTarget}|${effectivePrompt()}|${stamp}|${text}`);
}
/** The key as it was before (the whole glossary's mark): translations kept then are still found. */
export function legacyTranslationKey(text: string): string {
  const s = getSettings();
  return hash(`${s.aiProvider}|${effectiveModel()}|${s.aiTask}|${s.aiTarget}|${effectivePrompt()}|${s.aiTask === 'furigana' ? '' : glossaryStamp()}|${text}`);
}
export function hash(str: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2654435761); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const FORMAT = 'You will receive a JSON array of strings (paragraphs). Return ONLY a JSON array of strings of exactly the same length, where item i is the translation of item i. Keep line breaks inside an item. No prose, no code fences.';

/** The pace the provider allows: requests spaced so that no more than its per-minute limit go out (learnt from
 *  its own answer — Gemini's free tier names it: 10 or 15 a minute for its Flash models), shared by every request
 *  of the app (translating, translating ahead, names for the glossary). */
const pace = { gap: 0, nextAt: 0, until: 0 };
const waiters = new Set<(seconds: number) => void>();
/** Told when requests wait for the provider's per-minute limit (the seconds left), and 0 when they go on. */
export function onAiWait(fn: (seconds: number) => void): () => void { waiters.add(fn); return () => waiters.delete(fn); }
const tellWait = (sec: number) => waiters.forEach((f) => { try { f(sec); } catch { /* one listener */ } });
async function paced(): Promise<void> {
  const now = Date.now(); const at = Math.max(now, pace.nextAt, pace.until); pace.nextAt = at + pace.gap;
  if (at - now > 400) { tellWait(Math.ceil((at - now) / 1000)); await new Promise((r) => setTimeout(r, at - now)); tellWait(0); }
}
/** The day's quota used up (not the minute's): nothing to wait for today. */
export class QuotaError extends Error { constructor(msg: string) { super(msg); this.name = 'QuotaError'; } }
/** A provider's «too many requests», read: how long it says to wait, the limit it names, and whether it is the
 *  minute's (wait and go on) or the day's (stop). Gemini puts these in its JSON (RetryInfo, QuotaFailure). */
function readLimit(body: string, header?: string | null): { wait?: number; perMinute?: number; daily: boolean } {
  let wait = Number(header) || undefined; let perMinute: number | undefined; let daily = false;
  try {
    const j = JSON.parse(body) as { error?: { details?: { '@type'?: string; retryDelay?: string; violations?: { quotaId?: string; quotaValue?: string }[] }[] } };
    for (const d of j.error?.details ?? []) {
      if (d.retryDelay) { const m = /([\d.]+)s/.exec(d.retryDelay); if (m) wait = Number(m[1]); }
      for (const v of d.violations ?? []) { const id = v.quotaId ?? ''; if (/PerDay/i.test(id)) daily = true; else if (/PerMinute/i.test(id) && Number(v.quotaValue)) perMinute = Math.min(perMinute ?? Infinity, Number(v.quotaValue)); }
    }
  } catch { /* not JSON */ }
  return { wait, perMinute, daily };
}
/** A busy or limited provider (429, 5xx) is waited for and asked again — as long as it says to wait, up to six
 *  times — and from then on requests are spaced to its per-minute limit; the day's quota used up stops at once;
 *  anything else fails at once. */
async function chat(system: string, user: string, json = true): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    await paced();
    try { return await chatOnce(system, user, json); }
    catch (e) {
      const st = (e as { status?: number }).status ?? Number(/\b(429|500|502|503|504|529)\b/.exec(String((e as Error)?.message ?? ''))?.[1] ?? 0);
      if (!st || ![429, 500, 502, 503, 504, 529].includes(st)) throw e;
      const lim = (e as { limit?: ReturnType<typeof readLimit> }).limit ?? { daily: false };
      if (lim.daily) throw new QuotaError(t('aiDailyQuota'));
      if (st === 429) { const rpm = lim.perMinute ?? 10; pace.gap = Math.max(pace.gap, Math.ceil(60000 / rpm * 1.05)); }
      if (attempt >= 6) throw st === 429 ? Object.assign(new Error(t('aiRateLimited')), { status: 429 }) : e;
      const waitMs = Math.min(65000, lim.wait ? lim.wait * 1000 + 500 : 2000 * 2 ** Math.min(attempt, 4));
      pace.until = Math.max(pace.until, Date.now() + waitMs);
    }
  }
}
const failure = (who: string, r: Sent) => Object.assign(new Error(`${who} ${r.status}: ${r.text.slice(0, 200)}`), { status: r.status, limit: readLimit(r.text, r.retryAfter) });
async function chatOnce(system: string, user: string, json = true): Promise<string> {
  const s = getSettings();
  if (s.aiProvider === 'local' && !trying) {
    const L = await import('./localai');
    return s.localEngine === 'server' ? L.serverChat(system, user, json) : L.deviceChat(system, user);
  }
  const c = conn(); const { key, model, base } = c;
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 90000);
  try {
    if (c.style === 'gemini') {
      const r = await send(`${base}/models/${encodeURIComponent(model)}:generateContent${key ? `?key=${encodeURIComponent(key)}` : ''}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...c.headers }, signal: ctl.signal,
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: 'application/json' } : {}) } }),
      }, c.viaApp);
      if (!r.ok) throw failure(c.label, r);
      const j = JSON.parse(r.text) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      noteUsage(model, j.usageMetadata?.promptTokenCount ?? 0, j.usageMetadata?.candidatesTokenCount ?? 0);
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    }
    if (c.style === 'anthropic') {
      const r = await send(`${base}/messages`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, ...(s.aiProvider === 'custom' && key ? { authorization: `Bearer ${key}` } : {}), 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...c.headers },
        body: JSON.stringify({ model, max_tokens: 8192, temperature: 0.2, system, messages: [{ role: 'user', content: user }] }),
      }, c.viaApp);
      if (!r.ok) throw failure(c.label, r);
      const j = JSON.parse(r.text) as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      noteUsage(model, j.usage?.input_tokens ?? 0, j.usage?.output_tokens ?? 0);
      return j.content?.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('') ?? '';
    }
    // OpenAI and compatible (OpenRouter, OpenCode, local servers, most custom APIs)
    const headers: Record<string, string> = { 'content-type': 'application/json', ...c.headers };
    if (key) headers.authorization = `Bearer ${key}`;
    const r = await send(`${base}/chat/completions`, {
      method: 'POST', headers, signal: ctl.signal,
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    }, c.viaApp);
    if (!r.ok) throw failure(c.label, r);
    const j = JSON.parse(r.text) as { choices?: { message?: { content?: string | { text?: string }[] } }[]; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    noteUsage(model, j.usage?.prompt_tokens ?? 0, j.usage?.completion_tokens ?? 0);
    const content = j.choices?.[0]?.message?.content;
    return Array.isArray(content) ? content.map((x) => x.text ?? '').join('') : content ?? '';
  } finally { clearTimeout(timeout); }
}

function parseArray(raw: string, n: number): string[] {
  let txt = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const a = txt.indexOf('['), b = txt.lastIndexOf(']');
  if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  try {
    const arr = JSON.parse(txt) as unknown;
    if (Array.isArray(arr) && arr.length === n) return arr.map((x) => String(x ?? ''));
    if (Array.isArray(arr) && n === 1) return [arr.map((x) => String(x ?? '')).join('\n')];
  } catch { /* fall through */ }
  if (n === 1) return [raw.trim()];
  throw new Error('bad translation format');
}

/** What surrounds a passage, given to the model so a name, a tone or a pronoun carries on from one batch to the
 *  next: the book, the chapter, and the paragraphs just before (not to be translated). */
export interface TrContext { book?: string; chapter?: string; before?: string[] }
const STYLE = 'Some items hold inline tags <i>, <b>, <em>, <strong>, <u>, <sup>, <sub>: keep each tag around the words that render the tagged words, and add no other tags.';
function contextLines(c?: TrContext): string {
  if (!c) return '';
  const lines = [c.book ? `Book: ${c.book}` : '', c.chapter ? `Chapter: ${c.chapter}` : '', c.before?.length ? `The text just before (for continuity only — do not translate it, do not include it):\n${c.before.map((x) => `> ${x.slice(0, 600)}`).join('\n')}` : ''].filter(Boolean);
  return lines.length ? `Context:\n${lines.join('\n')}` : '';
}

/** Translate several paragraphs in one request. A reply that does not hold one translation per paragraph is
 *  asked for again in halves (down to single paragraphs), so one bad answer costs a batch's half, not all of it. */
export async function translateBatch(texts: string[], bookId?: string, ctx?: TrContext): Promise<string[]> {
  if (!texts.length) return [];
  const s = getSettings();
  // (The reader's glossary: the terms these paragraphs hold, given with them, and put right after.)
  const gl = s.aiTask === 'furigana' ? [] : termsIn(texts, bookId);
  const styled = s.aiTask !== 'furigana' && texts.some((x) => /<(i|b|em|strong|u|sup|sub)>/.test(x));
  const prompt = [effectivePrompt(), glossaryPrompt(gl), styled ? STYLE : '', s.aiContext !== false && s.aiTask !== 'furigana' ? contextLines(ctx) : ''].filter(Boolean).join('\n\n');
  const fix = (out: string[]) => (gl.length ? out.map((x) => applyGlossary(x, gl)) : out);
  // A small model on the device does better with one paragraph at a time and plain text back.
  if (s.aiProvider === 'local' && s.localEngine === 'device') {
    const out: string[] = [];
    for (const t of texts) out.push(t.trim() ? (await chat(prompt, t, false)).replace(/^["“«]|["”»]$/g, '').trim() : t);
    return fix(out);
  }
  const system = `${prompt}\n\n${FORMAT}`;
  const ask = async (part: string[]): Promise<string[]> => {
    const raw = await chat(system, JSON.stringify(part));
    try { return parseArray(raw, part.length); }
    catch (e) {
      if (part.length === 1) throw e;
      const mid = Math.ceil(part.length / 2);
      return [...await ask(part.slice(0, mid)), ...await ask(part.slice(mid))];
    }
  };
  return fix(await ask(texts));
}

/** Names and terms a passage holds (people, places, sects, techniques, titles), each with a rendering in the
 *  target language — offered to the reader for the book's glossary. */
export async function suggestTerms(texts: string[], known: string[]): Promise<{ from: string; to: string; kind?: string }[]> {
  const s = getSettings(); const lang = langName(s.aiTarget);
  const system = `You build a translation glossary. From the text, list the proper names and recurring special terms (people, places, organisations, sects, techniques, titles, invented words) — at most 40, the most frequent first — each with its rendering in ${lang} as a careful translator would fix it for the whole book (transliterate names; translate meaningful titles). Skip these, already in the glossary: ${JSON.stringify(known.slice(0, 200))}. Return ONLY a JSON array of objects {"from": original, "to": rendering, "kind": "person|place|group|term"}. No prose.`;
  const raw = await chat(system, texts.join('\n\n').slice(0, 24000));
  let txt = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''); const a = txt.indexOf('['), b = txt.lastIndexOf(']'); if (a >= 0 && b > a) txt = txt.slice(a, b + 1);
  const arr = JSON.parse(txt) as { from?: string; to?: string; kind?: string }[];
  const seen = new Set(known.map((x) => x.toLowerCase()));
  return arr.filter((x) => x && typeof x.from === 'string' && typeof x.to === 'string' && x.from.trim() && x.to.trim() && !seen.has(x.from.trim().toLowerCase())).map((x) => ({ from: x.from!.trim(), to: x.to!.trim(), kind: x.kind }));
}

export async function translateOne(text: string): Promise<string> { return (await translateBatch([text]))[0]; }

/** The provider's model list for the current key (text-generation models, newest-looking first). */
export async function listModels(): Promise<string[]> {
  const c = conn(); const { key, base } = c;
  const ctl = new AbortController(); const timeout = setTimeout(() => ctl.abort(), 20000);
  try {
    let names: string[] = [];
    if (c.style === 'gemini') {
      const r = await send(`${base}/models?pageSize=200${key ? `&key=${encodeURIComponent(key)}` : ''}`, { method: 'GET', headers: { ...c.headers }, signal: ctl.signal }, c.viaApp);
      if (!r.ok) throw new Error(`${c.label} ${r.status}: ${r.text.slice(0, 200)}`);
      const j = JSON.parse(r.text) as { models?: { name: string; supportedGenerationMethods?: string[] }[] };
      names = (j.models ?? []).filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => m.name.replace(/^models\//, ''));
    } else if (c.style === 'anthropic') {
      const r = await send(`${base}/models?limit=100`, { method: 'GET', signal: ctl.signal, headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true', ...c.headers } }, c.viaApp);
      if (!r.ok) throw new Error(`${c.label} ${r.status}: ${r.text.slice(0, 200)}`);
      names = ((JSON.parse(r.text) as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
    } else {
      const headers: Record<string, string> = { ...c.headers }; if (key) headers.authorization = `Bearer ${key}`;
      const r = await send(`${base}/models`, { method: 'GET', signal: ctl.signal, headers }, c.viaApp);
      if (!r.ok) throw new Error(`${c.label} ${r.status}: ${r.text.slice(0, 200)}`);
      names = ((JSON.parse(r.text) as { data?: { id: string }[] }).data ?? []).map((m) => m.id);
    }
    // Chat models first; embeddings, audio, image and vision-only models are noise here.
    const noise = /embed|tts|whisper|audio|image|imagen|veo|vision-only|moderation|realtime|transcribe|dall-e|aqa/i;
    return [...new Set(names)].filter((n) => !noise.test(n)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } finally { clearTimeout(timeout); }
}

/* ---------- Read-aloud through an AI voice ---------- */

export const AI_VOICES: Record<string, string[]> = {
  gemini: ['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'],
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'],
};
export function aiTtsSupported(): boolean { const s = getSettings(); const p = s.aiProvider; return p === 'gemini' || p === 'openai' || p === 'custom' || p === 'openrouter' || (p === 'local' && s.localEngine === 'server'); }

function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bits = 16): Blob {
  const header = new ArrayBuffer(44); const v = new DataView(header);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
  v.setUint16(22, channels, true); v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * channels * bits / 8, true); v.setUint16(32, channels * bits / 8, true); v.setUint16(34, bits, true);
  w(36, 'data'); v.setUint32(40, pcm.length, true);
  return new Blob([header, pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) as ArrayBuffer], { type: 'audio/wav' });
}

/** Synthesise speech for one passage; returns an audio blob. */
export async function aiSpeak(text: string): Promise<Blob> {
  const s = getSettings();
  if (s.aiProvider === 'local') return (await import('./localai')).serverSpeak(text, s.aiVoice.trim());
  const key = s.aiKey.trim();
  const base = effectiveBaseUrl();
  const voice = s.aiVoice.trim();
  if (s.aiProvider === 'gemini') {
    const model = s.aiTtsModel.trim() || 'gemini-2.5-flash-preview-tts';
    const r = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice || 'Kore' } } } } }),
    });
    if (!r.ok) throw new Error(`Gemini TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json() as { candidates?: { content?: { parts?: { inlineData?: { data: string; mimeType: string } }[] } }[] };
    const part = j.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (!part?.inlineData) throw new Error('no audio');
    const bin = atob(part.inlineData.data); const bytes = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType)?.[1] ?? 24000);
    return part.inlineData.mimeType.includes('pcm') || part.inlineData.mimeType.includes('L16') ? pcmToWav(bytes, rate) : new Blob([bytes], { type: part.inlineData.mimeType });
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  const r = await fetch(`${base}/audio/speech`, { method: 'POST', headers, body: JSON.stringify({ model: s.aiTtsModel.trim() || 'gpt-4o-mini-tts', voice: voice || 'alloy', input: text, response_format: 'mp3' }) });
  if (!r.ok) throw new Error(`TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.blob();
}

/** A request through a custom API to see that it answers: how long it took, or why it did not (nothing saved). */
let trying: CustomApi | null = null;
export async function testApi(c: CustomApi): Promise<{ ok: boolean; ms: number; why?: string }> {
  const t0 = performance.now(); trying = c;
  try { const out = await chatOnce('Reply with the single word OK.', 'OK?', false); return { ok: !!out.trim(), ms: performance.now() - t0 }; }
  catch (e) { return { ok: false, ms: performance.now() - t0, why: String((e as Error).message ?? e) }; }
  finally { trying = null; }
}
/** A GET through the app's own connection where there is one (services that do not allow pages to call them). */
export async function appGet(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }> { const r = await send(url, { method: 'GET', headers }, true); return { status: r.status, body: r.text }; }
