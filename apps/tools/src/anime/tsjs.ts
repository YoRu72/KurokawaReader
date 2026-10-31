// Seanime extensions are often written in TypeScript and handed out as such (Seanime compiles them itself). Here
// the TypeScript compiler does the same — loaded only when such an extension comes, its types erased, nothing
// else changed. Code that already parses as JavaScript is left alone.
export function parsesAsJs(code: string): boolean { try { new Function(code); return true; } catch { return false; } }

export async function toJs(code: string): Promise<string> {
  if (parsesAsJs(code)) return code;
  const ts = (await import('typescript')).default;
  const out = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, useDefineForClassFields: true, removeComments: false, isolatedModules: true }, reportDiagnostics: false }).outputText;
  // (The payload runs as a function body: module syntax has no place there.)
  return out.replace(/^\s*import\s[^\n]*$/gm, '').replace(/^\s*export\s*\{[^}]*\}\s*;?\s*$/gm, '').replace(/^(\s*)export\s+(default\s+)?(?=class|function|async|const|let|var)/gm, '$1');
}
