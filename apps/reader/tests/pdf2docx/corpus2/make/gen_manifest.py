#!/usr/bin/env python3
"""Writes ../manifest.json: for every PDF in ../pdf: program + version, route, Producer/Creator (pdfinfo), tagged, fonts
embedded/subset (pdffonts), pages, whether the long paragraph crosses a page, how many times the long word is hyphenated at a
line end, and which source features this rendering could carry (full | approx | absent; absent ones are not scored)."""
import json, os, re, subprocess, sys
from common import SRC, PDF, ROOT
def sh(*a):
    try: return subprocess.run(a, capture_output=True, text=True, timeout=60).stdout
    except Exception: return ''
def ver(*a): return (sh(*a) or '').strip().splitlines()[0:1] and (sh(*a) or '').strip().splitlines()[0] or ''
V = {'soffice': ver('soffice', '--version'), 'chrome': ver('google-chrome', '--version'), 'wkhtmltopdf': ver('wkhtmltopdf', '--version'),
     'pdflatex': ver('pdflatex', '--version'), 'xelatex': ver('xelatex', '--version'), 'qpdf': ver('qpdf', '--version'),
     'tesseract': ver('tesseract', '--version'), 'pdftoppm': (sh('pdftoppm', '-v') + subprocess.run(['pdftoppm', '-v'], capture_output=True, text=True).stderr).strip().splitlines()[0],
     'reportlab': 'ReportLab 5.0.1', 'pdf-lib': 'pdf-lib 1.17.1', 'playwright': 'Playwright 1.63.0 (Chromium print, tagged option)'}
KEYS = ['title', 'headings', 'longPara', 'emphasis', 'links', 'bullets', 'numbered', 'table', 'merged', 'picture', 'caption', 'footnotes', 'columns', 'headerFooter', 'mono', 'ligatures', 'hyphen', 'arabic', 'japanese', 'chinese']
def feats(**kw):
    f = {k: 'full' for k in KEYS}; f.update(kw); return f
