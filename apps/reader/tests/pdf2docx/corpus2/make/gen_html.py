#!/usr/bin/env python3
"""Builds WORK/source.html from source.json (semantic HTML: h1-h3, nested lists, thead table with colspan, figure/figcaption,
end-notes list for the footnotes (HTML has none), CSS columns, dir=rtl Arabic)."""
import html, os, shutil
from common import SRC, FIG, WORK
def esc(s): return html.escape(s, quote=True)
def runs(rs):
    o = []
    for r in rs:
        if 'fn' in r: o.append('<sup><a href="#fn%d" id="r%d">%d</a></sup>' % (r['fn'], r['fn'], r['fn'])); continue
        t = esc(r['t'])
        if r.get('b'): t = '<strong>%s</strong>' % t
        if r.get('i'): t = '<em>%s</em>' % t
        if r.get('mono'): t = '<code>%s</code>' % t
        if r.get('link'): t = '<a href="%s">%s</a>' % (esc(r['link']), t)
        o.append(t)
    return ''.join(o)
def lst(b):
    tag = b['type']; out = []; depth = -1
    for it in b['items']:
        while depth < it['level']: out.append('<%s>' % tag); depth += 1
        while depth > it['level']: out.append('</li></%s>' % tag); depth -= 1
        else: pass
        out.append('<li>%s' % esc(it['text']))
        # close <li> unless a nested list follows
        nxt = b['items'][b['items'].index(it) + 1] if b['items'].index(it) + 1 < len(b['items']) else None
        if not (nxt and nxt['level'] > it['level']): out.append('</li>')
    while depth >= 0: out.append('</%s>' % tag); depth -= 1
    return ''.join(out)
def lang_attr(l): return ' lang="%s"%s' % (l, ' dir="rtl"' if l == 'ar' else '')
body = []
for b in SRC['blocks']:
    t = b['type']; l = b.get('lang', 'en')
    if t == 'title': body.append('<h1 class="title">%s</h1>' % esc(b['text'])); continue
    if t == 'h': body.append('<h%d%s>%s</h%d>' % (b['level'] + 1, lang_attr(l), esc(b['text']), b['level'] + 1))
    elif t == 'p': body.append('<p%s%s>%s</p>' % (lang_attr(l), ' class="just"' if b['id'] == 'p-long' else '', runs(b['runs'])))
    elif t in ('ul', 'ol'): body.append('<div%s>%s</div>' % (lang_attr(l), lst(b)))
    elif t == 'table':
        rows = []
        for ri, row in enumerate(b['rows']):
            cells = []
            for c in row:
                tag = 'th' if c.get('header') else 'td'; sp = ' colspan="%d"' % c['span'] if c.get('span', 1) > 1 else ''
                cells.append('<%s%s>%s</%s>' % (tag, sp, esc(c['text']).replace('\n', '<br>'), tag))
            rows.append('<tr>%s</tr>' % ''.join(cells))
        head = rows[0]; rest = ''.join(rows[1:])
        body.append('<table%s><thead>%s</thead><tbody>%s</tbody></table>' % (lang_attr(l), head, rest))
    elif t == 'figure': body.append('<figure><img src="figure.png" width="300" alt="Sounding lines"><figcaption>%s</figcaption></figure>' % esc(b['caption']))
    elif t == 'columns': body.append('<div class="cols">%s</div>' % ''.join('<p>%s</p>' % runs(p['runs']) for p in b['blocks']))
    elif t == 'code': body.append('<pre>%s</pre>' % esc('\n'.join(b['lines'])))
body.append('<h2>Notes</h2><ol class="notes">%s</ol>' % ''.join('<li id="fn%s">%s <a href="#r%s">back</a></li>' % (k, esc(v), k) for k, v in SRC['footnotes'].items()))
css = '''@page{size:A4;margin:22mm 20mm}body{font-family:Carlito,"Noto Sans CJK JP","FreeSerif",sans-serif;font-size:11pt;line-height:1.35;color:#000}
h1,h2,h3,h4{font-weight:bold;margin:12pt 0 6pt}h1.title{font-size:24pt}h2{font-size:17pt}h3{font-size:14pt}h4{font-size:12pt}
p.just{text-align:justify;hyphens:auto;-webkit-hyphens:auto}[lang=ar]{font-family:FreeSerif,"DejaVu Sans",serif}[lang=ja]{font-family:"Noto Sans CJK JP",sans-serif}[lang=zh]{font-family:"Noto Sans CJK SC",sans-serif}
table{border-collapse:collapse;margin:8pt 0}th,td{border:1px solid #000;padding:3pt 8pt;text-align:left}[dir=rtl] th,[dir=rtl] td{text-align:right}
.cols{column-count:2;column-gap:20pt}.cols p{margin:0 0 8pt}pre{font-family:"DejaVu Sans Mono",monospace;font-size:9.5pt;margin:6pt 0 6pt 12pt}
figure{text-align:center;margin:8pt 0}figcaption{font-size:9.5pt}a{color:#0563c1}code{font-family:"DejaVu Sans Mono",monospace}'''
doc = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>%s</title><style>%s</style></head><body>%s</body></html>' % (esc(SRC['meta']['title']), css, '\n'.join(body))
open(os.path.join(WORK, 'source.html'), 'w', encoding='utf-8').write(doc); shutil.copy(FIG, os.path.join(WORK, 'figure.png')); print('wrote source.html', len(doc))
