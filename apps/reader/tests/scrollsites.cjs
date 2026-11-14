// node tests/scrollsites.cjs [file]: every scroll of the flowing reader's text goes through one of its two helpers
// (src/views/reader.ts): `readerScroll` — on the reader's behalf (a page turned by a key, a volume key or a tap zone, a
// contents entry, a search hit, read-aloud following, the auto-scroll): theirs — and `placeScroll` — the reader's own
// placing (a place restored or held, a chapter shown from its top). A scroll written straight to the scroller anywhere
// else is neither: the place-keeping («held through layout changes») would take it for the engine's and put the text
// back (a volume key's page turn did so). A source check: the scroller's offset written (scrollTop =, +=, -=),
// scrollBy, scrollTo, and scrollIntoView on anything in the text are looked for outside the two helpers' bodies; and no
// other module writes to the reader's scroller. (The lists of panels — the contents, the pages strip — scroll their
// own boxes: allowed by name.)
const fs = require('fs'); const path = require('path');
const SRC = path.resolve(__dirname, '../src');
const file = process.argv[2] ? path.resolve(process.argv[2]) : path.join(SRC, 'views/reader.ts');
let fails = 0; const ok = (n, c, x) => { console.log((c ? 'ok   ' : 'FAIL ') + n + (c || x === undefined ? '' : '  ' + JSON.stringify(x, null, 1).slice(0, 2000))); if (!c) fails++; };

const text = fs.readFileSync(file, 'utf8'); const lines = text.split('\n');
// The two helpers' bodies: from `const readerScroll = (` / `const placeScroll = (` to their closing `};` at the same indent.
const bodies = [];
for (const name of ['readerScroll', 'placeScroll']) {
  const i = lines.findIndex((l) => new RegExp(`^(\\s*)const ${name} = \\(`).test(l));
  ok(`the helper ${name} is there`, i >= 0);
  if (i < 0) continue;
  const indent = /^(\s*)/.exec(lines[i])[1];
  let j = i; while (j < lines.length && !(lines[j].startsWith(indent + '};') && j > i)) j++;
  bodies.push([i, j]);
}
const inHelper = (n) => bodies.some(([a, b]) => n >= a && n <= b);
// (Comments left out: a line's code only.)
const code = (l) => l.replace(/\/\/.*$/, '');
const WRITE = /\bscroll\.scroll(Top|Left)\s*(=|\+=|-=)(?!=)|\bscroll\.scroll(By|To)\s*\(/;
const INTO = /scrollIntoView\s*\(/;
// (Panel lists scrolling their own boxes, by what they are called on.)
const PANEL = /(body|overlay|list)\.querySelector\(['"]\.(current|page-cell\.current)['"]\)\?\.scrollIntoView/;
const stray = [];
lines.forEach((l, n) => {
  const c = code(l);
  if (WRITE.test(c) && !inHelper(n)) stray.push(`${path.basename(file)}:${n + 1}: ${l.trim().slice(0, 160)}`);
  if (INTO.test(c) && !PANEL.test(c)) stray.push(`${path.basename(file)}:${n + 1}: ${l.trim().slice(0, 160)}`);
});
ok('every scroll of the text goes through readerScroll or placeScroll', stray.length === 0, stray);

// No other module writes to the reader's scroller (it is handed only to modules that read it).
if (!process.argv[2]) {
  const others = [];
  const walk = (d) => { for (const f of fs.readdirSync(d)) { const p = path.join(d, f); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.ts$/.test(f) && p !== file) { const t = fs.readFileSync(p, 'utf8'); if (/reader-scroll/.test(t) && /\.scroll(Top|Left)\s*(=|\+=|-=)(?!=)|\.scroll(By|To)\s*\(/.test(t.replace(/\/\/.*$/gm, ''))) others.push(path.relative(SRC, p)); } } };
  walk(SRC);
  // (The PDF view has its own scroller and its own place-keeping: formats/pdf.ts, views/pdfview.)
  const allowed = new Set(['formats/pdf.ts']);
  const bad = others.filter((f) => !allowed.has(f));
  ok('no other module writes to the reader\'s scroller', bad.length === 0, bad);
}

console.log(fails ? `scrollsites: ${fails} failed` : 'scrollsites: ok');
process.exit(fails ? 1 : 0);
