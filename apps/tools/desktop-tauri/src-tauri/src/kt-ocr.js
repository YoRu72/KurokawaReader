ObjC.import('Vision'); ObjC.import('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  const req = $.VNRecognizeTextRequest.alloc.init; req.recognitionLevel = 0; req.usesLanguageCorrection = true;
  if (argv[1]) req.recognitionLanguages = $([argv[1]]);
  const h = $.VNImageRequestHandler.alloc.initWithURLOptions(url, $({}));
  h.performRequestsError($([req]), null);
  const out = []; const res = req.results; const n = res ? res.count : 0;
  for (let i = 0; i < n; i++) { const o = res.objectAtIndex(i); const c = o.topCandidates(1); if (!c.count) continue; const b = o.boundingBox; out.push({ text: c.objectAtIndex(0).string.js, x: b.origin.x, y: b.origin.y, width: b.size.width, height: b.size.height }); }
  return JSON.stringify(out);
}