# python3 tests/pdftext/sim.py <base.pdf> <outdir> [font.ttf]: the base PDF (Word-made Arabic, CID TrueType fonts)
# broken in every way PDF writers break the text behind the glyphs, to try copying and searching against:
#   noTU       — no /ToUnicode at all (the text is glyph ids);
#   spaceTU    — the space glyph named a damma, ligature glyphs named nothing (the "فظُ:وسميناهُفيُ" case);
#   puaTU      — every Arabic glyph named a private-use character;
#   shiftTU    — glyphs named consecutive code points (some writers' "identity" maps);
#   presTU     — glyphs named by their presentation forms (U+FExx), lam-alef as one;
#   visualTU   — each glyph right but the strings written in visual (reversed) order per run;
# and, with a font given, simple8.pdf — a one-byte symbolic TrueType font (reportlab) of pre-shaped presentation
# forms with its /ToUnicode removed (old Arabic DTP output).
import sys, os, re, unicodedata
import pikepdf

base, out = sys.argv[1], sys.argv[2]; os.makedirs(out, exist_ok=True)
font = sys.argv[3] if len(sys.argv) > 3 else None

def parse_tu(stream):
    """ToUnicode CMap → {code:int: text}; and the preamble to rebuild it."""
    s = stream.read_bytes().decode('latin1')
    m = {}
    for blk in re.findall(r'beginbfchar(.*?)endbfchar', s, re.S):
        for src, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>', blk):
            m[int(src, 16)] = bytes.fromhex(dst).decode('utf-16-be', 'replace') if dst else ''
    for blk in re.findall(r'beginbfrange(.*?)endbfrange', s, re.S):
        for lo, hi, dst in re.findall(r'<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>', blk):
            lo, hi = int(lo, 16), int(hi, 16); d = bytes.fromhex(dst).decode('utf-16-be', 'replace')
            for c in range(min(lo, hi), min(hi, lo + 4096) + 1): m[c] = (d[:-1] + chr(max(0, min(0x10ffff, ord(d[-1]) + c - lo)))) if d else ''
    return m

def write_tu(m):
    lines = ['/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CIDSystemInfo <</Registry (Adobe) /Ordering (UCS) /Supplement 0>> def /CMapName /Adobe-Identity-UCS def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange']
    items = sorted((c, t) for c, t in m.items() if t)  # (a glyph named nothing is left out of the map)
    for i in range(0, len(items), 100):
        chunk = items[i:i + 100]
        lines.append(f'{len(chunk)} beginbfchar')
        for c, t in chunk: lines.append(f'<{c:04X}> <{t.encode("utf-16-be").hex().upper()}>')
        lines.append('endbfchar')
    lines.append('endcmap CMapName currentdict /CMap defineresource pop end end')
    return '\n'.join(lines).encode('latin1')

AR = re.compile(r'^[؀-ۿ\s]+$')
PRES = {}
for cp in range(0xFE70, 0xFEFD):
    name = unicodedata.name(chr(cp), '')
    base_ = unicodedata.normalize('NFKC', chr(cp))
    form = name.split()[-2] if name.endswith('FORM') else ''
    PRES.setdefault(base_, {})[form] = chr(cp)
def pres(t):
    out = []
    for i, ch in enumerate(t):
        f = PRES.get(ch)
        if not f: out.append(ch); continue
        out.append(f.get('INITIAL' if i == 0 and len(t) > 1 else 'MEDIAL' if 0 < i < len(t) - 1 else 'FINAL' if i == len(t) - 1 and len(t) > 1 else 'ISOLATED') or f.get('ISOLATED') or ch)
    s = ''.join(out)
    return s.replace('لا', PRES.get('لا', {}).get('ISOLATED', 'لا'))

def mutate(kind):
    pdf = pikepdf.open(base)
    for page in pdf.pages:
        for key, f in page.Resources.Font.items():
            if '/ToUnicode' not in f: continue
            if kind == 'noTU': del f['/ToUnicode']; continue
            m = parse_tu(f.ToUnicode)
            if kind == 'spaceTU':
                for c, t in m.items():
                    if t == ' ': m[c] = 'ُ'
                    elif len(t.replace(' ', '')) > 1 and AR.match(t): m[c] = ''
            elif kind == 'puaTU':
                k = 0
                for c, t in sorted(m.items()):
                    if t.strip() and AR.match(t): m[c] = chr(0xE000 + k); k += 1
            elif kind == 'shiftTU':
                for k, c in enumerate(sorted(m)): m[c] = chr(0x0600 + (k % 0xff))
            elif kind == 'presTU':
                for c, t in m.items():
                    if t.strip() and AR.match(t): m[c] = pres(t.strip())
            f.ToUnicode = pikepdf.Stream(pdf, write_tu(m))
        if kind == 'visualTU':
            # Every string of a text operator reversed: the glyphs stay where they are drawn, their order in
            # the string does not (writers that emit visual order, with each glyph positioned by TJ).
            cs = pikepdf.parse_content_stream(page)
            out_ops = []
            for operands, op in cs:
                if str(op) == 'TJ':
                    arr = pikepdf.Array([pikepdf.String(bytes(x)[::-1] if len(bytes(x)) % 2 == 0 and len(bytes(x)) > 2 and False else bytes(x)) if isinstance(x, pikepdf.String) else x for x in operands[0]])
                    operands = [arr]
                out_ops.append((operands, op))
            page.Contents = pdf.make_stream(pikepdf.unparse_content_stream(out_ops))
    pdf.save(os.path.join(out, kind + '.pdf'))

for kind in ['noTU', 'spaceTU', 'puaTU', 'shiftTU', 'presTU']: mutate(kind)

if font:
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    pdfmetrics.registerFont(TTFont('Sim', font))
    path = os.path.join(out, 'simple8.pdf')
    c = canvas.Canvas(path, pagesize=(595, 842)); c.setFont('Sim', 18)
    lines = ['اللفظ: وسميناه في تقسيمنا: اللسان.', 'وقد سبق إلى ذكر هذه العلامات المناطقة حين قسموا الدلالة إلى دلالة', 'وضعية، ودلالة عقلية، ودلالة طبيعية.']
    y = 780
    for ln in lines:
        words = [pres(w) for w in ln.split(' ')]
        # Drawn right to left, each word placed by hand (no space glyph drawn): visual order within the word.
        x = 560
        for w in words:
            vis = w[::-1]
            wd = pdfmetrics.stringWidth(vis, 'Sim', 18); x -= wd
            c.drawString(x, y, vis); x -= 6
        y -= 34
    c.save()
    pdf = pikepdf.open(path)
    for page in pdf.pages:
        for key, f in page.Resources.Font.items():
            if '/ToUnicode' in f: del f['/ToUnicode']
    pdf.save(os.path.join(out, 'simple8.pdf.tmp')); os.replace(os.path.join(out, 'simple8.pdf.tmp'), path)
print('made', sorted(os.listdir(out)))
