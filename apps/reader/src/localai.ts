// Local AI: models that run on the reader's own hardware, with no account and nothing sent away.
//  - On this device: a GGUF model run inside the app by wllama (llama.cpp compiled to WebAssembly) — phones,
//    tablets, computers alike. The engine is fetched once and kept; models are downloaded once (or imported
//    from a file) and kept on the device.
//  - Local server: Ollama, LM Studio, llama.cpp's server, Jan, KoboldCpp, GPT4All, LocalAI… on this computer
//    or another one on the network, found by looking at their usual ports. Requests go through the app's
//    native side where a web page could not reach them (Android's secure origin, a desktop's CORS).
import { getSettings, updateSettings } from './settings';

/* ---------------------------------------------------------------- catalogue */

export type LocalModel = { id: string; name: string; repo: string; file: string; sizeMB: number; ram: string; note: string; chat: 'chatml' | 'gemma' | 'auto' };
/** Small instruction models that read and write Arabic, English, Japanese, Chinese and Korean well for their size. */
export const CATALOG: LocalModel[] = [
  { id: 'qwen2.5-0.5b', name: 'Qwen2.5 0.5B Instruct', repo: 'Qwen/Qwen2.5-0.5B-Instruct-GGUF', file: 'qwen2.5-0.5b-instruct-q4_k_m.gguf', sizeMB: 398, ram: '1 GB', note: 'fast', chat: 'chatml' },
  { id: 'qwen2.5-1.5b', name: 'Qwen2.5 1.5B Instruct', repo: 'Qwen/Qwen2.5-1.5B-Instruct-GGUF', file: 'qwen2.5-1.5b-instruct-q4_k_m.gguf', sizeMB: 1120, ram: '2 GB', note: 'balanced', chat: 'chatml' },
  { id: 'qwen2.5-3b', name: 'Qwen2.5 3B Instruct', repo: 'Qwen/Qwen2.5-3B-Instruct-GGUF', file: 'qwen2.5-3b-instruct-q4_k_m.gguf', sizeMB: 1930, ram: '4 GB', note: 'best', chat: 'chatml' },
  { id: 'gemma-2-2b', name: 'Gemma 2 2B Instruct', repo: 'bartowski/gemma-2-2b-it-GGUF', file: 'gemma-2-2b-it-Q4_K_M.gguf', sizeMB: 1710, ram: '3 GB', note: 'multilingual', chat: 'gemma' },
];
const hfUrl = (m: { repo: string; file: string }) => `https://huggingface.co/${m.repo}/resolve/main/${m.file}`;

/** Models on this device: the catalogue's downloaded ones and files imported by the reader. */
type Installed = { id: string; name: string; sizeMB: number; imported?: boolean; chat: LocalModel['chat'] };
const IKEY = 'kr.localModels';
export function installed(): Installed[] { try { return JSON.parse(localStorage.getItem(IKEY) ?? '[]') as Installed[]; } catch { return []; } }
function setInstalled(list: Installed[]): void { try { localStorage.setItem(IKEY, JSON.stringify(list)); } catch { /* full */ } }

/* ---------------------------------------------------------------- the engine (wllama) */

// Pinned versions to try, newest first (the first that loads is kept).
const WLLAMA = ['2.3.5', '2.3.1', '2.3.0', '2.2.1'];
const CDN = (v: string) => `https://cdn.jsdelivr.net/npm/@wllama/wllama@${v}/esm`;
const CACHE = 'kr-localai-v1';

/** A file from the network, kept in the app's own cache so the engine works offline afterwards. */
async function cached(url: string): Promise<Response> {
  try {
    const c = await caches.open(CACHE);
    const hit = await c.match(url); if (hit) return hit;
    const r = await fetch(url); if (r.ok) await c.put(url, r.clone()); return r;
  } catch { return fetch(url); }
}

