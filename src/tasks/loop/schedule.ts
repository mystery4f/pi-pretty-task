/**
 * The schedule seam: raw expression in, next-fire calculation out (ADR-0006).
 *
 * The pump, the tools and the panel depend only on {@link Recurrence}, never on
 * interval parsing itself. Cron lands later by extending {@link parseSchedule};
 * nothing else has to learn a second syntax.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/** A schedule resolved to the one calculation the pump needs. */
export interface Recurrence {
  /** The expression exactly as the user wrote it, trimmed; listings show this. */
  readonly expression: string;
  /** Epoch milliseconds of the first fire strictly after `after`, or null when none follows. */
  nextFire(after: number): number | null;
}

/** Sub-second schedules are not offered; the pump itself may tick every second. */
export const MIN_INTERVAL_MS = 1_000;

const DURATION_PATTERN = /^(\d+)\s*([smh])$/;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

/**
 * Parses the interval shorthand shared by `schedule` and `expiresIn`: a whole
 * number followed by `s`, `m` or `h`, such as `30s`, `10m` or `2h`.
 *
 * Returns undefined for anything else, including zero, fractions and days. The
 * caller turns that into a user-facing message; the parser holds no prose.
 */
export function parseDurationMs(input: string): number | undefined {
  const match = DURATION_PATTERN.exec(input.trim());
  if (match === null) return undefined;

  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return undefined;

  const durationMs = amount * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (!Number.isSafeInteger(durationMs) || durationMs < MIN_INTERVAL_MS) return undefined;
  return durationMs;
}

/**
 * Resolves a raw schedule expression. Interval shorthand is accepted today;
 * a five-field cron expression becomes accepted here in the cron ticket.
 */
export function parseSchedule(expression: string): Recurrence | undefined {
  const text = expression.trim();
  const intervalMs = parseDurationMs(text);
  if (intervalMs === undefined) return undefined;

  return {
    expression: text,
    // An interval always has another fire; only calendar schedules can run out.
    nextFire: (after) => after + intervalMs,
  };
}
