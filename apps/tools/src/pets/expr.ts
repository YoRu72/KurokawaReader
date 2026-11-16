// The small, safe expression language of pet conditions and durations: numbers, true/false, a FIXED set of names
// (given by the caller), + - * / %, comparisons, and / or / not (also && || !), parentheses, and a handful of Math
// functions. It is parsed into a tree and walked — nothing is ever handed to JavaScript's eval or Function, no
// property of any object is looked up by the text, and any other name or call makes the whole expression refused
// (the importer then skips what used it and says so in its report).

export type Val = number | boolean;
type Node =
  | { k: 'n'; v: Val }
  | { k: 'v'; name: string }
  | { k: 'u'; op: '!' | '-'; a: Node }
  | { k: 'b'; op: string; a: Node; b: Node }
  | { k: 'f'; name: string; args: Node[] };

export class ExprError extends Error {}
export const EXPR_MAX_LEN = 512;
const MAX_TOKENS = 256; const MAX_DEPTH = 32;
const FUNCS: Record<string, { n: [number, number]; f: (a: number[], rnd: () => number) => number }> = {
  'Math.random': { n: [0, 0], f: (_a, rnd) => rnd() },
  'Math.floor': { n: [1, 1], f: (a) => Math.floor(a[0]) },
  'Math.ceil': { n: [1, 1], f: (a) => Math.ceil(a[0]) },
  'Math.round': { n: [1, 1], f: (a) => Math.round(a[0]) },
  'Math.abs': { n: [1, 1], f: (a) => Math.abs(a[0]) },
  'Math.min': { n: [1, 8], f: (a) => Math.min(...a) },
  'Math.max': { n: [1, 8], f: (a) => Math.max(...a) },
};
const OPS = ['===', '!==', '==', '!=', '<=', '>=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '!', '(', ')', ','];

function tokens(src: string): string[] {
  if (src.length > EXPR_MAX_LEN) throw new ExprError('tooLong');
  const out: string[] = []; let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+(\.\d+)?|\.\d+)([eE][-+]?\d+)?/.exec(src.slice(i, i + 40));
    if (num) { out.push(num[0]); i += num[0].length; }
    else if (/[A-Za-z_]/.test(c)) { const m = /^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*/.exec(src.slice(i, i + 120))!; out.push(m[0]); i += m[0].length; }
    else { const op = OPS.find((o) => src.startsWith(o, i)); if (!op) throw new ExprError('badChar'); out.push(op); i += op.length; }
    if (out.length > MAX_TOKENS) throw new ExprError('tooLong');
  }
  return out;
}

/** The expression's tree; `names` are the only names it may use. */
export function compile(src: string, names: ReadonlySet<string>): Node {
  const tk = tokens(src); let p = 0; let depth = 0;
  const peek = () => tk[p]; const take = () => tk[p++];
  const deeper = <T>(f: () => T): T => { if (++depth > MAX_DEPTH) throw new ExprError('tooDeep'); try { return f(); } finally { depth--; } };
  const or = (): Node => deeper(() => { let a = and(); while (peek() === '||' || peek() === 'or') { take(); a = { k: 'b', op: '||', a, b: and() }; } return a; });
  const and = (): Node => deeper(() => { let a = cmp(); while (peek() === '&&' || peek() === 'and') { take(); a = { k: 'b', op: '&&', a, b: cmp() }; } return a; });
  const cmp = (): Node => { const a = add(); const o = peek(); if (o && ['<', '<=', '>', '>=', '==', '!=', '===', '!=='].includes(o)) { take(); return { k: 'b', op: o.length === 3 ? o.slice(0, 2) : o, a, b: add() }; } return a; };
  const add = (): Node => { let a = mul(); while (peek() === '+' || peek() === '-') { const o = take(); a = { k: 'b', op: o, a, b: mul() }; } return a; };
  const mul = (): Node => { let a = un(); while (peek() === '*' || peek() === '/' || peek() === '%') { const o = take(); a = { k: 'b', op: o, a, b: un() }; } return a; };
  const un = (): Node => deeper(() => { const o = peek(); if (o === '!' || o === 'not') { take(); return { k: 'u', op: '!', a: un() }; } if (o === '-') { take(); return { k: 'u', op: '-', a: un() }; } if (o === '+') { take(); return un(); } return prim(); });
  const prim = (): Node => {
    const t = take();
    if (t === undefined) throw new ExprError('unexpectedEnd');
    if (t === '(') { const e = or(); if (take() !== ')') throw new ExprError('noParen'); return e; }
    if (/^[\d.]/.test(t)) { const v = Number(t); if (!Number.isFinite(v)) throw new ExprError('badNumber'); return { k: 'n', v }; }
    if (t === 'true' || t === 'false') return { k: 'n', v: t === 'true' };
    if (/^[A-Za-z_]/.test(t)) {
      if (peek() === '(') {
        const fn = Object.prototype.hasOwnProperty.call(FUNCS, t) ? FUNCS[t] : undefined; if (!fn) throw new ExprError(`unknownCall:${t}`);
        take(); const args: Node[] = [];
        if (peek() !== ')') { for (;;) { args.push(or()); if (peek() === ',') { take(); continue; } break; } }
        if (take() !== ')') throw new ExprError('noParen');
        if (args.length < fn.n[0] || args.length > fn.n[1]) throw new ExprError('arity');
        return { k: 'f', name: t, args };
      }
      if (!names.has(t)) throw new ExprError(`unknownName:${t}`);
      return { k: 'v', name: t };
    }
    throw new ExprError(`unexpected:${t}`);
  };
  const e = or(); if (p !== tk.length) throw new ExprError(`unexpected:${tk[p]}`);
  return e;
}

const num = (v: Val): number => (typeof v === 'boolean' ? (v ? 1 : 0) : v);
const truthy = (v: Val): boolean => (typeof v === 'boolean' ? v : v !== 0 && !Number.isNaN(v));
/** The tree's value with these names' values (a name missing counts as 0); `rnd` for Math.random(). */
export function evaluate(n: Node, env: Readonly<Record<string, Val>>, rnd: () => number = Math.random): Val {
  switch (n.k) {
    case 'n': return n.v;
    case 'v': { const v = Object.prototype.hasOwnProperty.call(env, n.name) ? env[n.name] : 0; return typeof v === 'number' || typeof v === 'boolean' ? v : 0; }
    case 'u': { const a = evaluate(n.a, env, rnd); return n.op === '!' ? !truthy(a) : -num(a); }
    case 'f': return FUNCS[n.name].f(n.args.map((x) => num(evaluate(x, env, rnd))), rnd);
    case 'b': {
      if (n.op === '&&') return truthy(evaluate(n.a, env, rnd)) && truthy(evaluate(n.b, env, rnd));
      if (n.op === '||') return truthy(evaluate(n.a, env, rnd)) || truthy(evaluate(n.b, env, rnd));
      const a = num(evaluate(n.a, env, rnd)), b = num(evaluate(n.b, env, rnd));
      switch (n.op) {
        case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return b === 0 ? 0 : a / b; case '%': return b === 0 ? 0 : a % b;
        case '<': return a < b; case '<=': return a <= b; case '>': return a > b; case '>=': return a >= b; case '==': return a === b; case '!=': return a !== b;
      }
      return 0;
    }
  }
}
/** Compile and evaluate once (true/false), or null when the text is refused. */
export function test(src: string, names: ReadonlySet<string>, env: Readonly<Record<string, Val>>): boolean | null {
  try { return truthy(evaluate(compile(src, names), env)); } catch { return null; }
}
export type Expr = Node;
export { truthy, num };
