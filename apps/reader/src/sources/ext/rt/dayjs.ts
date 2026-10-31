// dayjs as the plugins use it — dayjs(x), .format('LL'), .subtract(n, 'days'), .toISOString(), .fromNow() —
// with the localizedFormat, relativeTime and customParseFormat plugins' tokens the LNReader app loads for
// everyone. The English locale only; the names are what the sites' dates are read with anyway.

type Unit = 'millisecond' | 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year' | 'date';
const UNITS: Record<string, Unit> = { ms: 'millisecond', millisecond: 'millisecond', milliseconds: 'millisecond', s: 'second', second: 'second', seconds: 'second', m: 'minute', minute: 'minute', minutes: 'minute', h: 'hour', hour: 'hour', hours: 'hour', d: 'day', day: 'day', days: 'day', w: 'week', week: 'week', weeks: 'week', M: 'month', month: 'month', months: 'month', y: 'year', year: 'year', years: 'year', D: 'date', date: 'date', dates: 'date' };
const unitOf = (u?: string): Unit => UNITS[u ?? ''] ?? UNITS[(u ?? '').toLowerCase()] ?? 'millisecond';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
const LOCALIZED: Record<string, string> = { LTS: 'h:mm:ss A', LT: 'h:mm A', L: 'MM/DD/YYYY', LL: 'MMMM D, YYYY', LLL: 'MMMM D, YYYY h:mm A', LLLL: 'dddd, MMMM D, YYYY h:mm A', l: 'M/D/YYYY', ll: 'MMM D, YYYY', lll: 'MMM D, YYYY h:mm A', llll: 'ddd, MMM D, YYYY h:mm A' };
const ISO = /^(\d{4})[-/]?(\d{1,2})?[-/]?(\d{0,2})[Tt\s]*(\d{1,2})?:?(\d{1,2})?:?(\d{1,2})?[.:]?(\d+)?$/;

function parseWithFormat(s: string, fmt: string): Date | null {
  const tokens = /YYYY|YY|MMMM|MMM|MM|M|DD|D|HH|H|hh|h|mm|m|ss|s|A|a|SSS|Z|ZZ|\[[^\]]*\]|./g;
  let y = 1970, mo = 0, d = 1, hh = 0, mi = 0, se = 0, ms = 0, pm: boolean | null = null; let pos = 0;
  const num = (max: number) => { const m = new RegExp(`^\\d{1,${max}}`).exec(s.slice(pos)); if (!m) return null; pos += m[0].length; return Number(m[0]); };
  for (const t of fmt.match(tokens) ?? []) {
    if (t.startsWith('[')) { pos += t.length - 2; continue; }
    switch (t) {
      case 'YYYY': { const v = num(4); if (v === null) return null; y = v; break; }
      case 'YY': { const v = num(2); if (v === null) return null; y = v + (v < 69 ? 2000 : 1900); break; }
      case 'MMMM': case 'MMM': { const rest = s.slice(pos).toLowerCase(); const i = MONTHS.findIndex((m) => rest.startsWith(t === 'MMM' ? m.slice(0, 3).toLowerCase() : m.toLowerCase())); if (i < 0) return null; mo = i; pos += t === 'MMM' ? 3 : MONTHS[i].length; break; }
      case 'MM': case 'M': { const v = num(2); if (v === null) return null; mo = v - 1; break; }
      case 'DD': case 'D': { const v = num(2); if (v === null) return null; d = v; break; }
      case 'HH': case 'H': case 'hh': case 'h': { const v = num(2); if (v === null) return null; hh = v; break; }
      case 'mm': case 'm': { const v = num(2); if (v === null) return null; mi = v; break; }
      case 'ss': case 's': { const v = num(2); if (v === null) return null; se = v; break; }
      case 'SSS': { const v = num(3); if (v === null) return null; ms = v; break; }
      case 'A': case 'a': { const m = /^(am|pm)/i.exec(s.slice(pos)); if (!m) return null; pm = m[1].toLowerCase() === 'pm'; pos += 2; break; }
      case 'Z': case 'ZZ': { const m = /^[+-]\d{2}:?\d{2}/.exec(s.slice(pos)); if (m) pos += m[0].length; break; }
      default: { if (s[pos] === t) pos++; else if (/\s/.test(t) && /\s/.test(s[pos] ?? '')) pos++; else if (!/\s/.test(t)) return null; }
    }
  }
  if (pm !== null) { if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
  const dt = new Date(y, mo, d, hh, mi, se, ms);
  return isNaN(dt.getTime()) ? null : dt;
}

