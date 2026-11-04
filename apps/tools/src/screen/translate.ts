// The translators of the app's own pages (the player's subtitles, the computer's screen translator), the same as
// the phone's floating translator (KtTranslate.java): Google Translate (no key), DeepL (the user's key), or an AI
// model (OpenAI-style, Anthropic, Gemini). Requests go through the app's own connection (request), so no site
// refuses a page. What was translated is remembered for the session.
import { request } from '../http';
import { AI_PRESETS, type ScreenConfig } from './config';

const cache = new Map<string, string>();
const hasLetters = (s: string): boolean => /\p{L}/u.test(s);
const idOf = (c: ScreenConfig): string => `${c.engine}|${c.source}|${c.target}|${c.engine === 'ai' ? `${c.ai.preset}${c.ai.base}${c.ai.model}${c.ai.prompt.length}` : ''}`;

/** The translations of `texts`, in order; lines without letters come back as they are. */
export async function translateTexts(texts: string[], c: ScreenConfig): Promise<string[]> {
  const out = texts.slice(); const ask: string[] = []; const id = idOf(c);
  for (const tx of texts) if (hasLetters(tx) && !cache.has(`${id}\u0000${tx}`) && !ask.includes(tx)) ask.push(tx);
  if (ask.length) {
    const got = c.engine === 'deepl' ? await deepl(ask, c) : c.engine === 'ai' ? await ai(ask, c) : c.engine === 'microsoft' ? await keyless(ask, c, 'microsoft') : await keyless(ask, c, 'google');
    ask.forEach((tx, i) => cache.set(`${id}\u0000${tx}`, got[i] ?? tx));
    if (cache.size > 6000) for (const k of [...cache.keys()].slice(0, 2000)) cache.delete(k);
  }
  texts.forEach((tx, i) => { if (hasLetters(tx)) out[i] = cache.get(`${id}\u0000${tx}`) ?? tx; });
  return out;
}

async function send(url: string, method: string, headers: Record<string, string>, body?: string): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await request(url, { method, headers, body });
    if ((r.status === 429 || r.status >= 500) && attempt < 3) { await new Promise((ok) => setTimeout(ok, 800 * 2 ** attempt)); continue; }
    if (r.status >= 300) throw new Error(`HTTP ${r.status}: ${r.body.slice(0, 160)}`);
    return r.body;
  }
}
/* ---------- the keyless engines: Google and Microsoft, each the other's stand-in ---------- */
// (Google refused — too many requests, a check — falls back to Microsoft for the batch, and the other way round;
// which one last answered is asked first for the next minute.)
let keylessDown: Record<string, number> = {};
async function keyless(texts: string[], c: ScreenConfig, want: 'google' | 'microsoft'): Promise<string[]> {
  const order: ('google' | 'microsoft')[] = want === 'google' ? ['google', 'microsoft'] : ['microsoft', 'google'];
  const now = Date.now(); const live = order.filter((e) => (keylessDown[e] ?? 0) < now); const tryOrder = live.length ? [...live, ...order.filter((e) => !live.includes(e))] : order;
  let last: unknown = null;
  for (const e of tryOrder) {
    try { return e === 'google' ? await google(texts, c) : await microsoft(texts, c); }
    catch (err) { last = err; keylessDown[e] = Date.now() + 60000; }
  }
  throw last instanceof Error ? last : new Error(String(last));
}
const gCode = (l: string): string => (!l ? 'auto' : l === 'zh' ? 'zh-CN' : l === 'he' ? 'iw' : l);
/** Google Translate (the free address its own pages use): many lines in one request, each on its own line, the
 *  answer's lines matched back; a batch whose lines came back in another number is asked line by line. */
