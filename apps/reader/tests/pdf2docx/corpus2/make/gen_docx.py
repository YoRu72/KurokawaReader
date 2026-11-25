#!/usr/bin/env python3
"""Builds WORK/source.docx from source.json with python-docx (real heading styles, list styles, a real table with a
merged cell and a header row, a hyperlink relationship, real footnotes patched in, section columns, header/footer with a
PAGE field, right-to-left paragraphs, East-Asian fonts). Then LibreOffice exports it (see run_all.sh)."""
import copy, os, re, zipfile, shutil
from docx import Document
from docx.shared import Pt, Cm, RGBColor
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement, parse_xml
from docx.oxml.ns import qn, nsdecls
from docx.opc.constants import RELATIONSHIP_TYPE as RT
from common import SRC, FIG, WORK, text

LATIN = 'Carlito'; MONO = 'DejaVu Sans Mono'; ARAB = 'FreeSerif'; CJK = {'ja': 'Noto Sans CJK JP', 'zh': 'Noto Sans CJK SC'}

def set_fonts(rpr_owner, ascii=None, ea=None, cs=None):
    rpr = rpr_owner.get_or_add_rPr(); rf = rpr.find(qn('w:rFonts'))
    if rf is None: rf = OxmlElement('w:rFonts'); rpr.insert(0, rf)
    for k, v in (('w:ascii', ascii), ('w:hAnsi', ascii), ('w:eastAsia', ea), ('w:cs', cs)):
        if v: rf.set(qn(k), v)

def style_fonts(doc):
    for name, size, bold in (('Normal', 11, False), ('Title', 24, True), ('Heading 1', 17, True), ('Heading 2', 14, True), ('Heading 3', 12, True), ('Caption', 9.5, False)):
        st = doc.styles[name]; st.font.name = LATIN; st.font.size = Pt(size); st.font.bold = bold; st.font.color.rgb = RGBColor(0, 0, 0)
        set_fonts(st.element, LATIN, None, ARAB)
        if name != 'Normal':
            st.paragraph_format.space_before = Pt(10 if name != 'Title' else 0); st.paragraph_format.space_after = Pt(6)
    for name in ('List Bullet', 'List Bullet 2', 'List Number'): doc.styles[name].font.name = LATIN
    doc.styles['Normal'].paragraph_format.space_after = Pt(6)
    doc.styles['Normal'].paragraph_format.line_spacing = 1.15

def fld(par, instr):
    for typ, t in (('begin', None), (None, instr), ('end', None)):
        r = par.add_run()
        if typ: e = OxmlElement('w:fldChar'); e.set(qn('w:fldCharType'), typ); r._r.append(e)
        else: e = OxmlElement('w:instrText'); e.set(qn('xml:space'), 'preserve'); e.text = ' %s ' % t; r._r.append(e)

def add_runs(doc, par, runs, lang='en', rtl=False):
    for r in runs:
        if 'fn' in r:
            run = par.add_run(); run.font.superscript = True
            ref = OxmlElement('w:footnoteReference'); ref.set(qn('w:id'), str(r['fn'])); run._r.append(ref); continue
        if 'link' in r:
            rid = doc.part.relate_to(r['link'], RT.HYPERLINK, is_external=True)
            h = OxmlElement('w:hyperlink'); h.set(qn('r:id'), rid); h.set(qn('w:history'), '1')
            run = par.add_run(r['t']); run.font.color.rgb = RGBColor(0x05, 0x63, 0xC1); run.font.underline = True
            h.append(run._r); par._p.append(h); continue
        run = par.add_run(r['t'])
        if r.get('b'): run.bold = True
        if r.get('i'): run.italic = True
        if r.get('mono'): run.font.name = MONO; set_fonts(run._r, MONO)
        style_lang(run, lang, rtl)

def style_lang(run, lang, rtl):
    if lang == 'ar':
        run.font.name = ARAB; set_fonts(run._r, ARAB, None, ARAB)
        rpr = run._r.get_or_add_rPr(); e = OxmlElement('w:rtl'); rpr.append(e)
        l = OxmlElement('w:lang'); l.set(qn('w:bidi'), 'ar-SA'); rpr.append(l)
    elif lang in CJK:
        set_fonts(run._r, None, CJK[lang]); rpr = run._r.get_or_add_rPr(); l = OxmlElement('w:lang'); l.set(qn('w:eastAsia'), 'ja-JP' if lang == 'ja' else 'zh-CN'); rpr.append(l)

def bidi(par):
    ppr = par._p.get_or_add_pPr(); ppr.append(OxmlElement('w:bidi'))

def para(doc, style, runs, lang='en', align=None):
    p = doc.add_paragraph(style=style)
    if lang == 'ar': bidi(p)
    add_runs(doc, p, runs, lang)
    if align is not None: p.alignment = align
    return p

