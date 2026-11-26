#!/usr/bin/env node
// Prepares a release of one app in one go, so the last step is not a hand edit: every version field of the app
// bumped the same way, the notes file for that version made from a template when it is not there yet, parity checked,
// and what changed printed. Plain Node, no dependencies. Dry run unless --write is given.
//
//   node scripts/release-prep.mjs <tools|reader> <version>                 what would change (nothing is written)
//   node scripts/release-prep.mjs <tools|reader> <version> --write         do it
//   node scripts/release-prep.mjs <tools|reader> <version> --write --drop work-t21-pets,work-t21-rust
//                                                  drop the notes lines tagged with a branch that did not make the release
//   node scripts/release-prep.mjs <tools|reader> <version> --write --finish
//                                                  remove the branch markers that are left (they are HTML comments, so
//                                                  they never show, but the release check refuses a notes file with them)
//
// Version fields of an app (docs/RELEASING.md step 2): apps/<app>/package.json and apps/<app>/desktop/package.json.
// The Tauri shells read the version from package.json (tauri.conf.json «../../package.json»), the Android build derives
// versionName and versionCode from it (native/android/overlay.mjs), and the Cargo crates stay at their own numbers;
// the script checks that the Tauri configs still point at package.json and says so when one does not.
//
// Notes markers (docs/notes/v<version>.md): a bullet or a heading may end with «<!-- branch: work-t21-anime -->»
// (several branches: «<!-- branch: a, b -->» — the line needs all of them). --drop removes that bullet (the line and
// the lines indented under it) or that section (a heading and everything up to the next heading of the same or higher
// level). Run it with --drop for every branch that is NOT in the release, then with --finish.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = process.env.RELEASE_PREP_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const app = argv.find((a) => a === 'tools' || a === 'reader');
const version = argv.find((a) => /^\d+\.\d+\.\d+$/.test(a));
const WRITE = argv.includes('--write'), FINISH = argv.includes('--finish');
const dropIdx = argv.indexOf('--drop');
const DROP = dropIdx >= 0 ? String(argv[dropIdx + 1] || '').split(',').map((s) => s.trim()).filter(Boolean) : [];
if (!app || !version) { console.error('usage: node scripts/release-prep.mjs <tools|reader> <x.y.z> [--write] [--drop <branch,...>] [--finish]'); process.exit(2); }

