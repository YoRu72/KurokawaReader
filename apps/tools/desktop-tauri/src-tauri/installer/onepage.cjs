#!/usr/bin/env node
// The installer's one screen (Tools' stage P9; the Reader's installer/onepage.cjs, stage R6b, with Tools' names), put into the NSIS installer Tauri has just built. Tauri renders its own
// installer script (target/<…>/release/nsis/<arch>/installer.nsi, its template filled in) and compiles it with its own
// copy of NSIS; this script changes only the PAGES of that rendered script and compiles it again with the same NSIS,
// so every file, registry entry, file type, shortcut, WebView2 step and the uninstaller stay Tauri's own:
//   1. `Page custom KrOnePage KrOnePageLeave` (installer/onepage.nsh) put before Tauri's first page;
//   2. each of Tauri's installer pages that a person would click through (welcome, licence, folder, Start-menu folder,
//      components, finish) given a PRE function that skips it once the one screen was used — calling the page's own
//      PRE function first-hand when it had one —; the progress page stays (it closes by itself);
//   3. `Call KrAfterInstall` first in .onInstSuccess (the screen's choices: no desktop shortcut, no file types, open the
//      app);
//   4. the screen's words (installer/onepage-lang.nsh) after Tauri's MUI_LANGUAGE lines.
// Then the new installer is copied over the one in target/<…>/release/bundle/nsis/.
//
// Guarded: when the rendered script is not as expected (no PassiveMode variable, no .onInstSuccess, no progress page,
// no output file…), nothing is changed and Tauri's own installer is kept — with a warning, or (--strict, CI) a failure.
//   node installer/onepage.cjs <src-tauri dir> [--strict]
//   node installer/onepage.cjs --transform <in.nsi> <out.nsi>    (the change alone, no NSIS: tests/installerpatch.cjs)
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HERE = __dirname;
const PAGE = /^\s*(?:!insertmacro\s+MUI_PAGE_\w+|Page\s+custom\b)/i;
const SKIPPED = /^\s*!insertmacro\s+MUI_PAGE_(WELCOME|LICENSE|DIRECTORY|STARTMENU|COMPONENTS|FINISH)\b/i;
const PRE = /^(\s*)!define\s+MUI_PAGE_CUSTOMFUNCTION_PRE\s+(\S+)\s*$/i;

/** The rendered script's text → { text, notes } with the one screen in, or throws Error(reason) when it is not as
 *  expected. `inc`: how the two include files are named in it (absolute paths in a real build). */
function transform(src, inc = { page: path.join(HERE, 'onepage.nsh'), lang: path.join(HERE, 'onepage-lang.nsh') }) {
  const bom = src.charCodeAt(0) === 0xfeff ? '\ufeff' : '';
  const nl = /\r\n/.test(src) ? '\r\n' : '\n';
  const lines = (bom ? src.slice(1) : src).split(/\r?\n/);
  const find = (re) => lines.findIndex((l) => re.test(l));
  if (lines.some((l) => /KrOnePage/.test(l))) throw new Error('already has the one screen');
  const need = [
    [/^\s*Var\s+(?:\/GLOBAL\s+)?PassiveMode\b/i, 'no PassiveMode variable'],
    [/^\s*Function\s+\.onInstSuccess\b/i, 'no .onInstSuccess function'],
    [/^\s*!insertmacro\s+MUI_PAGE_INSTFILES\b/i, 'no progress page'],
    [/^\s*!define\s+OUTFILE\s+"[^"]+"/i, 'no OUTFILE'],
    [/^\s*!define\s+PRODUCTNAME\s+"/i, 'no PRODUCTNAME'],
    [/^\s*!define\s+MAINBINARYNAME\s+"/i, 'no MAINBINARYNAME'],
    [/^\s*!insertmacro\s+MUI_LANGUAGE\b/i, 'no MUI_LANGUAGE'],
  ];
  for (const [re, why] of need) if (find(re) < 0) throw new Error(why);
  const first = find(PAGE);
  if (first < 0) throw new Error('no page');
  if (find(/^\s*Var\s+(?:\/GLOBAL\s+)?PassiveMode\b/i) > first) throw new Error('PassiveMode declared after the pages');
  // (Put at the top level: before the conditional block the first page may sit in.)
  let depth = 0, at = first, top = 0;
  for (let i = 0; i < first; i++) {
    if (depth === 0) top = i;
    const l = lines[i].trim();
    if (/^!if(def|ndef|macrodef|macrondef)?\b/i.test(l)) depth++;
    else if (/^!endif\b/i.test(l)) depth = Math.max(0, depth - 1);
  }
  if (depth > 0) at = top;
  // (Before Tauri's pages: also before the defines that belong to its first page.)
  while (at > 0 && /^\s*!define\s+MUI_(PAGE|WELCOMEPAGE|LICENSEPAGE|DIRECTORYPAGE|STARTMENUPAGE|COMPONENTSPAGE|FINISHPAGE|INSTFILESPAGE)_/i.test(lines[at - 1])) at--;
  const wrappers = [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === at) out.push('; (Kurokawa Tools, P9: the one screen — installer/onepage.nsh, put here by installer/onepage.cjs.)', `!include "${inc.page}"`, 'Page custom KrOnePage KrOnePageLeave');
    const l = lines[i];
    if (SKIPPED.test(l)) {
      const n = wrappers.length + 1;
      // (The page's own PRE function, defined among the lines since the previous page.)
      let own = null;
      for (let j = out.length - 1; j >= 0; j--) {
        if (PAGE.test(out[j]) || /^\s*!include\s/.test(out[j])) break;
        const m = PRE.exec(out[j]);
        if (m) { own = m[2]; out[j] = `${m[1]}!define MUI_PAGE_CUSTOMFUNCTION_PRE KrPre_${n}`; break; }
      }
      if (!own) out.push(`!define MUI_PAGE_CUSTOMFUNCTION_PRE KrPre_${n}`);
      wrappers.push({ n, own, page: SKIPPED.exec(l)[1].toUpperCase() });
    }
    out.push(l);
    if (/^\s*Function\s+\.onInstSuccess\b/i.test(l)) out.push('  Call KrAfterInstall');
  }
  out.push('', '; (Kurokawa Tools, P9: Tauri\'s pages skipped once the one screen was used — installer/onepage.cjs.)');
  for (const w of wrappers) {
    out.push(`Function KrPre_${w.n}`, '  !insertmacro KR_SKIP_IF_ONE_PAGE');
    if (w.own) out.push(`  Call ${w.own}`);
    out.push('FunctionEnd');
  }
  out.push(`!include "${inc.lang}"`, '');
  return { text: bom + out.join(nl), notes: { at, wrappers: wrappers.map((w) => `${w.page}${w.own ? `(${w.own})` : ''}`) } };
}

function walk(dir, test, acc = []) {
  let list = [];
  try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of list) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (!/^(deps|build|incremental|\.fingerprint)$/.test(e.name)) walk(p, test, acc); } else if (test(p)) acc.push(p);
  }
  return acc;
}