export class Dayjs {
  readonly $d: Date;
  constructor(input?: unknown, format?: string | string[] | { format?: string }) {
    if (input === undefined) this.$d = new Date();
    else if (input === null) this.$d = new Date(NaN);
    else if (input instanceof Dayjs) this.$d = new Date(input.$d.getTime());
    else if (input instanceof Date) this.$d = new Date(input.getTime());
    else if (typeof input === 'number') this.$d = new Date(input);
    else if (typeof input === 'string' && format && typeof format !== 'object') {
      const fmts = Array.isArray(format) ? format : [format]; let got: Date | null = null;
      for (const f of fmts) { got = parseWithFormat(input.trim(), f); if (got) break; }
      this.$d = got ?? new Date(NaN);
    } else if (typeof input === 'string') {
      const s = input.trim(); const m = !/Z$/i.test(s) && ISO.exec(s);
      if (m) this.$d = new Date(Number(m[1]), (Number(m[2]) || 1) - 1, Number(m[3]) || 1, Number(m[4]) || 0, Number(m[5]) || 0, Number(m[6]) || 0, Number((m[7] || '0').slice(0, 3)));
      else this.$d = new Date(s);
    } else this.$d = new Date(NaN);
  }
  isValid(): boolean { return !isNaN(this.$d.getTime()); }
  valueOf(): number { return this.$d.getTime(); }
  unix(): number { return Math.floor(this.$d.getTime() / 1000); }
  toDate(): Date { return new Date(this.$d.getTime()); }
  toISOString(): string { return this.$d.toISOString(); }
  toJSON(): string | null { return this.isValid() ? this.toISOString() : null; }
  toString(): string { return this.$d.toUTCString(); }
  clone(): Dayjs { return new Dayjs(this.$d); }
  locale(): Dayjs { return this; }
  utc(): Dayjs { return this; }
  local(): Dayjs { return this; }
  tz(): Dayjs { return this; }
  utcOffset(): number { return -this.$d.getTimezoneOffset(); }
  year(v?: number): number | Dayjs { return v === undefined ? this.$d.getFullYear() : this.set('year', v); }
  month(v?: number): number | Dayjs { return v === undefined ? this.$d.getMonth() : this.set('month', v); }
  date(v?: number): number | Dayjs { return v === undefined ? this.$d.getDate() : this.set('date', v); }
  day(v?: number): number | Dayjs { return v === undefined ? this.$d.getDay() : this.set('day', v); }
  hour(v?: number): number | Dayjs { return v === undefined ? this.$d.getHours() : this.set('hour', v); }
  minute(v?: number): number | Dayjs { return v === undefined ? this.$d.getMinutes() : this.set('minute', v); }
  second(v?: number): number | Dayjs { return v === undefined ? this.$d.getSeconds() : this.set('second', v); }
  millisecond(v?: number): number | Dayjs { return v === undefined ? this.$d.getMilliseconds() : this.set('millisecond', v); }
  get(u: string): number { return this[({ year: 'year', month: 'month', date: 'date', day: 'day', hour: 'hour', minute: 'minute', second: 'second', millisecond: 'millisecond' } as Record<string, 'year' | 'month' | 'date' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond'>)[unitOf(u)] ?? 'millisecond']() as number; }
  set(u: string, v: number): Dayjs {
    const d = this.clone().$d; const unit = unitOf(u);
    if (unit === 'year') d.setFullYear(v); else if (unit === 'month') d.setMonth(v); else if (unit === 'date') d.setDate(v); else if (unit === 'day') d.setDate(d.getDate() + (v - d.getDay()));
    else if (unit === 'hour') d.setHours(v); else if (unit === 'minute') d.setMinutes(v); else if (unit === 'second') d.setSeconds(v); else d.setMilliseconds(v);
    return new Dayjs(d);
  }
  add(n: number, u?: string): Dayjs {
    const d = this.clone().$d; const unit = unitOf(u); n = Number(n);
    if (unit === 'year') d.setFullYear(d.getFullYear() + n); else if (unit === 'month') d.setMonth(d.getMonth() + n);
    else if (unit === 'week') d.setDate(d.getDate() + 7 * n); else if (unit === 'day' || unit === 'date') d.setDate(d.getDate() + n);
    else if (unit === 'hour') d.setTime(d.getTime() + n * 3600000); else if (unit === 'minute') d.setTime(d.getTime() + n * 60000);
    else if (unit === 'second') d.setTime(d.getTime() + n * 1000); else d.setTime(d.getTime() + n);
    return new Dayjs(d);
  }
  subtract(n: number, u?: string): Dayjs { return this.add(-Number(n), u); }
  startOf(u: string): Dayjs {
    const d = this.clone().$d; const unit = unitOf(u);
    if (unit === 'year') { d.setMonth(0, 1); d.setHours(0, 0, 0, 0); } else if (unit === 'month') { d.setDate(1); d.setHours(0, 0, 0, 0); }
    else if (unit === 'week') { d.setDate(d.getDate() - d.getDay()); d.setHours(0, 0, 0, 0); } else if (unit === 'day' || unit === 'date') d.setHours(0, 0, 0, 0);
    else if (unit === 'hour') d.setMinutes(0, 0, 0); else if (unit === 'minute') d.setSeconds(0, 0); else if (unit === 'second') d.setMilliseconds(0);
    return new Dayjs(d);
  }
  endOf(u: string): Dayjs { const unit = unitOf(u); return this.startOf(u).add(1, unit === 'date' ? 'day' : unit).subtract(1, 'millisecond'); }
  diff(other: unknown, u?: string, float = false): number {
    const o = dayjs(other); const ms = this.valueOf() - o.valueOf(); const unit = unitOf(u);
    let r: number;
    if (unit === 'year' || unit === 'month') { const months = (this.$d.getFullYear() - o.$d.getFullYear()) * 12 + (this.$d.getMonth() - o.$d.getMonth()); r = unit === 'year' ? months / 12 : months; }
    else r = ms / ({ millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, date: 86400000, week: 604800000 } as Record<string, number>)[unit];
    return float ? r : (r < 0 ? Math.ceil(r) : Math.floor(r));
  }
  isBefore(o: unknown, u?: string): boolean { return u ? this.endOf(u).valueOf() < dayjs(o).valueOf() : this.valueOf() < dayjs(o).valueOf(); }
  isAfter(o: unknown, u?: string): boolean { return u ? dayjs(o).valueOf() < this.startOf(u).valueOf() : this.valueOf() > dayjs(o).valueOf(); }
  isSame(o: unknown, u?: string): boolean { return u ? this.startOf(u).valueOf() <= dayjs(o).valueOf() && dayjs(o).valueOf() <= this.endOf(u).valueOf() : this.valueOf() === dayjs(o).valueOf(); }
  isSameOrBefore(o: unknown, u?: string): boolean { return this.isSame(o, u) || this.isBefore(o, u); }
  isSameOrAfter(o: unknown, u?: string): boolean { return this.isSame(o, u) || this.isAfter(o, u); }
  isBetween(a: unknown, b: unknown, u?: string): boolean { return this.isAfter(a, u) && this.isBefore(b, u); }
  daysInMonth(): number { return new Date(this.$d.getFullYear(), this.$d.getMonth() + 1, 0).getDate(); }
  format(fmt = 'YYYY-MM-DDTHH:mm:ssZ'): string {
    if (!this.isValid()) return 'Invalid Date';
    const d = this.$d;
    const expanded = fmt.replace(/\[([^\]]*)\]|LTS|LT|LLLL|LLL|LL|L|llll|lll|ll|l/g, (m, lit) => (lit !== undefined ? m : LOCALIZED[m] ?? m));
    const H = d.getHours(), h = H % 12 || 12;
    const tz = -d.getTimezoneOffset(); const z = `${tz >= 0 ? '+' : '-'}${pad(Math.floor(Math.abs(tz) / 60))}:${pad(Math.abs(tz) % 60)}`;
    return expanded.replace(/\[([^\]]*)\]|YYYY|YY|MMMM|MMM|MM|M|DD|D|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|SSS|A|a|ZZ|Z|X|x|Q/g, (m, lit) => {
      if (lit !== undefined) return lit;
      switch (m) {
        case 'YYYY': return pad(d.getFullYear(), 4); case 'YY': return pad(d.getFullYear() % 100);
        case 'MMMM': return MONTHS[d.getMonth()]; case 'MMM': return MONTHS[d.getMonth()].slice(0, 3); case 'MM': return pad(d.getMonth() + 1); case 'M': return String(d.getMonth() + 1);
        case 'DD': return pad(d.getDate()); case 'D': return String(d.getDate());
        case 'dddd': return DAYS[d.getDay()]; case 'ddd': return DAYS[d.getDay()].slice(0, 3); case 'dd': return DAYS[d.getDay()].slice(0, 2); case 'd': return String(d.getDay());
        case 'HH': return pad(H); case 'H': return String(H); case 'hh': return pad(h); case 'h': return String(h);
        case 'mm': return pad(d.getMinutes()); case 'm': return String(d.getMinutes()); case 'ss': return pad(d.getSeconds()); case 's': return String(d.getSeconds());
        case 'SSS': return pad(d.getMilliseconds(), 3); case 'A': return H < 12 ? 'AM' : 'PM'; case 'a': return H < 12 ? 'am' : 'pm';
        case 'ZZ': return z.replace(':', ''); case 'Z': return z; case 'X': return String(Math.floor(d.getTime() / 1000)); case 'x': return String(d.getTime()); case 'Q': return String(Math.floor(d.getMonth() / 3) + 1);
      }
      return m;
    });
  }
  /** relativeTime: "3 days ago". */
  fromNow(noSuffix = false): string { return this.from(new Date(), noSuffix); }
  toNow(noSuffix = false): string { return this.to(new Date(), noSuffix); }
  from(other: unknown, noSuffix = false): string { return relative(dayjs(other).valueOf() - this.valueOf(), noSuffix); }
  to(other: unknown, noSuffix = false): string { return relative(this.valueOf() - dayjs(other).valueOf(), noSuffix); }
  calendar(): string { return this.format('L'); }
}
function relative(diffMs: number, noSuffix: boolean): string {
  const past = diffMs >= 0; const s = Math.abs(diffMs) / 1000;
  const word = s < 45 ? 'a few seconds' : s < 90 ? 'a minute' : s < 2700 ? `${Math.round(s / 60)} minutes` : s < 5400 ? 'an hour' : s < 79200 ? `${Math.round(s / 3600)} hours` : s < 129600 ? 'a day' : s < 2246400 ? `${Math.round(s / 86400)} days` : s < 3888000 ? 'a month' : s < 29808000 ? `${Math.round(s / 2592000)} months` : s < 47260800 ? 'a year' : `${Math.round(s / 31536000)} years`;
  return noSuffix ? word : past ? `${word} ago` : `in ${word}`;
}

export interface DayjsFn {
  (input?: unknown, format?: string | string[] | { format?: string }, strict?: boolean | string): Dayjs;
  extend(plugin: unknown, option?: unknown): DayjsFn;
  locale(name?: string): string;
  isDayjs(x: unknown): boolean;
  unix(s: number): Dayjs;
  utc(input?: unknown, format?: string): Dayjs;
  duration?(x: number): { asMilliseconds(): number };
  Ls: Record<string, unknown>;
  en: Record<string, unknown>;
}
export const dayjs: DayjsFn = Object.assign((input?: unknown, format?: string | string[] | { format?: string }) => new Dayjs(input, format), {
  extend: () => dayjs,
  locale: () => 'en',
  isDayjs: (x: unknown) => x instanceof Dayjs,
  unix: (s: number) => new Dayjs(s * 1000),
  utc: (input?: unknown, format?: string) => new Dayjs(input, format),
  Ls: { en: {} }, en: {},
}) as DayjsFn;
(dayjs as unknown as { default: DayjsFn }).default = dayjs;
