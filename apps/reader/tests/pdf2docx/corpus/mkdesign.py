# Design-tool PDFs (what Canva, Figma and the like export): every glyph placed on its own, rotated text, text
# with wide letter spacing, overlapping layers (text over shapes, shapes over text), a full-page background
# picture, and a "title" drawn as outlines (paths, not text). Run: python3 mkdesign.py → design.pdf
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib.colors import Color, HexColor
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image, ImageDraw
import math, os, glob

W, H = A4
fonts = glob.glob('/usr/share/fonts/**/DejaVuSans.ttf', recursive=True) or glob.glob('/usr/share/fonts/**/*.ttf', recursive=True)
pdfmetrics.registerFont(TTFont('Deja', fonts[0]))
bold = glob.glob('/usr/share/fonts/**/DejaVuSans-Bold.ttf', recursive=True)
pdfmetrics.registerFont(TTFont('DejaB', bold[0] if bold else fonts[0]))

# A background picture: a soft gradient with blobs, like a poster's.
img = Image.new('RGB', (595, 842), (250, 244, 230)); d = ImageDraw.Draw(img)
for i in range(0, 842, 4):
    d.line([(0, i), (595, i)], fill=(250 - i // 10, 244 - i // 14, 230 - i // 20))
for cx, cy, r, col in [(120, 160, 140, (255, 200, 120)), (480, 700, 180, (160, 200, 255)), (520, 120, 90, (255, 170, 200))]:
    d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=col)
img.save('bg.jpg', quality=80)

c = canvas.Canvas('design.pdf', pagesize=A4)

def per_glyph(text, x, y, font, size, spacing=0.0, color=HexColor('#222222')):
    """Each glyph with its own Tm — the way design tools write text — with extra spacing between them."""
    c.setFillColor(color)
    for ch in text:
        c.setFont(font, size); c.drawString(x, y, ch)
        x += pdfmetrics.stringWidth(ch, font, size) + spacing

# Page 1: poster — background, overlapping layers, per-glyph text, rotated text, outlines.
c.drawImage(ImageReader('bg.jpg'), 0, 0, W, H)
c.setFillColor(Color(0.1, 0.1, 0.3, alpha=0.85)); c.roundRect(50, 560, 495, 220, 24, fill=1, stroke=0)
per_glyph('SUMMER FESTIVAL', 80, 700, 'DejaB', 34, spacing=6, color=HexColor('#ffffff'))
per_glyph('Music · Food · Art', 80, 650, 'Deja', 18, spacing=2.5, color=HexColor('#ffd166'))
per_glyph('12–14 July 2026, Riverside Park', 80, 610, 'Deja', 14, spacing=0.8, color=HexColor('#eeeeee'))
# A shape over text (the layer order of a design tool): the text under a translucent band stays text.
per_glyph('Early-bird tickets from 15 €', 80, 500, 'Deja', 16, color=HexColor('#333333'))
c.setFillColor(Color(1, 0.4, 0.3, alpha=0.5)); c.rect(60, 490, 300, 30, fill=1, stroke=0)
# Rotated text: a diagonal stamp and a vertical side label.
c.saveState(); c.translate(420, 420); c.rotate(30); per_glyph('LIMITED', -60, 0, 'DejaB', 40, spacing=4, color=Color(0.9, 0.1, 0.1, alpha=0.8)); c.restoreState()
c.saveState(); c.translate(560, 120); c.rotate(90); per_glyph('riverside-festival.example', 0, 0, 'Deja', 12, spacing=1, color=HexColor('#555555')); c.restoreState()
# A "title" as outlines: letters drawn as paths (no text in the PDF at all).
c.setFillColor(HexColor('#1d3557')); c.setStrokeColor(HexColor('#1d3557'))
p = c.beginPath(); p.moveTo(80, 300); p.lineTo(80, 380); p.lineTo(110, 380); p.curveTo(140, 380, 140, 340, 110, 340); p.lineTo(80, 340); c.drawPath(p, fill=1, stroke=0)   # a "P"
p = c.beginPath(); p.moveTo(160, 300); p.lineTo(160, 380); p.lineTo(220, 380); p.lineTo(220, 368); p.lineTo(172, 368); p.lineTo(172, 346); p.lineTo(210, 346); p.lineTo(210, 334); p.lineTo(172, 334); p.lineTo(172, 312); p.lineTo(220, 312); p.lineTo(220, 300); c.drawPath(p, fill=1, stroke=0)   # an "E"
# Body text with per-glyph placement and a slight baseline wobble (Figma's rounding).
y = 250
for line in ['Three days of music on two stages, street food from forty kitchens,', 'and an open-air gallery along the river. Children under twelve free.', 'Tickets and the full programme at the address on the side.']:
    x = 80
    for ch in line:
        c.setFont('Deja', 11); c.setFillColor(HexColor('#222222')); c.drawString(x, y + (0.15 if ord(ch) % 2 else -0.15), ch); x += pdfmetrics.stringWidth(ch, 'Deja', 11)
    y -= 16
c.showPage()

# Page 2: a social card — text in a circle (each glyph rotated), overlapping boxes, text behind a picture.
c.setFillColor(HexColor('#0b132b')); c.rect(0, 0, W, H, fill=1, stroke=0)
c.setFillColor(HexColor('#1c2541')); c.circle(W / 2, H / 2 + 60, 200, fill=1, stroke=0)
txt = 'DESIGN • TOOLS • EXPORT • TEST • '
n = len(txt); r = 215
for i, ch in enumerate(txt):
    a = 90 - i * (360 / n)
    c.saveState(); c.translate(W / 2 + r * math.cos(math.radians(a)), H / 2 + 60 + r * math.sin(math.radians(a))); c.rotate(a - 90)
    c.setFont('DejaB', 16); c.setFillColor(HexColor('#5bc0be')); c.drawString(-5, 0, ch); c.restoreState()
per_glyph('HELLO', W / 2 - 95, H / 2 + 50, 'DejaB', 48, spacing=8, color=HexColor('#ffffff'))
c.setFillColor(HexColor('#3a506b')); c.rect(80, 120, 435, 160, fill=1, stroke=0)
per_glyph('A card with layers: a box, then text, then a picture over part of it.', 95, 250, 'Deja', 12, color=HexColor('#ffffff'))
per_glyph('Text that a picture half covers should still come out whole.', 95, 225, 'Deja', 12, color=HexColor('#ffffff'))
c.drawImage(ImageReader('bg.jpg'), 300, 130, 200, 120)
c.saveState(); c.translate(100, 140); c.rotate(-15); per_glyph('tilted caption', 0, 0, 'Deja', 14, spacing=1.5, color=HexColor('#ffd166')); c.restoreState()
c.showPage()
c.save()
os.remove('bg.jpg')
print('design.pdf')
