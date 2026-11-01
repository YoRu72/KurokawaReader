// Prism's antivirus check after a download (the computer only): Microsoft Defender's command-line scanner on
// Windows, ClamAV elsewhere, or a command of the user's own ({file} stands for the file). Only the kinds of file
// chosen are scanned. Exit codes: 0 clean; Defender 2 and ClamAV 1 mean a threat; anything else is an error.
'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { execFile } = require('node:child_process');

function inPath(exe) { for (const d of String(process.env.PATH || '').split(path.delimiter)) { const p = path.join(d, exe); try { if (fs.statSync(p).isFile()) return p; } catch { /* next */ } } return null; }
function defender() {
  if (process.platform !== 'win32') return null;
  const base = 'C:\\ProgramData\\Microsoft\\Windows Defender\\Platform';
  try { const vs = fs.readdirSync(base).map((v) => path.join(base, v, 'MpCmdRun.exe')).filter((p) => fs.existsSync(p)).sort(); if (vs.length) return vs[vs.length - 1]; } catch { /* none */ }
  const p = 'C:\\Program Files\\Windows Defender\\MpCmdRun.exe'; return fs.existsSync(p) ? p : null;
}
/** «a "b c" d» → ['a', 'b c', 'd']. */
function splitArgs(s) { const out = []; let cur = ''; let q = false; let has = false; for (const ch of String(s || '')) { if (ch === '"') { q = !q; has = true; } else if (/\s/.test(ch) && !q) { if (has) out.push(cur); cur = ''; has = false; } else { cur += ch; has = true; } } if (has) out.push(cur); return out; }
function scanner(cfg) {
  const kind = cfg.kind === 'auto' || !cfg.kind ? (process.platform === 'win32' ? 'defender' : 'clamav') : cfg.kind;
  if (kind === 'defender') { const p = defender(); return p ? { kind, exe: p, args: ['-Scan', '-ScanType', '3', '-File', '{file}', '-DisableRemediation'] } : null; }
  if (kind === 'clamav') { const p = inPath(process.platform === 'win32' ? 'clamscan.exe' : 'clamscan'); return p ? { kind, exe: p, args: ['--no-summary', '{file}'] } : null; }
  if (kind === 'custom' && String(cfg.command || '').trim()) return { kind, exe: cfg.command.trim(), args: splitArgs(cfg.args || '{file}') };
  return null;
}
function wanted(cfg, file) { const exts = (cfg.extensions || []).map((e) => String(e).trim().replace(/^\./, '').toLowerCase()).filter(Boolean); if (!exts.length) return true; const ext = path.extname(file).slice(1).toLowerCase(); return exts.includes(ext); }
/** { result: 'clean' | 'infected' | 'error' | 'skipped', detail?, scanner? } */
function scan(cfg, file) {
  return new Promise((resolve) => {
    if (!wanted(cfg, file)) { resolve({ result: 'skipped' }); return; }
    const s = scanner(cfg); if (!s) { resolve({ result: 'error', detail: 'no-scanner' }); return; }
    const args = s.args.map((a) => a.replace('{file}', file));
    execFile(s.exe, args, { windowsHide: true, timeout: 10 * 60000, maxBuffer: 4 << 20 }, (err, out, errOut) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      const detail = `${out || ''}${errOut || ''}`.split(/\r?\n/).filter((l) => l.trim()).slice(0, 6).join('\n');
      const threat = s.kind === 'defender' ? code === 2 : s.kind === 'clamav' ? code === 1 : code !== 0 && code !== -1;
      resolve(code === 0 ? { result: 'clean', scanner: s.kind } : threat ? { result: 'infected', detail, scanner: s.kind } : { result: 'error', detail: detail || (err && err.message) || `exit ${code}`, scanner: s.kind });
    });
  });
}
/** Which scanner «auto» would use here, for Settings. */
function available() { return { defender: !!defender(), clamav: !!inPath(process.platform === 'win32' ? 'clamscan.exe' : 'clamscan'), platform: process.platform }; }
module.exports = { scan, available, splitArgs };
