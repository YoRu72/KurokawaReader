# Build an EPUB 3 of مقامات الحريري from the Shamela page dumps in ./maqamat/.
import json, glob, os, re, html, zipfile, sys
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'maqamat')
OUT = os.path.join(HERE, 'maqamat-al-hariri.epub')
COVER = os.path.join(HERE, 'maqamat-cover.jpg')

pages = {}
for f in sorted(glob.glob(os.path.join(SRC, 'batch-*.json'))):
    d = json.load(open(f, encoding='utf-8'))
    for pg in d['pages']:
        pages[int(pg['page_id'])] = pg
ids = sorted(pages)
missing = [i for i in range(1, ids[-1] + 1) if i not in pages]
print('pages', len(ids), 'first', ids[0], 'last', ids[-1], 'missing', missing[:20], '...' if len(missing) > 20 else '')
if missing and '--force' not in sys.argv:
    sys.exit('missing pages — refusing to build (pass --force to build anyway)')

# TOC from Shamela (title → first page_id), fetched earlier.
TOC = [(1,"﷽"),(9,"المقامة الصنعانية"),(15,"المقامة الحلوانية"),(25,"المقامة الدينارية"),(30,"المقامة الدمياطية"),(38,"المقامة الكوفية"),(48,"المقامة المراغية"),(59,"المقامة البرقعيدية"),(67,"المقامة المعرية"),(75,"المقامة الإسكندرية"),(86,"المقامة الرحبية"),(94,"المقامة الساوية"),(102,"المقامة الدمشقية"),(115,"المقامة البغدادية"),(123,"المقامة المكية"),(131,"المقامة الفرضية"),(143,"المقامة المغربية"),(153,"المقامة القهقرية"),(162,"المقامة السنجارية"),(175,"المقامة النصيبية"),(184,"المقامة الفارقية"),(189,"المقامة الرازية"),(201,"المقامة الفراتية"),(210,"المقامة الشعرية"),(226,"المقامة القطيعية"),(238,"المقامة الكرجية"),(246,"المقامة الرقطاء"),(257,"المقامة الوبرية"),(270,"المقامة السمرقندية"),(280,"المقامة الواسطية"),(295,"المقامة الصورية"),(305,"المقامة الرملية"),(316,"المقامة الطيبية"),(340,"المقامة التفليسية"),(347,"المقامة الزبيدية"),(360,"المقامة الشيرازية"),(365,"المقامة الملطية"),(378,"المقامة الصعدية"),(388,"المقامة المروية"),(397,"المقامة العمانية"),(408,"المقامة التبريزية"),(421,"المقامة التنيسية"),(428,"المقامة النجرانية"),(439,"المقامة البكرية"),(459,"المقامة الشتوية"),(475,"المقامة الرملية"),(482,"المقامة الحلبية"),(501,"المقامة الحجرية"),(514,"المقامة الحرامية"),(525,"المقامة الساسانية"),(536,"المقامة البصرية"),(554,"خاتمة")]
TOC[0] = (1, "المقدّمة")

def to_arabic_digits(s):
    return s.translate(str.maketrans('0123456789', '٠١٢٣٤٥٦٧٨٩'))

def render_body(text, sub_titles, seen, chapter_title=''):
    """Shamela body → XHTML. Titles are <span data-type="title" id=toc-N>; paragraphs split on \\r;
    verse lines are 'hemistich ... hemistich'."""
    out = []
    # Replace title spans with markers
    def title_repl(m):
        return '\r@@TITLE@@' + html.unescape(re.sub(r'<[^>]+>', '', m.group(1))) + '\r'
    text = re.sub(r'<span data-type="title"[^>]*>(.*?)</span>', title_repl, text, flags=re.S)
    text = re.sub(r'<[^>]+>', '', text)
    for raw in text.split('\r'):
        line = raw.strip()
        if not line:
            continue
        if line.startswith('@@TITLE@@'):
            tl = line[len('@@TITLE@@'):].strip()
            if re.sub(r'[\u064B-\u0652\u0640\s]', '', tl) in ('بسماللهالرحمنالرحيم', '﷽'):
                out.append(f'<p class="basmala">{html.escape(tl)}</p>')
                continue
            if tl and tl != '﷽' and re.sub(r'[\u064B-\u0652\u0640]', '', tl) == re.sub(r'[\u064B-\u0652\u0640]', '', chapter_title):
                continue
            if tl and tl != '﷽':
                sub_titles.append(tl)
                out.append(f'<h3>{html.escape(tl)}</h3>')
            elif tl == '﷽':
                out.append(f'<p class="basmala">{html.escape(tl)}</p>')
            continue
        # Shamela's data repeats some long passages across neighbouring pages; drop exact repeats.
        if len(line) > 80:
            if line in seen:
                continue
            seen.add(line)
        if ' ... ' in line:
            a, b = line.split(' ... ', 1)
            out.append(f'<div class="verse"><span class="h1">{html.escape(a.strip())}</span><span class="h2">{html.escape(b.strip())}</span></div>')
        else:
            out.append(f'<p>{html.escape(line)}</p>')
    # wrap runs of verses in a poem block so they can be centred as a unit
    merged, i = [], 0
    while i < len(out):
        if out[i].startswith('<div class="verse">'):
            j = i
            while j < len(out) and out[j].startswith('<div class="verse">'):
                j += 1
            merged.append('<div class="poem">' + '\n'.join(out[i:j]) + '</div>')
            i = j
        else:
            merged.append(out[i]); i += 1
    return '\n'.join(merged)

