// AI providers for chapter translation and read-aloud: Gemini, OpenAI and
// OpenAI-compatible endpoints (OpenRouter, local servers), Anthropic.
// Keys live in the visual settings (localStorage) and are excluded from backups.
import { getSettings } from './settings';

export type AiProvider = 'gemini' | 'openai' | 'anthropic' | 'openrouter' | 'custom';

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
  { id: 'gemini', label: 'Google Gemini', model: 'gemini-2.5-flash', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openai', label: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic Claude', model: 'claude-haiku-4-5', baseUrl: 'https://api.anthropic.com/v1', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter', model: 'google/gemini-2.5-flash', baseUrl: 'https://openrouter.ai/api/v1', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'custom', label: 'OpenAI-compatible (custom URL)', model: 'gpt-4o-mini', baseUrl: 'http://localhost:11434/v1', keyUrl: '' },
];

export function providerInfo(id: AiProvider = getSettings().aiProvider) { return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0]; }
export function aiReady(): boolean { const s = getSettings(); return !!s.aiKey || s.aiProvider === 'custom'; }
export function effectiveModel(): string { return getSettings().aiModel.trim() || providerInfo().model; }
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
export function translationKey(text: string): string {
  const s = getSettings();
  return hash(`${s.aiProvider}|${effectiveModel()}|${s.aiTask}|${s.aiTarget}|${effectivePrompt()}|${text}`);
}
export function hash(str: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) { const c = str.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2654435761); }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
}

const FORMAT = 'You will receive a JSON array of strings (paragraphs). Return ONLY a JSON array of strings of exactly the same length, where item i is the translation of item i. Keep line breaks inside an item. No prose, no code fences.';

async function chat(system: string, user: string, json = true): Promise<string> {
  const s = getSettings();
  const key = s.aiKey.trim();
  const model = effectiveModel();
  const base = effectiveBaseUrl();
  const ctl = new AbortController();
  const timeout = setTimeout(() => ctl.abort(), 90000);
  try {
    if (s.aiProvider === 'gemini') {
      const r = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.2, ...(json ? { responseMimeType: 'application/json' } : {}) } }),
      });
      if (!r.ok) throw new Error(`Gemini ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      return j.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    }
    if (s.aiProvider === 'anthropic') {
      const r = await fetch(`${base}/messages`, {
        method: 'POST', signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
        body: JSON.stringify({ model, max_tokens: 8192, temperature: 0.2, system, messages: [{ role: 'user', content: user }] }),
      });
      if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
      const j = await r.json() as { content?: { type: string; text?: string }[] };
      return j.content?.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('') ?? '';
    }
    // OpenAI and compatible
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (key) headers.authorization = `Bearer ${key}`;
    if (s.aiProvider === 'openrouter') { headers['HTTP-Referer'] = 'https://github.com/YoRu72/KurokawaReader'; headers['X-Title'] = 'KurokawaReader'; }
    const r = await fetch(`${base}/chat/completions`, {
      method: 'POST', headers, signal: ctl.signal,
      body: JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!r.ok) throw new Error(`${providerInfo().label} ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json() as { choices?: { message?: { content?: string } }[] };
    return j.choices?.[0]?.message?.content ?? '';
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

/** Translate several paragraphs in one request. */
export async function translateBatch(texts: string[]): Promise<string[]> {
  if (!texts.length) return [];
  const system = `${effectivePrompt()}\n\n${FORMAT}`;
  const raw = await chat(system, JSON.stringify(texts));
  return parseArray(raw, texts.length);
}

export async function translateOne(text: string): Promise<string> { return (await translateBatch([text]))[0]; }

/* ---------- Read-aloud through an AI voice ---------- */

export const AI_VOICES: Record<string, string[]> = {
  gemini: ['Kore', 'Puck', 'Zephyr', 'Charon', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'],
  openai: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'],
};
export function aiTtsSupported(): boolean { const p = getSettings().aiProvider; return p === 'gemini' || p === 'openai' || p === 'custom' || p === 'openrouter'; }

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
