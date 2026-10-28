// KittenTTS on the device: a small English voice (KittenML/KittenTTS, Apache-2.0 — 15 to 80 million parameters,
// 25 to 80 MB) run by ONNX Runtime in WebAssembly, with nothing sent anywhere. Fetched once when the reader
// asks for it and kept in the app's cache, like the on-device language models (localai.ts); the two runtimes it
// needs (onnxruntime-web, and espeak-ng as WebAssembly through the phonemizer package) are fetched from the CDN
// the same way. English only — a passage in another script goes to the device's own voice.
//
// The model is a StyleTTS2-like network: text → espeak IPA phonemes (en-us, with stress) → symbol ids;
// a style vector per voice (voices.npz, a row per text length); a speed; out comes 24 kHz audio.
import { getSettings, updateSettings } from './settings';

export type KittenModel = { id: string; name: string; repo: string; sizeMB: number; note: string };
export const KITTEN_MODELS: KittenModel[] = [
  { id: 'nano-int8', name: 'Nano (int8)', repo: 'KittenML/kitten-tts-nano-0.8-int8', sizeMB: 25, note: 'smallest' },
  { id: 'nano', name: 'Nano', repo: 'KittenML/kitten-tts-nano-0.8-fp32', sizeMB: 56, note: 'small, cleaner' },
  { id: 'micro', name: 'Micro', repo: 'KittenML/kitten-tts-micro-0.8', sizeMB: 41, note: 'balanced' },
  { id: 'mini', name: 'Mini', repo: 'KittenML/kitten-tts-mini-0.8', sizeMB: 80, note: 'best' },
];
/** The repository's config.json: which files are the network and the voices, the voices' friendly names, a
 *  speed each voice is meant for. */