def build():
    doc = Document(); style_fonts(doc)
    sec = doc.sections[0]; sec.page_width = Cm(21); sec.page_height = Cm(29.7)
    for a in ('left_margin', 'right_margin'): setattr(sec, a, Cm(2.3))
    sec.top_margin = Cm(2.4); sec.bottom_margin = Cm(2.2)
    # header and footer (footer carries a PAGE field)
    hp = sec.header.paragraphs[0]; hp.text = SRC['meta']['header']; hp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fp = sec.footer.paragraphs[0]; fp.alignment = WD_ALIGN_PARAGRAPH.CENTER
    fp.add_run(SRC['meta']['footer'] + ' - Page '); fld(fp, 'PAGE')
    # hyphenation on
    doc.settings.element.append(OxmlElement('w:autoHyphenation'))
    cm = doc.core_properties; cm.title = SRC['meta']['title']; cm.author = 'Corpus generator'
    for b in SRC['blocks']:
        t = b['type']; lang = b.get('lang', 'en')
        if t == 'title':
            p = doc.add_paragraph(b['text'], style='Title')
        elif t == 'h':
            p = doc.add_paragraph(style='Heading %d' % b['level'])
            if lang == 'ar': bidi(p)
            r = p.add_run(b['text']); style_lang(r, lang, False)
        elif t == 'p':
            p = para(doc, None, b['runs'], lang, WD_ALIGN_PARAGRAPH.JUSTIFY if b['id'] == 'p-long' else None)
        elif t in ('ul', 'ol'):
            for it in b['items']:
                style = ('List Bullet' if it['level'] == 0 else 'List Bullet 2') if t == 'ul' else 'List Number'
                p = doc.add_paragraph(style=style)
                if lang == 'ar': bidi(p)
                r = p.add_run(it['text']); style_lang(r, lang, False)
        elif t == 'table':
            rows = b['rows']; ncol = max(sum(c.get('span', 1) for c in r) for r in rows)
            tb = doc.add_table(rows=len(rows), cols=ncol); tb.style = 'Table Grid'
            if lang == 'ar': tb._tbl.tblPr.append(OxmlElement('w:bidiVisual'))
            for ri, row in enumerate(rows):
                ci = 0
                for c in row:
                    cell = tb.cell(ri, ci); span = c.get('span', 1)
                    if span > 1: cell = cell.merge(tb.cell(ri, ci + span - 1))
                    cell.text = ''; cp = cell.paragraphs[0]
                    if lang == 'ar': bidi(cp)
                    for li, line in enumerate(c['text'].split('\n')):
                        r = cp.add_run(line); style_lang(r, lang, False)
                        if c.get('header'): r.bold = True
                        if li < len(c['text'].split('\n')) - 1: r.add_break()
                    ci += span
                if row[0].get('header'):
                    trpr = tb.rows[ri]._tr.get_or_add_trPr(); trpr.append(OxmlElement('w:tblHeader'))
            doc.add_paragraph()
        elif t == 'figure':
            p = doc.add_paragraph(); p.alignment = WD_ALIGN_PARAGRAPH.CENTER; p.add_run().add_picture(FIG, width=Cm(8))
            c = doc.add_paragraph(b['caption'], style='Caption'); c.alignment = WD_ALIGN_PARAGRAPH.CENTER
        elif t == 'columns':
            s = doc.add_section(WD_SECTION.CONTINUOUS); cols = s._sectPr.find(qn('w:cols'))
            if cols is None: cols = OxmlElement('w:cols'); s._sectPr.append(cols)
            cols.set(qn('w:num'), str(b['n'])); cols.set(qn('w:space'), '567')
            for sub in b['blocks']: para(doc, None, sub['runs'], sub.get('lang', 'en'))
            s2 = doc.add_section(WD_SECTION.CONTINUOUS); c2 = s2._sectPr.find(qn('w:cols')); c2.set(qn('w:num'), '1')
        elif t == 'code':
            for line in b['lines']:
                p = doc.add_paragraph(); r = p.add_run(line); r.font.name = MONO; r.font.size = Pt(9.5); set_fonts(r._r, MONO)
                p.paragraph_format.space_after = Pt(0); p.paragraph_format.left_indent = Cm(0.6)
    out = os.path.join(WORK, 'source-nofn.docx'); doc.save(out); return out

FN_NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
def add_footnotes(src, dst):
    notes = SRC['footnotes']
    xml = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:footnotes %s>' % FN_NS,
           '<w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>',
           '<w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>']
    for k, v in notes.items():
        xml.append('<w:footnote w:id="%s"><w:p><w:pPr><w:spacing w:after="0"/></w:pPr><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteRef/></w:r>'
                   '<w:r><w:rPr><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve"> %s</w:t></w:r></w:p></w:footnote>' % (k, v))
    xml.append('</w:footnotes>')
    zin = zipfile.ZipFile(src); zout = zipfile.ZipFile(dst, 'w', zipfile.ZIP_DEFLATED)
    for it in zin.infolist():
        data = zin.read(it.filename)
        if it.filename == '[Content_Types].xml':
            data = data.decode().replace('</Types>', '<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/></Types>').encode()
        if it.filename == 'word/_rels/document.xml.rels':
            data = data.decode().replace('</Relationships>', '<Relationship Id="rIdFn1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes" Target="footnotes.xml"/></Relationships>').encode()
        zout.writestr(it, data)
    zout.writestr('word/footnotes.xml', ''.join(xml)); zout.close()

if __name__ == '__main__':
    a = build(); b = os.path.join(WORK, 'source.docx'); add_footnotes(a, b); print('wrote', b, os.path.getsize(b))
