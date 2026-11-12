// A chapter the site did not really give: the page of a browser check ("Just a moment…") or of an error in its
// place, or next to nothing. Such a chapter is not kept — and one kept by an older version is let go and fetched
// again (IReader's chapter health check).

const CHECK = /\b(?:just a moment\.{0,3}|checking (?:if the site connection is secure|your browser)|verify(?:ing)? (?:that )?you are (?:a )?human|enable javascript and cookies to continue|attention required!? \| cloudflare|ddos protection by|cf-browser-verification|please complete the security check|access denied|error 1020|too many requests)\b/i;

const SHORT_ERROR = /^(?:(?:http\s*)?(?:error\s*)?(?:[45]\d\d)?[\s:.\-–—]*(?:page\s+)?(?:not\s+found|forbidden|unauthori[sz]ed|bad\s+(?:gateway|request)|service\s+(?:temporarily\s+)?unavailable|internal\s+server\s+error|gateway\s+time-?out|error|null|undefined|none|no\s+content|empty)?[.!]?|[45]\d\d)$/i;

/** Why a chapter's HTML is not the chapter: 'check' (a check or error page), 'empty', or null when it is fine. */
export function badChapter(html: string): 'check' | 'empty' | null {
  const text = html.replace(/<(?:script|style)[^>]*>[\s\S]*?<\/(?:script|style)>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/\s+/g, ' ').trim();
  // (A check page is short: a long chapter that mentions "access denied" in its story is a chapter.)
  if (text.length < 600 && CHECK.test(text)) return 'check';
  // (Nothing: no letter or digit at all, or a few words that are only an error in the chapter's place. A chapter
  // short by right — "The End.", «تمت.», «完» — is a chapter: it was once taken for nothing, never kept, and a
  // download of every chapter never finished.)
  if (!/<img\b/i.test(html) && (!/[\p{L}\p{N}]/u.test(text) || (text.length < 40 && SHORT_ERROR.test(text)))) return 'empty';
  return null;
}
