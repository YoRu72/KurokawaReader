"""Check rebuilt fonts against the PDF: shape every word the converter saw with HarfBuzz (the system library,
through ctypes) and compare the letter glyphs it picks with the ones the PDF drew.

usage: python3 fontcheck.py <out.docx> <convert log>   (the log of tests/pdf2docx/convert.cjs, which prints
"P2D check <family> [[text, [glyph ids], rtl], ...]" for every rebuilt font)
Prints, per font, how many words shape exactly as in the PDF and the commonest mismatches.
"""
import ctypes, io, json, re, sys, zipfile
from collections import Counter

hb = ctypes.CDLL('libharfbuzz.so.0')
hb.hb_blob_create.restype = ctypes.c_void_p
hb.hb_blob_create.argtypes = [ctypes.c_char_p, ctypes.c_uint, ctypes.c_int, ctypes.c_void_p, ctypes.c_void_p]
hb.hb_face_create.restype = ctypes.c_void_p
hb.hb_face_create.argtypes = [ctypes.c_void_p, ctypes.c_uint]
hb.hb_font_create.restype = ctypes.c_void_p
hb.hb_font_create.argtypes = [ctypes.c_void_p]
hb.hb_buffer_create.restype = ctypes.c_void_p
for f, a in [('hb_buffer_add_utf8', [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.c_uint, ctypes.c_int]),
             ('hb_buffer_guess_segment_properties', [ctypes.c_void_p]), ('hb_buffer_set_direction', [ctypes.c_void_p, ctypes.c_int]),
             ('hb_shape', [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint]), ('hb_buffer_destroy', [ctypes.c_void_p])]:
    getattr(hb, f).argtypes = a


class Info(ctypes.Structure):
    _fields_ = [('codepoint', ctypes.c_uint32), ('mask', ctypes.c_uint32), ('cluster', ctypes.c_uint32), ('v1', ctypes.c_uint32), ('v2', ctypes.c_uint32)]


hb.hb_buffer_get_glyph_infos.restype = ctypes.POINTER(Info)
hb.hb_buffer_get_glyph_infos.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint)]


def font(data):
    keep = ctypes.create_string_buffer(data, len(data))
    blob = hb.hb_blob_create(keep, len(data), 1, None, None)
    return hb.hb_font_create(hb.hb_face_create(blob, 0)), keep


def shape(f, text, rtl):
    b = hb.hb_buffer_create(); s = text.encode()
    hb.hb_buffer_add_utf8(b, s, len(s), 0, -1); hb.hb_buffer_guess_segment_properties(b)
    hb.hb_buffer_set_direction(b, 5 if rtl else 4)
    hb.hb_shape(f, b, None, 0)
    n = ctypes.c_uint(); info = hb.hb_buffer_get_glyph_infos(b, ctypes.byref(n))
    out = [info[i].codepoint for i in range(n.value)]
    hb.hb_buffer_destroy(b)
    return out[::-1] if rtl else out  # logical order


def fonts_of(docx):
    z = zipfile.ZipFile(docx); ft = z.read('word/fontTable.xml').decode(); rels = z.read('word/_rels/fontTable.xml.rels').decode()
    tgt = dict(re.findall(r'Id="(rId\d+)"[^>]*Target="([^"]+)"', rels)); out = {}
    for m in re.finditer(r'<w:font w:name="([^"]+)">(.*?)</w:font>', ft, re.S):
        e = re.search(r'<w:embedRegular r:id="(rId\d+)" w:fontKey="\{([^}]+)\}"', m.group(2)) or re.search(r'<w:embed\w+ r:id="(rId\d+)" w:fontKey="\{([^}]+)\}"', m.group(2))
        if not e: continue
        key = bytes.fromhex(e.group(2).replace('-', ''))[::-1]; d = bytearray(z.read('word/' + tgt[e.group(1)]))
        for i in range(32): d[i] ^= key[i % 16]
        out[m.group(1)] = bytes(d)
    return out


def marks_of(data):
    from fontTools.ttLib import TTFont
    t = TTFont(io.BytesIO(data)); order = t.getGlyphOrder()
    cd = t['GDEF'].table.GlyphClassDef.classDefs if 'GDEF' in t else {}
    return {i for i, g in enumerate(order) if cd.get(g) == 3}


def main(docx, log):
    fonts = fonts_of(docx)
    for line in open(log, encoding='utf-8'):
        m = re.search(r'P2D check (.+?) (\[\[.*\]\])\s*$', line)
        if not m or m.group(1) not in fonts: continue
        fam, words = m.group(1), json.loads(m.group(2))
        f, keep = font(fonts[fam]); marks = marks_of(fonts[fam])
        ok = 0; bad = Counter(); ex = {}
        for text, bases, rtl in words:
            got = [g for g in shape(f, text, bool(rtl)) if g not in marks]
            if got == bases: ok += 1
            else:
                key = text.strip(); bad[key] += 1; ex[key] = (bases, got)
        n = len(words)
        print(f'{fam}: {ok}/{n} words shape as in the PDF ({100 * ok / max(1, n):.1f}%)')
        for t, c in bad.most_common(15): print('   ', c, t, 'pdf', ex[t][0], 'font', ex[t][1])


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