async function google(texts: string[], c: ScreenConfig): Promise<string[]> {
  const url = (q: string) => `https://translate.googleapis.com/translate_a/single?client=gtx&dt=t&sl=${encodeURIComponent(gCode(c.source))}&tl=${encodeURIComponent(gCode(c.target))}&q=${encodeURIComponent(q)}`;
  const one = async (tx: string): Promise<string> => { const j = JSON.parse(await send(url(tx), 'GET', {})) as [[string, string][]]; return (j?.[0] ?? []).map((x) => x?.[0] ?? '').join(''); };
  // (Batches of up to 40 lines or 3000 characters, the lines joined with newlines Google keeps; a line of the batch
  // with a newline of its own is asked alone.)
  const out: string[] = new Array(texts.length); const batches: number[][] = []; let cur: number[] = []; let size = 0;
  for (let i = 0; i < texts.length; i++) { const tx = texts[i]; if (tx.includes('\n') || tx.length > 1500) { batches.push([i]); continue; } if (cur.length >= 40 || size + tx.length > 3000) { if (cur.length) batches.push(cur); cur = []; size = 0; } cur.push(i); size += tx.length + 1; }
  if (cur.length) batches.push(cur);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, batches.length) }, async () => {
    for (let b = next++; b < batches.length; b = next++) {
      const idx = batches[b];
      if (idx.length === 1) { out[idx[0]] = await one(texts[idx[0]]); continue; }
      const joined = idx.map((i) => texts[i]).join('\n');
      let lines: string[] | null = null;
      try { const j = JSON.parse(await send(url(joined), 'GET', {})) as [[string, string][]]; const whole = (j?.[0] ?? []).map((x) => x?.[0] ?? '').join(''); const got = whole.split('\n'); if (got.length === idx.length) lines = got; } catch { /* line by line */ }
      if (lines) idx.forEach((i, k) => { out[i] = lines![k].trim(); });
      else for (const i of idx) out[i] = await one(texts[i]);
    }
  }));
  return out;
}
/** Microsoft Translator by the token Edge's own translator takes (no key): up to 100 lines in one request. */
let msToken: { v: string; at: number } | null = null;
const mCode = (l: string): string => (!l || l === 'auto' ? '' : l === 'zh' || l === 'zh-CN' ? 'zh-Hans' : l === 'zh-TW' ? 'zh-Hant' : l === 'iw' ? 'he' : l === 'pt' ? 'pt' : l === 'sr' ? 'sr-Cyrl' : l);
async function microsoft(texts: string[], c: ScreenConfig): Promise<string[]> {
  if (!msToken || Date.now() - msToken.at > 8 * 60000) msToken = { v: (await send('https://edge.microsoft.com/translate/auth', 'GET', {})).trim(), at: Date.now() };
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 100) {
    const part = texts.slice(i, i + 100);
    const from = mCode(c.source);
    const j = JSON.parse(await send(`https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&to=${encodeURIComponent(mCode(c.target) || 'en')}${from ? `&from=${encodeURIComponent(from)}` : ''}`, 'POST', { Authorization: `Bearer ${msToken.v}`, 'Content-Type': 'application/json' }, JSON.stringify(part.map((Text) => ({ Text }))))) as { translations?: { text: string }[] }[];
    if (!Array.isArray(j) || j.length !== part.length) throw new Error('Microsoft');
    out.push(...j.map((x) => x.translations?.[0]?.text ?? ''));
  }
  return out;
}
const dCode = (l: string, target: boolean): string => { const u = l.toUpperCase(); if (!target) return u.replace(/-.*/, ''); return u === 'EN' ? 'EN-US' : u === 'PT' ? 'PT-BR' : u === 'ZH' || u === 'ZH-CN' ? 'ZH-HANS' : u === 'ZH-TW' ? 'ZH-HANT' : u; };
async function deepl(texts: string[], c: ScreenConfig): Promise<string[]> {
  const key = c.deeplKey.trim(); if (!key) throw new Error('deeplKey');
  const base = key.endsWith(':fx') ? 'https://api-free.deepl.com' : 'https://api.deepl.com'; const out: string[] = [];
  for (let i = 0; i < texts.length; i += 50) {
    const part = texts.slice(i, i + 50);
    const j = JSON.parse(await send(`${base}/v2/translate`, 'POST', { Authorization: `DeepL-Auth-Key ${key}`, 'Content-Type': 'application/json' }, JSON.stringify({ text: part, target_lang: dCode(c.target, true), ...(c.source && c.source !== 'auto' ? { source_lang: dCode(c.source, false) } : {}) }))) as { translations?: { text: string }[] };
    if (j.translations?.length !== part.length) throw new Error('DeepL');
    out.push(...j.translations.map((x) => x.text));
  }
  return out;
}
const RULES = 'You get a JSON array of strings; return ONLY a JSON array with exactly as many strings, each the translation of the string at the same place, in the same order. Keep numbers, names and symbols; do not merge, split, explain or add anything.';
export function parseArray(raw: string, n: number): string[] | null {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''); const a = s.indexOf('['), b = s.lastIndexOf(']'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  try { const v = JSON.parse(s) as unknown; if (Array.isArray(v) && v.length === n) return v.map((x) => String(x ?? '')); } catch { /* not JSON */ }
  return n === 1 ? [raw.trim()] : null;
}
async function ai(texts: string[], c: ScreenConfig): Promise<string[]> {
  const p = AI_PRESETS.find((x) => x.id === c.ai.preset) ?? AI_PRESETS[0];
  const style = c.ai.preset === 'custom' ? c.ai.style : p.style; const base = (c.ai.base.trim() || p.base).replace(/\/+$/, ''); const model = c.ai.model.trim() || p.model; const key = c.ai.key.trim();
  const system = `${c.ai.prompt.trim() || `Translate into the language whose code is «${c.target}»: natural, accurate and idiomatic, faithful to the meaning and tone.`}\n\n${RULES} Target language: ${c.target}.`;
  const once = async (part: string[]): Promise<string[]> => {
    const user = JSON.stringify(part); let reply = '';
    if (style === 'gemini') {
      const j = JSON.parse(await send(`${base}/models/${encodeURIComponent(model)}:generateContent${key ? `?key=${encodeURIComponent(key)}` : ''}`, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }))) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
      reply = j.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') ?? '';
    } else if (style === 'anthropic') {
      const j = JSON.parse(await send(`${base}/messages`, 'POST', { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, JSON.stringify({ model, max_tokens: 8192, temperature: 0.2, system, messages: [{ role: 'user', content: user }] }))) as { content?: { type: string; text?: string }[] };
      reply = j.content?.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('') ?? '';
    } else {
      const j = JSON.parse(await send(`${base}/chat/completions`, 'POST', { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, JSON.stringify({ model, temperature: 0.2, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }))) as { choices?: { message?: { content?: string } }[] };
      reply = j.choices?.[0]?.message?.content ?? '';
    }
    const arr = parseArray(reply, part.length);
    if (arr) return arr;
    if (part.length === 1) throw new Error('bad translation format');
    const h = Math.floor(part.length / 2); return [...await once(part.slice(0, h)), ...await once(part.slice(h))];
  };
  const out: string[] = [];
  for (let i = 0; i < texts.length; i += 40) out.push(...await once(texts.slice(i, i + 40)));
  return out;
}

