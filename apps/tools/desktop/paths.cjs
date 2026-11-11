// Paths on Windows, where aria2 reports files with "/" while the folder it was given keeps its "\": one place that
// makes both sides agree. Pure (the platform is a parameter) so it is tested on any system. Off Windows nothing changes.
'use strict';

/** The native form of a path: backslashes, no \\?\ prefix (\\?\UNC\s\x → \\s\x), the drive letter's case kept. Off Windows: as is. */
function nativePath(p, platform) {
  if (platform !== 'win32' || typeof p !== 'string' || !p) return p;
  let s = p.replace(/\//g, '\\');
  const unc = /^\\\\[?.]\\UNC\\/i.exec(s);
  if (unc) s = '\\\\' + s.slice(unc[0].length);
  else { const pre = /^\\\\[?.]\\/.exec(s); if (pre) s = s.slice(pre[0].length); }
  const lead = s.startsWith('\\\\') ? '\\\\' : '';
  return lead + s.slice(lead.length).replace(/\\{2,}/g, '\\');
}

/** `filePath` relative to `dir` with "/" between its parts ("Show/e1.mkv"). Windows: both made native first, the prefix compared
 *  ignoring letter case and only at a folder boundary (C:\dl2\x is not in C:\dl); a file outside dir keeps its full native path.
 *  Off Windows: the plain prefix cut, as it always was. */
function relPath(filePath, dir, platform) {
  const fp = String(filePath ?? ''); const d0 = String(dir ?? '');
  if (platform !== 'win32') return fp.startsWith(d0) ? fp.slice(d0.length).replace(/^[\\/]+/, '') : fp;
  const f = nativePath(fp, platform); const d = nativePath(d0, platform).replace(/\\+$/, '');
  if (!f) return '';
  if (d && f.slice(0, d.length).toLowerCase() === d.toLowerCase() && (f.length === d.length || f[d.length] === '\\')) return f.slice(d.length).replace(/^\\+/, '').replace(/\\/g, '/');
  return f;
}

module.exports = { nativePath, relPath };
