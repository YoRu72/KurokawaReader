#!/usr/bin/env python3
"""Renders content.py's six documents into the sources the programs read, beside this script:
  <kind>.docx  (python-docx; LibreOffice Writer exports it)   slides.pptx (python-pptx; LibreOffice Impress)
  <kind>.html  (Chromium / wkhtmltopdf)                        <kind>.tex  (pdfLaTeX / XeLaTeX)
Each program is given what is natural for it: real styles, numbering, merged cells, tab leaders, frames, sections."""
import html, os, re, zipfile
from docx import Document
from docx.shared import Pt, Cm, RGBColor, Emu
from docx.enum.section import WD_SECTION, WD_ORIENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn, nsdecls
from content import DOCS, H

LATIN = 'Carlito'; SERIF = 'Liberation Serif'; ARAB = 'FreeSerif'; FIG = os.path.join(H, 'figure.png')
esc = lambda s: html.escape(s, quote=True)

# ------------------------------------------------------------------ docx helpers
def fonts(el, ascii=None, cs=None):
    rpr = el.get_or_add_rPr(); rf = rpr.find(qn('w:rFonts'))
    if rf is None: rf = OxmlElement('w:rFonts'); rpr.insert(0, rf)
    for k, v in (('w:ascii', ascii), ('w:hAnsi', ascii), ('w:cs', cs)):
        if v: rf.set(qn(k), v)
def base(doc, latin=LATIN, size=11):
    for name, sz, b in (('Normal', size, False), ('Title', 22, True), ('Heading 1', 15, True), ('Heading 2', 12.5, True), ('Caption', 9, False)):
        st = doc.styles[name]; st.font.name = latin; st.font.size = Pt(sz); st.font.bold = b; st.font.color.rgb = RGBColor(0, 0, 0); fonts(st.element, latin, ARAB)
    doc.styles['Normal'].paragraph_format.space_after = Pt(4)
def fld(par, instr):
    for typ in ('begin', None, 'end'):
        r = par.add_run()
        if typ: e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), typ)
        else: e = OxmlElement('w:instrText'); e.set(qn('xml:space'), 'preserve'); e.text = ' %s ' % instr
        r._r.append(e)
def rtl(par):
    par._p.get_or_add_pPr().append(OxmlElement('w:bidi'))
def ar_run(run):
    run.font.name = ARAB; fonts(run._r, ARAB, ARAB); rpr = run._r.get_or_add_rPr(); rpr.append(OxmlElement('w:rtl')); l = OxmlElement('w:lang'); l.set(qn('w:bidi'), 'ar-SA'); rpr.append(l)
def runs(doc, par, rs, ar=False):
    for r in rs:
        if 'fn' in r:
            run = par.add_run(); run.font.superscript = True; ref = OxmlElement('w:footnoteReference'); ref.set(qn('w:id'), str(r['fn'])); run._r.append(ref); continue
        run = par.add_run(r['t'])
        if r.get('b'): run.bold = True
        if r.get('i'): run.italic = True
        if r.get('sup'): run.font.superscript = True
        if r.get('sub'): run.font.subscript = True
        if ar: ar_run(run)
def page(sec, w=21, h=29.7, m=2.2):
    sec.page_width = Cm(w); sec.page_height = Cm(h)
    for a in ('left_margin', 'right_margin', 'top_margin', 'bottom_margin'): setattr(sec, a, Cm(m))
SID = [100]
def shape(prst, w_pt, h_pt, fill=None, line='000000'):
    """An inline DrawingML shape (wps): a logo mark or a check box drawn as a square."""
    SID[0] += 1; cx, cy = int(w_pt * 12700), int(h_pt * 12700)
    f = '<a:solidFill><a:srgbClr val="%s"/></a:solidFill>' % fill if fill else '<a:noFill/>'
    return parse_xml(
      '<w:r %s><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="%d" cy="%d"/><wp:docPr id="%d" name="Shape %d"/>'
      '<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">'
      '<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:cNvSpPr/><wps:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="%d" cy="%d"/></a:xfrm>'
      '<a:prstGeom prst="%s"><a:avLst/></a:prstGeom>%s<a:ln w="9525"><a:solidFill><a:srgbClr val="%s"/></a:solidFill></a:ln></wps:spPr><wps:bodyPr/></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>'
      % (nsdecls('w', 'wp'), cx, cy, SID[0], SID[0], cx, cy, prst, f, line))
def borders(tbl, on=True):
    tp = tbl._tbl.tblPr; b = OxmlElement('w:tblBorders')
    for e in ('top', 'left', 'bottom', 'right', 'insideH', 'insideV'):
        x = OxmlElement('w:' + e); x.set(qn('w:val'), 'single' if on else 'nil'); x.set(qn('w:sz'), '4'); b.append(x)
    tp.append(b)
def para_bottom_rule(par):
    ppr = par._p.get_or_add_pPr(); pb = OxmlElement('w:pBdr'); b = OxmlElement('w:bottom'); b.set(qn('w:val'), 'single'); b.set(qn('w:sz'), '6'); b.set(qn('w:space'), '1'); pb.append(b); ppr.append(pb)
def underline_field(doc, label, width_cm=12):
    """A label and a line to write on: an underlined tab out to a right tab stop (Writer's natural form line)."""
    p = doc.add_paragraph(); p.add_run(label + ' ')
    p.paragraph_format.tab_stops.add_tab_stop(Cm(width_cm), WD_TAB_ALIGNMENT.LEFT)
    r = p.add_run('\t'); r.font.underline = True; p.paragraph_format.space_after = Pt(10); return p
