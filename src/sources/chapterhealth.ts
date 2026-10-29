// A chapter the site did not really give: the page of a browser check ("Just a moment…") or of an error in its
// place, or next to nothing. Such a chapter is not kept — and one kept by an older version is let go and fetched
// again (IReader's chapter health check).

const CHECK = /\b(?:just a moment\.{0,3}|checking (?:if the site connection is secure|your browser)|verify(?:ing)? (?:that )?you are (?:a )?human|enable javascript and cookies to continue|attention required!? \| cloudflare|ddos protection by|cf-browser-verification|please complete the security check|access denied|error 1020|too many requests)\b/i;

/** Why a chapter's HTML is not the chapter: 'check' (a check or error page), 'empty', or null when it is fine. */
export function badChapter(html: string): 'check' | 'empty' | null {
  const text = html.replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
  // (A check page is short: a long chapter that mentions "access denied" in its story is a chapter.)
  if (text.length < 600 && CHECK.test(text)) return 'check';
  if (text.length < 15 && !/<img\b/i.test(html)) return 'empty';
  return null;
}
