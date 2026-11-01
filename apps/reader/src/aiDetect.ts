// A custom API told apart from its key (and its address, when given): which service it is — OpenAI, Anthropic,
// Gemini, Grok (xAI), Groq, DeepSeek, Mistral, OpenRouter, Together, Fireworks, Cerebras, Perplexity, Hugging Face,
// NVIDIA, GitHub Models, Moonshot (Kimi), Zhipu (GLM), Chutes, DeepInfra, OpenCode Zen, or a server of your own
// (Ollama, LM Studio, vLLM…) — how it is spoken to, and its models with what each service says of them: free or
// paid (and the price for a million tokens), how many tokens it takes in and gives out, whether it is up.
import type { ApiStyle } from './ai';

export interface KnownService { id: string; name: string; style: ApiStyle; base: string; prefix?: RegExp; keyUrl?: string; freeNote?: string }
export const SERVICES: KnownService[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', style: 'anthropic', base: 'https://api.anthropic.com/v1', prefix: /^sk-ant-/, keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', name: 'OpenRouter', style: 'openai', base: 'https://openrouter.ai/api/v1', prefix: /^sk-or-/, keyUrl: 'https://openrouter.ai/keys', freeNote: 'free' },
  { id: 'xai', name: 'xAI (Grok)', style: 'openai', base: 'https://api.x.ai/v1', prefix: /^xai-/, keyUrl: 'https://console.x.ai' },
  { id: 'groq', name: 'Groq', style: 'openai', base: 'https://api.groq.com/openai/v1', prefix: /^gsk_/, keyUrl: 'https://console.groq.com/keys', freeNote: 'tier' },
  { id: 'gemini', name: 'Google Gemini', style: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', prefix: /^AIza/, keyUrl: 'https://aistudio.google.com/apikey', freeNote: 'tier' },
  { id: 'cerebras', name: 'Cerebras', style: 'openai', base: 'https://api.cerebras.ai/v1', prefix: /^csk-/, keyUrl: 'https://cloud.cerebras.ai', freeNote: 'tier' },
  { id: 'perplexity', name: 'Perplexity', style: 'openai', base: 'https://api.perplexity.ai', prefix: /^pplx-/ },
  { id: 'fireworks', name: 'Fireworks', style: 'openai', base: 'https://api.fireworks.ai/inference/v1', prefix: /^fw_/ },
  { id: 'huggingface', name: 'Hugging Face', style: 'openai', base: 'https://router.huggingface.co/v1', prefix: /^hf_/, freeNote: 'tier' },
  { id: 'nvidia', name: 'NVIDIA NIM', style: 'openai', base: 'https://integrate.api.nvidia.com/v1', prefix: /^nvapi-/, freeNote: 'tier' },
  { id: 'github', name: 'GitHub Models', style: 'openai', base: 'https://models.github.ai/inference', prefix: /^(ghp_|github_pat_|gho_)/, freeNote: 'tier' },
  { id: 'together', name: 'Together AI', style: 'openai', base: 'https://api.together.xyz/v1', prefix: /^tgp_/ },
  { id: 'chutes', name: 'Chutes', style: 'openai', base: 'https://llm.chutes.ai/v1', prefix: /^cpk_/ },
  { id: 'openai', name: 'OpenAI', style: 'openai', base: 'https://api.openai.com/v1', prefix: /^sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}$/ },
  { id: 'deepseek', name: 'DeepSeek', style: 'openai', base: 'https://api.deepseek.com/v1', prefix: /^sk-[a-f0-9]{32}$/ },
  { id: 'moonshot', name: 'Moonshot (Kimi)', style: 'openai', base: 'https://api.moonshot.ai/v1', prefix: /^sk-[A-Za-z0-9]{40,}$/ },
  { id: 'zhipu', name: 'Zhipu (GLM)', style: 'openai', base: 'https://open.bigmodel.cn/api/paas/v4', prefix: /^[a-f0-9]{32}\.[A-Za-z0-9]{10,}$/ },
  { id: 'mistral', name: 'Mistral', style: 'openai', base: 'https://api.mistral.ai/v1', prefix: /^[A-Za-z0-9]{32}$/ },
  { id: 'deepinfra', name: 'DeepInfra', style: 'openai', base: 'https://api.deepinfra.com/v1/openai', prefix: /^[A-Za-z0-9]{32}$/ },
  { id: 'opencode', name: 'OpenCode Zen', style: 'openai', base: 'https://opencode.ai/zen/v1', prefix: /^sk-[A-Za-z0-9]{30,}$/ },
];

export interface ModelInfo { id: string; name?: string; context?: number; output?: number; priceIn?: number; priceOut?: number; free?: boolean; active?: boolean; kind?: string }
export interface Detected { service: KnownService; base: string; style: ApiStyle; models: ModelInfo[]; note?: string }
type Get = (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string }>;

const authFor = (style: ApiStyle, key: string): { headers: Record<string, string>; query: string } =>
  style === 'gemini' ? { headers: {}, query: key ? `key=${encodeURIComponent(key)}` : '' } : style === 'anthropic' ? { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }, query: '' } : { headers: key ? { authorization: `Bearer ${key}` } : {}, query: '' };