def add_footnotes(path, notes):
    if not notes: return
    xml = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">',
           '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>', '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>']
    for k, v in notes.items():
        xml.append('<w:footnote w:id="%s"><w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r><w:r><w:rPr><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve"> %s</w:t></w:r></w:p></w:footnote>' % (k, esc(v)))
    xml.append('</w:footnotes>'); tmp = path + '.tmp'; os.rename(path, tmp)
    zin = zipfile.ZipFile(tmp); zout = zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED)
    for it in zin.infolist():
        d = zin.read(it.filename)
        if it.filename == '[Content_Types].xml': d = d.decode().replace('</Types>', '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>').encode()
        if it.filename == 'word/_rels/document.xml.rels': d = d.decode().replace('</Relationships>', '<Relationship Id="rIdFn1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>').encode()
        zout.writestr(it, d)
    zout.writestr('word/footnotes.xml', ''.join(xml)); zout.close(); zin.close(); os.remove(tmp)
def table(doc, b, ar=False, header_bold=True):
    rows = b['rows']; ncol = max(sum(c.get('span', 1) for c in r) for r in rows)
    tb = doc.add_table(rows=len(rows), cols=ncol); tb.style = 'Table Grid'
    if ar: tb._tbl.tblPr.append(OxmlElement('w:bidiVisual'))
    taken = set()
    for ri, row in enumerate(rows):
        ci = 0
        for c in row:
            while (ri, ci) in taken: ci += 1
            cell = tb.cell(ri, ci); span, rs = c.get('span', 1), c.get('rowspan', 1)
            if span > 1 or rs > 1: cell = cell.merge(tb.cell(ri + rs - 1, ci + span - 1))
            for dr in range(rs):
                for dc in range(span): taken.add((ri + dr, ci + dc))
            cp = cell.paragraphs[0]
            if ar: rtl(cp)
            r = cp.add_run(c['text'])
            if ar: ar_run(r)
            if c.get('header') and header_bold: r.bold = True
            if ci in b.get('money', []) or (ci + span - 1) in b.get('money', []): cp.alignment = WD_ALIGN_PARAGRAPH.RIGHT
            ci += span
        if row[0].get('header'): tb.rows[ri]._tr.get_or_add_trPr().append(OxmlElement('w:tblHeader'))
    return tb

# ------------------------------------------------------------------ docx documents
def invoice_docx(d):
    doc = Document(); base(doc); sec = doc.sections[0]; page(sec)
    p = doc.add_paragraph(); p._p.append(shape('ellipse', 26, 26, '1F5A8C', '1F5A8C')); p.add_run(' '); p._p.append(shape('rect', 14, 26, '7FA7C9', '7FA7C9')); p.add_run('  ')
    r = p.add_run('Brightwater Tool Hire'); r.bold = True; r.font.size = Pt(18)
    p = doc.add_paragraph('14 Kestrel Yard, Port Amble PA2 7LD'); para_bottom_rule(p)
    for b in d['blocks'][2:6]:
        p = doc.add_paragraph(); runs(doc, p, b['runs']); p.alignment = WD_ALIGN_PARAGRAPH.RIGHT; p.paragraph_format.space_after = Pt(0)
    doc.add_paragraph(d['blocks'][6]['text'], style='Heading 1')
    for b in d['blocks'][7:9]: runs(doc, doc.add_paragraph(), b['runs'])
    table(doc, d['blocks'][9]); doc.add_paragraph()
    for b in d['blocks'][10:13]:
        p = doc.add_paragraph(); runs(doc, p, b['runs']); p.alignment = WD_ALIGN_PARAGRAPH.RIGHT; p.paragraph_format.space_after = Pt(0)
    doc.add_paragraph(); underline_field(doc, 'Signed:', 8); doc.add_paragraph('For Brightwater Tool Hire')
    fp = sec.footer.paragraphs[0]; r = fp.add_run(d['meta']['footer']); r.font.size = Pt(7.5)
    return doc