type Wllama = {
  loadModelFromUrl?(url: string, o?: Record<string, unknown>): Promise<void>;
  loadModelFromHF?(repo: string, file: string, o?: Record<string, unknown>): Promise<void>;
  loadModel(blobs: Blob[], o?: Record<string, unknown>): Promise<void>;
  createChatCompletion?(messages: { role: string; content: string }[], o?: Record<string, unknown>): Promise<string>;
  createCompletion(prompt: string, o?: Record<string, unknown>): Promise<string>;
  exit(): Promise<void>;
  modelManager?: { getModels(): Promise<{ url: string; remove(): Promise<void> }[]>; downloadModel?(url: string, o?: Record<string, unknown>): Promise<unknown> };
  cacheManager?: { list(): Promise<{ name: string }[]>; delete(name: string): Promise<void> };
};
type WllamaModule = { Wllama: new (paths: Record<string, string>, o?: Record<string, unknown>) => Wllama };
let mod: WllamaModule | null = null;
let modVersion = '';
async function engineModule(): Promise<WllamaModule> {
  if (mod) return mod;
  let lastErr: unknown;
  for (const v of WLLAMA) {
    try {
      // (From the app's cache when fetched before: the module as a blob, its WebAssembly from the cache.)
      const src = await (await cached(`${CDN(v)}/index.js`)).text();
      if (!/Wllama/.test(src)) throw new Error('not wllama');
      let m: WllamaModule;
      try { m = await import(/* @vite-ignore */ URL.createObjectURL(new Blob([src], { type: 'text/javascript' }))); }
      catch { m = await import(/* @vite-ignore */ `${CDN(v)}/index.js`); }
      mod = m; modVersion = v; return m;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`The on-device engine could not be fetched (${String((lastErr as Error)?.message ?? lastErr)}). It needs the internet once.`);
}
async function wasmPaths(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const k of ['single-thread/wllama.wasm', 'multi-thread/wllama.wasm']) {
    const url = `${CDN(modVersion)}/${k}`;
    try { const b = await (await cached(url)).blob(); out[k] = URL.createObjectURL(new Blob([b], { type: 'application/wasm' })); } catch { out[k] = url; }
  }
  return out;
}

let engine: Wllama | null = null;
let loadedId = '';
let loading: Promise<Wllama> | null = null;
export type Progress = (done: number, total: number) => void;

/** OPFS: where imported model files are kept. */
async function modelsDir(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('kr-models', { create: true });
}

/** The engine with this model loaded (downloading it first when needed). */
async function engineFor(id: string, onProgress?: Progress): Promise<Wllama> {
  if (engine && loadedId === id) return engine;
  if (loading) await loading.catch(() => undefined);
  if (engine && loadedId === id) return engine;
  loading = (async () => {
    const M = await engineModule();
    if (engine) { await engine.exit().catch(() => undefined); engine = null; loadedId = ''; }
    const w = new M.Wllama(await wasmPaths(), { allowOffline: true });
    // A context long enough for a page of text and its translation; threads as the device allows.
    const cfg = { n_ctx: 4096, n_batch: 512, progressCallback: (p: { loaded: number; total: number }) => onProgress?.(p.loaded, p.total) };
    const inst = installed().find((m) => m.id === id);
    if (inst?.imported) {
      const fh = await (await modelsDir()).getFileHandle(id);
      await w.loadModel([await fh.getFile()], cfg);
    } else {
      const c = CATALOG.find((m) => m.id === id); if (!c) throw new Error('model');
      if (w.loadModelFromUrl) await w.loadModelFromUrl(hfUrl(c), cfg);
      else if (w.loadModelFromHF) await w.loadModelFromHF(c.repo, c.file, cfg);
      else throw new Error('engine');
    }
    engine = w; loadedId = id; return w;
  })();
  try { return await loading; } finally { loading = null; }
}

/** Download a catalogue model (kept by the engine's own store) and record it as installed. */
export async function downloadModel(id: string, onProgress: Progress): Promise<void> {
  const c = CATALOG.find((m) => m.id === id); if (!c) throw new Error('model');
  await engineFor(id, onProgress);
  setInstalled([...installed().filter((m) => m.id !== id), { id, name: c.name, sizeMB: c.sizeMB, chat: c.chat }]);
}

