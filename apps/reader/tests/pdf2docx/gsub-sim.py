import sys
from fontTools.ttLib import TTFont
f=TTFont(sys.argv[1]); cm=f.getBestCmap(); G=f['GSUB'].table; L=G.LookupList.Lookup
gdef=f['GDEF'].table.GlyphClassDef.classDefs
feat={fr.FeatureTag:fr.Feature.LookupListIndex for fr in G.FeatureList.FeatureRecord}
def J(c):
  c=ord(c)
  if 0x64b<=c<=0x65f or c==0x670: return 'T'
  if c in (0x622,0x623,0x624,0x625,0x627,0x629,0x62f,0x630,0x631,0x632,0x648): return 'R'
  if 0x620<=c<=0x64a and c!=0x621: return 'D'
  return 'U'
def shape(t):
  forms=[]
  for i,ch in enumerate(t):
    if J(ch) in 'TU': forms.append(None); continue
    p=i-1
    while p>=0 and J(t[p])=='T': p-=1
    q=i+1
    while q<len(t) and J(t[q])=='T': q+=1
    jp = p>=0 and J(t[p])=='D'
    jn = q<len(t) and J(ch)=='D' and J(t[q]) in 'DR'
    forms.append('medi' if jp and jn else 'fina' if jp else 'init' if jn else 'isol')
  buf=[[cm.get(ord(ch),'.notdef'),fm] for ch,fm in zip(t,forms)]
  for fm in ('isol','fina','medi','init'):
    for li in feat.get(fm,[]):
      for g in buf:
        if g[1]==fm and g[0] in L[li].SubTable[0].mapping: g[0]=L[li].SubTable[0].mapping[g[0]]
  def lig(li):
    lk=L[li]; ign=lk.LookupFlag&8; st=lk.SubTable[0]; i=0
    while i<len(buf):
      g=buf[i][0]
      if g in st.ligatures:
        for lg in st.ligatures[g]:
          j=i+1; ok=True; used=[i]
          for comp in lg.Component:
            while ign and j<len(buf) and gdef.get(buf[j][0])==3: j+=1
            if j>=len(buf) or buf[j][0]!=comp: ok=False; break
            used.append(j); j+=1
          if ok:
            buf[i][0]=lg.LigGlyph
            for k in reversed(used[1:]): del buf[k]
            break
      i+=1
  for li in feat.get('rlig',[]): lig(li)
  out=[g[0] for g in buf]
  print(t, ' '.join(out))
  for li in feat.get('calt',[]):
    lk=L[li]
    for i in range(len(buf)):
      for st in lk.SubTable:
        if st.Format!=3: continue
        if buf[i][0] not in st.InputCoverage[0].glyphs: continue
        def nxt(k,d):
          k+=d
          while 0<=k<len(buf) and gdef.get(buf[k][0])==3: k+=d
          return k
        ok=True
        for c in st.LookAheadCoverage:
          k=nxt(i,1); ok = ok and 0<=k<len(buf) and buf[k][0] in c.glyphs
        for c in st.BacktrackCoverage:
          k=nxt(i,-1); ok = ok and 0<=k<len(buf) and buf[k][0] in c.glyphs
        if ok:
          sub=L[st.SubstLookupRecord[0].LookupListIndex].SubTable[0].mapping
          print('  calt', buf[i][0], '->', sub.get(buf[i][0])); buf[i][0]=sub.get(buf[i][0],buf[i][0]); break
  print('  final', ' '.join(g[0] for g in buf))
for t in sys.argv[2:]: shape(t)
