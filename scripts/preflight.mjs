#!/usr/bin/env node
// Release preflight for Kurokawa Reader and Kurokawa Tools. Plain Node, no dependencies.
//
//   node scripts/preflight.mjs tools|reader|all [--quick] [options]
//
// One command that catches what used to appear only at the final push: build, type check, every test the release
// workflow runs (with the arguments it gives them), the start-JS budgets, string parity, version and notes, tests
// missing from the workflow, leftovers, big files, yellow colours. Prints a PASS/FAIL table; exits 1 on any new failure.
//
// Statuses:  PASS  ok · FAIL  new failure (exit 1) · KNOWN  listed in apps/<app>/tests/known-failures.json and failed as
//            listed · FIXED  a known failure that now passes (trim the list) · WARN  report only · SKIP  not run, with reason
//            · FLAKY  failed, then passed on --retry (exit 0, shown loudly).
//
// Options:  --quick                build, tsc, budgets, parity checks, tests touched by the diff + the smoke set
//           --only <name>          run only tests whose file name contains <name> (e.g. --only hunt)
//           --timeout-scale <n>    multiply every test's time limit (a busy or small machine; or PREFLIGHT_TIMEOUT_SCALE)
//           --port-wait <s>        how long to wait for a test's fixed port to be free (default 90)
//           --list-ports           print every test that listens on a fixed port, and exit
//           --retry                re-run a failing test once; pass on retry is shown as FLAKY
//           --no-tests             skip the tests (static checks only)
//           --base <ref>           what «new» is measured against (default origin/main, else main)
//           --write-i18n-baseline  store today's missing-string counts as the accepted baseline
//           --verbose              print more of a failing test's output, and every missing key
//           --json <file>          also write the results as JSON
//
// Tests run one after another on purpose: they use fixed ports (e.g. 5483 is taken by both filesjobs and hunt in
// Tools, 5196/5197/5199 by several pdf2docx tests in Reader) and shared temp folders, so running them in parallel
// would produce failures that are not real. Files that tell the preflight what is accepted:
//   scripts/preflight.config.json            timeouts, smoke sets, budgets, size limit, allow-lists
//   apps/<app>/tests/known-failures.json     tests that fail on the untouched baseline, with the true reason
//   apps/<app>/tests/not-in-ci.json          tests that are deliberately not in the release workflow, with a reason
//   apps/<app>/tests/i18n-baseline.json      accepted number of strings missing in each language
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const target = argv.find((a) => ['tools', 'reader', 'all'].includes(a));
if (!target) { console.error('usage: node scripts/preflight.mjs tools|reader|all [--quick] [--only name] [--retry] [--no-tests] [--base ref] [--write-i18n-baseline] [--verbose] [--json file]'); process.exit(2); }
const QUICK = flag('--quick'), RETRY = flag('--retry'), VERBOSE = flag('--verbose'), NO_TESTS = flag('--no-tests');
const ONLY = opt('--only');
const TIMEOUT_SCALE = Number(opt('--timeout-scale') || process.env.PREFLIGHT_TIMEOUT_SCALE || 1) || 1;
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return d; } };
const CONFIG = readJson(path.join(ROOT, 'scripts/preflight.config.json'), {});
const git = (args, cwd = ROOT) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 << 20 }); return r.status === 0 ? r.stdout : null; };

// ---------- what «new» means: the merge base with origin/main (or main) ----------
const BASE_REF = opt('--base') || ['origin/main', 'main'].find((r) => git(['rev-parse', '--verify', '--quiet', r]) !== null);
const BASE = BASE_REF ? (git(['merge-base', 'HEAD', BASE_REF]) || '').trim() || BASE_REF : null;
let GLOBAL_ROOT = '';
{ const r = spawnSync('npm', ['root', '-g'], { encoding: 'utf8' }); if (r.status === 0) GLOBAL_ROOT = r.stdout.trim(); }
const NODE_PATH = [process.env.NODE_PATH, GLOBAL_ROOT].filter(Boolean).join(path.delimiter);

