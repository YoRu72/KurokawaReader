# A two-chapter EPUB for the translator test: a paragraph with italics and a name, one already in Arabic, and a
# second chapter (translated ahead while the first is read).
import zipfile, sys
out = sys.argv[1]
z = zipfile.ZipFile(out, 'w'); z.writestr('mimetype', 'application/epub+zip', compress_type=zipfile.ZIP_STORED)
z.writestr('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>')
X = lambda body, title: f'<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>{title}</title></head><body>{body}</body></html>'
z.writestr('OEBPS/c1.xhtml', X('<h1>The Gate</h1><p>Lin Feng looked at the <i>old gate</i> for a long time.</p><p>مرحبًا بكم في البوابة القديمة.</p><p>Then he walked on, alone.</p><p><a href="c2.xhtml">The Road</a></p>', 'The Gate'))
z.writestr('OEBPS/c2.xhtml', X('<h1>The Road</h1><p>The road went on into the hills.</p>', 'The Road'))
z.writestr('OEBPS/nav.xhtml', X('<nav epub:type="toc"><ol><li><a href="c1.xhtml">The Gate</a></li><li><a href="c2.xhtml">The Road</a></li></ol></nav>', 'Contents'))
z.writestr('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">kr-translator-test</dc:identifier><dc:title>Gate Story</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>')
z.close()
