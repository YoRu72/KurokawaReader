// yt-dlp's failures in plain words, one table for every platform: the desktop shells (Electron, Tauri) and the phone
// hand the page yt-dlp's own last error line as it is, and this decides what the person is told and what they can
// do about it (sign in, try again now or later, get a JavaScript runtime, bring yt-dlp up to date). The raw line
// stays available under «Details». Pure: no DOM, no requests (tests/videoerrors.cjs runs it alone).

export type VideoErrKind = 'botCheck' | 'ageGate' | 'private' | 'members' | 'signIn' | 'rateLimit' | 'geo' | 'gone' | 'notLive' | 'noJs' | 'outdated' | 'timeout' | 'network' | 'unsupported' | 'other';
/** What the sheet offers beside the message. */
export type VideoErrAction = 'signIn' | 'retry' | 'retryLater' | 'getDeno' | null;
export interface VideoErr { kind: VideoErrKind; /** The i18n key of the plain message. */ key: string; action: VideoErrAction; /** yt-dlp's own line, «ERROR:» and the extractor's tag taken off. */ raw: string }
export type Shell = 'tauri' | 'electron' | 'android' | 'web';

// (Order matters: the first that matches wins — a «sign in to confirm you're not a bot» is the check, not a sign-in.)
const TABLE: [VideoErrKind, RegExp][] = [
  ['botCheck', /confirm (that )?you('|’)?re not a (bot|robot)|not a robot|captcha|unusual traffic|automated (requests|queries)/i],
  ['ageGate', /age[- ]?restrict|confirm your age|inappropriate for some users|age[- ]?gate|age verification|\b18\+/i],
  ['private', /private video|this video is private|video is private|protected (tweet|post|account)|private (post|account|profile)|this account is private/i],
  ['members', /members[- ]?only|join this channel|available to (this channel's )?members|premium members|requires? (a )?(paid )?subscription/i],
  ['notLive', /live event will begin|premieres? in|this live event|is upcoming|has not (yet )?started|stream (has )?not (yet )?(started|begun)|waiting for (the )?(live|stream)/i],
  ['rateLimit', /HTTP Error 429|too many requests|rate[- ]?limit|try again later/i],
  ['geo', /not available in your (country|region)|geo[- ]?restrict|blocked in your (country|region)|not made this video available in your country|unavailable in your location/i],
  ['gone', /video (is )?unavailable|has been removed|no longer available|does not exist|HTTP Error 404|account (has been )?(terminated|suspended)|was deleted|been deleted|content isn'?t available|post (is )?unavailable/i],
  ['signIn', /sign ?in|log ?in|login required|requires? (an )?account|authenticat|use --cookies|cookies (are|is) (needed|required)|this content requires/i],
  ['noJs', /No supported JavaScript runtime|n challenge solving failed|signature solving failed|js[- ]?runtimes?/i],
  ['outdated', /unable to extract|failed to extract|failed to parse|nsig extraction failed|player response|Unable to download API page|KeyError|IndexError|please report this issue|update yt-dlp|yt-dlp -U/i],
  ['timeout', /timed? ?out|timeout/i],
  ['unsupported', /unsupported url|no video formats found|no media found|is not a valid URL/i],
  ['network', /unable to download webpage|getaddrinfo|name or service not known|network is unreachable|connection (refused|reset)|temporary failure in name resolution|ssl|certificate|HTTP Error 5\d\d|remote end closed/i],
];
const KEY: Record<VideoErrKind, string> = {
  botCheck: 'vErrBotCheck', ageGate: 'vErrAge', private: 'vErrPrivate', members: 'vErrMembers', signIn: 'vErrSignIn', rateLimit: 'vErrRateLimit', geo: 'vErrGeo', gone: 'vErrGone',
  notLive: 'vErrNotLive', noJs: 'vErrNoJs', outdated: 'vErrOutdated', timeout: 'vErrTimeout', network: 'vErrNetwork', unsupported: 'vErrUnsupported', other: 'vErrOther',
};
/** yt-dlp's line tidied: «ERROR: [youtube] abc: …» → «…», spaces folded, at most 300 characters. */
export function rawLine(e: unknown): string {
  return String((e as Error)?.message ?? e ?? '').replace(/^(?:Error:\s*)?ERROR:\s*/i, '').replace(/^\[[\w:.-]+\]\s*(?:[\w-]{1,40}:\s+)?/, '').replace(/\s+/g, ' ').trim().slice(0, 300);
}
/** The plain message and the action for a failure seen on `shell`. */
export function videoError(e: unknown, shell: Shell): VideoErr {
  const full = String((e as Error)?.message ?? e ?? ''); const raw = rawLine(e);
  const kind = (TABLE.find(([, re]) => re.test(full))?.[0] ?? 'other');
  let action: VideoErrAction;
  switch (kind) {
    case 'botCheck': case 'ageGate': case 'private': case 'members': case 'signIn': action = 'signIn'; break;
    case 'rateLimit': case 'notLive': action = 'retryLater'; break;
    // (A runtime the Tauri build fetches itself; Electron gives yt-dlp its own Node — there the binary is too old for
    // it, said in the message —; a phone's yt-dlp is brought up to date and tried again.)
    case 'noJs': action = shell === 'tauri' ? 'getDeno' : 'retry'; break;
    case 'geo': case 'gone': case 'unsupported': action = null; break;
    default: action = 'retry';
  }
  // (The sign-in a phone keeps in its cookie jars and the computers keep per site; on the web there is none.)
  if (action === 'signIn' && shell === 'web') action = null;
  const key = kind === 'noJs' && shell === 'electron' ? 'vErrNoJsElectron' : KEY[kind];
  return { kind, key, action, raw };
}
/** A failure an up-to-date yt-dlp often mends (the site changed): worth one update and one more try. */
export const healable = (k: VideoErrKind): boolean => k === 'outdated' || k === 'noJs';