type KittenConfig = { model_file: string; voices: string; voice_aliases?: Record<string, string>; speed_priors?: Record<string, number> };
async function configOf(m: KittenModel, onProgress?: Progress): Promise<KittenConfig> {
  const c = await (await fetchFile(m, 'config.json', onProgress)).json() as Partial<KittenConfig>;
  if (!c.model_file || !c.voices) throw new Error('kitten:config');
  return { model_file: c.model_file, voices: c.voices, voice_aliases: c.voice_aliases, speed_priors: c.speed_priors };
}
/** The voices, by their names in the app and their keys in the model's voices file. */
export const KITTEN_VOICES: { id: string; name: string; key: string }[] = [
  { id: 'bella', name: 'Bella', key: 'expr-voice-2-f' }, { id: 'jasper', name: 'Jasper', key: 'expr-voice-2-m' },
  { id: 'luna', name: 'Luna', key: 'expr-voice-3-f' }, { id: 'bruno', name: 'Bruno', key: 'expr-voice-3-m' },
  { id: 'rosie', name: 'Rosie', key: 'expr-voice-4-f' }, { id: 'hugo', name: 'Hugo', key: 'expr-voice-4-m' },
  { id: 'kiki', name: 'Kiki', key: 'expr-voice-5-f' }, { id: 'leo', name: 'Leo', key: 'expr-voice-5-m' },
];
// The files come from this app's own GitHub release first (a mirror made by .github/workflows/kittentts-models.yml,
// named `<repo>.<file>`), from Hugging Face when the mirror has not got them.
const MIRROR = 'https://github.com/YoRu72/KurokawaReader/releases/download/models-kittentts-0.8';
const HF = (m: KittenModel, file: string) => `https://huggingface.co/${m.repo}/resolve/main/${file}`;
const mirrorUrl = (m: KittenModel, file: string) => `${MIRROR}/${m.repo.split('/')[1]}.${file.split('/').pop()}`;
/** The file from the mirror, else from Hugging Face; kept in the cache under the Hugging Face address either way. */
async function fetchFile(m: KittenModel, file: string, onProgress?: Progress): Promise<Response> {
  const key = HF(m, file);
  const c = await caches.open(CACHE).catch(() => null);
  const hit = await c?.match(key); if (hit) return hit;
  try { return await cached(mirrorUrl(m, file), onProgress, key); }
  catch { return cached(key, onProgress, key); }
}
const ORT_VERSION = '1.20.1';
const ORT = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}`;
const PHONEMIZER = 'https://cdn.jsdelivr.net/npm/phonemizer@1.2.1/+esm';
const CACHE = 'kr-kitten-v1';
const SAMPLE_RATE = 24000;

export type Progress = (done: number, total: number) => void;

/* ---------------------------------------------------------------- what is on the device */
const IKEY = 'kr.kitten.installed';
export function installedKitten(): string[] { try { return JSON.parse(localStorage.getItem(IKEY) ?? '[]') as string[]; } catch { return []; } }
function setInstalled(list: string[]): void { try { localStorage.setItem(IKEY, JSON.stringify(list)); } catch { /* full */ } }
export function kittenSupported(): boolean { return typeof WebAssembly === 'object' && typeof caches !== 'undefined'; }
/** Ready to speak: a model on the device, and the one chosen in settings among them. */
export function kittenReady(): boolean { const id = getSettings().kittenModel; return !!id && installedKitten().includes(id); }

/** A file from the network, kept in the app's own cache (under `key` when given); progress as it comes. */
async function cached(url: string, onProgress?: Progress, key = url): Promise<Response> {
  const c = await caches.open(CACHE).catch(() => null);
  const hit = await c?.match(key); if (hit) return hit;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  if (!onProgress || !r.body) { if (c) await c.put(key, r.clone()); return r; }
  // (Read through, so the reader sees the download move.)
  const total = Number(r.headers.get('content-length') ?? 0); let got = 0;
  const reader = r.body.getReader(); const parts: Uint8Array[] = [];
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onProgress(got, total || got); }
  const blob = new Blob(parts as BlobPart[]);
  const res = new Response(blob, { headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'content-length': String(blob.size) } });
  if (c) await c.put(key, res.clone());
  return res;
}

/** Download a model (its network and its voices), kept on the device. */
export async function downloadKitten(id: string, onProgress: Progress): Promise<void> {
  const m = KITTEN_MODELS.find((x) => x.id === id); if (!m) throw new Error('model');
  const total = m.sizeMB * 1024 * 1024;
  const cfg = await configOf(m);
  await fetchFile(m, cfg.model_file, (done) => onProgress(Math.min(done, total * 0.98), total));
  await fetchFile(m, cfg.voices);
  // (The runtimes fetched now too, so the first word is not kept waiting for them.)
  await runtimes().catch(() => undefined);
  onProgress(total, total);
  if (!installedKitten().includes(id)) setInstalled([...installedKitten(), id]);
  if (!getSettings().kittenModel) updateSettings({ kittenModel: id });
}
export async function removeKitten(id: string): Promise<void> {
  const m = KITTEN_MODELS.find((x) => x.id === id); if (!m) return;
  const c = await caches.open(CACHE).catch(() => null);
  try { const cfg = await configOf(m); await c?.delete(HF(m, cfg.model_file)); await c?.delete(HF(m, cfg.voices)); } catch { /* never fetched */ }
  await c?.delete(HF(m, 'config.json'));
  setInstalled(installedKitten().filter((x) => x !== id));
  if (getSettings().kittenModel === id) updateSettings({ kittenModel: installedKitten()[0] ?? '' });
  if (loaded?.id === id) { await loaded.session.release?.(); loaded = null; }
}

/* ---------------------------------------------------------------- the runtimes */
type Ort = {
  env: { wasm: { wasmPaths?: string; numThreads?: number; proxy?: boolean } };
  InferenceSession: { create(data: Uint8Array, o?: Record<string, unknown>): Promise<Session> };
  Tensor: new (type: string, data: unknown, dims: number[]) => unknown;
};
type Session = { run(feeds: Record<string, unknown>): Promise<Record<string, { data: Float32Array }>>; outputNames: string[]; release?(): Promise<void> };
type Phonemizer = { phonemize(text: string, lang?: string): Promise<string[] | string> };
let rt: Promise<{ ort: Ort; ph: Phonemizer }> | null = null;
function runtimes(): Promise<{ ort: Ort; ph: Phonemizer }> {
  return (rt ??= (async () => {
    // (The modules by their CDN addresses — their WebAssembly sits beside them there; the browser's HTTP cache
    // keeps them, and the model files are what is big.)
    const ortMod = await import(/* @vite-ignore */ `${ORT}/dist/ort.min.mjs`).catch(() => import(/* @vite-ignore */ `${ORT}/+esm`)) as Ort & { default?: Ort };
    const ort = (ortMod.InferenceSession ? ortMod : ortMod.default) as Ort;
    ort.env.wasm.wasmPaths = `${ORT}/dist/`;
    ort.env.wasm.numThreads = Math.max(1, Math.min(4, (navigator.hardwareConcurrency ?? 2) - 1));
    const phMod = await import(/* @vite-ignore */ PHONEMIZER) as Phonemizer & { default?: Phonemizer };
    const ph = (typeof phMod.phonemize === 'function' ? phMod : phMod.default) as Phonemizer;
    if (typeof ph?.phonemize !== 'function') throw new Error('phonemizer');
    return { ort, ph };
  })().catch((e) => { rt = null; throw e; }));
}

/* ---------------------------------------------------------------- the voices file (NPZ) */
/** An .npz (a zip of .npy arrays) read to Float32 rows: name → [rows][256]. */
async function readVoices(bytes: Uint8Array): Promise<Map<string, Float32Array[]>> {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(bytes);
  const out = new Map<string, Float32Array[]>();
  for (const name of Object.keys(zip.files)) {
    if (!name.endsWith('.npy')) continue;
    const npy = await zip.files[name].async('uint8array');
    const parsed = readNpy(npy); if (!parsed) continue;
    const { shape, data } = parsed;
    const cols = shape.length >= 2 ? shape[shape.length - 1] : data.length; const rows = shape.length >= 2 ? data.length / cols : 1;
    const list: Float32Array[] = []; for (let r = 0; r < rows; r++) list.push(data.subarray(r * cols, (r + 1) * cols));
    out.set(name.replace(/\.npy$/, ''), list);
  }
  return out;
}
/** A .npy of little-endian float32 (or float64, read down) → its shape and data. */
function readNpy(b: Uint8Array): { shape: number[]; data: Float32Array } | null {
  if (b[0] !== 0x93 || String.fromCharCode(...b.subarray(1, 6)) !== 'NUMPY') return null;
  const major = b[6]; const hlen = major >= 2 ? new DataView(b.buffer, b.byteOffset + 8, 4).getUint32(0, true) : new DataView(b.buffer, b.byteOffset + 8, 2).getUint16(0, true);
  const start = (major >= 2 ? 12 : 10); const header = new TextDecoder('latin1').decode(b.subarray(start, start + hlen));
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] ?? '').split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => Number.isFinite(n));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1] ?? '<f4';
  const body = b.subarray(start + hlen);
  const n = shape.reduce((a, c) => a * c, 1) || 0;
  if (/f8$/.test(descr)) { const d = new Float64Array(body.buffer.slice(body.byteOffset, body.byteOffset + n * 8)); return { shape, data: Float32Array.from(d) }; }
  return { shape, data: new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + n * 4)) };
}

/* ---------------------------------------------------------------- tokens */
// The model's symbol table, as KittenTTS's TextCleaner has it: pad, punctuation, letters, IPA.
const SYMBOLS = ['$', ...";:,.!?¡¿—…\"«»\"\" ", ...'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', ..."ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘'̩'ᵻ"];
// (A symbol listed twice takes its last index, as Python's dict did when the table was built.)
const INDEX = new Map<string, number>(); SYMBOLS.forEach((sy, i) => INDEX.set(sy, i));
function tokensOf(phonemes: string): number[] {
  // (Words and punctuation marks apart, one space between: the way the model was trained.)
  const parts = phonemes.match(/[\p{L}\p{N}_]+|[^\p{L}\p{N}\s_]/gu) ?? [];   // (Python's \w+|[^\w\s])
  const ids: number[] = [];
  for (const ch of parts.join(' ')) { const i = INDEX.get(ch); if (i !== undefined) ids.push(i); }
  return [0, ...ids, 10, 0];
}

/* ---------------------------------------------------------------- speaking */
type Loaded = { id: string; session: Session; voices: Map<string, Float32Array[]>; cfg: KittenConfig };
let loaded: Loaded | null = null;
let loadingP: Promise<Loaded> | null = null;
async function model(id: string): Promise<Loaded> {
  if (loaded?.id === id) return loaded;
  if (loadingP) await loadingP.catch(() => undefined);
  if (loaded?.id === id) return loaded;
  loadingP = (async () => {
    const m = KITTEN_MODELS.find((x) => x.id === id); if (!m) throw new Error('model');
    const { ort } = await runtimes();
    const cfg = await configOf(m);
    const bytes = new Uint8Array(await (await fetchFile(m, cfg.model_file)).arrayBuffer());
    const voices = await readVoices(new Uint8Array(await (await fetchFile(m, cfg.voices)).arrayBuffer()));
    if (loaded) { await loaded.session.release?.(); loaded = null; }
    const session = await ort.InferenceSession.create(bytes, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
    loaded = { id, session, voices, cfg };
    return loaded;
  })().finally(() => { loadingP = null; });
  return loadingP;
}

/** Text in sentences short enough for one pass of the model. */
function chunks(text: string, max = 300): string[] {
  const out: string[] = []; let cur = '';
  for (const s of text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/)) {
    if (!s) continue;
    if (cur && cur.length + s.length + 1 > max) { out.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s;
    while (cur.length > max) { let cut = cur.lastIndexOf(' ', max); if (cut < max / 2) cut = max; out.push(cur.slice(0, cut)); cur = cur.slice(cut).trim(); }
  }
  if (cur) out.push(cur);
  return out;
}

/** The text spoken: 24 kHz mono samples. Throws when nothing is on the device. */
export async function kittenSamples(text: string, o: { voice?: string; speed?: number; model?: string } = {}): Promise<Float32Array> {
  const s = getSettings();
  const id = o.model ?? s.kittenModel; if (!id || !installedKitten().includes(id)) throw new Error('kitten:none');
  const { ort, ph } = await runtimes();
  const md = await model(id);
  const voice = KITTEN_VOICES.find((v) => v.id === (o.voice ?? s.kittenVoice)) ?? KITTEN_VOICES[7];
  // (The voice's key in the file: the repository's alias for its name when it has one, else the known key.)
  const key = md.cfg.voice_aliases?.[voice.name] ?? md.cfg.voice_aliases?.[voice.id] ?? voice.key;
  const rows = md.voices.get(key) ?? md.voices.get(voice.key) ?? md.voices.values().next().value as Float32Array[] | undefined;
  if (!rows?.length) throw new Error('kitten:voices');
  const speed = Math.max(0.5, Math.min(2, o.speed ?? s.kittenSpeed ?? 1)) * (md.cfg.speed_priors?.[key] ?? 1);
  const pieces: Float32Array[] = [];
  for (const part of chunks(text)) {
    const phon = await ph.phonemize(part, 'en-us');
    const ipa = Array.isArray(phon) ? phon.join(' ') : String(phon);
    const ids = tokensOf(ipa); if (ids.length <= 3) continue;
    const style = rows[Math.min(part.length, rows.length - 1)];
    const feeds = {
      input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map((n) => BigInt(n))), [1, ids.length]),
      style: new ort.Tensor('float32', style, [1, style.length]),
      speed: new ort.Tensor('float32', Float32Array.from([speed]), [1]),
    };
    const out = await md.session.run(feeds);
    const audio = out[md.session.outputNames[0]].data;
    // (The model's tail is silence with a click: cut, as KittenTTS cuts it.)
    pieces.push(audio.subarray(0, Math.max(0, audio.length - 5000)));
  }
  const total = pieces.reduce((a, p) => a + p.length, 0);
  const all = new Float32Array(total); let at = 0; for (const p of pieces) { all.set(p, at); at += p.length; }
  return all;
}

/** The text spoken, as a WAV file to play. */
export async function kittenSpeak(text: string, o: { voice?: string; speed?: number; model?: string } = {}): Promise<Blob> {
  return wavOf(await kittenSamples(text, o), SAMPLE_RATE);
}
/** Float samples as a 16-bit WAV. */
export function wavOf(samples: Float32Array, rate: number): Blob {
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true); str(36, 'data'); v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) { const x = Math.max(-1, Math.min(1, samples[i])); v.setInt16(44 + i * 2, x < 0 ? x * 32768 : x * 32767, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

/** Whether a passage is one this voice can read (Latin letters, mostly). */
export function kittenCanRead(text: string): boolean {
  const letters = text.match(/\p{L}/gu) ?? []; if (!letters.length) return false;
  const latin = letters.filter((c) => /[A-Za-zÀ-ɏ]/.test(c)).length;
  return latin / letters.length > 0.8;
}