/** The bundle's installers this rendered script is for: those named with its version (Tauri names them
 *  <product>_<version>_<arch>-setup.exe), else the newest one alone. */
function pickSetups(all, version) {
  const mine = version ? all.filter((p) => path.basename(p).includes(`_${version}_`)) : [];
  if (mine.length) return mine;
  return [all.slice().sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]];
}

function makensis() {
  const c = [process.env.MAKENSIS, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'makensis.exe'), process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'tauri', 'NSIS', 'Bin', 'makensis.exe'), 'C:\\Program Files (x86)\\NSIS\\makensis.exe', 'C:\\Program Files\\NSIS\\makensis.exe'].filter(Boolean);
  for (const p of c) if (fs.existsSync(p)) return p;
  return 'makensis';
}

function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--transform') {
    const r = transform(fs.readFileSync(args[1], 'utf8'));
    fs.writeFileSync(args[2], r.text);
    console.log(JSON.stringify(r.notes));
    return 0;
  }
  const strict = args.includes('--strict');
  const root = path.resolve(args.find((a) => !a.startsWith('--')) || path.join(HERE, '..'));
  const say = (msg) => { console.log(`${strict ? '::error::' : '::warning::'}one-page installer not applied: ${msg} — Tauri's own installer is kept.`); return strict ? 1 : 0; };
  const nsis = walk(path.join(root, 'target'), (p) => /[\\/]nsis[\\/][^\\/]+[\\/]installer\.nsi$/.test(p)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  if (!nsis.length) return say('no rendered installer.nsi under target/');
  let done = 0;
  for (const nsi of nsis) {
    const dir = path.dirname(nsi);
    const src = fs.readFileSync(nsi, 'utf8');
    let r;
    try { r = transform(src); } catch (e) { return say(`${nsi}: ${e.message}`); }
    const out = /^\s*!define\s+OUTFILE\s+"([^"]+)"/im.exec(src)[1];
    const outFile = path.isAbsolute(out) ? out : path.join(dir, out);
    const patched = path.join(dir, 'installer.kr.nsi');
    fs.writeFileSync(patched, r.text);
    const started = Date.now();
    const run = spawnSync(makensis(), ['-V2', '-INPUTCHARSET', 'UTF8', patched], { cwd: dir, encoding: 'utf8', maxBuffer: 64 << 20 });
    process.stdout.write(run.stdout || ''); process.stderr.write(run.stderr || '');
    if (run.status !== 0) return say(`makensis failed (${run.error ? run.error.message : 'exit ' + run.status}) on ${patched}`);
    // (The bundle's installer replaced by the new one: target/<…>/release/bundle/nsis/*-setup.exe beside this nsis/.)
    const bundle = path.join(dir, '..', '..', 'bundle', 'nsis');
    // (Only this script's version's: an earlier build's installer beside it — CI's installtest.ps1 builds a second,
    // higher version into the same folder — is left as it is.)
    const all = walk(bundle, (p) => /-setup\.exe$/i.test(p));
    if (!all.length) return say(`no setup .exe in ${bundle}`);
    const version = (/^\s*!define\s+VERSION\s+"([^"]+)"/im.exec(src) || [])[1];
    const setups = pickSetups(all, version);
    for (const s of setups) if (path.resolve(s) !== path.resolve(outFile)) fs.copyFileSync(outFile, s);
    const mb = (fs.statSync(setups[0]).size / 1048576).toFixed(2);
    console.log(`one-page installer: applied to ${setups.map((s) => path.basename(s)).join(', ')} (${mb} MB, compiled in ${((Date.now() - started) / 1000).toFixed(1)} s); first page at line ${r.notes.at + 1}; Tauri's pages skipped: ${r.notes.wrappers.join(', ') || 'none'}`);
    done++;
  }
  return done ? 0 : say('nothing done');
}

if (require.main === module) process.exit(main());
module.exports = { transform, pickSetups };
