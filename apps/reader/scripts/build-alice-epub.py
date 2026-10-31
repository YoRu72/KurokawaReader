import os, re, zipfile, glob
HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'alice/src/epub')
PNG = os.path.join(HERE, 'alice-png')
OUT = os.path.join(HERE, 'alice-in-wonderland.epub')

def img_name(svg):
    return 'cover.jpg' if svg == 'cover.svg' else svg.replace('.svg', '.png')

z = zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED)
z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0" encoding="UTF-8"?>\n<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="epub/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')

opf = open(os.path.join(SRC, 'content.opf'), encoding='utf-8').read()
def fix_item(m):
    href = m.group(1)
    if href.startswith('images/') and href.endswith('.svg'):
        new = 'images/' + img_name(os.path.basename(href))
        mt = 'image/jpeg' if new.endswith('.jpg') else 'image/png'
        return m.group(0).replace(href, new).replace('media-type="image/svg+xml"', f'media-type="{mt}"')
    return m.group(0)
opf = re.sub(r'<item[^>]*href="([^"]+)"[^>]*/>', fix_item, opf)
z.writestr('epub/content.opf', opf)

for f in sorted(glob.glob(os.path.join(SRC, 'text/*.xhtml'))) + [os.path.join(SRC, 'toc.xhtml')]:
    t = open(f, encoding='utf-8').read()
    t = re.sub(r'(\.\./)?images/([\w-]+)\.svg', lambda m: (m.group(1) or '') + 'images/' + img_name(m.group(2) + '.svg'), t)
    rel = os.path.relpath(f, SRC)
    z.writestr('epub/' + rel, t)
for f in glob.glob(os.path.join(SRC, 'css/*.css')):
    z.writestr('epub/css/' + os.path.basename(f), open(f, encoding='utf-8').read())
for f in glob.glob(os.path.join(PNG, '*')):
    z.write(f, 'epub/images/' + os.path.basename(f))
z.close()
print(OUT, os.path.getsize(OUT) // 1024, 'KB')
