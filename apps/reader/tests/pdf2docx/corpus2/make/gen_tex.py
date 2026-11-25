#!/usr/bin/env python3
"""Builds WORK/<engine>.tex from source.json for pdflatex / xelatex / lualatex (hyperref on, real \\footnote, itemize/
enumerate, tabular with \\multicolumn, multicol, fancyhdr, verbatim). pdfLaTeX carries Latin only (no bidi/xeCJK/CJKutf8/
luatexja here). xelatex/lualatex take Arabic and CJK through fontspec fonts and the engines' own right-to-left primitives."""
import re, sys, os
from common import SRC, FIG, WORK
eng = sys.argv[1]
def esc(s):
    s = s.replace('\\', '\\textbackslash{}')
    for a, b in (('&', '\\&'), ('%', '\\%'), ('$', '\\$'), ('#', '\\#'), ('_', '\\_'), ('{', '\\{'), ('}', '\\}'), ('~', '\\textasciitilde{}'), ('^', '\\textasciicircum{}')): s = s.replace(a, b)
    return s
AR = re.compile(r'[\u0600-\u06FF]')
def rtl_text(s):
    """Arabic text for xe/lua: Latin and digit runs are put back left-to-right inside the right-to-left run."""
    parts = re.split(r'([A-Za-z0-9][A-Za-z0-9 ]*[A-Za-z0-9]|[A-Za-z0-9])', s); out = []
    for p in parts:
        if not p: continue
        if re.match(r'[A-Za-z0-9]', p):
            out.append('\\beginL %s\\endL{}' % p if eng == 'xelatex' else '{\\textdir TLT %s}' % p)
        else: out.append(p)
    return ''.join(out)
def cjk(s):  # no CJK line-breaking package here: a zero-width glue after each character gives the engine break points
    return ''.join(c + '\\hskip0pt\\relax{}' if ord(c) > 0x2E80 and c not in '，。、' else c + '\\hskip0pt\\relax{}' for c in s)
def runs(rs):
    o = []
    for r in rs:
        if 'fn' in r: o.append('\\footnote{%s}' % esc(SRC['footnotes'][str(r['fn'])])); continue
        t = esc(r['t'])
        if r.get('b'): t = '\\textbf{%s}' % t
        if r.get('i'): t = '\\textit{%s}' % t
        if r.get('mono'): t = '\\texttt{%s}' % t
        if r.get('link'): t = '\\href{%s}{%s}' % (r['link'], t)
        o.append(t)
    return ''.join(o)
uni = eng != 'pdflatex'
pre = ['\\documentclass[11pt,a4paper]{article}', '\\usepackage[a4paper,margin=22mm]{geometry}']
if eng == 'pdflatex': pre += ['\\usepackage[T1]{fontenc}', '\\usepackage{lmodern}', '\\input{glyphtounicode}\\pdfgentounicode=1']
else: pre += ['\\usepackage{fontspec}', '\\setmainfont{Carlito}', '\\setmonofont{DejaVu Sans Mono}',
              '\\newfontfamily\\arabicfont[Script=Arabic]{FreeSerif}', '\\newfontfamily\\jpfont{Noto Sans CJK JP}', '\\newfontfamily\\zhfont{Noto Sans CJK SC}']
if eng == 'xelatex': pre += ['\\TeXXeTstate=1']
pre += ['\\usepackage{graphicx,multicol,fancyhdr,caption}', '\\usepackage[hidelinks]{hyperref}',
        '\\hypersetup{pdftitle={%s}}' % esc(SRC['meta']['title']),
        '\\pagestyle{fancy}\\fancyhf{}\\fancyhead[C]{\\small %s}\\fancyfoot[C]{\\small %s -- Page \\thepage}' % (esc(SRC['meta']['header']), esc(SRC['meta']['footer'])),
        '\\renewcommand{\\headrulewidth}{0pt}\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{6pt}\\sloppy' if False else '\\renewcommand{\\headrulewidth}{0pt}\\setlength{\\parindent}{0pt}\\setlength{\\parskip}{6pt}',
        '\\begin{document}']