/** The models a service lists, with what it says of each (fields as each names them). */
export function readModels(style: ApiStyle, serviceId: string, body: string): ModelInfo[] {
  const j = JSON.parse(body) as Record<string, unknown>;
  if (style === 'gemini') {
    const ms = (j.models ?? []) as { name: string; displayName?: string; inputTokenLimit?: number; outputTokenLimit?: number; supportedGenerationMethods?: string[] }[];
    return ms.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName, context: m.inputTokenLimit, output: m.outputTokenLimit }));
  }
  const data = (Array.isArray(j) ? j : (j.data ?? j.models ?? [])) as Record<string, unknown>[];
  return data.map((m) => {
    const id = String(m.id ?? m.name ?? '');
    const pr = (m.pricing ?? {}) as Record<string, unknown>; const tp = (m.top_provider ?? {}) as Record<string, unknown>;
    // OpenRouter: prices per token (strings); Together: per million (input/output); others name none.
    let priceIn: number | undefined, priceOut: number | undefined;
    if (pr.prompt !== undefined) { priceIn = Number(pr.prompt) * 1e6; priceOut = Number(pr.completion) * 1e6; }
    else if (pr.input !== undefined) { priceIn = Number(pr.input); priceOut = Number(pr.output); }
    const context = Number(m.context_length ?? m.context_window ?? m.max_context_length ?? m.max_input_tokens ?? m.contextWindow ?? (tp.context_length as number) ?? 0) || undefined;
    const output = Number(tp.max_completion_tokens ?? m.max_completion_tokens ?? m.max_output_tokens ?? m.max_tokens ?? 0) || undefined;
    const free = /:free$|-free$|(^|[-_/])free([-_]|$)/i.test(id) || (priceIn === 0 && priceOut === 0) || undefined;
    return { id, name: (m.name ?? m.display_name) as string | undefined, context, output, priceIn: isFinite(priceIn as number) ? priceIn : undefined, priceOut: isFinite(priceOut as number) ? priceOut : undefined, free, active: m.active === false ? false : undefined, kind: (m.type ?? (m.architecture as { modality?: string } | undefined)?.modality) as string | undefined };
  }).filter((m) => m.id && !/embed|tts|whisper|transcribe|moderation|dall-e|image-gen|rerank/i.test(m.id) && !/^(embedding|image|audio|moderation|rerank)$/.test(m.kind ?? ''));
}

/** The services a key may belong to, by its form (a key is never sent to a service it might not be for: when its
 *  form fits several, the person picks one). With an address, the address decides. */
export function candidatesFor(key: string, url: string): KnownService[] {
  key = key.trim(); url = url.trim().replace(/\/+$/, '');
  if (url) {
    const known = SERVICES.find((s) => url.startsWith(s.base) || s.base.startsWith(url));
    if (known) return [{ ...known, base: url }];
    const local = /localhost|127\.0\.0\.1|192\.168\.|10\.\d+\.|\.local\b/.test(url); const host = (() => { try { return new URL(url).hostname; } catch { return url; } })();
    const styles: ApiStyle[] = /generativelanguage|\/v1beta/.test(url) ? ['gemini'] : /anthropic/.test(url) ? ['anthropic'] : ['openai', 'anthropic', 'gemini'];
    return styles.map((st) => ({ id: 'custom', name: local ? 'Server of your own' : host, style: st, base: url }));
  }
  return SERVICES.filter((s) => s.prefix?.test(key));
}
/** The service at `c`, asked for its model list with the key: what it is and what it offers. */
export async function probe(c: KnownService, key: string, get: Get): Promise<Detected> {
  const a = authFor(c.style, key.trim());
  const path = c.style === 'gemini' ? `${c.base}/models?pageSize=200${a.query ? `&${a.query}` : ''}` : c.style === 'anthropic' ? `${c.base}/models?limit=100` : `${c.base}/models`;
  const r = await get(path, a.headers);
  if (r.status !== 200) throw Object.assign(new Error(`${c.name}: HTTP ${r.status}${r.body ? ` — ${r.body.slice(0, 160)}` : ''}`), { status: r.status });
  return { service: c, base: c.base, style: c.style, models: sortModels(readModels(c.style, c.id, r.body)) };
}
/** With an address of no known service, each way of speaking is tried in turn (OpenAI's first). */
export async function detectAt(cands: KnownService[], key: string, get: Get): Promise<Detected> {
  let last: unknown = null;
  for (const c of cands) { try { const d = await probe(c, key, get); if (d.models.length || cands.length === 1) return d; } catch (e) { last = e; } }
  throw last ?? new Error('unknown');
}
/** Free ones first, then the newest-looking names. */
export function sortModels(ms: ModelInfo[]): ModelInfo[] { return [...new Map(ms.map((m) => [m.id, m])).values()].sort((a, b) => Number(!!b.free) - Number(!!a.free) || b.id.localeCompare(a.id, undefined, { numeric: true })); }