// ---------- helpers ----------
const sec = (ms) => (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + 's';
const tail = (s, n) => s.split('\n').filter((l) => l.trim()).slice(-n).join('\n');
// Runs a command; kills the whole process group on timeout. Never throws.
function run(cmd, args, { cwd, env = {}, timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now(); let out = '', timedOut = false;
    const p = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const add = (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); };
    p.stdout.on('data', add); p.stderr.on('data', add);
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-p.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    p.on('error', (e) => { clearTimeout(timer); resolve({ code: 127, out: String(e), ms: Date.now() - t0, timedOut }); });
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: timedOut ? 124 : code, out, ms: Date.now() - t0, timedOut }); });
  });
}
const resolveFrom = (appDir, spec, load) => {
  for (const base of [appDir, ROOT, GLOBAL_ROOT]) { if (!base) continue; try { const rq = createRequire(path.join(base, 'x.js')); return load ? rq(spec) : rq.resolve(spec); } catch {} }
  return null;
};

// ---------- fixed ports and the run lock ----------
// Many tests listen on a fixed port (5480-5499, 5180-5499 in Reader, 6899). Two test runs at once (another preflight, a
// baseline run by hand, another worker on the same machine) make false failures, so: a lock file per app, and each
// test's own ports probed before it starts (waited for up to PORT_WAIT s, then a plain failure naming the port).
const PORT_WAIT = Number(opt('--port-wait') || 90);
function fixedPorts(file) {
  let src = ''; try { src = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const ports = new Set(); for (const re of [/\.listen\(\s*(\d{4,5})\b/g, /\bPORT\s*=\s*(\d{4,5})\b/g]) for (const m of src.matchAll(re)) ports.add(+m[1]);
  return [...ports];
}
const portBusy = (port) => new Promise((resolve) => { const s = net.connect({ port, host: '127.0.0.1' }); const done = (v) => { s.destroy(); resolve(v); }; s.setTimeout(400, () => done(false)); s.on('connect', () => done(true)); s.on('error', () => done(false)); });
async function waitPorts(ports) {
  const until = Date.now() + PORT_WAIT * 1000;
  for (;;) { let busy = null; for (const p of ports) if (await portBusy(p)) { busy = p; break; } if (busy === null) return null; if (Date.now() > until) return busy; await new Promise((r) => setTimeout(r, 2000)); }
}
function takeLock(app) {
  const f = path.join(os.tmpdir(), `kurokawa-preflight-${app}.lock`);
  try { const pid = +fs.readFileSync(f, 'utf8'); if (pid && pid !== process.pid) { try { process.kill(pid, 0); return { ok: false, pid }; } catch {} } } catch {}
  fs.writeFileSync(f, String(process.pid)); process.on('exit', () => { try { if (+fs.readFileSync(f, 'utf8') === process.pid) fs.unlinkSync(f); } catch {} }); return { ok: true };
}

// ---------- the per-app run ----------
async function preflight(app) {
  const APP = path.join(ROOT, 'apps', app);
  const TESTS = path.join(APP, 'tests');
  const rows = []; // { step, status, detail }
  const add = (step, status, detail = '') => { rows.push({ step, status, detail }); console.log(`  ${status.padEnd(5)} ${step}${detail ? '  — ' + detail.split('\n')[0].slice(0, 200) : ''}`); };
  const cfg = { ...(CONFIG.defaults || {}), ...(CONFIG[app] || {}) };
  const pkg = readJson(path.join(APP, 'package.json'), {});
  const version = pkg.version;
  if (!NO_TESTS && !flag('--list-ports')) { const l = takeLock(app); if (!l.ok) { add('run lock', 'FAIL', `another preflight of ${app} is running (pid ${l.pid}); two runs at once fight over the fixed test ports`); return { app, version, rows }; } }
  console.log(`\n=== ${app} ${version}${QUICK ? ' (quick)' : ''} — base ${BASE_REF || '(none)'} ===`);

  // changed files since the merge base (working tree included, untracked included)
  const changed = new Map(); // path -> A | M | D
  if (BASE) {
    for (const l of (git(['diff', '--name-status', '--no-renames', BASE, '--', `apps/${app}`, 'shared', 'scripts', '.github']) || '').split('\n')) { const m = l.match(/^([AMD])\t(.+)$/); if (m) changed.set(m[2], m[1]); }
    for (const f of (git(['ls-files', '--others', '--exclude-standard', '--', `apps/${app}`, 'shared', 'scripts', '.github']) || '').split('\n').filter(Boolean)) changed.set(f, 'A');
  }
  const addedLines = (file) => { // added lines of a file vs base: [{n, text}]
    if (!BASE) return [];
    const tracked = git(['ls-files', '--error-unmatch', file]) !== null;
    const text = tracked ? git(['diff', '-U0', '--no-renames', BASE, '--', file]) : null;
    if (!text) { try { return fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').map((t, i) => ({ n: i + 1, text: t })); } catch { return []; } }
    const out = []; let n = 0;
    for (const l of text.split('\n')) { const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)/); if (h) { n = +h[1]; continue; } if (l.startsWith('+++')) continue; if (l.startsWith('+')) out.push({ n: n++, text: l.slice(1) }); }
    return out;
  };

  // 1. build
  const b = await run('node', ['scripts/build.mjs'], { cwd: APP, env: { KR_META: '1', NODE_PATH }, timeoutMs: 300000 });
  add('build', b.code === 0 ? 'PASS' : 'FAIL', b.code === 0 ? sec(b.ms) : tail(b.out, 8));

  // 2. tsc
  const tsc = resolveFrom(APP, 'typescript/bin/tsc');
  if (!tsc) add('tsc --noEmit', 'FAIL', 'typescript not found (apps/<app>/node_modules or global)');
  else { const t = await run('node', [tsc, '--noEmit', '-p', '.'], { cwd: APP, timeoutMs: 600000 }); add('tsc --noEmit', t.code === 0 ? 'PASS' : 'FAIL', t.code === 0 ? sec(t.ms) : tail(t.out, 10)); }

  // 3. version parity + notes
  {
    const desk = readJson(path.join(APP, 'desktop/package.json'), {});
    const baseVer = BASE ? (() => { try { return JSON.parse(git(['show', `${BASE}:apps/${app}/package.json`])).version; } catch { return null; } })() : null;
    if (desk.version !== version) add('version parity', 'FAIL', `package.json ${version} ≠ desktop/package.json ${desk.version}`);
    else add('version parity', 'PASS', `${version}${baseVer ? (baseVer === version ? ` (same as ${BASE_REF})` : ` (was ${baseVer})`) : ''}`);
    if (baseVer === version && [...changed.keys()].some((f) => f.startsWith(`apps/${app}/src/`))) add('version bumped', 'WARN', `src changed but the version is still ${version} (as on ${BASE_REF})`);
    const nf = path.join(APP, 'docs/notes', `v${version}.md`);
    if (!fs.existsSync(nf)) add('release notes', 'FAIL', `missing apps/${app}/docs/notes/v${version}.md`);
    else { const t = fs.readFileSync(nf, 'utf8'); if (t.trim().length < 40) add('release notes', 'FAIL', 'notes file is empty'); else if (t.includes('«—»')) add('release notes', 'FAIL', 'contains a «—» placeholder'); else if (/\b(TODO|TBD|XXX|FIXME)\b/.test(t)) add('release notes', 'WARN', 'contains TODO/TBD/XXX/FIXME'); else add('release notes', 'PASS', `v${version}.md, ${t.split('\n').length} lines`); }
  }

  // 4. i18n parity
  {
    const ts = resolveFrom(APP, 'typescript', true);
    const keysOf = (file) => {
      const src = fs.readFileSync(file, 'utf8'); const sf = ts.createSourceFile(file, src, ts.ScriptTarget.ES2022, true);
      const keys = new Set(); let dup = 0;
      const visit = (n) => { if (ts.isVariableDeclaration(n) && n.initializer) { let o = n.initializer; while (o && (ts.isAsExpression(o) || ts.isParenthesizedExpression(o))) o = o.expression; if (o && ts.isObjectLiteralExpression(o)) { for (const p of o.properties) { const nm = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null; if (nm) { if (keys.has(nm)) dup++; keys.add(nm); } } return; } } ts.forEachChild(n, visit); };
      visit(sf); return { keys, dup };
    };
    if (!ts) add('i18n parity', 'FAIL', 'typescript not found');
    else {
      const dir = path.join(APP, 'src/i18n'); const en = keysOf(path.join(dir, 'en.ts')); const basePath = path.join(TESTS, 'i18n-baseline.json');
      const baseline = readJson(basePath, null); const now = {}; const detail = [];
      for (const lang of ['ar', 'ja', 'ko', 'zh']) { const f = path.join(dir, lang + '.ts'); if (!fs.existsSync(f)) continue; const l = keysOf(f); const missing = [...en.keys].filter((k) => !l.keys.has(k)); const extra = [...l.keys].filter((k) => !en.keys.has(k)); now[lang] = { missing: missing.length, extra: extra.length, list: missing }; }
      if (flag('--write-i18n-baseline')) {
        const out = { _: 'Accepted number of en.ts keys missing in each language (a missing key falls back to English). strict=true: a higher count fails the preflight; false: it only warns. Written by: node scripts/preflight.mjs <app> --write-i18n-baseline', date: new Date().toISOString().slice(0, 10), enKeys: en.keys.size, languages: {} };
        for (const [lang, v] of Object.entries(now)) out.languages[lang] = { missing: v.missing, strict: baseline?.languages?.[lang]?.strict ?? lang === 'ar' };
        fs.writeFileSync(basePath, JSON.stringify(out, null, 2) + '\n'); add('i18n baseline', 'PASS', `written ${path.relative(ROOT, basePath)}: ` + Object.entries(now).map(([l, v]) => `${l} ${v.missing}`).join(', '));
      } else {
        let status = 'PASS'; const notes = [];
        if (!baseline) { status = 'WARN'; notes.push('no i18n-baseline.json (run --write-i18n-baseline)'); }
        for (const [lang, v] of Object.entries(now)) {
          const bl = baseline?.languages?.[lang]; const allowed = bl ? bl.missing : 0; const strict = bl ? bl.strict : lang === 'ar';
          let s = `${lang} ${v.missing}`;
          if (v.extra) { status = 'FAIL'; s += ` (+${v.extra} keys not in en.ts)`; }
          if (v.missing > allowed) { if (strict) status = 'FAIL'; else if (status === 'PASS') status = 'WARN'; s += ` (baseline ${allowed}: ${v.missing - allowed} new${strict ? '' : ', falls back to English'})`; }
          else if (v.missing < allowed) s += ` (baseline ${allowed}: ${allowed - v.missing} fewer, lower it with --write-i18n-baseline)`;
          notes.push(s);
          if (v.missing > allowed || VERBOSE) detail.push(`${lang} missing: ${v.list.slice(0, VERBOSE ? 1e6 : 25).join(', ')}${!VERBOSE && v.list.length > 25 ? ', …' : ''}`);
        }
        add(`i18n parity (en has ${en.keys.size} keys)`, status, 'missing — ' + notes.join('; '));
        if (status !== 'PASS') for (const d of detail) console.log('        ' + d.slice(0, 700));
      }
    }
  }

  // 5. which tests the release workflow runs, and which it does not
  const wf = app === 'tools' ? 'release-tools.yml' : 'release.yml';
  const wfText = fs.readFileSync(path.join(ROOT, '.github/workflows', wf), 'utf8');
  const chain = []; // {file, args:[]}
  for (const line of wfText.split('\n')) { if (/^\s*#/.test(line)) continue; for (const m of line.matchAll(/node tests\/([\w./-]+\.cjs)((?: [\w.-]+)*)(?= *(?:&&|\)|$|;))/g)) chain.push({ file: m[1], args: m[2].trim() ? m[2].trim().split(/\s+/) : [] }); }
  const otherWf = fs.readdirSync(path.join(ROOT, '.github/workflows')).filter((f) => f.endsWith('.yml') && f !== wf).map((f) => fs.readFileSync(path.join(ROOT, '.github/workflows', f), 'utf8')).join('\n');
  const allTests = fs.readdirSync(TESTS).filter((f) => f.endsWith('.cjs')).sort();
  const known = readJson(path.join(TESTS, 'known-failures.json'), { failures: [] }).failures;
  const notInCi = readJson(path.join(TESTS, 'not-in-ci.json'), { tests: [] }).tests;
  const inChain = new Set(chain.map((c) => c.file));
  {
    const bad = [], elsewhere = [];
    for (const t of allTests) { if (inChain.has(t) || notInCi.some((n) => n.name === t)) continue; if (new RegExp(`tests/${t.replace('.', '\\.')}\\b`).test(otherWf)) elsewhere.push(t); else bad.push(t); }
    const stale = notInCi.filter((n) => inChain.has(n.name) || !allTests.includes(n.name)).map((n) => n.name);
    const noReason = notInCi.filter((n) => !n.reason).map((n) => n.name);
    const missingChain = [...new Set(chain.filter((c) => !fs.existsSync(path.join(TESTS, c.file))).map((c) => c.file))];
    if (bad.length || missingChain.length || noReason.length) add('every test is in the workflow or listed', 'FAIL', [bad.length && `not in ${wf} and not in not-in-ci.json: ${bad.join(', ')}`, missingChain.length && `the workflow runs a test that does not exist: ${missingChain.join(', ')}`, noReason.length && `not-in-ci entries without a reason: ${noReason.join(', ')}`].filter(Boolean).join('; '));
    else add('every test is in the workflow or listed', stale.length ? 'WARN' : 'PASS', `${inChain.size} in ${wf}, ${elsewhere.length} only in a check workflow, ${notInCi.length} listed as not-in-ci${stale.length ? `; stale not-in-ci entries: ${stale.join(', ')}` : ''}`);
  }

  // 6. leftovers, big files, yellow
  {
    const hits = [], mark = /^(<<<<<<<|>>>>>>>) |\b(describe|it|test)\.only\s*\(|\bdebugger\s*;|console\.log\(\s*['"`](DEBUG|XXX|TMPDEBUG)/;
    for (const [f, st] of changed) { if (st === 'D' || !/\.(ts|tsx|js|mjs|cjs|css|html|rs|java|kt|yml)$/.test(f) || /(^|\/)(node_modules|dist)\//.test(f) || f === 'scripts/preflight.mjs') continue; for (const l of addedLines(f)) if (mark.test(l.text)) hits.push(`${f}:${l.n}`); }
    add('no leftovers added (.only, debugger, merge markers)', hits.length ? 'FAIL' : 'PASS', hits.slice(0, 8).join(', '));
    const limit = (CONFIG.maxAddedFileKB || 1024) * 1024;
    const allow = (CONFIG.allowBig || []).map((g) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '§').replace(/\*/g, '[^/]*').replace(/§/g, '.*') + '$'));
    const big = [], junk = [];
    for (const [f, st] of changed) { if (st !== 'A') continue; if (/(^|\/)(node_modules|dist|dist-old)\/|\.DS_Store$|(^|\/)meta\.json$|\.log$/.test(f)) junk.push(f); try { const sz = fs.statSync(path.join(ROOT, f)).size; if (sz > limit && !allow.some((r) => r.test(f))) big.push(`${f} ${(sz / 1048576).toFixed(1)} MB`); } catch {} }
    add(`no big or junk files added (limit ${CONFIG.maxAddedFileKB || 1024} KB)`, big.length || junk.length ? 'FAIL' : 'PASS', [...big, ...junk.map((j) => 'junk: ' + j)].slice(0, 6).join(', '));
    const y = [];
    for (const [f, st] of changed) { if (st === 'D' || !/\.css$/.test(f)) continue; for (const l of addedLines(f)) if (isYellow(l.text)) y.push(`${f}:${l.n} ${l.text.trim().slice(0, 70)}`); }
    add('no yellow/amber colours added (house rule, report only)', y.length ? 'WARN' : 'PASS', y.length ? `${y.length} line(s): ${y.slice(0, 3).join(' | ')}` : '');
    if (y.length) for (const l of y.slice(0, 20)) console.log('        ' + l);
  }

  // 7. tests
  if (!NO_TESTS) {
    if (fs.existsSync(path.join(APP, 'scripts/themes.mjs')) && app === 'tools') { const th = await run('node', ['scripts/themes.mjs', '--check'], { cwd: APP }); add('themes up to date (themes.mjs --check)', th.code === 0 ? 'PASS' : 'FAIL', th.code === 0 ? '' : tail(th.out, 6)); }
    // what to run: the workflow's chain with its arguments; then tests not in the chain, run bare unless not-in-ci.json says otherwise
    const plan = chain.map((c) => ({ ...c, from: 'ci' }));
    for (const t of allTests) { if (inChain.has(t)) continue; const n = notInCi.find((x) => x.name === t); if (n && n.run === false) { plan.push({ file: t, args: [], from: 'skip', reason: n.reason }); continue; } plan.push({ file: t, args: n?.args || [], env: n?.env, from: n ? 'not-in-ci' : 'extra' }); }
    let sel = plan;
    if (ONLY) sel = plan.filter((p) => p.file.includes(ONLY));
    else if (QUICK) {
      const smoke = new Set((cfg.smoke || []).map((s) => s.split(' ')[0]));
      const touched = new Set(); const srcChanged = [...changed.keys()].filter((f) => f.startsWith(`apps/${app}/src/`) || f.startsWith('shared/'));
      for (const f of changed.keys()) { const m = f.match(new RegExp(`^apps/${app}/tests/([^/]+\\.cjs)$`)); if (m) touched.add(m[1]); }
      const needles = srcChanged.map((f) => f.replace(/^apps\/\w+\//, '')).concat(srcChanged.map((f) => path.basename(f)));
      for (const t of allTests) { let txt = ''; try { txt = fs.readFileSync(path.join(TESTS, t), 'utf8'); } catch {} if (needles.some((n) => txt.includes(n))) touched.add(t); }
      for (const bt of Object.keys(cfg.budgets || {})) smoke.add(bt);
      sel = plan.filter((p) => touched.has(p.file) || smoke.has(p.file));
      console.log(`  quick: ${sel.length} of ${plan.length} test runs (${touched.size} touched by the diff, ${smoke.size} smoke/budget)`);
    }
    const timeouts = cfg.timeoutSec || {};
    let i = 0;
    for (const p of sel) {
      i++; const label = [p.file, ...p.args].join(' '); const name = `test ${label}`;
      const kn = known.find((k) => k.name === p.file && (!k.args || k.args === p.args.join(' ')));
      if (p.from === 'skip') { add(name, 'SKIP', p.reason); continue; }
      if (kn && kn.mode === 'skip') { add(name, 'SKIP', `known: ${kn.reason}`); continue; }
      const tmo = (timeouts[p.file] || timeouts.default || 180) * 1000 * TIMEOUT_SCALE;
      const ports = fixedPorts(path.join(TESTS, p.file));
      if (ports.length) { const busy = await waitPorts(ports); if (busy !== null) { add(`${name}  (${i}/${sel.length})`, 'FAIL', `another test run is using port ${busy}; wait for it or stop it (tests/${p.file} listens on ${ports.join(', ')})`); continue; } }
      const env = { NODE_PATH }; for (const [k, v] of Object.entries(p.env || {})) env[k] = v === '$TMPZIP' ? tmpZip() : v;
      const exec = () => run('node', [path.join('tests', p.file), ...p.args], { cwd: APP, env, timeoutMs: tmo });
      let r = await exec();
      let status = r.code === 0 ? 'PASS' : 'FAIL', detail = sec(r.ms);
      if (status === 'FAIL' && RETRY && !kn) { const r2 = await exec(); if (r2.code === 0) { status = 'FLAKY'; detail = `passed on retry (first run: ${tail(r.out, 2).replace(/\n/g, ' | ').slice(0, 160)})`; r = r2; } }
      if (status === 'PASS' && /^FAIL /m.test(r.out)) { status = 'WARN'; detail = 'exit 0 but the output has FAIL lines'; }
      let shown = '';
      if (status === 'FAIL') { detail = r.timedOut ? `timed out after ${sec(tmo)}` : `exit ${r.code} after ${sec(r.ms)}`; shown = tail(r.out, VERBOSE ? 60 : 8); }
      if (kn) { if (status === 'FAIL') { status = 'KNOWN'; detail = kn.reason; shown = ''; } else if (status === 'PASS') { status = 'FIXED'; detail = 'now passes, remove it from known-failures.json'; } }
      add(`${name}  (${i}/${sel.length})`, status, detail);
      for (const l of shown.split('\n').filter(Boolean)) console.log('        ' + l.slice(0, 220));
      rows[rows.length - 1].tests = true;
      const bi = r.code === 0 && cfg.budgets && cfg.budgets[p.file];
      if (bi) { const info = budgetInfo(APP, p.file, r.out, bi); add(`budget: ${info.name}`, info.status, info.detail); }
    }
    const unmatched = known.filter((k) => !allTests.includes(k.name)).map((k) => k.name);
    if (unmatched.length) add('known-failures.json', 'WARN', `lists tests that no longer exist: ${unmatched.join(', ')}`);
  }
  return { app, version, rows };
}

// A small ZIP made here (stored entries) for the tests that want «any zip» (env value "$TMPZIP" in not-in-ci.json).
let TMPZIP = null;
function tmpZip() {
  if (TMPZIP) return TMPZIP;
  const crc32 = zlib.crc32 || ((b) => { let c, crc = ~0; for (const x of b) { c = (crc ^ x) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; crc = (crc >>> 8) ^ c; } return ~crc >>> 0; });
  const files = [['a/one.txt', Buffer.from('one\n'.repeat(500))], ['a/two.bin', Buffer.alloc(3000, 7)], ['three.txt', Buffer.from('three')]];
  const parts = [], cd = []; let off = 0;
  for (const [name, data] of files) {
    const n = Buffer.from(name), crc = crc32(data); const h = Buffer.alloc(30); h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46); c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt32LE(crc, 16); c.writeUInt32LE(data.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(off, 42);
    parts.push(h, n, data); cd.push(c, n); off += 30 + n.length + data.length;
  }
  const cdb = Buffer.concat(cd); const e = Buffer.alloc(22); e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(files.length, 8); e.writeUInt16LE(files.length, 10); e.writeUInt32LE(cdb.length, 12); e.writeUInt32LE(off, 16);
  TMPZIP = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'kr-preflight-')), 'pack.zip'); fs.writeFileSync(TMPZIP, Buffer.concat([...parts, cdb, e])); return TMPZIP;
}

// start-JS budget: the test prints the size, the limit is a constant in the test's source (see preflight.config.json)
function budgetInfo(APP, file, out, spec) {
  const m = out.match(new RegExp(spec.output, 'm')); if (!m) return { name: spec.name, status: 'WARN', detail: 'could not read the size from the test output' };
  const size = parseFloat(m[1]); let limit = null;
  try { const src = fs.readFileSync(path.join(APP, 'tests', file), 'utf8'); const c = src.match(new RegExp(spec.limit)); if (c) limit = parseFloat(c[1]); } catch {}
  if (limit === null) return { name: spec.name, status: 'WARN', detail: `${size} KB (limit not found in the test)` };
  const room = limit - size, pct = (room / limit) * 100;
  return { name: spec.name, status: room < 0 ? 'FAIL' : pct < 5 ? 'WARN' : 'PASS', detail: `${size.toFixed(1)} KB of ${limit} KB, headroom ${room.toFixed(1)} KB (${pct.toFixed(0)} %)${pct < 5 ? ', nearly full' : ''}` };
}

// yellow / amber: a hex, rgb() or hsl() colour with a hue of 35-65 degrees and real colour, or the words
function isYellow(line) {
  if (/\b(yellow|amber|gold|goldenrod|khaki)\b/i.test(line.replace(/\/\*.*?\*\//g, ''))) return true;
  const hue = (r, g, b) => { r /= 255; g /= 255; b /= 255; const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn; if (d === 0) return null; let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h = (h * 60 + 360) % 360; const l = (mx + mn) / 2, s = d / (1 - Math.abs(2 * l - 1)); return { h, s, l }; };
  const yel = (c) => c && c.h >= 35 && c.h <= 65 && c.s >= 0.45 && c.l >= 0.25 && c.l <= 0.92;
  for (const m of line.matchAll(/#([0-9a-f]{3,8})\b/gi)) { let x = m[1]; if (x.length === 3 || x.length === 4) x = x.slice(0, 3).split('').map((c) => c + c).join(''); else if (x.length >= 6) x = x.slice(0, 6); else continue; if (yel(hue(parseInt(x.slice(0, 2), 16), parseInt(x.slice(2, 4), 16), parseInt(x.slice(4, 6), 16)))) return true; }
  for (const m of line.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi)) if (yel(hue(+m[1], +m[2], +m[3]))) return true;
  for (const m of line.matchAll(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/gi)) if (+m[1] >= 35 && +m[1] <= 65 && +m[2] >= 45 && +m[3] >= 25 && +m[3] <= 92) return true;
  return false;
}

// ---------- main ----------
if (flag('--list-ports')) { // every test that listens on a fixed port, and the tests that share one
  for (const a of target === 'all' ? ['tools', 'reader'] : [target]) {
    const dir = path.join(ROOT, 'apps', a, 'tests'); const by = new Map();
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.cjs')).sort()) for (const pt of fixedPorts(path.join(dir, f))) by.set(pt, [...(by.get(pt) || []), f]);
    console.log(`${a}: fixed ports`); for (const [pt, fs_] of [...by].sort((x, y) => x[0] - y[0])) console.log(`  ${pt}  ${fs_.join(', ')}${fs_.length > 1 ? '   <-- shared' : ''}`);
  }
  process.exit(0);
}
const apps = target === 'all' ? ['tools', 'reader'] : [target];
const results = []; const t0 = Date.now();
for (const a of apps) results.push(await preflight(a));
console.log('\n================ PREFLIGHT ' + (QUICK ? '(quick) ' : '') + '================');
let fail = 0;
for (const r of results) {
  console.log(`\n${r.app} ${r.version}`);
  const w = Math.min(70, Math.max(...r.rows.map((x) => x.step.length)));
  console.log('  ' + 'RESULT'.padEnd(7) + 'STEP'.padEnd(w + 2) + 'DETAIL');
  const pass = r.rows.filter((x) => x.status === 'PASS' && x.tests);
  for (const x of r.rows.filter((x) => !(x.status === 'PASS' && x.tests))) console.log('  ' + x.status.padEnd(7) + x.step.slice(0, w).padEnd(w + 2) + (x.detail || '').split('\n')[0].slice(0, 150));
  if (pass.length) console.log('  ' + 'PASS'.padEnd(7) + `${pass.length} tests passed`);
  const count = (s) => r.rows.filter((x) => x.status === s).length;
  const f = count('FAIL'); fail += f;
  console.log(`  -- ${f} FAIL, ${count('KNOWN')} KNOWN, ${count('FIXED')} FIXED, ${count('FLAKY')} FLAKY, ${count('WARN')} WARN, ${count('SKIP')} SKIP, ${count('PASS')} PASS`);
  for (const x of r.rows.filter((x) => x.status === 'FIXED')) console.log(`  trim known-failures.json: ${x.step}`);
  for (const x of r.rows.filter((x) => x.status === 'FLAKY')) console.log(`  FLAKY: ${x.step}: ${x.detail}`);
}
console.log(`\n${fail ? 'PREFLIGHT FAILED' : 'PREFLIGHT OK'} in ${sec(Date.now() - t0)}${fail ? ` (${fail} new failure(s))` : ''}`);
const jf = opt('--json'); if (jf) fs.writeFileSync(jf, JSON.stringify({ ok: !fail, base: BASE_REF, results }, null, 2));
process.exit(fail ? 1 : 0);
