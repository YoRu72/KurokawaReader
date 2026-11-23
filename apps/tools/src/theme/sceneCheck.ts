// A scene file checked before the scene engine sees it (theme/sceneRepo.ts: the repository's scenes). No imports, so
// it can be checked on its own. Mirrors the engine's own reader: json.rs's limits (256 KB, depth 32, 20,000 values,
// strings of 4,096) and the shape scenefile.rs requires.
const ENGINE_JSON_MAX = 256 * 1024, MAX_DEPTH = 32, MAX_NODES = 20_000, MAX_STR = 4096;
export class SceneFileError extends Error { constructor(public code: 'size' | 'checksum' | 'json' | 'limits' | 'shape', msg: string) { super(msg); } }
const bad = (code: SceneFileError['code'], m: string): never => { throw new SceneFileError(code, m); };
/** A scene file checked before the engine sees it: its size, UTF-8, the JSON's depth, node count and string lengths
 *  (json.rs's limits), and the shape scenefile.rs requires — `format` ktscene/1, the layer, emitter, palette and
 *  parameter counts, the particle budget. The engine still clamps every number itself. */
export function checkSceneBytes(bytes: Uint8Array): unknown {
  if (!bytes.length || bytes.length > ENGINE_JSON_MAX) bad('size', `${bytes.length} bytes`);
  let text: string; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return bad('json', 'not UTF-8'); }
  let doc: unknown; try { doc = JSON.parse(text); } catch { return bad('json', 'not JSON'); }
  let nodes = 0;
  const walk = (v: unknown, depth: number): void => {
    if (++nodes > MAX_NODES) bad('limits', 'too many values');
    if (depth > MAX_DEPTH) bad('limits', 'nested too deep');
    if (typeof v === 'string') { if (v.length > MAX_STR) bad('limits', 'string too long'); return; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad('limits', 'not a finite number'); return; }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return; }
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k.length > MAX_STR) bad('limits', 'key too long'); walk(x, depth + 1); }
  };
  walk(doc, 1);
  const o = doc as Record<string, unknown>;
  if (!o || typeof o !== 'object' || Array.isArray(o) || o.format !== 'ktscene/1') bad('shape', 'not a ktscene/1 file');
  const list = (k: string, max: number, min = 0): unknown[] => { const v = o[k]; if (v === undefined) return []; if (!Array.isArray(v) || v.length > max || v.length < min) return bad('shape', `${k}: 0–${max}`); if (v.some((x) => k !== 'palette' && (!x || typeof x !== 'object' || Array.isArray(x)))) bad('shape', `${k}: objects`); return v; };
  const layers = list('layers', 32); const emitters = list('emitters', 16); list('params', 16);
  // (The palette: a list of 0–32, or the legacy { roles: [...] }.)
  const pal = o.palette; const palList = pal && typeof pal === 'object' && !Array.isArray(pal) ? (pal as { roles?: unknown }).roles : pal;
  if (palList !== undefined && palList !== null && (!Array.isArray(palList) || palList.length > 32)) bad('shape', 'palette: a list of at most 32');
  for (const l of layers as Record<string, unknown>[]) if (l.kind !== undefined && typeof l.kind !== 'string') bad('shape', 'a layer kind is a word');
  let total = 0;
  for (const e of emitters as Record<string, unknown>[]) { if (typeof e.layer !== 'string') bad('shape', 'an emitter without a layer'); const m = typeof e.max === 'number' ? Math.min(2048, Math.max(1, e.max)) : 256; total += m; }
  if (total > 4096) bad('limits', 'more than 4,096 particles');
  for (const k of ['meta', 'view', 'space']) if (o[k] !== undefined && (typeof o[k] !== 'object' || Array.isArray(o[k]) || o[k] === null)) bad('shape', k);
  return doc;
}