/** Bring in a GGUF file the reader has (kept in the app's private storage). */
export async function importModel(file: File, onProgress?: Progress): Promise<string> {
  if (!/\.gguf$/i.test(file.name)) throw new Error('gguf');
  const id = `file-${file.name.replace(/[^\w.-]+/g, '_')}`;
  const dir = await modelsDir();
  const fh = await dir.getFileHandle(id, { create: true });
  const ws = await (fh as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
  // (Written in pieces, reporting progress: model files are large.)
  const step = 8 << 20;
  for (let off = 0; off < file.size; off += step) { await ws.write(await file.slice(off, off + step).arrayBuffer()); onProgress?.(Math.min(file.size, off + step), file.size); }
  await ws.close();
  const name = file.name.replace(/\.gguf$/i, '');
  setInstalled([...installed().filter((m) => m.id !== id), { id, name, sizeMB: Math.round(file.size / 1048576), imported: true, chat: /gemma/i.test(name) ? 'gemma' : 'auto' }]);
  return id;
}

/** Remove a model from the device. */
export async function removeModel(id: string): Promise<void> {
  if (loadedId === id && engine) { await engine.exit().catch(() => undefined); engine = null; loadedId = ''; }
  const inst = installed().find((m) => m.id === id);
  if (inst?.imported) { try { await (await modelsDir()).removeEntry(id); } catch { /* gone */ } }
  else {
    const c = CATALOG.find((m) => m.id === id);
    try {
      const M = await engineModule(); const w = new M.Wllama(await wasmPaths(), { allowOffline: true });
      const models = await w.modelManager?.getModels().catch(() => []) ?? [];
      for (const m of models) if (c && m.url.includes(c.file)) await m.remove();
      const list = await w.cacheManager?.list().catch(() => []) ?? [];
      for (const e of list) if (c && e.name.includes(c.file.replace(/\.gguf$/, ''))) await w.cacheManager!.delete(e.name);
    } catch { /* the record goes anyway */ }
  }
  setInstalled(installed().filter((m) => m.id !== id));
  if (getSettings().localModel === id) updateSettings({ localModel: '' });
}

/** The prompt in the model's own chat format (when the engine has no chat call of its own). */
function formatChat(kind: LocalModel['chat'], system: string, user: string): string {
  if (kind === 'gemma') return `<start_of_turn>user\n${system}\n\n${user}<end_of_turn>\n<start_of_turn>model\n`;
  return `<|im_start|>system\n${system}<|im_end|>\n<|im_start|>user\n${user}<|im_end|>\n<|im_start|>assistant\n`;
}

/** One answer from the model on this device. */
export async function deviceChat(system: string, user: string, maxTokens = 1536): Promise<string> {
  const id = getSettings().localModel;
  if (!id) throw new Error('no local model');
  const w = await engineFor(id);
  const kind = installed().find((m) => m.id === id)?.chat ?? 'chatml';
  const sampling = { temp: 0.2, top_p: 0.9, top_k: 40, penalty_repeat: 1.05 };
  if (w.createChatCompletion && kind !== 'gemma') {
    try { return (await w.createChatCompletion([{ role: 'system', content: system }, { role: 'user', content: user }], { nPredict: maxTokens, sampling })).trim(); } catch { /* the plain call below */ }
  }
  const out = await w.createCompletion(formatChat(kind, system, user), { nPredict: maxTokens, sampling, stopTokens: undefined });
  return out.replace(/<\|im_end\|>[\s\S]*$|<end_of_turn>[\s\S]*$/, '').trim();
}

/** Whether a WebAssembly engine can run here at all. */
export function deviceSupported(): boolean { return typeof WebAssembly === 'object' && 'storage' in navigator && typeof caches !== 'undefined'; }

/* ---------------------------------------------------------------- local servers */

export const SERVERS: { name: string; port: number }[] = [
  { name: 'Ollama', port: 11434 }, { name: 'LM Studio', port: 1234 }, { name: 'llama.cpp', port: 8080 }, { name: 'Jan', port: 1337 },
  { name: 'KoboldCpp', port: 5001 }, { name: 'GPT4All', port: 4891 }, { name: 'LocalAI', port: 8081 }, { name: 'vLLM', port: 8000 },
];

type HttpResult = { status: number; body: string };
/** A request that may go to http://localhost or the local network: through the native side when there is one. */
export async function localHttp(url: string, init: { method?: string; headers?: Record<string, string>; body?: string; timeoutMs?: number } = {}): Promise<HttpResult> {
  const desk = (window as unknown as { kurokawaDesktop?: { http?(o: unknown): Promise<HttpResult> } }).kurokawaDesktop;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: { httpRequest?(o: unknown): Promise<HttpResult> } } } }).Capacitor;
  const o = { url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body ?? null };
  const withTimeout = <T,>(p: Promise<T>) => new Promise<T>((res, rej) => { const tm = setTimeout(() => rej(new Error('timeout')), init.timeoutMs ?? 120000); p.then((v) => { clearTimeout(tm); res(v); }, (e) => { clearTimeout(tm); rej(e); }); });
  if (desk?.http) return withTimeout(desk.http(o));
  if (cap?.isNativePlatform?.() && cap.Plugins?.Kurokawa?.httpRequest) return withTimeout(cap.Plugins.Kurokawa.httpRequest(o));
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), init.timeoutMs ?? 120000);
  try { const r = await fetch(url, { method: o.method, headers: o.headers, body: init.body, signal: ctl.signal }); return { status: r.status, body: await r.text() }; }
  finally { clearTimeout(tm); }
}

