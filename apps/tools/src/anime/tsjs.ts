// Seanime extensions are often written in TypeScript and handed out as such (Seanime compiles them itself). Here
// the TypeScript compiler does the same: fetched the first time such an extension is installed (9 MB, about 2 MB
// over the wire), checked byte for byte against the release it is pinned to, and kept — it is not part of the
// app. Code that already parses as JavaScript is left alone.
import { db } from '../db';
import { request } from '../http';

const TS_VERSION = '6.0.3';
const TS_URL = `https://cdn.jsdelivr.net/npm/typescript@${TS_VERSION}/lib/typescript.js`;
const TS_SHA256 = '569177652966bd528c319171c7dd22860dbf72bde116cbc4f644f1d02bb12e39';
const KEY = `pack:typescript-${TS_VERSION}`;

type Ts = { transpileModule(code: string, o: { compilerOptions: Record<string, unknown>; reportDiagnostics?: boolean }): { outputText: string }; ScriptTarget: Record<string, number>; ModuleKind: Record<string, number> };
export function parsesAsJs(code: string): boolean { try { new Function(code); return true; } catch { return false; } }

async function sha256(text: string): Promise<string> { const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)); return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''); }
let compiler: Promise<Ts> | null = null;
function load(): Promise<Ts> {
  compiler ??= (async () => {
    let code = await (await db.getFile(KEY).catch(() => null))?.text();
    if (!code) {
      const r = await request(TS_URL); if (r.status !== 200) throw new Error(`TypeScript: HTTP ${r.status}`);
      if ((await sha256(r.body)) !== TS_SHA256) throw new Error('TypeScript: checksum');
      code = r.body; await db.putFile(KEY, new Blob([code], { type: 'text/javascript' })).catch(() => undefined);
    }
    // (The file is the compiler's own bundle: given a `module`, it puts its API there.)
    const mod: { exports: unknown } = { exports: {} };
    new Function('module', 'exports', code)(mod, mod.exports);
    return mod.exports as Ts;
  })();
  compiler.catch(() => { compiler = null; });
  return compiler;
}

export async function toJs(code: string): Promise<string> {
  if (parsesAsJs(code)) return code;
  const ts = await load();
  const out = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: true, removeComments: false, isolatedModules: true }, reportDiagnostics: false }).outputText;
  // (The payload runs as a function body: module syntax has no place there.)
  return out.replace(/^\s*import\s[^\n]*$/gm, '').replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '').replace(/^(\s*)export\s+(default\s+)?(?=class|function|async|const|let|var)/gm, '$1');
}