/** A picture read and translated by an AI model that sees (Gemini, OpenAI-style, Claude): its lines, where they are
 *  (fractions of the picture), and their translations — for text no OCR on this computer reads. */
export async function aiVision(dataUrl: string, c: ScreenConfig): Promise<{ text: string; tr: string; x: number; y: number; w: number; h: number }[]> {
  const p = AI_PRESETS.find((x) => x.id === c.ai.preset) ?? AI_PRESETS[0];
  const style = c.ai.preset === 'custom' ? c.ai.style : p.style; const base = (c.ai.base.trim() || p.base).replace(/\/+$/, ''); const model = c.ai.model.trim() || p.model; const key = c.ai.key.trim();
  const [, mime, b64] = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl) ?? ['', 'image/png', ''];
  const ask = `Find every line of text in this picture of a screen. Return ONLY a JSON array of objects {"text": the line as written, "tr": its translation into the language whose code is «${c.target}», "box": [x, y, width, height] in thousandths of the picture's width and height}. ${c.ai.prompt.trim() ? `Translate as instructed: ${c.ai.prompt.trim()}` : 'Translate naturally and faithfully.'}`;
  let reply = '';
  if (style === 'gemini') {
    const j = JSON.parse(await send(`${base}/models/${encodeURIComponent(model)}:generateContent${key ? `?key=${encodeURIComponent(key)}` : ''}`, 'POST', { 'Content-Type': 'application/json' }, JSON.stringify({ contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data: b64 } }, { text: ask }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json' } }))) as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
    reply = j.candidates?.[0]?.content?.parts?.map((x) => x.text ?? '').join('') ?? '';
  } else if (style === 'anthropic') {
    const j = JSON.parse(await send(`${base}/messages`, 'POST', { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, JSON.stringify({ model, max_tokens: 8192, temperature: 0.1, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data: b64 } }, { type: 'text', text: ask }] }] }))) as { content?: { type: string; text?: string }[] };
    reply = j.content?.filter((x) => x.type === 'text').map((x) => x.text ?? '').join('') ?? '';
  } else {
    const j = JSON.parse(await send(`${base}/chat/completions`, 'POST', { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, JSON.stringify({ model, temperature: 0.1, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: dataUrl } }, { type: 'text', text: ask }] }] }))) as { choices?: { message?: { content?: string } }[] };
    reply = j.choices?.[0]?.message?.content ?? '';
  }
  let s = reply.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''); const a = s.indexOf('['), b = s.lastIndexOf(']'); if (a >= 0 && b > a) s = s.slice(a, b + 1);
  const arr = JSON.parse(s) as { text?: string; tr?: string; box?: number[] }[];
  return arr.filter((x) => x && x.text && Array.isArray(x.box) && x.box.length === 4).map((x) => ({ text: String(x.text), tr: String(x.tr ?? x.text), x: x.box![0] / 1000, y: x.box![1] / 1000, w: x.box![2] / 1000, h: x.box![3] / 1000 }));
}
