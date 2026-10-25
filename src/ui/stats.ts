// Library-wide reading statistics: time today and in total, sessions, pages,
// streak, the daily goal and the last two weeks, plus the most-read books.
import { h, openSheet, pickSheet } from './dom';
import { t, formatDuration, formatDate, localDigits, countMinutes, dateLocale } from '../i18n';
import { db, type ReadingDay } from '../db';
import { getSettings, updateSettings } from '../settings';
import { todayKey, liveStatsOf } from '../stats';

const GOALS = [0, 15, 30, 45, 60, 90, 120, 180];
const MIN_DAY_MS = 30000;

function keyOf(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function streakOf(days: Record<string, ReadingDay>): number {
  const d = new Date();
  // A day that has not been read yet must not break a streak that is still alive.
  if ((days[keyOf(d)]?.ms ?? 0) < MIN_DAY_MS) d.setDate(d.getDate() - 1);
  let n = 0;
  while ((days[keyOf(d)]?.ms ?? 0) >= MIN_DAY_MS) { n++; d.setDate(d.getDate() - 1); }
  return n;
}

export async function showStats(): Promise<void> {
  const books = await db.allBooks();
  const days: Record<string, ReadingDay> = {};
  let ms = 0; let sessions = 0; let pages = 0;
  for (const b of books) {
    const stats = liveStatsOf(b.id) ?? b.stats;
    if (!stats) continue;
    ms += stats.ms; sessions += stats.sessions ?? 0; pages += stats.pages ?? 0;
    for (const [key, v] of Object.entries(stats.days ?? {})) {
      const d = days[key] ?? { ms: 0, pct: 0, words: 0 };
      d.ms += v.ms; d.words += v.words;
      d.sessions = (d.sessions ?? 0) + (v.sessions ?? 0);
      d.pages = (d.pages ?? 0) + (v.pages ?? 0);
      d.pct = Math.max(d.pct, v.pct);
      days[key] = d;
    }
  }
  const today = days[todayKey()]?.ms ?? 0;
  const dayCount = Object.values(days).filter((d) => d.ms >= MIN_DAY_MS).length;
  const streak = streakOf(days);
  const goal = getSettings().readingGoalMinutes;

  const sheet = openSheet(t('readingStats'), t('close'));
  sheet.body.style.fontFamily = 'var(--font-ui)';
  sheet.body.style.fontSize = '14.5px';
  sheet.body.style.lineHeight = '1.75';

  const tile = (label: string, value: string) => h('div', { class: 'stats-tile' }, h('b', { dir: 'auto' }, value), h('span', null, label));
  sheet.body.append(h('div', { class: 'stats-grid' },
    tile(t('today'), formatDuration(today)),
    tile(t('totalReading'), formatDuration(ms)),
    tile(t('readingSessions'), localDigits(sessions)),
    tile(t('pagesRead'), localDigits(Math.round(pages))),
    tile(t('readingStreak'), localDigits(streak)),
    tile(t('daysRead'), localDigits(dayCount))));

  const done = goal ? Math.min(100, (today / (goal * 60000)) * 100) : 0;
  sheet.body.append(h('div', { class: 'goal-line', style: { marginTop: '14px' } },
    h('span', null, goal ? t('goalProgress', { done: Math.round(today / 60000), goal }) : t('setGoal')),
    goal ? h('div', { class: 'bar' }, h('span', { style: { width: `${done}%` } })) : null,
    h('button', { class: 'btn small outlined', type: 'button', onclick: () => pickGoal() }, t('setGoal'))));

  // The last two weeks, oldest first.
  const now = new Date();
  const keys: string[] = [];
  for (let i = 13; i >= 0; i--) keys.push(keyOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  const max = Math.max(MIN_DAY_MS, ...keys.map((k) => days[k]?.ms ?? 0));
  sheet.body.append(
    h('div', { style: { margin: '18px 0 4px', fontWeight: '600' } }, t('last14Days')),
    h('div', { class: 'stats-days' }, ...keys.map((k) => {
      const v = days[k]?.ms ?? 0;
      const height = v ? Math.max(4, Math.round((v / max) * 56)) : 2;
      return h('div', { class: 'col', title: `${formatDate(new Date(`${k}T12:00:00`).getTime())} · ${formatDuration(v)}` },
        h('i', { class: v >= MIN_DAY_MS ? 'on' : undefined, style: { height: `${height}px` } }),
        h('em', null, localDigits(Number(k.slice(-2)))));
    })));

  // A month at a glance: each day shaded by how long was read, the calendar paged month by month.
  let shown = new Date(now.getFullYear(), now.getMonth(), 1);
  const cal = h('div', { class: 'stats-cal' });
  const calTitle = h('b', null);
  const weekStart = (() => { try { const l = new Intl.Locale(dateLocale()) as Intl.Locale & { weekInfo?: { firstDay: number }; getWeekInfo?: () => { firstDay: number } }; return (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay ?? 1; } catch { return 1; } })() % 7;
  const paintCal = () => {
    calTitle.textContent = shown.toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' });
    const first = new Date(shown); const lead = (first.getDay() - weekStart + 7) % 7;
    const count = new Date(shown.getFullYear(), shown.getMonth() + 1, 0).getDate();
    const monthMax = Math.max(MIN_DAY_MS * 2, ...Array.from({ length: count }, (_, i) => days[keyOf(new Date(shown.getFullYear(), shown.getMonth(), i + 1))]?.ms ?? 0));
    const cells: HTMLElement[] = [];
    for (let i = 0; i < 7; i++) cells.push(h('em', null, new Date(2023, 0, 1 + ((weekStart + i) % 7)).toLocaleDateString(dateLocale(), { weekday: 'narrow' })));
    for (let i = 0; i < lead; i++) cells.push(h('i', { class: 'pad' }));
    for (let d = 1; d <= count; d++) {
      const date = new Date(shown.getFullYear(), shown.getMonth(), d); const key = keyOf(date);
      const v = days[key]?.ms ?? 0; const level = v < MIN_DAY_MS ? 0 : Math.min(4, 1 + Math.floor((v / monthMax) * 3.99));
      cells.push(h('i', { class: `l${level}${key === todayKey() ? ' today' : ''}${date > now ? ' future' : ''}`, title: `${formatDate(date.getTime())} · ${formatDuration(v)}` }, h('span', null, localDigits(d))));
    }
    cal.replaceChildren(...cells);
  };
  const page = (by: number) => { shown = new Date(shown.getFullYear(), shown.getMonth() + by, 1); paintCal(); };
  sheet.body.append(
    h('div', { class: 'stats-cal-head' },
      h('button', { class: 'btn small outlined', type: 'button', 'aria-label': t('prevMonth'), onclick: () => page(-1) }, '‹'),
      calTitle,
      h('button', { class: 'btn small outlined', type: 'button', 'aria-label': t('nextMonth'), onclick: () => page(1) }, '›')),
    cal);
  paintCal();

  const top = books.filter((b) => ((liveStatsOf(b.id) ?? b.stats)?.ms ?? 0) > 0).sort((a, b) => ((liveStatsOf(b.id) ?? b.stats)?.ms ?? 0) - ((liveStatsOf(a.id) ?? a.stats)?.ms ?? 0)).slice(0, 5);
  sheet.body.append(h('div', { style: { margin: '18px 0 4px', fontWeight: '600' } }, t('mostRead')));
  if (!top.length) sheet.body.append(h('p', { style: { color: 'var(--md-on-surface-dim)', margin: '4px 0' } }, t('noReadingYet')));
  for (const b of top) sheet.body.append(h('div', { style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: '10px', padding: '7px 0', borderBottom: '1px solid var(--md-outline-variant)' } },
    h('span', { dir: 'auto' }, b.title),
    h('span', { style: { color: 'var(--md-on-surface-dim)', fontVariantNumeric: 'tabular-nums' } }, formatDuration((liveStatsOf(b.id) ?? b.stats)?.ms ?? 0))));

  sheet.actions.append(h('button', { class: 'btn primary small', type: 'button', onclick: () => sheet.close() }, t('close')));

  function pickGoal(): void {
    pickSheet(t('dailyGoal'), GOALS.map((n): [string, string] => [String(n), n ? countMinutes(n) : t('goalOff')]), String(getSettings().readingGoalMinutes), (v) => {
      updateSettings({ readingGoalMinutes: Number(v) });
      sheet.close();
      void showStats();
    }, t('close'));
  }
}
