import os
import pypdf, io, json
from fontTools.cffLib import CFFFontSet
from fontTools.pens.boundsPen import BoundsPen
def fnv(b):
  h=0x811c9dc5
  for x in b: h=((h^x)*0x01000193)&0xffffffff
  return h
r=pypdf.PdfReader(os.environ.get('PDF', 'book.pdf'))
out={}
def walk(res):
  if not res: return
  res=res.get_object()
  for k,f in (res.get('/Font') or {}).items():
    f=f.get_object(); n=f['/BaseFont'].split('+')[-1]
    fd=f.get('/FontDescriptor')
    if not fd or '/FontFile3' not in fd or n in out: continue
    d=fd['/FontFile3'].get_object().get_data(); c=CFFFontSet(); c.decompile(io.BytesIO(d),None)
    top=c[c.fontNames[0]]; cs=top.CharStrings; gs=top.getGlyphOrder()
    out[n]={}
    for g in top.charset:
      b=cs[g].bytecode
      if b is None: cs[g].compile(); b=cs[g].bytecode
      from fontTools.pens.recordingPen import DecomposingRecordingPen
      rp=DecomposingRecordingPen(gs)
      try: cs[g].draw(rp)
      except Exception: pass
      pts=[]
      for op,args in rp.value:
        pts+= [p for p in args if isinstance(p,tuple)]
      body=[p[0] for p in pts if p[1] >= -40]
      bb=(min(body),0,max(body),0) if body else ((min(p[0] for p in pts),0,max(p[0] for p in pts),0) if pts else None)
      out[n][g]=[fnv(b), bb]
  for k,x in (res.get('/XObject') or {}).items():
    x=x.get_object()
    if x.get('/Subtype')=='/Form': walk(x.get('/Resources'))
for p in r.pages: walk(p.get('/Resources'))
json.dump(out,open('hashes.json','w'))
for n in ('Adv_Lots_Ma','Adv_Lots_Ba'):
  print(n, {g:v[1] for g,v in out[n].items() if g in 'k l m n o p q r s t u'.split()})
