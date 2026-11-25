#!/usr/bin/env python3
"""Where each list item of source.json stands in each corpus PDF: its text's first word and its mark (points; for a
right-to-left item, from the page's right edge), read with `pdftotext -bbox` (poppler). Writes ../listgeo.json, used by
score.cjs (list_geometry). A mark the text layer does not carry (a bullet drawn as a shape, a symbol glyph without text)
is null: only the text's place is judged there."""
import json, os, re, subprocess, html
HERE = os.path.dirname(os.path.abspath(__file__)); ROOT = os.path.dirname(HERE)
src = json.load(open(os.path.join(ROOT, 'source.json'))); man = json.load(open(os.path.join(ROOT, 'manifest.json')))
items = []
def walk(bs):
    for b in bs:
        if b['type'] in ('ul', 'ol'):
            for i, it in enumerate(b['items']): items.append({'list': b['id'], 'i': i, 'text': it['text'], 'rtl': b.get('lang') == 'ar'})
        if b['type'] == 'columns': walk(b['blocks'])
walk(src['blocks'])
WRE = re.compile(r'<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">(.*?)</word>')
PRE = re.compile(r'<page width="([\d.]+)" height="([\d.]+)">')
MARK = re.compile(r'^([•◦▪●○–—\-*o]|\(?[0-9a-zA-Z٠-٩ء-ي]{1,3}[.)]|[0-9]{1,3})$')
out = {}
for p in man['pdfs']:
    if p['id'].startswith('scan-'): continue
    try: x = subprocess.run(['pdftotext', '-bbox', os.path.join(ROOT, p['file']), '-'], capture_output=True, text=True).stdout
    except Exception: continue
    pages = x.split('<page ')[1:]; res = []
    for it in items:
        toks = it['text'].split(); found = None
        for pg in pages:
            W = float(PRE.search('<page ' + pg).group(1))
            ws = [(float(a), float(b), float(c), float(d), html.unescape(t)) for a, b, c, d, t in WRE.findall(pg)]
            lines = {}
            for w in ws: lines.setdefault(round((w[1] + w[3]) / 2), []).append(w)
            for key, ln0 in lines.items():
                ln = [w for k2, l2 in lines.items() if abs(k2 - key) <= 2 for w in l2]
                ln.sort(key=lambda w: -w[2] if it['rtl'] else w[0])
                for k, w in enumerate(ln):
                    if w[4] != toks[0] or (len(toks) > 1 and (k + 1 >= len(ln) or ln[k + 1][4] != toks[1])): continue
                    mk = ln[k - 1] if k > 0 and MARK.match(ln[k - 1][4]) and (w[0] - ln[k - 1][2] if not it['rtl'] else ln[k - 1][0] - w[2]) < 30 else None
                    if it['rtl']: found = {'text': round(W - w[2], 2), 'mark': round(W - mk[2], 2) if mk else None}
                    else: found = {'text': round(w[0], 2), 'mark': round(mk[0], 2) if mk else None}
                    break
                if found: break
            if found: break
        res.append({**{k: it[k] for k in ('list', 'i', 'rtl')}, **(found or {'text': None, 'mark': None})})
    out[p['id']] = res
json.dump(out, open(os.path.join(ROOT, 'listgeo.json'), 'w'), indent=1, ensure_ascii=False)
print('\n'.join(f"{k}: " + ' '.join(f"{r['text']}/{r['mark']}" for r in v) for k, v in out.items()))
