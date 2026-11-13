/**
 * Five-field cron, resolved onto the one calculation a loop's pump needs.
 *
 * The fields are minute, hour, day of month, month and day of week (0–6 from
 * Sunday; 7 is accepted as Sunday, as Vixie cron does). A field takes `*`, a
 * number, a comma-separated list, an inclusive `a-b` range, and a `/step` after
 * `*`, a range or a number. Month and weekday names are not accepted: the
 * rejection message names the shapes that are, so a typo cannot be guessed at.
 *
 * The arithmetic runs in the machine's local zone through `Date`'s local-time
 * constructors, so `0 9 * * 1-5` means 09:00 on the wall wherever the loop runs,
 * including across a daylight-saving transition (ADR-0006).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/** A parsed cron expression: the one call the schedule seam needs. */
export interface CronSchedule {
  /** Epoch milliseconds of the first fire strictly after `after`, or null when none follows. */
  nextFire(after: number): number | null;
}

/** A field as a lookup; the raw text of the two day fields is kept for its `*`. */
interface CronSpec {
  readonly minutes: readonly number[];
  readonly hours: readonly number[];
  readonly daysOfMonth: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly daysOfWeek: ReadonlySet<number>;
  /** Vixie cron resolves the two day fields differently when either was `*`. */
  readonly dayOfMonthStar: boolean;
  readonly dayOfWeekStar: boolean;
}

const FIELDS = 5;
const NUMBER_PATTERN = /^\d+$/;

/**
 * How far ahead a fire may be before the expression counts as unreachable:
 * eight years, enough for a leap day behind any weekday constraint. A cron
 * expression that never matches (`0 0 31 2 *`) resolves to "no next fire".
 */
const SEARCH_DAYS = 366 * 8;

/**
 * Parses a five-field cron expression. Returns undefined for anything else —
 * the wrong number of fields, an out-of-range value, a scrambled range, a named
 * day — and leaves the wording of the complaint to the caller.
 */
export function parseCron(expression: string): CronSchedule | undefined {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== FIELDS) return undefined;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];
  const minutes = parseField(minute, 0, 59);
  const hours = parseField(hour, 0, 23);
  const daysOfMonth = parseField(dayOfMonth, 1, 31);
  const months = parseField(month, 1, 12);
  const daysOfWeek = parseField(dayOfWeek, 0, 7, 7);
  if (
    minutes === undefined ||
    hours === undefined ||
    daysOfMonth === undefined ||
    months === undefined ||
    daysOfWeek === undefined
  ) {
    return undefined;
  }

  const spec: CronSpec = {
    minutes: [...minutes].sort((left, right) => left - right),
    hours: [...hours].sort((left, right) => left - right),
    daysOfMonth,
    months,
    daysOfWeek,
    dayOfMonthStar: dayOfMonth.startsWith("*"),
    dayOfWeekStar: dayOfWeek.startsWith("*"),
  };
  return { nextFire: (after) => nextFireAt(spec, after) };
}

/**
 * One field as a set of values. `wrap` folds the one extra weekday (7) onto the
 * day it duplicates (Sunday), so `0 0 * * 7` is Sunday rather than a rejection.
 */
function parseField(
  text: string,
  min: number,
  max: number,
  wrap?: number,
): ReadonlySet<number> | undefined {
  if (text.length === 0) return undefined;
  const values = new Set<number>();
  for (const item of text.split(",")) {
    const expanded = expandItem(item, min, max);
    if (expanded === undefined) return undefined;
    for (const value of expanded) values.add(wrap === undefined ? value : value % wrap);
  }
  return values;
}

/** One list item: `*`, `n`, `a-b`, `n/step`, `a-b/step`, each within `min`–`max`. */
function expandItem(item: string, min: number, max: number): number[] | undefined {
  const [rangeText, stepText, ...extra] = item.split("/");
  if (rangeText === undefined || rangeText.length === 0 || extra.length > 0) return undefined;

  const step = stepText === undefined ? 1 : parseNumber(stepText, 1, max);
  if (step === undefined) return undefined;

  let from: number;
  let to: number;
  if (rangeText === "*") {
    from = min;
    to = max;
  } else {
    const [startText, endText, ...rest] = rangeText.split("-");
    if (startText === undefined || rest.length > 0) return undefined;
    const start = parseNumber(startText, min, max);
    if (start === undefined) return undefined;
    from = start;
    if (endText === undefined) {
      // `5/10` reads as "from 5 to the end of the field", the usual shorthand.
      to = stepText === undefined ? start : max;
    } else {
      const end = parseNumber(endText, min, max);
      if (end === undefined || end < start) return undefined;
      to = end;
    }
  }

  const values: number[] = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

/** A whole number in range, or undefined: no clamping, no fractions, no sign. */
function parseNumber(text: string, min: number, max: number): number | undefined {
  if (!NUMBER_PATTERN.test(text)) return undefined;
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/**
 * The first minute of the calendar that matches, scanning day by day in local
 * time. Days are stepped at noon so that a transition near midnight cannot
 * shift the scan onto the previous or next date.
 */
function nextFireAt(spec: CronSpec, after: number): number | null {
  if (!Number.isFinite(after)) return null;

  // Start at the first minute boundary strictly after the supplied instant.
  const cursor = new Date(after);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  let day = localNoon(cursor);
  for (let scanned = 0; scanned < SEARCH_DAYS; scanned += 1) {
    if (matchesDay(spec, day)) {
      const found = firstMatchOnDay(spec, day, cursor.getTime());
      if (found !== null) return found;
    }
    day = localNoon(new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1));
  }
  return null;
}

function localNoon(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0, 0, 0);
}

/** Vixie cron's rule: a `*` day field demands both day tests, two written ones alternate. */
function matchesDay(spec: CronSpec, day: Date): boolean {
  if (!spec.months.has(day.getMonth() + 1)) return false;
  const dayOfMonth = spec.daysOfMonth.has(day.getDate());
  const dayOfWeek = spec.daysOfWeek.has(day.getDay());
  return spec.dayOfMonthStar || spec.dayOfWeekStar
    ? dayOfMonth && dayOfWeek
    : dayOfMonth || dayOfWeek;
}

function firstMatchOnDay(spec: CronSpec, day: Date, notBefore: number): number | null {
  for (const hour of spec.hours) {
    for (const minute of spec.minutes) {
      const candidate = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        hour,
        minute,
        0,
        0,
      );
      // A reading the spring-forward transition deletes normalizes to another
      // hour; that day has no fire rather than a shifted or doubled one.
      if (candidate.getHours() !== hour || candidate.getMinutes() !== minute) continue;
      if (candidate.getDate() !== day.getDate()) continue;
      if (candidate.getTime() >= notBefore) return candidate.getTime();
    }
  }
  return null;
}
