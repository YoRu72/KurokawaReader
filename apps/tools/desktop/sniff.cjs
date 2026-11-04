// What a file really is, from its first bytes (and, for a ZIP, what is inside): sites that send everything as
// «application/octet-stream» or name it «file.bin» get their files their right extension once they are here.
// (The same rules as the Android engine's KrDownloader.sniffExt / withSniffed; the page has a copy for probing.)
'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** The extension the bytes say, or null when they say nothing known. */
function sniffBytes(b) {
  if (!b || b.length < 4) return null;
  const head = b.toString('latin1', 0, Math.min(b.length, 4096));
  if (head.startsWith('PK\x03\x04') || head.startsWith('PK\x05\x06')) return 'zip';
  if (head.startsWith('%PDF')) return 'pdf';
  if (head.startsWith("7z\xbc\xaf'\x1c")) return '7z';
  if (head.startsWith('Rar!')) return 'rar';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gz';
  if (head.startsWith('\xfd7zXZ')) return 'xz';
  if (head.startsWith('BZh')) return 'bz2';
  if (b.length >= 12 && head.startsWith('ftyp', 4)) { const brand = head.slice(8, 12); return brand.startsWith('M4A') ? 'm4a' : brand.startsWith('qt') ? 'mov' : brand.startsWith('hei') || brand.startsWith('mif1') ? 'heic' : brand.startsWith('avif') ? 'avif' : brand.startsWith('3gp') ? '3gp' : 'mp4'; }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return head.includes('webm') ? 'webm' : 'mkv';
  if (head.startsWith('OggS')) return head.includes('OpusHead') ? 'opus' : 'ogg';
  if (head.startsWith('fLaC')) return 'flac';
  if (head.startsWith('ID3') || (b[0] === 0xff && (b[1] & 0xe6) === 0xe2)) return 'mp3';
  if (b.length >= 12 && head.startsWith('RIFF')) { const k = head.slice(8, 12); return k === 'WAVE' ? 'wav' : k === 'AVI ' ? 'avi' : k === 'WEBP' ? 'webp' : null; }
  if (head.startsWith('\x89PNG')) return 'png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (head.startsWith('GIF8')) return 'gif';
  if (head.startsWith('#EXTM3U')) return 'm3u8';
  if (head.startsWith('d8:announce') || head.startsWith('d13:announce') || (head.startsWith('d') && head.includes('4:infod'))) return 'torrent';
  if (head.startsWith('MZ')) return 'exe';
  if (head.startsWith('\x7fELF')) return null;
  if (head.startsWith('G') && b.length > 376 && b[188] === 0x47 && b[376] === 0x47) return 'ts';
  if (head.startsWith('<!DOCTYPE html') || head.startsWith('<html') || /^\s*<(!doctype html|html)/i.test(head)) return 'html';
  if (head.startsWith('{') || head.startsWith('[')) { try { JSON.parse(head.length < 4096 ? head : ''); return 'json'; } catch { return null; } }
  if (head.startsWith('<?xml')) return 'xml';
  if (head.startsWith('WEBVTT')) return 'vtt';
  if (/^1\r?\n\d\d:\d\d:\d\d,\d{3} -->/.test(head)) return 'srt';
  if (head.startsWith('[Script Info]')) return 'ass';
  return null;
}

/** A ZIP's kind from its entry names: an APK, an app bundle, an e-book, an Office file, comics, or a ZIP. */
function zipKind(names, sniffMime) {
  let manifest = false, dex = false, apks = false, xapk = false, apkm = false, word = false, xl = false, ppt = false, cbz = true, files = 0;
  for (const nm of names) {
    const low = nm.toLowerCase();
    if (nm === 'AndroidManifest.xml') manifest = true; else if (nm === 'classes.dex' || nm === 'resources.arsc') dex = true;
    else if (low.endsWith('.apk')) apks = true; else if (nm === 'manifest.json') xapk = true; else if (nm === 'info.json') apkm = true;
    else if (nm.startsWith('word/')) word = true; else if (nm.startsWith('xl/')) xl = true; else if (nm.startsWith('ppt/')) ppt = true;
    if (!nm.endsWith('/')) { files++; if (!/\.(jpe?g|png|webp|gif|avif|xml|txt|json)$/.test(low)) cbz = false; }
  }
  if (manifest && dex) return 'apk';
  if (apks) return xapk ? 'xapk' : apkm ? 'apkm' : 'apks';
  if (sniffMime === 'epub') return 'epub';
  if (names.includes('mimetype') && names.some((n) => n.startsWith('OEBPS/') || n.endsWith('.opf'))) return 'epub';
  if (word) return 'docx'; if (xl) return 'xlsx'; if (ppt) return 'pptx';
  if (cbz && files > 2) return 'cbz';
  return 'zip';
}