export type FoundServer = { name: string; url: string; models: string[] };
/** Look for local servers on this computer (or the given host): their OpenAI-compatible model lists. */
export async function findServers(host = 'localhost'): Promise<FoundServer[]> {
  const h = host.replace(/^https?:\/\//, '').replace(/[:/].*$/, '') || 'localhost';
  const found = await Promise.all(SERVERS.map(async (s) => {
    const url = `http://${h}:${s.port}/v1`;
    try {
      const r = await localHttp(`${url}/models`, { timeoutMs: 1800 });
      if (r.status !== 200) return null;
      const j = JSON.parse(r.body) as { data?: { id: string }[]; models?: { name: string }[] };
      const models = (j.data ?? []).map((m) => m.id).concat((j.models ?? []).map((m) => m.name));
      return { name: s.name, url, models };
    } catch { return null; }
  }));
  return found.filter((x): x is FoundServer => !!x);
}

/** The models a server offers. */
export async function serverModels(url: string): Promise<string[]> {
  const r = await localHttp(`${url.replace(/\/+$/, '')}/models`, { timeoutMs: 5000 });
  if (r.status !== 200) throw new Error(`${r.status}`);
  const j = JSON.parse(r.body) as { data?: { id: string }[] };
  return (j.data ?? []).map((m) => m.id);
}

/** One answer from the local server's chosen model. */
export async function serverChat(system: string, user: string, json: boolean): Promise<string> {
  const s = getSettings();
  const base = (s.localServer || 'http://localhost:11434/v1').replace(/\/+$/, '');
  let model = s.localServerModel;
  if (!model) { model = (await serverModels(base))[0] ?? ''; if (model) updateSettings({ localServerModel: model }); }
  const r = await localHttp(`${base}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, timeoutMs: 300000,
    body: JSON.stringify({ model, temperature: 0.2, stream: false, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  void json;
  if (r.status !== 200) {
    throw new Error(`Local server ${r.status}: ${r.body.slice(0, 200)}`);
  }
  const j = JSON.parse(r.body) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content ?? '';
}

/** Speech from a local server that offers OpenAI's /audio/speech (Kokoro-FastAPI, LocalAI, openedai-speech…). */
export async function serverSpeak(text: string, voice: string): Promise<Blob> {
  const s = getSettings();
  const base = (s.localServer || 'http://localhost:8880/v1').replace(/\/+$/, '');
  const body = JSON.stringify({ model: s.aiTtsModel.trim() || 'kokoro', voice: voice || 'af_heart', input: text, response_format: 'mp3' });
  const desk = (window as unknown as { kurokawaDesktop?: { http?(o: unknown): Promise<HttpResult> } }).kurokawaDesktop;
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?(): boolean; Plugins?: { Kurokawa?: { httpRequest?(o: unknown): Promise<HttpResult> } } } }).Capacitor;
  const nat = desk?.http ?? (cap?.isNativePlatform?.() ? cap.Plugins?.Kurokawa?.httpRequest : undefined);
  if (nat) {
    const r = await nat({ url: `${base}/audio/speech`, method: 'POST', headers: { 'content-type': 'application/json' }, body, binary: true });
    if (r.status !== 200) throw new Error(`Local TTS ${r.status}`);
    const bin = atob(r.body); const bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: 'audio/mpeg' });
  }
  const r = await fetch(`${base}/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (!r.ok) throw new Error(`Local TTS ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.blob();
}

/** Is a local model set up to answer? */
export function localReady(): boolean {
  const s = getSettings();
  return s.localEngine === 'server' ? !!s.localServer : !!s.localModel && installed().some((m) => m.id === s.localModel);
}
