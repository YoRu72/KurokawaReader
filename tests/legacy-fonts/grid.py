import os
import pypdf, io, sys
from fontTools.cffLib import CFFFontSet
from fontTools.pens.basePen import BasePen
from PIL import Image, ImageDraw, ImageChops
r=pypdf.PdfReader(os.environ.get('PDF', 'book.pdf'))
fonts={}
def walk(res):
  if not res: return
  res=res.get_object()
  for k,f in (res.get('/Font') or {}).items():
    f=f.get_object(); n=f['/BaseFont'].split('+')[-1]
    fd=f.get('/FontDescriptor')
    if not fd or '/FontFile3' not in fd: continue
    d=fd['/FontFile3'].get_object().get_data(); c=CFFFontSet(); c.decompile(io.BytesIO(d),None)
    top=c[c.fontNames[0]]; cs=top.CharStrings
    fonts.setdefault(n,{})
    for g in top.charset:
      if g not in fonts[n]: fonts[n][g]=cs
  for k,x in (res.get('/XObject') or {}).items():
    x=x.get_object()
    if x.get('/Subtype')=='/Form': walk(x.get('/Resources'))
for p in r.pages[int(sys.argv[1]):int(sys.argv[2])]: walk(p.get('/Resources'))
print({n:len(v) for n,v in fonts.items()})
class P(BasePen):
  def __init__(s,ox,oy,sc): super().__init__(None); s.ox=ox; s.oy=oy; s.sc=sc; s.cur=[]; s.polys=[]
  def T(s,p): return (s.ox+p[0]*s.sc, s.oy-p[1]*s.sc)
  def _moveTo(s,p): s.cur=[s.T(p)]
  def _lineTo(s,p): s.cur.append(s.T(p))
  def _curveToOne(s,a,b,c):
    p0=s.cur[-1]; A,B,C=s.T(a),s.T(b),s.T(c)
    for i in range(1,9):
      t=i/8; s.cur.append(tuple((1-t)**3*p0[j]+3*(1-t)**2*t*A[j]+3*(1-t)*t*t*B[j]+t**3*C[j] for j in (0,1)))
  def _closePath(s):
    if len(s.cur)>2: s.polys.append(s.cur)
    s.cur=[]
  def _endPath(s): s._closePath()
for n,gl in fonts.items():
  names=sorted(gl)
  cols=12; cell=120; rows=(len(names)+cols-1)//cols
  im=Image.new('L',(cols*cell,rows*cell),255); dr=ImageDraw.Draw(im)
  for i,g in enumerate(names):
    x0=(i%cols)*cell; y0=(i//cols)*cell
    pen=P(x0+35,y0+80,0.065)
    try: gl[g][g].draw(pen)
    except Exception as e: pass
    mask=Image.new('1',im.size,0)
    for poly in pen.polys:
      m2=Image.new('1',im.size,0); ImageDraw.Draw(m2).polygon(poly,fill=1); mask=ImageChops.logical_xor(mask,m2)
    im.paste(0,mask=mask)
    dr.text((x0+3,y0+104),g[:16],fill=0)
    dr.rectangle([x0,y0,x0+cell-1,y0+cell-1],outline=180)
  im.save(f'{n}.png'); print(n, im.size)