/** The names inside a ZIP on disk (its central directory read from the end; a ZIP64 one read as far as it goes). */
function zipNames(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size; if (size < 22) return [];
    const tailLen = Math.min(size, 65557 + 22); const tail = Buffer.alloc(tailLen); fs.readSync(fd, tail, 0, tailLen, size - tailLen);
    let eocd = -1; for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return [];
    let count = tail.readUInt16LE(eocd + 10), cdSize = tail.readUInt32LE(eocd + 12), cdOff = tail.readUInt32LE(eocd + 16);
    if ((cdOff === 0xffffffff || count === 0xffff) && eocd >= 20 && tail.readUInt32LE(eocd - 20) === 0x07064b50) {
      const z64 = Number(tail.readBigUInt64LE(eocd - 12)); const zb = Buffer.alloc(56); fs.readSync(fd, zb, 0, 56, z64);
      count = Number(zb.readBigUInt64LE(32)); cdSize = Number(zb.readBigUInt64LE(40)); cdOff = Number(zb.readBigUInt64LE(48));
    }
    const cd = Buffer.alloc(Math.min(cdSize, 8 << 20)); const got = fs.readSync(fd, cd, 0, cd.length, cdOff);
    const names = []; let p = 0;
    while (p + 46 <= got && names.length < count && cd.readUInt32LE(p) === 0x02014b50) {
      const n = cd.readUInt16LE(p + 28), m = cd.readUInt16LE(p + 30), k = cd.readUInt16LE(p + 32);
      names.push(cd.toString('utf8', p + 46, p + 46 + n)); p += 46 + n + m + k;
    }
    return names;
  } finally { fs.closeSync(fd); }
}

/** What the finished file at `file` really is: its extension, or null. */
function sniffFile(file) {
  let b; try { const fd = fs.openSync(file, 'r'); try { b = Buffer.alloc(4096); const n = fs.readSync(fd, b, 0, 4096, 0); b = b.subarray(0, n); } finally { fs.closeSync(fd); } } catch { return null; }
  const ext = sniffBytes(b);
  if (ext !== 'zip') return ext;
  let names = []; try { names = zipNames(file); } catch { /* a ZIP all the same */ }
  let mime = ''; if (names.includes('mimetype')) { try { const fd = fs.openSync(file, 'r'); const h = Buffer.alloc(30); fs.readSync(fd, h, 0, 30, 0); const n = h.readUInt16LE(26), e = h.readUInt16LE(28); const m = Buffer.alloc(40); fs.readSync(fd, m, 0, 40, 30 + n + e); fs.closeSync(fd); if (m.toString('ascii').startsWith('application/epub+zip')) mime = 'epub'; } catch { /* left */ } }
  return zipKind(names, mime);
}

/** The name with the sniffed extension when its own says nothing («.bin», none, «.php»…) or only «a ZIP» of what is
 *  more (an APK, an e-book); null: keep the name. */
function withSniffed(name, ext) {
  if (!name || !ext) return null; const low = name.toLowerCase();
  if (low.endsWith('.' + ext)) return null;
  const dot = low.lastIndexOf('.'); const cur = dot > 0 ? low.slice(dot + 1) : '';
  const junk = /^(bin|dat|tmp|file|download|dl|php|aspx?|jsp|cgi|octet-stream|unknown)$/.test(cur);
  const weak = junk || !cur || !/^[a-z0-9]{1,5}$/.test(cur) || /^\d+$/.test(cur);
  const zipOf = cur === 'zip' && ext !== 'zip' && ext !== 'cbz';
  if (!weak && !zipOf) return null;
  if (ext === 'html' || ext === 'json' || ext === 'xml') return null;   // (a page or an answer in a file's place: told elsewhere)
  const stem = dot > 0 && (junk || zipOf) ? name.slice(0, dot) : name;
  return stem + '.' + ext;
}

/** A finished download renamed to what it is, when its name says nothing; the new path, or null. */
function fixName(file) {
  try {
    const ext = sniffFile(file); const nm = withSniffed(path.basename(file), ext); if (!nm) return null;
    let to = path.join(path.dirname(file), nm); let i = 2; const { name, ext: e } = path.parse(to);
    while (fs.existsSync(to)) to = path.join(path.dirname(file), `${name} (${i++})${e}`);
    fs.renameSync(file, to); return to;
  } catch { return null; }
}

module.exports = { sniffBytes, sniffFile, withSniffed, fixName, zipKind };
