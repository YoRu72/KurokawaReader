# An EPUB holding a picture in each of the ways books place them: a plain <img>, one inside an internal link, an
# SVG-wrapped page illustration (<svg><image xlink:href>), <picture>/<source srcset>, an <img> with only srcset,
# a path with a space (written %20), an <object data>, and a CSS background illustration.
import zipfile, io, sys
from PIL import Image, ImageDraw
def png(color, label):
    im = Image.new('RGB', (360, 480), color); d = ImageDraw.Draw(im); d.rectangle((20, 20, 340, 460), outline='white', width=6); d.text((40, 40), label, fill='white')
    b = io.BytesIO(); im.save(b, 'PNG'); return b.getvalue()
out = sys.argv[1]
z = zipfile.ZipFile(out, 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
imgs = {'plain.png': ('#a33', 'plain'), 'linked.png': ('#3a3', 'linked'), 'svgpage.png': ('#33a', 'svg page'), 'pic.png': ('#a3a', 'picture'), 'srcset.png': ('#3aa', 'srcset only'), 'with space.png': ('#aa3', 'space'), 'object.png': ('#555', 'object'), 'bg.png': ('#a63', 'background')}
for n, (c, l) in imgs.items(): z.writestr('OEBPS/Images/' + n, png(c, l))
X = lambda body, title: f'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:xlink="http://www.w3.org/1999/xlink"><head><title>{title}</title><style>.bgill{{background-image:url(../Images/bg.png);background-size:contain;background-repeat:no-repeat;width:300px;height:400px}}</style></head><body>{body}</body></html>'
z.writestr('OEBPS/Text/c1.xhtml', X('<h1>One</h1><p>Before the pictures.</p><p><img id="pl" src="../Images/plain.png" alt="plain"/></p><p><a href="c2.xhtml#end"><img src="../Images/linked.png" alt="linked"/></a></p><p>After.</p>', 'One'))
z.writestr('OEBPS/Text/c2.xhtml', X('<div class="svgwrap"><svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="100%" height="100%" viewBox="0 0 360 480" preserveAspectRatio="xMidYMid meet"><image width="360" height="480" xlink:href="../Images/svgpage.png"/></svg></div><p id="end">The end of two.</p>', 'Two'))
z.writestr('OEBPS/Text/c3.xhtml', X('<h1>Three</h1><picture><source srcset="../Images/pic.png"/><img alt="picture"/></picture><p><img srcset="../Images/srcset.png 1x" alt="srcset only"/></p><p><img src="../Images/with%20space.png" alt="space"/></p><p><object data="../Images/object.png" type="image/png">an object</object></p><div class="bgill" role="img" aria-label="background"></div><p>Done.</p>', 'Three'))
man = ''.join(f'<item id="i{k}" href="Images/{n.replace(" ", "%20")}" media-type="image/png"/>' for k, n in enumerate(imgs))
z.writestr('OEBPS/content.opf', f'<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-images-test</dc:identifier><dc:title>Pictures Test</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="Text/c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="Text/c2.xhtml" media-type="application/xhtml+xml" properties="svg"/><item id="c3" href="Text/c3.xhtml" media-type="application/xhtml+xml"/>{man}</manifest><spine><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>')
z.writestr('OEBPS/nav.xhtml', X('<nav epub:type="toc"><ol><li><a href="Text/c1.xhtml">One</a></li><li><a href="Text/c2.xhtml">Two</a></li><li><a href="Text/c3.xhtml">Three</a></li></ol></nav>', 'Nav'))
z.close()