def footnotes(text):
    text = re.sub(r'<[^>]+>', '', text or '').strip()
    if not text:
        return ''
    items = [l.strip() for l in text.split('\r') if l.strip()]
    return '<aside class="footnotes" epub:type="footnote"><hr/>' + ''.join(f'<p class="fn">{html.escape(l)}</p>' for l in items) + '</aside>'

chapters = []
for i, (start, title) in enumerate(TOC):
    end = TOC[i + 1][0] - 1 if i + 1 < len(TOC) else ids[-1]
    parts = [f'<h2 id="t{i}">{html.escape(title)}</h2>']
    subs = []
    seen = set()
    for pid in range(start, end + 1):
        pg = pages.get(pid)
        if not pg:
            continue
        parts.append(render_body(pg['body'], subs, seen, title))
        fn = footnotes(pg.get('foot'))
        if fn:
            parts.append(fn)
    body = '\n'.join(parts)
    # The first chapter's duplicated heading from the basmala title is removed by render_body.
    chapters.append((f'ch{i:02d}.xhtml', title, body, subs))

css = """
html { font-family: 'Uthman TN1', 'Amiri', 'Noto Naskh Arabic', serif; direction: rtl; }
body { margin: 1em; line-height: 1.9; }
h2 { text-align: center; font-size: 1.5em; margin: 1.2em 0 .8em; }
h3 { text-align: center; font-size: 1.15em; margin: 1.4em 0 .6em; color: #6b4a1a; }
p { margin: 0 0 .7em; text-align: justify; }
p.basmala { text-align: center; font-size: 1.4em; margin: 0 0 1em; }
.poem { margin: .9em auto; max-width: 34em; }
.verse { display: flex; gap: 2em; justify-content: space-between; margin: .15em 0; text-align: start; }
.verse span { flex: 1; }
.verse .h2 { text-align: end; }
.footnotes { font-size: .85em; color: #666; margin-top: 1.5em; }
.footnotes hr { width: 30%; margin: 0 0 .6em; border: 0; border-top: 1px solid #bbb; }
"""

z = zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED)
z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
z.writestr('OEBPS/style.css', css)
if os.path.exists(COVER):
    z.write(COVER, 'OEBPS/cover.jpg')

manifest = ['<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>', '<item id="css" href="style.css" media-type="text/css"/>']
if os.path.exists(COVER):
    manifest.append('<item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>')
spine, nav = [], []
for idx, (name, title, body, subs) in enumerate(chapters):
    doc = f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ar" xml:lang="ar" dir="rtl">
<head><meta charset="utf-8"/><title>{html.escape(title)}</title><link rel="stylesheet" href="style.css"/></head>
<body>
<section epub:type="chapter">
{body}
</section>
</body></html>'''
    z.writestr('OEBPS/' + name, doc)
    manifest.append(f'<item id="c{idx}" href="{name}" media-type="application/xhtml+xml"/>')
    spine.append(f'<itemref idref="c{idx}"/>')
    sub_nav = ''.join(f'<li><a href="{name}">{html.escape(s)}</a></li>' for s in subs[:3])
    nav.append(f'<li><a href="{name}#t{idx}">{html.escape(title)}</a>{("<ol>" + sub_nav + "</ol>") if sub_nav else ""}</li>')

z.writestr('OEBPS/nav.xhtml', f'''<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ar" xml:lang="ar" dir="rtl"><head><title>الفهرس</title></head>
<body><nav epub:type="toc" id="toc"><h1>الفهرس</h1><ol>{''.join(nav)}</ol></nav></body></html>''')
z.writestr('OEBPS/content.opf', f'''<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="ar" dir="rtl">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
<dc:identifier id="uid">urn:kurokawa:shamela:26585</dc:identifier>
<dc:title>مقامات الحريري</dc:title>
<dc:creator>أبو محمد القاسم بن علي الحريري البصري (ت ٥١٦هـ)</dc:creator>
<dc:language>ar</dc:language>
<dc:source>https://shamela.ws/book/26585</dc:source>
<dc:description>مقامات الحريري الخمسون كاملةً مع المقدّمة والخاتمة، نصُّ المكتبة الشاملة (الكتاب رقم ٢٦٥٨٥)، مع أرقام صفحات المطبوع بين معقوفين. العمل في الملك العام.</dc:description>
<dc:rights>النصّ في الملك العام (المؤلّف توفّي سنة ٥١٦هـ).</dc:rights>
<meta property="dcterms:modified">2026-10-20T00:00:00Z</meta>
</metadata>
<manifest>{''.join(manifest)}</manifest>
<spine page-progression-direction="rtl">{''.join(spine)}</spine>
</package>''')
z.close()
print(OUT, os.path.getsize(OUT) // 1024, 'KB', len(chapters), 'chapters')
