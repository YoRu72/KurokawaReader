#!/usr/bin/env python3
"""What the Android build must and must not carry: every Python pack with yt-dlp in it, and an APK with no large
resource (the 3 MB yt-dlp script youtubedl-android bundles) and no Picnic tables (Bouncy Castle, unused).
Usage: checksize.py <packs dir> <apk>"""
import glob, sys, zipfile
packs, apk = sys.argv[1], sys.argv[2]
bad = []
for f in glob.glob(f'{packs}/*python*.zip'):
    if 'yt-dlp' not in zipfile.ZipFile(f).namelist(): bad.append(f'no yt-dlp in {f}')
if not glob.glob(f'{packs}/*python*.zip'): bad.append('no Python pack made')
z = zipfile.ZipFile(apk)
bad += [f'large resource {i.filename} ({i.file_size} bytes)' for i in z.infolist() if i.filename.startswith('res/') and i.file_size > 1_000_000]
bad += [f'Picnic table {i.filename}' for i in z.infolist() if 'picnic' in i.filename]
for b in bad: print('FAIL', b)
print('size check:', 'failed' if bad else 'passed')
sys.exit(1 if bad else 0)
