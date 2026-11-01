// The source checked for a temporal-dead-zone error (the «Cannot access 'b' before initialization» the + button
// once threw).
// Finds functions that read a let/const of their enclosing block and are called (directly, not from another
// nested function) earlier in that block than the variable's declaration — a temporal-dead-zone error at run time.
const ROOT = require('path').join(__dirname, '..'); process.argv[2] = ROOT; // (The parser of TypeScript 6 — TypeScript 7, the native one, has no JavaScript API: CI installs it as ts-api.)
const ts = ['ts-api', 'typescript'].map((n) => { try { return require(require.resolve(n, { paths: [ROOT, process.cwd()] })); } catch { return null; } }).find((x) => x && x.createSourceFile); if (!ts) { console.log('no TypeScript parser: npm install --no-save ts-api@npm:typescript@6'); process.exit(1); } let found = 0; const fs = require('fs'); const path = require('path');
const files = []; (function walk(d) { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f)) files.push(p); } })(process.argv[2] + '/src');
for (const file of files) {
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const line = (n) => sf.getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const visitBlock = (stmts) => {
    const decls = new Map(); // name -> pos
    const fns = new Map();   // fn name -> body node
    for (const s of stmts) {
      if (ts.isVariableStatement(s) && (s.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const))) for (const d of s.declarationList.declarations) {
        const names = []; const grab = (b) => { if (ts.isIdentifier(b)) names.push(b.text); else if (b.elements) b.elements.forEach((e) => e.name && grab(e.name)); }; grab(d.name);
        for (const n of names) decls.set(n, d.getStart());
        // (An async function reads its variables after its first await, by when they exist: left out.)
        if (ts.isIdentifier(d.name) && d.initializer && (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer)) && !(d.initializer.modifiers || []).some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)) fns.set(d.name.text, d.initializer);
      }
      if (ts.isFunctionDeclaration(s) && s.name) fns.set(s.name.text, s);
    }
    // what each function reads (names only, from its whole body)
    const reads = new Map(); for (const [n, f] of fns) { const set = new Set(); const body = f.body; const v = (x) => { if (ts.isFunctionLike(x)) return; if (ts.isIdentifier(x)) set.add(x.text); ts.forEachChild(x, v); }; if (body) ts.forEachChild(body, v), ts.isExpression(body) && v(body); reads.set(n, set); }
    // closure: f reads g (a function) → reads what g reads
    for (let i = 0; i < 4; i++) for (const [n, set] of reads) for (const g of [...set]) if (reads.has(g) && g !== n) for (const x of reads.get(g)) set.add(x);
    // direct calls at this block's level (not inside nested functions)
    for (const s of stmts) {
      const v = (x) => {
        if (ts.isFunctionLike(x) && x !== s) return;
        if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && reads.has(x.expression.text)) {
          for (const r of reads.get(x.expression.text)) { const at = decls.get(r); if (at !== undefined && at > x.getStart() && r !== x.expression.text) { found++; console.log(`${path.relative(process.argv[2], file)}:${line(x)} ${x.expression.text}() reads ${r} declared at line ${sf.getLineAndCharacterOfPosition(at).line + 1}`); } }
        }
        ts.forEachChild(x, v);
      };
      if (ts.isFunctionDeclaration(s)) continue; v(s);
    }
  };
  const all = (n) => { if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n)) visitBlock(n.statements); ts.forEachChild(n, all); };
  all(sf);
}
if (found) { console.log(`${found} read(s) before the declaration`); process.exit(1); } console.log('all passed');
