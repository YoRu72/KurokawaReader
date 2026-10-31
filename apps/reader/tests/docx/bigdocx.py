# python3 tests/docx/bigdocx.py <out.docx> [paragraphs=1500] [images=80]: a long Word document — headings every
# forty paragraphs, Arabic and English paragraphs, tables, footnote-like notes, and pictures (each a fresh PNG, so
# nothing is shared) — to time the reader on, as a phone would see a thesis or a scanned-and-OCRed book.
import sys, io, random
import docx
from docx.shared import Pt, Inches
from PIL import Image, ImageDraw
out = sys.argv[1]; N = int(sys.argv[2]) if len(sys.argv) > 2 else 1500; NI = int(sys.argv[3]) if len(sys.argv) > 3 else 80
rnd = random.Random(1)
AR = 'الحمد لله الذي جعل البيت الحرام مثابة للناس وأمنا، والصلاة والسلام على المبعوث رحمة للعالمين، وعلى آله وصحبه أجمعين. '
EN = 'The office finds that efficient workflows affect the final outcome significantly, and the committee reviews the quarterly figures. '
d = docx.Document()
d.add_heading('كتاب طويل للاختبار', 0)
img_every = max(1, N // NI)
for i in range(N):
    if i % 40 == 0: d.add_heading(f'الفصل {i // 40 + 1}: عنوان الفصل' if i % 80 == 0 else f'Chapter {i // 40 + 1}', 1 if i % 80 == 0 else 2)
    p = d.add_paragraph((AR if i % 3 else EN) * rnd.randint(2, 6)); p.runs[0].font.size = Pt(12)
    if i % 25 == 7:
        t = d.add_table(rows=5, cols=4); t.style = 'Table Grid'
        for r in range(5):
            for c in range(4): t.cell(r, c).text = f'{r},{c} ' + ('نص' if c % 2 else 'text')
    if i % img_every == 3:
        im = Image.new('RGB', (900, 600), (rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255))); dr = ImageDraw.Draw(im)
        for _ in range(40):
            x0, y0 = rnd.randint(0, 800), rnd.randint(0, 500); dr.ellipse([x0, y0, x0 + rnd.randint(10, 100), y0 + rnd.randint(10, 100)], fill=(rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255)))
        b = io.BytesIO(); im.save(b, 'PNG'); b.seek(0); d.add_picture(b, width=Inches(5))
d.save(out); print('saved', out)
