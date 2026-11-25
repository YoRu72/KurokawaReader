import sys, glob, os
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
d, out = sys.argv[1], sys.argv[2]
c = canvas.Canvas(out, pagesize=A4); c.setTitle('scan')
for f in sorted(glob.glob(os.path.join(d, 'pg-*.tif'))):
    c.drawImage(f, 0, 0, width=A4[0], height=A4[1]); c.showPage()
c.save()