def paper_docx(d):
    doc = Document(); base(doc, SERIF, 10); sec = doc.sections[0]; page(sec, m=2.0)
    hp = sec.header.paragraphs[0]; r = hp.add_run(d['meta']['header']); r.italic = True; r.font.size = Pt(8.5); hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fp = sec.footer.paragraphs[0]; fp.alignment = WD_ALIGN_PARAGRAPH.CENTER; fld(fp, 'PAGE')
    B = {b.get('id', b.get('text')): b for b in d['blocks']}
    t = doc.add_paragraph(d['blocks'][0]['text'], style='Title'); t.alignment = WD_ALIGN_PARAGRAPH.CENTER
    for k in ('authors', 'affil'):
        p = doc.add_paragraph(); runs(doc, p, B[k]['runs']); p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    h = doc.add_paragraph('Abstract', style='Heading 2'); h.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p = doc.add_paragraph(); runs(doc, p, B['abstract']['runs']); p.paragraph_format.left_indent = Cm(2); p.paragraph_format.right_indent = Cm(2); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    def cols(n):
        s = doc.add_section(WD_SECTION.CONTINUOUS); c = s._sectPr.find(qn('w:cols'))
        if c is None: c = OxmlElement('w:cols'); s._sectPr.append(c)
        c.set(qn('w:num'), str(n)); c.set(qn('w:space'), '454')
    cols(2); colw = (21 - 4 - 0.8) / 2
    for b in d['blocks'][5:]:
        t = b['type']
        if t == 'h': doc.add_paragraph(b['text'], style='Heading 1')
        elif t == 'p':
            p = doc.add_paragraph(); runs(doc, p, b['runs']); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        elif t == 'eq':
            p = doc.add_paragraph(); ts = p.paragraph_format.tab_stops; ts.add_tab_stop(Cm(colw / 2), WD_TAB_ALIGNMENT.CENTER); ts.add_tab_stop(Cm(colw), WD_TAB_ALIGNMENT.RIGHT)
            p.add_run('\t'); m = re.match(r'(.*?)(\d)$', b['text']) if b['id'] == 'eq2' else None
            if b['id'] == 'eq1':
                for seg, it, sub in (('ds', 1, 0), ('/', 0, 0), ('dt', 1, 0), (' = ', 0, 0), ('k', 1, 0), (' (', 0, 0), ('s', 1, 0), ('0', 0, 1), (' − ', 0, 0), ('s', 1, 0), (')', 0, 0)):
                    r = p.add_run(seg); r.italic = bool(it); r.font.subscript = bool(sub)
            else:
                for seg, it, sup in (('F', 1, 0), (' = ', 0, 0), ('Q', 1, 0), (' ', 0, 0), ('s', 1, 0), (' + ', 0, 0), ('k', 1, 0), (' ', 0, 0), ('A', 1, 0), (' ', 0, 0), ('r', 1, 0), ('2', 0, 1)):
                    r = p.add_run(seg); r.italic = bool(it); r.font.superscript = bool(sup)
            p.add_run('\t' + b['num'])
        elif t in ('figure', 'table'):
            if t == 'figure':
                cols(1)
                p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.add_run().add_picture(FIG, width=Cm(11))
                c = doc.add_paragraph(b['caption'], style='Caption'); c.alignment = WD_ALIGN_PARAGRAPH.CENTER
            else:
                c = doc.add_paragraph(b['caption'], style='Caption'); c.alignment = WD_ALIGN_PARAGRAPH.CENTER
                tb = table(doc, b); tb.alignment = 1; cols(2)
        elif t == 'ref':
            p = doc.add_paragraph(b['text']); p.paragraph_format.left_indent = Cm(0.6); p.paragraph_format.first_line_indent = Cm(-0.6)
    doc.save(os.path.join(H, 'paper.docx')); add_footnotes(os.path.join(H, 'paper.docx'), d['footnotes']); return None

def arabic_docx(d):
    doc = Document(); base(doc); sec = doc.sections[0]; page(sec)
    for st in ('Normal', 'Heading 1', 'Heading 2', 'List Number', 'List Bullet'): fonts(doc.styles[st].element, None, ARAB); doc.styles[st].font.size = Pt(14 if st.startswith('Heading 2') else 18 if st == 'Heading 1' else 13)
    for b in d['blocks']:
        t = b['type']
        if t == 'h': p = doc.add_paragraph(style='Heading %d' % b['level']); rtl(p); ar_run(p.add_run(b['text']))
        elif t == 'p': p = doc.add_paragraph(); rtl(p); runs(doc, p, b['runs'], True); p.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
        elif t in ('ol', 'ul'):
            for it in b['items']: p = doc.add_paragraph(style='List Number' if t == 'ol' else 'List Bullet'); rtl(p); ar_run(p.add_run(it['text']))
        elif t == 'table': table(doc, b, True); doc.add_paragraph()
        elif t == 'verse':
            p = doc.add_paragraph(); rtl(p); ts = p.paragraph_format.tab_stops; ts.add_tab_stop(Cm(8.3), WD_TAB_ALIGNMENT.CENTER)
            ar_run(p.add_run(b['a'])); ar_run(p.add_run('\t\t')); ar_run(p.add_run(b['b'])); p.alignment = WD_ALIGN_PARAGRAPH.DISTRIBUTE
    doc.save(os.path.join(H, 'arabic.docx'))

def form_docx(d):
    doc = Document(); base(doc); sec = doc.sections[0]; page(sec)
    for b in d['blocks']:
        t = b['type']
        if t == 'h': doc.add_paragraph(b['text'], style='Heading 1')
        elif t == 'p':
            p = doc.add_paragraph(); runs(doc, p, b['runs'])
            if b.get('role') == 'fine':
                for r in p.runs: r.font.size = Pt(7.5)
        elif t == 'field': underline_field(doc, b['label'])
        elif t == 'check':
            p = doc.add_paragraph(); p.add_run(b['label'] + '   ')
            for o in b['options']: p._p.append(shape('rect', 9, 9)); p.add_run(' ' + o + '     ')
            p.paragraph_format.space_after = Pt(10)
        elif t == 'grid':
            doc.add_paragraph(b['label']); tb = doc.add_table(rows=1, cols=b['n']); tb.style = 'Table Grid'
            for c in tb.columns: c.width = Cm(0.8)
            for c in tb.rows[0].cells: c.width = Cm(0.8)
            tb.rows[0].height = Cm(0.8); tb.alignment = 0; doc.add_paragraph()
        elif t == 'leader':
            p = doc.add_paragraph(); p.paragraph_format.tab_stops.add_tab_stop(Cm(12), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS); p.add_run(b['text'] + '\t' + b['value'])
        elif t == 'layout':
            tb = doc.add_table(rows=3, cols=2); borders(tb, False)
            for ci, col in enumerate(b['cols']):
                for ri, txt in enumerate(col):
                    cp = tb.cell(ri, ci).paragraphs[0]; r = cp.add_run(txt)
                    if ri == 0: r.bold = True
                    else: cp.paragraph_format.tab_stops.add_tab_stop(Cm(7.5)); r2 = cp.add_run(' \t'); r2.font.underline = True
            doc.add_paragraph()
    return doc

