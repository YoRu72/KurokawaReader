#!/usr/bin/env python3
"""Makes figure.png: a tiny generated picture (sounding lines over a basin outline), used by every rendering."""
from PIL import Image, ImageDraw
import os
im = Image.new('RGB', (360, 190), (225, 236, 244)); d = ImageDraw.Draw(im)
d.polygon([(20, 150), (60, 40), (200, 25), (330, 70), (340, 160), (180, 175)], fill=(170, 200, 224), outline=(40, 80, 120))
for k in range(6): d.line([(40 + k * 8, 150 - k * 14), (320 - k * 6, 70 + k * 12)], fill=(30, 70, 110), width=2)
for k in range(5): d.ellipse([60 + k * 55, 60 + (k % 2) * 40, 68 + k * 55, 68 + (k % 2) * 40], fill=(200, 60, 60))
im = im.quantize(16)
im.save(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'figure.png'), optimize=True)