LO = feats(); CH = feats(footnotes='approx'); TX = feats(footnotes='full')
TEXT_ONLY = {k: 'absent' for k in KEYS}; TEXT_ONLY.update(longPara='approx', ligatures='approx', hyphen='approx', arabic='approx', japanese='approx', chinese='approx', title='approx', headings='approx', table='approx')
PROG = {
 'lo-docx-tagged': ('LibreOffice Writer', V['soffice'], 'python-docx .docx -> soffice --convert-to pdf, UseTaggedPDF=true', LO),
 'lo-docx-untagged': ('LibreOffice Writer', V['soffice'], 'same .docx, UseTaggedPDF=false', LO),
 'lo-docx-pdfa': ('LibreOffice Writer', V['soffice'], 'same .docx, SelectPdfVersion=2 (PDF/A-2b), tagged', LO),
 'lo-odt-tagged': ('LibreOffice Writer', V['soffice'], '.fodt saved by LibreOffice from the .docx -> pdf, tagged', LO),
 'lo-odt-untagged': ('LibreOffice Writer', V['soffice'], '.fodt -> pdf, untagged', LO),
 'chain-lo-draw': ('LibreOffice Draw', V['soffice'], 'lo-docx-untagged.pdf opened by Draw (PDF import) and exported again; stands for "printed to PDF again" (Chromium viewer print is not scriptable here)', LO),
 'chrome-pw-tagged': ('Chromium (Skia/PDF)', V['playwright'] + '; ' + V['chrome'], 'HTML -> page.pdf with header/footer template, tagged=true, outline=true', CH),
 'chrome-pw-untagged': ('Chromium (Skia/PDF)', V['playwright'], 'HTML -> page.pdf, tagged=false, outline=false', CH),
 'chrome-cli': ('Google Chrome', V['chrome'], 'google-chrome --headless=new --print-to-pdf --no-pdf-header-footer (no running header/footer)', {**CH, 'headerFooter': 'absent'}),
 'wkhtmltopdf': ('wkhtmltopdf (unpatched Qt 5.15)', V['wkhtmltopdf'], 'HTML -> wkhtmltopdf; its header/footer flags need the patched Qt build, so no running header/footer', {**CH, 'headerFooter': 'absent', 'arabic': 'approx', 'hyphen': 'approx'}),
 'pdflatex': ('pdfLaTeX', V['pdflatex'], 'article, T1+lmodern, glyphtounicode, hyperref, fancyhdr, multicol; Latin only (no bidi/xeCJK/CJKutf8 here)', {**TX, 'arabic': 'absent', 'japanese': 'absent', 'chinese': 'absent'}),
 'xelatex': ('XeLaTeX', V['xelatex'], 'fontspec Carlito/FreeSerif/Noto Sans CJK; Arabic by TeXXeT \\beginR (no bidi/polyglossia here) so Arabic list/table are typed markers and reversed cells; CJK without xeCJK (zero-width glue breaks)', {**TX, 'arabic': 'approx'}),
 'reportlab': ('ReportLab platypus', V['reportlab'], 'standard Helvetica/Courier not embedded, CID fonts for CJK not embedded, no Arabic shaping library, footnotes as end list', {**feats(), 'footnotes': 'approx', 'arabic': 'absent', 'hyphen': 'absent'}),
 'pdflib': ('pdf-lib', V['pdf-lib'], 'plain positioned text + drawn table + picture, standard fonts; no footnotes/links/Arabic/CJK', {**feats(), 'footnotes': 'absent', 'links': 'absent', 'arabic': 'absent', 'japanese': 'absent', 'chinese': 'absent', 'headings': 'approx', 'bullets': 'approx', 'numbered': 'approx', 'hyphen': 'absent', 'title': 'approx'}),
 'scan-image': ('scan (pdftoppm 200 dpi 1-bit, wrapped with ReportLab)', V['pdftoppm'], 'lo-docx-untagged rasterised: image only, no text layer', {k: 'absent' for k in KEYS}),
 'scan-ocr': ('tesseract pdf output', V['tesseract'], 'same pages through tesseract -l eng+ara+jpn+chi_sim pdf: invisible text over the scan', TEXT_ONLY),
 'qpdf-linearized': ('qpdf rewrite', V['qpdf'], 'qpdf --linearize of lo-docx-tagged', LO),
 'qpdf-objstm': ('qpdf rewrite', V['qpdf'], 'qpdf --object-streams=generate of chrome-pw-tagged', CH),
 'qpdf-encrypted': ('qpdf encryption', V['qpdf'], 'qpdf --encrypt "" owner 256 of reportlab.pdf (empty user password)', {**feats(), 'footnotes': 'approx', 'arabic': 'absent', 'hyphen': 'absent'}),
}
FAILED = [{'id': 'lualatex', 'program': 'LuaLaTeX', 'status': 'failed', 'reason': 'luaotfload-main.lua is missing from this TeX Live install (fontspec cannot load any font), so no PDF could be made'}]
def pages_text(f, n): return [sh('pdftotext', '-f', str(i), '-l', str(i), '-raw', f, '-') for i in range(1, n + 1)]
out = {'source': 'source.json', 'generated': 'by make/gen_manifest.py', 'featureKeys': KEYS, 'pdfs': [], 'failed': FAILED}
LW = SRC['meta']['longWord']
for pid in sorted(PROG):
    f = os.path.join(PDF, pid + '.pdf')
    if not os.path.exists(f): print('MISSING', pid); continue
    info = sh('pdfinfo', f); g = lambda k: (re.search(r'^%s:\s*(.*)$' % k, info, re.M) or [None, ''])[1].strip()
    fonts = [l for l in sh('pdffonts', f).splitlines()[2:] if l.strip()]
    emb = [l.split()[-5] for l in fonts] if fonts else []
    # (pdffonts columns: ... emb sub uni obj gen -> emb is 5th from the end)
    sub = [l.split()[-4] for l in fonts]
    n = int(g('Pages') or 0); pt = pages_text(f, n) if 'scan-image' != pid else ['']
    alltxt = ' '.join(pt)
    first = [i + 1 for i, t in enumerate(pt) if 'The survey crew began' in t.replace('\n', ' ')]
    last = [i + 1 for i, t in enumerate(pt) if 'faded paper map' in t.replace('\n', ' ') or 'paper map of the outer' in t.replace('\n', ' ')]
    crosses = bool(first and last and first[0] != last[0])
    flat = re.sub(r'\s+', ' ', alltxt)
    broken = len(re.findall(r'(?i)elec[a-z]*-\s?[a-z]+', flat)) if LW in flat.replace('- ', '').replace('-', '') or 'electro' in flat else 0
    broken = sum(1 for m in re.finditer(r'(?i)(electro[a-z]*)-\s*([a-z]+)', flat) if (m.group(1) + m.group(2)).lower() == LW)
    prog, version, route, ft = PROG[pid]
    out['pdfs'].append({'id': pid, 'file': 'pdf/%s.pdf' % pid, 'program': prog, 'version': version, 'route': route, 'producer': g('Producer'), 'creator': g('Creator'),
        'tagged': g('Tagged').lower() == 'yes', 'encrypted': g('Encrypted').lower().startswith('yes'), 'linearized': g('Optimized').lower() == 'yes', 'pdfVersion': g('PDF version'),
        'pages': n, 'fontsEmbedded': 'none' if not fonts else ('all' if all(e == 'yes' for e in emb) else ('some' if any(e == 'yes' for e in emb) else 'none')),
        'fontsSubset': 'none' if not fonts else ('all' if all(s == 'yes' for s in sub) else ('some' if any(s == 'yes' for s in sub) else 'none')), 'fontCount': len(fonts),
        'bytes': os.path.getsize(f), 'longParaCrossesPage': crosses, 'longWordHyphenated': broken, 'features': ft})
json.dump(out, open(os.path.join(ROOT, 'manifest.json'), 'w'), indent=1, ensure_ascii=False)
print('manifest:', len(out['pdfs']), 'pdfs;', ', '.join('%s p%d x%d%s' % (p['id'], p['pages'], p['longWordHyphenated'], 'C' if p['longParaCrossesPage'] else '') for p in out['pdfs']))
