// Models from Hugging Face, the way Prism fetches them: a model named (owner/name), linked, or searched for; its
// files listed with their sizes and SHA-256; the ones worth downloading picked for you (one GGUF quantization —
// Q4_K_M first, as is usual — with its vision part, or the weights in one format: safetensors rather than the
// PyTorch .bin, without the ONNX / original/ copies, without an fp16 twin); every file pinned to one commit,
// small ones first, and checked against its SHA-256 when it is done. The server can be a mirror (hf-mirror.com);
// a token opens gated and private models.
import { request } from '../http';
import { getSettings } from '../settings';

export type RepoKind = 'model' | 'dataset';
export interface RepoFile { path: string; size: number; sha256?: string }
export interface Variant { label: string; size: number; files: string[] }
export interface Suggestion { files: string[]; variants: Variant[]; variant?: string; extras: string[] }
export interface Repo { id: string; kind: RepoKind; sha: string; revision: string; gated: boolean; private: boolean; downloads?: number; likes?: number; task?: string; files: RepoFile[]; suggestion: Suggestion; path?: string }
export interface Hit { id: string; downloads?: number; likes?: number; task?: string; gated: boolean }
export interface HfPrefs { endpoint: string; token: string; folder: string }
export const HF_DEFAULT: HfPrefs = { endpoint: 'https://huggingface.co', token: '', folder: '' };
export const hfPrefs = (): HfPrefs => ({ ...HF_DEFAULT, ...(getSettings().hf as Partial<HfPrefs> | undefined) });
export const MIRROR = 'https://hf-mirror.com';
const server = () => (hfPrefs().endpoint || HF_DEFAULT.endpoint).replace(/\/+$/, '');
const SMALL = 20 * 1048576;

/* ---------- names and links ---------- */
const NOT_OWNERS = new Set(['models', 'datasets', 'spaces', 'docs', 'blog', 'api', 'papers', 'collections', 'join', 'login', 'settings', 'pricing', 'organizations', 'tasks', 'learn', 'posts', 'chat']);
const valid = (s: string) => /^[A-Za-z0-9][\w.-]*$/.test(s) && s.length <= 96;
const HUB = (host: string) => ['huggingface.co', 'hf.co', 'www.huggingface.co', 'hf-mirror.com'].includes(host) || (() => { try { return new URL(server()).host === host; } catch { return false; } })();
export type Link = { kind: 'repo'; repo: { id: string; kind: RepoKind; revision?: string; path?: string } } | { kind: 'file'; url: string };
/** What the words name: `owner/name`, `datasets/owner/name`, or a link to a repository, a folder in it, a file's page. */
export function parse(input: string): Link | null {
  const s = input.trim(); if (!s) return null;
  if (!/^https?:\/\//i.test(s)) {
    const parts = s.replace(/^\/+|\/+$/g, '').split('/'); let kind: RepoKind = 'model';
    if (parts[0] === 'datasets') { kind = 'dataset'; parts.shift(); } else if (parts[0] === 'models') parts.shift();
    return parts.length === 2 && parts.every(valid) && !NOT_OWNERS.has(parts[0]) ? { kind: 'repo', repo: { id: parts.join('/'), kind } } : null;
  }
  let u: URL; try { u = new URL(s); } catch { return null; }
  if (!HUB(u.host)) return null;
  const seg = u.pathname.split('/').filter(Boolean).map(decodeURIComponent); let kind: RepoKind = 'model';
  if (seg[0] === 'datasets') { kind = 'dataset'; seg.shift(); }
  if (seg.length < 2 || NOT_OWNERS.has(seg[0]) || !valid(seg[0]) || !valid(seg[1])) return null;
  const id = `${seg[0]}/${seg[1]}`;
  if (seg[2] === 'blob' && seg.length > 4) return { kind: 'file', url: `${u.origin}/${kind === 'dataset' ? 'datasets/' : ''}${id}/resolve/${seg.slice(3).map(encodeURIComponent).join('/')}` };
  if (seg[2] === 'resolve') return null;   // (a file's own link: downloaded like any other)
  if (seg[2] === 'tree' && seg[3]) return { kind: 'repo', repo: { id, kind, revision: seg[3], path: seg.slice(4).join('/') || undefined } };
  return { kind: 'repo', repo: { id, kind } };
}
export const isHfLink = (s: string): boolean => { const p = parse(s); return !!p && p.kind === 'repo' && /^https?:/i.test(s.trim()); };