b = []
def rtl_par(s, extra=''):
    if eng == 'xelatex': return '{\\raggedleft\\arabicfont\\beginR %s\\endR\\par}' % rtl_text(s)
    return '{\\raggedleft\\pardir TRT\\textdir TRT\\arabicfont %s\\par}' % rtl_text(s)
for blk in SRC['blocks']:
    t = blk['type']; l = blk.get('lang', 'en')
    if t == 'title': b.append('{\\Huge\\bfseries %s\\par}\\vspace{6pt}' % esc(blk['text']))
    elif t == 'h':
        if l == 'ar':
            if uni: b.append('\\bigskip{\\Large\\bfseries %s}' % rtl_par(blk['text']).replace('{\\raggedleft', '{\\raggedleft\\Large\\bfseries'))
        else: b.append('\\%ssection*{%s}' % ('sub' * (blk['level'] - 1), esc(blk['text'])))
    elif t == 'p':
        txt = runs(blk['runs'])
        if l == 'ar':
            if uni: b.append(rtl_par(''.join(r['t'] for r in blk['runs'])))
        elif l == 'ja':
            if uni: b.append('{\\jpfont %s\\par}' % cjk(blk['runs'][0]['t']))
        elif l == 'zh':
            if uni: b.append('{\\zhfont %s\\par}' % cjk(blk['runs'][0]['t']))
        else: b.append(txt + '\n')
    elif t in ('ul', 'ol'):
        if l == 'ar':
            if uni:
                for it in blk['items']: b.append(rtl_par('\u2022 ' + it['text']))
            continue
        env = 'itemize' if t == 'ul' else 'enumerate'; depth = 0; out = []
        for it in blk['items']:
            while depth < it['level'] + 1: out.append('\\begin{%s}' % env); depth += 1
            while depth > it['level'] + 1: out.append('\\end{%s}' % env); depth -= 1
            out.append('\\item %s' % esc(it['text']))
        while depth > 0: out.append('\\end{%s}' % env); depth -= 1
        b.append('\n'.join(out))
    elif t == 'table':
        rows = blk['rows']
        if l == 'ar':
            if uni:
                b.append('\\begin{center}\\begin{tabular}{|c|c|}\\hline')
                for r in rows: b.append(' & '.join('{\\arabicfont\\beginR %s\\endR}' % rtl_text(c['text']) if eng == 'xelatex' else '{\\arabicfont\\pardir TRT\\textdir TRT %s}' % rtl_text(c['text']) for c in reversed(r)) + '\\\\\\hline')
                b.append('\\end{tabular}\\end{center}')
            continue
        b.append('\\begin{center}\\begin{tabular}{|l|l|l|}\\hline')
        for r in rows:
            cells = []
            for c in r:
                tx = '\\parbox[t]{3cm}{%s}' % '\\\\'.join(esc(x) for x in c['text'].split('\n')) if '\n' in c['text'] else esc(c['text'])
                if c.get('header'): tx = '\\textbf{%s}' % tx
                cells.append('\\multicolumn{%d}{|l|}{%s}' % (c['span'], tx) if c.get('span', 1) > 1 else tx)
            b.append(' & '.join(cells) + '\\\\\\hline')
        b.append('\\end{tabular}\\end{center}')
    elif t == 'figure':
        b.append('\\begin{figure}[h]\\centering\\includegraphics[width=8cm]{figure.png}\\caption*{%s}\\end{figure}' % esc(blk['caption']))
    elif t == 'columns':
        b.append('\\begin{multicols}{2}\n' + '\n\n'.join(runs(p['runs']) for p in blk['blocks']) + '\n\\end{multicols}')
    elif t == 'code': b.append('\\begin{verbatim}\n' + '\n'.join(blk['lines']) + '\n\\end{verbatim}')
b.append('\\end{document}')
src = '\n'.join(pre) + '\n' + '\n\n'.join(b) + '\n'
if eng == 'pdflatex': src = src.replace('Figure 1.', 'Figure 1.')
open(os.path.join(WORK, eng + '.tex'), 'w', encoding='utf-8').write(src); print('wrote', eng + '.tex')
