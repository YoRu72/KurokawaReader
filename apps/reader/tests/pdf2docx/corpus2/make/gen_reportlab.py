#!/usr/bin/env python3
"""ReportLab (platypus) rendering: standard Helvetica/Courier (not embedded), CID fonts for Japanese/Chinese (not
embedded), link annotations, ListFlowable, Table with span and repeated header row, canvas header/footer, outline
bookmarks, footnotes as an end list. No Arabic (no shaping library here)."""
import html, os
from reportlab.lib.pagesizes import A4
from reportlab.lib.units import mm
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_JUSTIFY, TA_CENTER
from reportlab.platypus import BaseDocTemplate, PageTemplate, Frame, Paragraph, Spacer, Table, TableStyle, Image, ListFlowable, ListItem, Preformatted, FrameBreak, NextPageTemplate, KeepTogether
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from common import SRC, FIG, PDF
pdfmetrics.registerFont(UnicodeCIDFont('HeiseiKakuGo-W5')); pdfmetrics.registerFont(UnicodeCIDFont('STSong-Light'))
W, H = A4; M = 22 * mm
base = ParagraphStyle('b', fontName='Helvetica', fontSize=10.5, leading=14, spaceAfter=6)
st = {'title': ParagraphStyle('t', parent=base, fontName='Helvetica-Bold', fontSize=22, leading=26, spaceAfter=10),
      1: ParagraphStyle('h1', parent=base, fontName='Helvetica-Bold', fontSize=16, leading=20, spaceBefore=10),
      2: ParagraphStyle('h2', parent=base, fontName='Helvetica-Bold', fontSize=13.5, leading=17, spaceBefore=8),
      3: ParagraphStyle('h3', parent=base, fontName='Helvetica-Bold', fontSize=11.5, leading=15, spaceBefore=6),
      'just': ParagraphStyle('j', parent=base, alignment=TA_JUSTIFY), 'cap': ParagraphStyle('c', parent=base, fontSize=9, alignment=TA_CENTER),
      'ja': ParagraphStyle('ja', parent=base, fontName='HeiseiKakuGo-W5'), 'zh': ParagraphStyle('zh', parent=base, fontName='STSong-Light'),
      'cols': ParagraphStyle('cl', parent=base, fontSize=10)}
def runs(rs):
    o = []
    for r in rs:
        if 'fn' in r: o.append('<super>%d</super>' % r['fn']); continue
        t = html.escape(r['t'])
        if r.get('b'): t = '<b>%s</b>' % t
        if r.get('i'): t = '<i>%s</i>' % t
        if r.get('mono'): t = '<font name="Courier">%s</font>' % t
        if r.get('link'): t = '<a href="%s" color="blue">%s</a>' % (r['link'], t)
        o.append(t)
    return ''.join(o)
class Doc(BaseDocTemplate):
    def afterFlowable(self, f):
        if getattr(f, '_outline', None):
            lvl, txt = f._outline; self._n = getattr(self, '_n', 0) + 1; k = 'h%d' % self._n; self.canv.bookmarkPage(k); self.canv.addOutlineEntry(txt, k, lvl - 1, 0)
def deco(c, d):
    c.saveState(); c.setFont('Helvetica', 8)
    c.drawCentredString(W / 2, H - 14 * mm, SRC['meta']['header']); c.drawCentredString(W / 2, 12 * mm, '%s - Page %d' % (SRC['meta']['footer'], d.page)); c.restoreState()
doc = Doc(os.path.join(PDF, 'reportlab.pdf'), pagesize=A4, leftMargin=M, rightMargin=M, topMargin=24 * mm, bottomMargin=22 * mm, title=SRC['meta']['title'], author='Corpus generator')
fw = W - 2 * M; fh = H - 46 * mm
doc.addPageTemplates([PageTemplate(id='one', frames=[Frame(M, 22 * mm, fw, fh, id='f')], onPage=deco),
                      PageTemplate(id='two', frames=[Frame(M, 22 * mm, fw, fh, id='g')], onPage=deco)])
S = []
def cells_ar(): return None
for b in SRC['blocks']:
    t = b['type']; l = b.get('lang', 'en')
    if l == 'ar': continue   # no Arabic shaping here: absent
    if t == 'title': p = Paragraph(html.escape(b['text']), st['title']); p._outline = (1, b['text']); S.append(p)
    elif t == 'h': p = Paragraph(html.escape(b['text']), st[b['level']]); p._outline = (b['level'], b['text']); S.append(p)
    elif t == 'p':
        sty = st['just'] if b['id'] == 'p-long' else st.get(l, base)
        S.append(Paragraph(runs(b['runs']), sty))
    elif t in ('ul', 'ol'):
        items = []; stack = []
        # nested: build ListFlowable per level
        def build(items_, lvl):
            out = []; i = 0
            while i < len(items_):
                it = items_[i]
                if it['level'] == lvl:
                    sub = []; j = i + 1
                    while j < len(items_) and items_[j]['level'] > lvl: sub.append(items_[j]); j += 1
                    content = [Paragraph(html.escape(it['text']), base)]
                    if sub: content.append(build(sub, lvl + 1))
                    out.append(ListItem(content)); i = j
                else: i += 1
            return ListFlowable(out, bulletType='bullet' if t == 'ul' else '1', start='•' if t == 'ul' else None, leftIndent=14)
        S.append(build(b['items'], 0))
    elif t == 'table':
        data = []; spans = []
        for ri, row in enumerate(b['rows']):
            line = []; ci = 0
            for c in row:
                line.append(Paragraph(html.escape(c['text']).replace('\n', '<br/>'), ParagraphStyle('cell', parent=base, fontName='Helvetica-Bold' if c.get('header') else 'Helvetica', spaceAfter=0)))
                if c.get('span', 1) > 1: spans.append(('SPAN', (ci, ri), (ci + c['span'] - 1, ri))); line += [''] * (c['span'] - 1)
                ci += c.get('span', 1)
            data.append(line)
        tb = Table(data, colWidths=[fw / 3.2] * 3, repeatRows=1); tb.setStyle(TableStyle([('GRID', (0, 0), (-1, -1), 0.6, 'black')] + spans)); S += [Spacer(1, 4), tb, Spacer(1, 8)]
    elif t == 'figure': S += [Image(FIG, width=80 * mm, height=80 * mm * 190 / 360), Paragraph(html.escape(b['caption']), st['cap'])]
    elif t == 'columns':
        S.append(NextPageTemplate('one'))
        cw = (fw - 8 * mm) / 2; ps = [Paragraph(runs(p['runs']), st['cols']) for p in b['blocks']]
        tb = Table([[ [ps[0], ps[1]], [ps[2], ps[3]] ]], colWidths=[cw + 4 * mm, cw + 4 * mm]); tb.setStyle(TableStyle([('VALIGN', (0, 0), (-1, -1), 'TOP'), ('LEFTPADDING', (0, 0), (-1, -1), 0)]))
        S.append(tb)
    elif t == 'code': S.append(Preformatted('\n'.join(b['lines']), ParagraphStyle('code', parent=base, fontName='Courier', fontSize=9.5, leading=12, leftIndent=12)))
S.append(Spacer(1, 6)); S.append(Paragraph('Notes', st[2]))
for k, v in SRC['footnotes'].items(): S.append(Paragraph('%s %s' % (k, html.escape(v)), ParagraphStyle('n', parent=base, fontSize=9)))
doc.build(S); print('wrote reportlab.pdf')