const dir = path.join(ROOT, 'apps', app);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const log = []; const problems = [];
const say = (s) => { log.push(s); console.log(s); };
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i]; return 0; };
const VERSION_RE = /("version"\s*:\s*")([^"]*)(")/;

// ---------- 1. every version field ----------
const files = [path.join(dir, 'package.json'), path.join(dir, 'desktop', 'package.json')];
const planned = [];
for (const f of files) {
  if (!fs.existsSync(f)) { problems.push(`${rel(f)} is missing`); continue; }
  const text = fs.readFileSync(f, 'utf8'); const m = text.match(VERSION_RE);
  if (!m) { problems.push(`${rel(f)} has no "version" field`); continue; }
  planned.push({ f, text, old: m[2], next: text.replace(VERSION_RE, `$1${version}$3`) });
}
const olds = new Set(planned.map((p) => p.old));
if (olds.size > 1) say(`note: the version fields differ now (${[...olds].join(' vs ')}); both go to ${version}`);
for (const p of planned) if (cmp(p.old, version) > 0) problems.push(`${rel(p.f)} is at ${p.old}, higher than ${version}: refusing to go backwards`);
// (The Tauri configs and the Android overlay follow package.json: confirm that they still do.)
for (const c of [path.join(dir, 'desktop-tauri', 'src-tauri', 'tauri.conf.json'), path.join(dir, 'desktop-tauri', 'setup', 'src-tauri', 'tauri.conf.json')]) {
  if (!fs.existsSync(c)) continue; const m = fs.readFileSync(c, 'utf8').match(VERSION_RE);
  if (m && !/package\.json$/.test(m[2])) problems.push(`${rel(c)} carries its own version «${m[2]}» instead of reading package.json: bump it by hand`);
}

// ---------- 2. the notes file ----------
const notesPath = path.join(dir, 'docs', 'notes', `v${version}.md`);
const TEMPLATE = `### Fixes
- **«—»** (what was wrong, in plain words, and what it does now) <!-- branch: work-... -->

### New
- **«—»** (one line each; say what you can do now) <!-- branch: work-... -->

### What we ask you to try
These parts were built and tested on a computer and need a real phone or a real computer:
- «—»
`;
let notesText = fs.existsSync(notesPath) ? fs.readFileSync(notesPath, 'utf8') : null;
let notesNext = notesText;
if (notesText === null) { notesNext = TEMPLATE; say(`create ${rel(notesPath)} from the template (it holds «—» placeholders on purpose: the preflight and the release check refuse it until it is written)`); }
if (DROP.length || FINISH) {
  if (notesText === null) problems.push(`${rel(notesPath)} does not exist: nothing to drop or finish`);
  else { const r = editNotes(notesNext, DROP, FINISH); notesNext = r.text; for (const l of r.said) say(l); for (const l of r.refuse) problems.push(l); }
}

// ---------- 3. report, write, verify ----------
for (const p of planned) say(`${rel(p.f)}: "version" ${p.old} -> ${version}${p.old === version ? ' (already)' : ''}`);
if (notesText !== null && notesNext !== notesText) say(`${rel(notesPath)}: ${notesText.split('\n').length} -> ${notesNext.split('\n').length} lines`);
if (problems.length) { for (const p of problems) console.error('PROBLEM: ' + p); console.error(`release-prep: ${problems.length} problem(s); nothing written`); process.exit(1); }

if (!WRITE) { console.log(`\ndry run: nothing written. Add --write to apply.`); process.exit(0); }
for (const p of planned) if (p.next !== p.text) fs.writeFileSync(p.f, p.next);
if (notesNext !== notesText) { fs.mkdirSync(path.dirname(notesPath), { recursive: true }); fs.writeFileSync(notesPath, notesNext); }
// parity read back from disk
const back = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')).version);
if (back.some((v) => v !== version)) { console.error(`PROBLEM: after writing, the version fields read ${back.join(', ')}, not ${version}`); process.exit(1); }
const stillOpen = fs.readFileSync(notesPath, 'utf8');
const left = [];
if (stillOpen.includes('«—»')) left.push('«—» placeholders');
if (/<!--\s*branch\s*:/i.test(stillOpen)) left.push('branch markers (run again with --drop <branches not in the release> and then --finish)');
console.log(`\nwritten. Parity: ${files.map(rel).join(' = ')} = ${version}.`);
if (left.length) console.log(`The notes still have ${left.join(' and ')}: node scripts/release-check.mjs ${app} refuses them until they are gone.`);
else console.log(`Next: node scripts/release-check.mjs ${app} && node scripts/preflight.mjs ${app}`);

// ---------- notes editing ----------
function editNotes(text, drop, finish) {
  const lines = text.split('\n'); const said = []; const keep = []; let i = 0;
  const MARK = /\s*<!--\s*branch\s*:\s*([^>]*?)\s*-->/i;
  const branchesOf = (l) => { const m = l.match(MARK); return m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : []; };
  while (i < lines.length) {
    const l = lines[i]; const bs = branchesOf(l); const hit = bs.filter((b) => drop.includes(b));
    if (hit.length) {
      const head = l.match(/^(#{1,6})\s/);
      let j = i + 1;
      if (head) { while (j < lines.length && !(lines[j].match(/^(#{1,6})\s/) && lines[j].match(/^(#+)/)[1].length <= head[1].length)) j++; }
      else { while (j < lines.length && (/^\s{2,}\S/.test(lines[j]) || (lines[j].trim() === '' && j + 1 < lines.length && /^\s{2,}\S/.test(lines[j + 1])))) j++; }
      said.push(`drop (${hit.join(', ')}): ${l.replace(MARK, '').slice(0, 90)}${j - i > 1 ? `  [+${j - i - 1} lines under it]` : ''}`);
      i = j; continue;
    }
    keep.push(finish ? l.replace(MARK, '') : l); i++;
  }
  let out = keep.join('\n').replace(/\n{3,}/g, '\n\n');
  // A heading left with nothing under it goes too. «Nothing» means no text and no sub-heading that stays: a «## New» that is
  // followed directly by «### …» sub-headings (with text under them) is NOT empty. Taken in rounds, deepest first: removing an
  // empty «### A» can leave its «## New» empty, and that goes in the next round.
  const parts = out.split('\n'); const removed = new Set(); const dropped = [];
  const levelOf = (l) => { const m = l.match(/^(#{1,6})\s/); return m ? m[1].length : 0; };
  const sectionEnd = (k) => { const lv = levelOf(parts[k]); let n = k + 1; while (n < parts.length && !(levelOf(parts[n]) && levelOf(parts[n]) <= lv)) n++; return n; }; // up to the next heading of the same or a higher level
  for (let again = true; again;) {
    again = false;
    for (let k = parts.length - 1; k >= 0; k--) {
      if (removed.has(k) || !levelOf(parts[k])) continue;
      let live = false; for (let n = k + 1; n < sectionEnd(k); n++) if (!removed.has(n) && parts[n].trim() !== '') { live = true; break; }
      if (!live) { removed.add(k); dropped.push(k); again = true; said.push(`empty section removed: ${parts[k]}`); }
    }
  }
  // the guard: nothing this cleanup removed may have had text, or a sub-heading that stays, under it
  const refuse = [];
  for (const k of dropped) for (let n = k + 1; n < sectionEnd(k); n++) if (!removed.has(n) && parts[n].trim() !== '') { refuse.push(`would drop «${parts[k]}» but line ${n + 1} («${parts[n].slice(0, 60)}») is under it`); break; }
  const cleaned = parts.filter((_, k) => !removed.has(k));
  out = cleaned.join('\n'); if (!out.endsWith('\n')) out += '\n';
  // what stays: the headings of the result, printed before anything is written
  const keptHeadings = out.split('\n').filter((l) => levelOf(l));
  said.push(`headings kept (${keptHeadings.length}): ${keptHeadings.map((l) => l.replace(/\s*<!--.*?-->/, '').trim()).join(' | ')}`);
  if (finish) said.push('branch markers removed');
  return { text: out, said, refuse };
}