/* ---------- the server ---------- */
export class HfProblem extends Error { constructor(readonly code: 'notFound' | 'needsToken' | 'badToken' | 'gated' | 'net', msg?: string) { super(msg ?? code); } }
async function get<T>(url: string): Promise<T> {
  const tok = hfPrefs().token.trim();
  const r = await request(url, { headers: tok ? { Authorization: `Bearer ${tok}` } : {} });
  if (r.status === 200) return JSON.parse(r.body) as T;
  let code = ''; try { code = String((JSON.parse(r.body) as { error?: string }).error ?? ''); } catch { /* text */ }
  if (r.status === 401) throw new HfProblem(tok ? 'badToken' : 'needsToken');
  if (r.status === 403) throw new HfProblem(/gated|access/i.test(code) ? 'gated' : tok ? 'badToken' : 'needsToken');
  if (r.status === 404) throw new HfProblem(tok ? 'notFound' : 'needsToken');
  throw new HfProblem('net', `HTTP ${r.status}`);
}
type ApiSibling = { rfilename: string; size?: number; lfs?: { sha256?: string; size?: number } };
type ApiRepo = { id?: string; sha?: string; gated?: unknown; private?: boolean; downloads?: number; likes?: number; pipeline_tag?: string; siblings?: ApiSibling[] };
export async function readRepo(repo: { id: string; kind: RepoKind; revision?: string; path?: string }): Promise<Repo> {
  const rev = repo.revision ?? 'main';
  const info = await get<ApiRepo>(`${server()}/api/${repo.kind === 'dataset' ? 'datasets' : 'models'}/${repo.id}/revision/${encodeURIComponent(rev)}?blobs=true`);
  const files: RepoFile[] = (info.siblings ?? []).filter((s) => s.rfilename).map((s) => ({ path: s.rfilename, size: s.size ?? s.lfs?.size ?? 0, sha256: s.lfs?.sha256 && /^[0-9a-f]{64}$/i.test(s.lfs.sha256) ? s.lfs.sha256.toLowerCase() : undefined }));
  return { id: info.id || repo.id, kind: repo.kind, sha: info.sha || rev, revision: rev, gated: !!info.gated && info.gated !== false, private: !!info.private, downloads: info.downloads, likes: info.likes, task: info.pipeline_tag, files, suggestion: suggest(files, repo.kind, repo.path), path: repo.path };
}
export async function search(q: string): Promise<Hit[]> {
  const url = q.trim() ? `${server()}/api/models?search=${encodeURIComponent(q.trim())}&sort=downloads&direction=-1&limit=20` : `${server()}/api/models?sort=trendingScore&direction=-1&limit=20`;
  const r = await get<{ id: string; downloads?: number; likes?: number; pipeline_tag?: string; gated?: unknown }[]>(url);
  return r.map((x) => ({ id: x.id, downloads: x.downloads, likes: x.likes, task: x.pipeline_tag, gated: !!x.gated && x.gated !== false }));
}
/** A file's download link, pinned to the commit (every file from the same version). */
export const fileUrl = (repo: Repo, path: string): string => `${server()}/${repo.kind === 'dataset' ? 'datasets/' : ''}${repo.id}/resolve/${repo.sha}/${path.split('/').map(encodeURIComponent).join('/')}`;