def shy(txt):
    """Soft hyphens in long words (manual hyphenation: Writer here has no hyphenation dictionary): after the first vowel-consonant
    boundary past the word's middle less one letter, leaving two letters at least on each side."""
    def one(w):
        if len(w) < 8 or not w.isalpha(): return w
        for i in range(max(3, len(w) // 2 - 1), len(w) - 3):
            if w[i - 1].lower() in 'aeiouy' and w[i].lower() not in 'aeiouy': return w[:i] + '\u00ad' + w[i:]
        return w
    return ' '.join(one(w) for w in txt.split(' '))
BOOK_BOTTOM = float(os.environ.get('BOOK_BOTTOM', '1.8'))
def book_docx(d):
    doc = Document(); base(doc, SERIF, 11); sec = doc.sections[0]; page(sec, 14.8, 21, 1.8); sec.bottom_margin = Cm(BOOK_BOTTOM)
    doc.settings.odd_and_even_pages_header_footer = True
    doc.settings.element.append(OxmlElement('w:autoHyphenation'))
    for n in ('Heading 1',): doc.styles[n].paragraph_format.space_before = Pt(30); doc.styles[n].paragraph_format.space_after = Pt(18); doc.styles[n].font.size = Pt(16)
    ns = doc.styles['Normal'].paragraph_format; ns.space_after = Pt(0); ns.first_line_indent = Cm(0.5); ns.alignment = WD_ALIGN_PARAGRAPH.JUSTIFY
    def pgnum(s, fmt, start=None):
        for old in s._sectPr.findall(qn('w:pgNumType')): s._sectPr.remove(old)
        pn = OxmlElement('w:pgNumType'); pn.set(qn('w:fmt'), fmt)
        if start: pn.set(qn('w:start'), str(start))
        s._sectPr.append(pn)
    def heads(s, odd):
        s.header.is_linked_to_previous = False; s.even_page_header.is_linked_to_previous = False; s.footer.is_linked_to_previous = False; s.even_page_footer.is_linked_to_previous = False
        for hd, txt, al in ((s.header, odd, WD_ALIGN_PARAGRAPH.RIGHT), (s.even_page_header, d['meta']['header'], WD_ALIGN_PARAGRAPH.LEFT)):
            p = hd.paragraphs[0]; p.text = ''; r = p.add_run(txt); r.italic = True; r.font.size = Pt(9); p.alignment = al
        for ft in (s.footer, s.even_page_footer):
            p = ft.paragraphs[0]; p.text = ''; p.alignment = WD_ALIGN_PARAGRAPH.CENTER; fld(p, 'PAGE')
    # front matter: title page and contents, lower-roman numbers
    pgnum(sec, 'lowerRoman', 1)
    t = doc.add_paragraph(d['blocks'][0]['text'], style='Title'); t.alignment = WD_ALIGN_PARAGRAPH.CENTER; t.paragraph_format.space_before = Pt(120)
    p = doc.add_paragraph(d['blocks'][1]['runs'][0]['t']); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.first_line_indent = 0
    s = doc.add_section(WD_SECTION.NEW_PAGE); pgnum(s, 'lowerRoman'); heads(s, 'Contents')
    doc.add_paragraph('Contents', style='Heading 1')
    tocp = []
    for e in d['blocks'][3]['entries']:
        p = doc.add_paragraph(); p.paragraph_format.first_line_indent = 0; p.paragraph_format.tab_stops.add_tab_stop(Cm(11.2), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.DOTS); p.add_run(e['text'] + '\t' + e['page']); tocp.append(p)
    for b in d['blocks'][4:]:
        t = b['type']
        if t == 'h':
            s = doc.add_section(WD_SECTION.ODD_PAGE); heads(s, b['chapter'])
            pgnum(s, 'decimal', 1 if b['text'].startswith('1 ') else None)
            doc.add_paragraph(b['text'], style='Heading 1')
        elif t == 'p':
            txt = b['runs'][0]['t']
            if b.get('dropcap'):
                f = doc.add_paragraph(); fp = OxmlElement('w:framePr'); fp.set(qn('w:dropCap'), 'drop'); fp.set(qn('w:lines'), '3'); fp.set(qn('w:wrap'), 'around'); fp.set(qn('w:vAnchor'), 'text'); fp.set(qn('w:hAnchor'), 'text')
                f._p.get_or_add_pPr().insert(0, fp); f.paragraph_format.first_line_indent = 0; r = f.add_run(txt[0]); r.font.size = Pt(38)
                f.paragraph_format.line_spacing = Pt(38)
                p = doc.add_paragraph(); p.paragraph_format.first_line_indent = 0; words = txt[1:].split(' ')
                r = p.add_run(' '.join(words[:b['smallcapsWords']])); r.font.small_caps = True; p.add_run(' ' + shy(' '.join(words[b['smallcapsWords']:])))
            else: doc.add_paragraph(shy(txt))
        elif t == 'quote':
            p = doc.add_paragraph(b['text']); pf = p.paragraph_format; pf.left_indent = Cm(1); pf.right_indent = Cm(1); pf.first_line_indent = 0; pf.space_before = Pt(8); pf.space_after = Pt(8); p.runs[0].italic = True
        elif t == 'ornament':
            p = doc.add_paragraph(b['text']); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.paragraph_format.first_line_indent = 0; p.paragraph_format.space_before = Pt(8); p.paragraph_format.space_after = Pt(8)
    return doc

# ------------------------------------------------------------------ pptx
def slides_pptx(d):
    from pptx import Presentation
    from pptx.util import Pt as PPt, Emu as PEmu, Cm as PCm
    from pptx.dml.color import RGBColor as PRGB
    prs = Presentation(); prs.slide_width = PCm(25.4); prs.slide_height = PCm(14.29); blank = prs.slide_layouts[6]
    def box(sl, x, y, w, h, text, size, bold=False, color=None, bullets=None):
        tb = sl.shapes.add_textbox(PCm(x), PCm(y), PCm(w), PCm(h)); tf = tb.text_frame; tf.word_wrap = True
        lines = bullets or [text]
        for i, ln in enumerate(lines):
            p = tf.paragraphs[0] if i == 0 else tf.add_paragraph(); r = p.add_run(); r.text = ('• ' if bullets else '') + ln; r.font.size = PPt(size); r.font.bold = bold; r.font.name = 'Carlito'
            if color: r.font.color.rgb = PRGB.from_string(color)
        return tb
    def num(sl, n, color=None): box(sl, 23.2, 13.0, 1.8, 0.9, str(n), 11, color=color)
    S = d['blocks']
    sl = prs.slides.add_slide(blank); box(sl, 2, 4.5, 21.4, 2.6, S[0]['boxes'][0]['text'], 44, True); box(sl, 2, 7.6, 21.4, 1.4, S[0]['boxes'][1]['text'], 22); num(sl, 1)
    sl = prs.slides.add_slide(blank); box(sl, 1.5, 0.8, 22, 1.8, S[1]['boxes'][0]['text'], 32, True)
    sl.shapes.add_picture(FIG, PCm(1.5), PCm(3.4), width=PCm(10.5)); box(sl, 13, 3.4, 11, 5, None, 20, bullets=S[1]['boxes'][1]['items'])
    box(sl, 1.5, 11.6, 10, 1, S[1]['boxes'][2]['text'], 12); num(sl, 2)
    sl = prs.slides.add_slide(blank); bg = sl.background.fill; bg.solid(); bg.fore_color.rgb = PRGB.from_string('1F3A5C')
    box(sl, 1.5, 0.8, 14, 1.8, S[2]['boxes'][0]['text'], 32, True, 'FFFFFF')
    box(sl, 1.5, 4.0, 12, 1.2, S[2]['boxes'][1]['text'], 20, color='FFFFFF'); box(sl, 1.5, 5.6, 12, 1.2, S[2]['boxes'][2]['text'], 20, color='FFFFFF')
    box(sl, 16.5, 1.0, 7.5, 1.2, S[2]['boxes'][3]['text'], 18, True, 'FFFFFF'); num(sl, 3, 'FFFFFF')
    prs.save(os.path.join(H, 'slides.pptx'))

# ------------------------------------------------------------------ HTML
def hruns(rs, notes=None):
    o = []
    for r in rs:
        if 'fn' in r: o.append('<sup>%d</sup>' % r['fn']); continue
        t = esc(r['t'])
        for k, tag in (('b', 'strong'), ('i', 'em'), ('sup', 'sup'), ('sub', 'sub')):
            if r.get(k): t = '<%s>%s</%s>' % (tag, t, tag)
        o.append(t)
    return ''.join(o)
def htable(b, cls=''):
    rows = []
    for row in b['rows']:
        cells = []
        for ci, c in enumerate(row):
            tag = 'th' if c.get('header') else 'td'; a = ''
            if c.get('span', 1) > 1: a += ' colspan="%d"' % c['span']
            if c.get('rowspan', 1) > 1: a += ' rowspan="%d"' % c['rowspan']
            if re.fullmatch(r'[\d.]+', c['text']) and b.get('money'): a += ' class="num"'
            cells.append('<%s%s>%s</%s>' % (tag, a, esc(c['text']), tag))
        rows.append('<tr>%s</tr>' % ''.join(cells))
    return '<table%s><thead>%s</thead><tbody>%s</tbody></table>' % (cls, rows[0], ''.join(rows[1:]))
def page_html(title, css, body, lang='en', d='ltr'):
    return '<!doctype html><html lang="%s" dir="%s"><head><meta charset="utf-8"><title>%s</title><style>%s</style></head><body>%s</body></html>' % (lang, d, esc(title), css, body)

def invoice_html(d):
    B = d['blocks']; logo = '<svg width="60" height="36" viewBox="0 0 60 36"><circle cx="18" cy="18" r="17" fill="#1F5A8C"/><rect x="40" y="1" width="18" height="34" fill="#7FA7C9"/></svg>'
    body = ['<div class="lh">%s<span class="firm">Brightwater Tool Hire</span></div><p class="addr">14 Kestrel Yard, Port Amble PA2 7LD</p>' % logo,
            '<div class="to">%s</div>' % ''.join('<p>%s</p>' % hruns(b['runs']) for b in B[2:6]),
            '<h1>%s</h1>' % esc(B[6]['text'])] + ['<p>%s</p>' % hruns(b['runs']) for b in B[7:9]] + [htable(B[9]),
            '<div class="tot">%s</div>' % ''.join('<p>%s</p>' % hruns(b['runs']) for b in B[10:13]),
            '<p class="sig">Signed: <span class="line"></span></p><p>For Brightwater Tool Hire</p>']
    css = ('@page{size:A4;margin:20mm 20mm 26mm}body{font-family:Carlito,sans-serif;font-size:11pt;color:#000}.lh{display:flex;align-items:center;gap:10pt}.firm{font-size:18pt;font-weight:bold}'
           '.addr{border-bottom:1px solid #000;padding-bottom:4pt}.to{text-align:right}.to p,.tot p{margin:0}h1{font-size:15pt;margin:14pt 0 6pt}table{border-collapse:collapse;width:100%;margin:8pt 0}'
           'th,td{border:1px solid #000;padding:3pt 6pt;text-align:left}td.num{text-align:right}.tot{text-align:right;margin-top:8pt}.sig{margin-top:30pt}.line{display:inline-block;width:180pt;border-bottom:1px solid #000}')
    return page_html(d['meta']['title'], css, '\n'.join(body))

def arabic_html(d):
    body = []
    for b in d['blocks']:
        t = b['type']
        if t == 'h': body.append('<h%d>%s</h%d>' % (b['level'], esc(b['text']), b['level']))
        elif t == 'p': body.append('<p>%s</p>' % hruns(b['runs']))
        elif t in ('ol', 'ul'): body.append('<%s>%s</%s>' % (t, ''.join('<li>%s</li>' % esc(i['text']) for i in b['items']), t))
        elif t == 'table': body.append(htable(b))
        elif t == 'verse': body.append('<div class="verse"><span>%s</span><span>%s</span></div>' % (esc(b['a']), esc(b['b'])))
    css = ('@page{size:A4;margin:22mm 20mm}body{font-family:FreeSerif,"DejaVu Sans",serif;font-size:14pt;line-height:1.6;color:#000}h1{font-size:20pt}h2{font-size:16pt;margin:14pt 0 4pt}'
           'p{text-align:justify}table{border-collapse:collapse;margin:6pt 0}th,td{border:1px solid #000;padding:3pt 12pt;text-align:right}.verse{display:flex;justify-content:space-between;margin:8pt 30pt}')
    return page_html(d['meta']['title'], css, '\n'.join(body), 'ar', 'rtl')

def slides_html(d):
    S = d['blocks']; out = []
    out.append('<section><div class="b" style="left:20mm;top:45mm;width:214mm;font-size:44pt;font-weight:bold">%s</div><div class="b" style="left:20mm;top:76mm;font-size:22pt">%s</div><div class="n">1</div></section>' % (esc(S[0]['boxes'][0]['text']), esc(S[0]['boxes'][1]['text'])))
    out.append('<section><div class="b" style="left:15mm;top:8mm;font-size:32pt;font-weight:bold">%s</div><img src="figure.png" style="position:absolute;left:15mm;top:34mm;width:105mm">'
               '<ul class="b" style="left:130mm;top:34mm;width:110mm;font-size:20pt">%s</ul><div class="b" style="left:15mm;top:116mm;font-size:12pt">%s</div><div class="n">2</div></section>'
               % (esc(S[1]['boxes'][0]['text']), ''.join('<li>%s</li>' % esc(i) for i in S[1]['boxes'][1]['items']), esc(S[1]['boxes'][2]['text'])))
    out.append('<section class="dark"><div class="b" style="left:15mm;top:8mm;font-size:32pt;font-weight:bold">%s</div><div class="b" style="left:15mm;top:40mm;font-size:20pt">%s</div>'
               '<div class="b" style="left:15mm;top:56mm;font-size:20pt">%s</div><div class="b" style="left:165mm;top:10mm;font-size:18pt;font-weight:bold">%s</div><div class="n">3</div></section>'
               % tuple(esc(b['text']) for b in S[2]['boxes']))
    css = ('@page{size:254mm 142.9mm;margin:0}body{margin:0;font-family:Carlito,sans-serif;color:#000}section{position:relative;width:254mm;height:142.9mm;page-break-after:always;overflow:hidden}'
           'section:last-child{page-break-after:auto}.b{position:absolute;margin:0}ul.b{padding-left:8mm}li{margin-bottom:6pt}.n{position:absolute;right:12mm;bottom:8mm;font-size:11pt}'
           '.dark{background:#1F3A5C;color:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}')
    return page_html(d['meta']['title'], css, '\n'.join(out))

def form_html(d):
    body = []
    for b in d['blocks']:
        t = b['type']
        if t == 'h': body.append('<h1>%s</h1>' % esc(b['text']))
        elif t == 'p': body.append('<p%s>%s</p>' % (' class="fine"' if b.get('role') == 'fine' else '', hruns(b['runs'])))
        elif t == 'field': body.append('<p class="f">%s <span class="line"></span></p>' % esc(b['label']))
        elif t == 'check': body.append('<p class="f">%s %s</p>' % (esc(b['label']), ''.join('&nbsp;&nbsp;<span class="box"></span> %s' % esc(o) for o in b['options'])))
        elif t == 'grid': body.append('<p class="f">%s</p><table class="grid"><tr>%s</tr></table>' % (esc(b['label']), '<td></td>' * b['n']))
        elif t == 'leader': body.append('<p class="ld"><span class="lt">%s</span><span class="dots">%s</span><span class="lv">%s</span></p>' % (esc(b['text']), ' .' * 120, esc(b['value'])))
        elif t == 'layout':
            rows = ''.join('<tr>%s</tr>' % ''.join('<td>%s</td>' % (('<b>%s</b>' % esc(col[ri])) if ri == 0 else '%s <span class="line short"></span>' % esc(col[ri])) for col in b['cols']) for ri in range(3))
            body.append('<table class="lay">%s</table>' % rows)
    css = ('@page{size:A4;margin:20mm}body{font-family:"Liberation Sans",sans-serif;font-size:11pt;color:#000}h1{font-size:18pt}.f{margin:12pt 0}.line{display:inline-block;width:330pt;border-bottom:1px solid #000}.line.short{width:150pt}'
           '.box{display:inline-block;width:10pt;height:10pt;border:1px solid #000;vertical-align:-1pt}table.grid{border-collapse:collapse}table.grid td{border:1px solid #000;width:20pt;height:20pt}'
           '.ld{width:340pt;white-space:nowrap;overflow:hidden;margin:4pt 0;position:relative}.lt{background:#fff;padding-right:3pt}.dots{position:absolute;left:0;z-index:-1}.lv{position:absolute;right:0;background:#fff;padding-left:3pt}'
           'table.lay{width:100%;margin:14pt 0;border:none}table.lay td{padding:4pt 0;width:50%}.fine{font-size:7.5pt;margin-top:20pt}')
    return page_html(d['meta']['title'], css, '\n'.join(body))

# ------------------------------------------------------------------ TeX
def tesc(s):
    for a, b in (('\\', '\\textbackslash{}'), ('&', '\\&'), ('%', '\\%'), ('$', '\\$'), ('#', '\\#'), ('_', '\\_'), ('~', '\\textasciitilde{}')): s = s.replace(a, b)
    return s
def truns(rs, notes):
    o = []
    for r in rs:
        if 'fn' in r: o.append('\\footnote{%s}' % tesc(notes[str(r['fn'])])); continue
        t = tesc(r['t'])
        if r.get('sup'): t = '\\textsuperscript{%s}' % t
        elif r.get('sub'): t = '\\textsubscript{%s}' % t
        if r.get('i'): t = '\\textit{%s}' % t
        if r.get('b'): t = '\\textbf{%s}' % t
        o.append(t)
    return ''.join(o)

def paper_tex(d):
    N = d['footnotes']; B = {b.get('id', b.get('text')): b for b in d['blocks']}
    intro = d['blocks'][6]['runs']
    intro_tex = ''.join(['\\footnote{%s}' % tesc(N['1']) if 'fn' in r else tesc(r['t']) for r in intro[:3]])
    L = ['\\documentclass[10pt,a4paper,twocolumn]{article}', '\\usepackage[a4paper,margin=20mm]{geometry}', '\\usepackage[T1]{fontenc}\\usepackage{lmodern}\\input{glyphtounicode}\\pdfgentounicode=1',
         '\\usepackage{amsmath,graphicx,fancyhdr,caption}', '\\pagestyle{fancy}\\fancyhf{}\\fancyhead[C]{\\small\\itshape %s}\\fancyfoot[C]{\\thepage}\\renewcommand{\\headrulewidth}{0pt}' % tesc(d['meta']['header']),
         '\\title{%s}\\author{Ada Rowntree\\textsuperscript{1}, Tomas Elling\\textsuperscript{2}\\\\ \\small\\textsuperscript{1}Coastal Laboratory, Port Amble. \\textsuperscript{2}School of Water Studies, Hollin Vale.}\\date{}' % tesc(d['meta']['title']),
         '\\begin{document}', '\\twocolumn[\\maketitle\\thispagestyle{fancy}\\begin{center}\\begin{minipage}{0.7\\textwidth}\\centerline{\\bfseries Abstract}\\smallskip\\small %s\\end{minipage}\\end{center}\\bigskip]' % tesc(PAPER_ABS_T(d)),
         '\\section*{1 Introduction}',
         'A shallow estuary mixes river water with sea water twice a day. Its salinity at a place depends on the river flow, on the tide and on how fast the two waters stir. Many models describe this with care; ours keeps only what a harbour office can measure. We call the salinity of box $i$ the value $s_i$ and the river flow $Q$, and we take the mixing to grow with the square of the tidal range, $r^2$.\\footnote{%s} The rest of this note sets out the model, fits it and tests it.' % tesc(N['1']),
         '\\begin{equation}\\frac{ds}{dt} = k\\,(s_0 - s)\\tag{1}\\end{equation}', truns(B['intro2']['runs'], N),
         '\\section*{2 Method}', truns(B['method']['runs'], N), '\\begin{equation}F = Q\\,s + k\\,A\\,r^2\\tag{2}\\end{equation}', 'Here $A$ is the cross-section of the channel at the boundary. We fitted $k$ by least squares over all days of the first season and kept the second season apart for the test.',
         '\\begin{figure*}[t]\\centering\\includegraphics[width=0.6\\textwidth]{figure.png}\\caption*{%s}\\end{figure*}' % tesc(B['fig1']['caption']),
         '\\begin{table*}[t]\\centering\\caption*{%s}\\begin{tabular}{|l|c|c|}\\hline %s\\end{tabular}\\end{table*}' % (tesc(B['consts']['caption']), ' '.join(' & '.join(('\\textbf{%s}' if c.get('header') else '%s') % tesc(c['text']) for c in r) + ' \\\\ \\hline' for r in B['consts']['rows'])),
         '\\section*{3 Results}', truns(B['results']['runs'], N), '\\section*{References}', '\\small']
    for k in ('ref1', 'ref2', 'ref3'): L.append('\\par\\noindent\\hangindent=1.5em\\hangafter=1 %s' % tesc(B[k]['text']))
    L.append('\\end{document}'); return '\n\n'.join(L)
def PAPER_ABS_T(d): return [b for b in d['blocks'] if b.get('id') == 'abstract'][0]['runs'][0]['t']

def arabic_tex(d):
    def R(s):  # Latin words and 0-9 numbers put back left-to-right inside the right-to-left run
        return re.sub(r'([A-Za-z0-9][A-Za-z0-9 ]*[A-Za-z0-9]|[A-Za-z0-9])', lambda m: '\\beginL %s\\endL{}' % m.group(1), s)
    L = ['\\documentclass[12pt,a4paper]{article}', '\\usepackage[a4paper,margin=22mm]{geometry}', '\\usepackage{fontspec}\\setmainfont{FreeSerif}[Script=Arabic]', '\\TeXXeTstate=1', '\\pagestyle{empty}\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{6pt}', '\\begin{document}']
    for b in d['blocks']:
        t = b['type']
        if t == 'h': L.append('{\\raggedleft\\%s\\bfseries\\beginR %s\\endR\\par}\\smallskip' % ('LARGE' if b['level'] == 1 else 'large', R(b['text'])))
        elif t == 'p': L.append('{\\beginR %s\\endR\\par}' % R(b['runs'][0]['t']))
        elif t in ('ol', 'ul'):
            for i, it in enumerate(b['items']): L.append('{\\raggedleft\\beginR\\hspace*{1.5em}%s\\ %s\\endR\\par}' % ('%d.' % (i + 1) if t == 'ol' else '•', R(it['text'])))
        elif t == 'table':
            rows = [list(reversed(r)) for r in b['rows']]
            L.append('\\begin{flushright}\\begin{tabular}{|c|c|c|}\\hline %s\\end{tabular}\\end{flushright}' % ' '.join(' & '.join(('\\bfseries ' if c.get('header') else '') + '\\beginR %s\\endR' % R(c['text']) for c in r) + ' \\\\ \\hline' for r in rows))
        elif t == 'verse': L.append('\\medskip\\noindent\\hbox to\\linewidth{\\hskip2em\\beginR %s\\endR\\hfill\\beginR %s\\endR\\hskip2em}\\medskip' % (R(b['b']), R(b['a'])))
    L.append('\\end{document}'); return '\n\n'.join(L)

def book_tex(d):
    B = d['blocks']
    L = ['\\documentclass[11pt,twoside,openright]{book}', '\\usepackage[a5paper,hmargin=21mm,lines=26]{geometry}\\brokenpenalty=0', '\\usepackage{fontspec}\\setmainfont{Liberation Serif}', '\\usepackage{fancyhdr,lettrine}',
         '\\pagestyle{fancy}\\fancyhf{}\\fancyhead[LE]{\\small\\itshape %s}\\fancyhead[RO]{\\small\\itshape\\leftmark}\\fancyfoot[C]{\\thepage}\\renewcommand{\\headrulewidth}{0pt}' % tesc(d['meta']['header']),
         '\\renewcommand{\\chaptermark}[1]{\\markboth{#1}{}}\\fancypagestyle{plain}{\\fancyhf{}\\fancyfoot[C]{\\thepage}}',
         '\\usepackage{titlesec}\\titleformat{\\chapter}[hang]{\\Large\\bfseries}{\\thechapter}{1em}{}\\titlespacing*{\\chapter}{0pt}{20pt}{20pt}',
         '\\begin{document}', '\\frontmatter', '\\begin{titlepage}\\centering\\vspace*{50mm}{\\Huge\\bfseries %s\\par}\\bigskip{\\large %s\\par}\\end{titlepage}' % (tesc(B[0]['text']), tesc(B[1]['runs'][0]['t'])),
         '\\chapter*{Contents}\\markboth{Contents}{}\\thispagestyle{fancy}', '\\noindent 1\\quad The Lamp Keeper\\dotfill\\pageref{c1}\\par\\noindent 2\\quad Low Water\\dotfill\\pageref{c2}\\par', '\\mainmatter']
    for b in B[4:]:
        t = b['type']
        if t == 'h': L.append('\\chapter{%s}\\label{c%s}' % (tesc(b['chapter']), b['text'][0]))
        elif t == 'p':
            txt = tesc(b['runs'][0]['t'])
            if b.get('dropcap'):
                w = txt.split(' '); n = b['smallcapsWords']; first = w[0]
                L.append('\\lettrine{%s}{%s} \\textsc{%s} %s' % (first[0], first[1:], ' '.join(w[1:n]), ' '.join(w[n:])))
            else: L.append(txt)
        elif t == 'quote': L.append('\\begin{quote}\\itshape %s\\end{quote}' % tesc(b['text']))
        elif t == 'ornament': L.append('\\begin{center}%s\\end{center}' % b['text'])
    L.append('\\end{document}'); return '\n\n'.join(L)

if __name__ == '__main__':
    D = DOCS
    invoice_docx(D['invoice']).save(os.path.join(H, 'invoice.docx')); paper_docx(D['paper']); arabic_docx(D['arabic'])
    form_docx(D['form']).save(os.path.join(H, 'form.docx')); book_docx(D['book']).save(os.path.join(H, 'book.docx')); slides_pptx(D['slides'])
    for k, f in (('invoice', invoice_html), ('arabic', arabic_html), ('slides', slides_html), ('form', form_html)):
        open(os.path.join(H, k + '.html'), 'w', encoding='utf-8').write(f(D[k]))
    for k, f in (('paper', paper_tex), ('arabic', arabic_tex), ('book', book_tex)):
        open(os.path.join(H, k + '.tex'), 'w', encoding='utf-8').write(f(D[k]))
    print('sources written in', H)