/* ---------- what to download ---------- */
const PREFERRED = ['Q4_K_M', 'UD-Q4_K_XL', 'Q4_K_XL', 'Q4_K_S', 'IQ4_XS', 'IQ4_NL', 'Q4_0', 'MXFP4', 'MXFP4_MOE', 'Q5_K_M', 'UD-Q5_K_XL', 'Q5_K_S', 'Q6_K', 'UD-Q6_K_XL', 'Q8_0', 'UD-Q8_K_XL'];
const name = (p: string) => p.split('/').pop() ?? p;
const ext = (p: string) => (/\.([^./]+)$/.exec(p.toLowerCase())?.[1] ?? '');
const QUANT = /(?:^|[-_.])((?:UD-)?(?:I?Q\d(?:_[0-9A-Z]+)*|MXFP4(?:_MOE)?|BF16|F16|FP16|F32|FP32))(?=[-_.]|$)/i;
const quantOf = (p: string): string | undefined => { const m = QUANT.exec(name(p).replace(/\.gguf$/i, '')) ?? QUANT.exec(p.split('/').slice(-2, -1)[0] ?? ''); return m?.[1].toUpperCase(); };
const SPLIT = /-\d{5}-of-\d{5}$/;
const isMmproj = (p: string) => name(p).toLowerCase().includes('mmproj');
const altFormat = (p: string) => { const l = p.toLowerCase(); const top = l.split('/')[0]; return ['onnx', 'openvino', 'coreml', 'tflite', 'mlx', 'original', 'tensorrt'].includes(top) || ['h5', 'msgpack', 'ot', 'onnx', 'onnx_data', 'tflite', 'mlmodel', 'pb'].includes(ext(l)) || l.endsWith('/model.mlpackage'); };
export function suggest(files: RepoFile[], kind: RepoKind, path?: string): Suggestion {
  const p = path?.replace(/^\/+|\/+$/g, '');
  if (p) { const inside = files.filter((f) => f.path === p || f.path.startsWith(`${p}/`)).map((f) => f.path); if (inside.length) return { ...suggestAll(files, kind), files: inside, variant: undefined }; }
  return suggestAll(files, kind);
}
function suggestAll(files: RepoFile[], kind: RepoKind): Suggestion {
  if (kind === 'dataset') return { files: files.filter((f) => f.path !== '.gitattributes').map((f) => f.path), variants: [], extras: [] };
  const gguf = files.filter((f) => ext(f.path) === 'gguf');
  const weightsElsewhere = files.some((f) => ['safetensors', 'bin', 'pt', 'pth'].includes(ext(f.path)) && f.size > SMALL);
  if (gguf.length && !weightsElsewhere) return suggestGguf(gguf);
  return { files: suggestWeights(files), variants: [], extras: [] };
}
function suggestGguf(gguf: RepoFile[]): Suggestion {
  const groups = new Map<string, RepoFile[]>(); const extras: RepoFile[] = [];
  for (const f of gguf) { if (isMmproj(f.path)) { extras.push(f); continue; } const label = quantOf(f.path) ?? name(f.path).replace(/\.gguf$/i, '').replace(SPLIT, ''); groups.set(label, [...(groups.get(label) ?? []), f]); }
  const variants: Variant[] = [...groups].map(([label, fs]) => ({ label, size: fs.reduce((s, f) => s + f.size, 0), files: fs.map((f) => f.path).sort() })).sort((a, b) => a.size - b.size || a.label.localeCompare(b.label));
  const picked = PREFERRED.map((p) => variants.find((v) => v.label === p)).find(Boolean) ?? variants[Math.floor((variants.length - 1) / 2)];
  const rank = (q: string) => (q === 'F16' || q === 'FP16' ? 0 : q === 'BF16' ? 1 : q === 'Q8_0' ? 2 : q === 'F32' || q === 'FP32' ? 4 : 3);
  const extra = [...extras].sort((a, b) => rank(quantOf(a.path) ?? '') - rank(quantOf(b.path) ?? '') || a.path.localeCompare(b.path))[0]?.path;
  return { variant: picked?.label, variants: variants.length > 1 ? variants : [], extras: extra ? [extra] : [], files: [...(picked?.files ?? []), ...(extra ? [extra] : [])] };
}
function suggestWeights(files: RepoFile[]): string[] {
  const safet = files.some((f) => ext(f.path) === 'safetensors'); const names = new Set(files.map((f) => f.path));
  return files.filter((f) => f.path !== '.gitattributes' && !altFormat(f.path)).filter((f) => {
    const e = ext(f.path);
    if (['bin', 'pt', 'pth', 'ckpt'].includes(e) && safet) return f.size <= SMALL && !name(f.path).startsWith('pytorch_model');
    return e !== 'gguf';
  }).filter((f) => !['fp16', 'fp32', 'bf16'].some((v) => { const m = new RegExp(`^(.*)\\.${v}\\.([^.]+)$`).exec(f.path); return !!m && names.has(`${m[1]}.${m[2]}`); })).map((f) => f.path);
}
/** Small files first (configs and tokenizers ready before the weights), then by path (split parts in order). */
export const downloadOrder = (fs: RepoFile[]): RepoFile[] => [...fs].sort((a, b) => Number(a.size > SMALL) - Number(b.size > SMALL) || a.path.localeCompare(b.path));
/** A repository path made safe inside the save folder (null for one that would leave it). */
export function safePath(p: string): string | null { const parts = p.split('/'); return parts.every((x) => x && x !== '.' && x !== '..' && !/[\\:]/.test(x)) ? parts.join('/') : null; }
