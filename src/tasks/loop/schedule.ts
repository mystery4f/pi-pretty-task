/**
 * The schedule seam: raw expression in, next-fire calculation out (ADR-0006).
 *
 * The pump, the tools and the panel depend only on {@link Recurrence}, never on
 * interval parsing itself. Interval shorthand and five-field cron both resolve
 * here (ADR-0006); nothing else has to learn a second syntax.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { parseCron } from "./cron.js";

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

/** Why a schedule expression was refused; the caller turns it into the message. */
export type ScheduleProblem = "invalid" | "six-field";

/** One raw expression, resolved or refused with the shape that was wrong. */
export type ScheduleResolution =
  | { readonly kind: "resolved"; readonly recurrence: Recurrence }
  | { readonly kind: "rejected"; readonly problem: ScheduleProblem };

/**
 * Resolves a raw schedule expression onto {@link Recurrence}: interval shorthand
 * (`30s`, `10m`, `2h`) or a five-field cron expression (`0 9 * * 1-5`, ADR-0006).
 *
 * A refusal says which shape was wrong and nothing more: six whitespace-separated
 * fields is a cron expression written with the seconds column, which cron here
 * does not take, while everything else is simply invalid. The parser holds no
 * prose; the caller names the accepted shapes (ADR-0006).
 */
export function resolveSchedule(expression: string): ScheduleResolution {
  const text = expression.trim();
  const intervalMs = parseDurationMs(text);
  if (intervalMs !== undefined) {
    return {
      kind: "resolved",
      recurrence: {
        expression: text,
        // An interval always has another fire; only calendar schedules can run out.
        nextFire: (after) => after + intervalMs,
      },
    };
  }

  const fields = text.length === 0 ? [] : text.split(/\s+/);
  if (fields.length === 6) return { kind: "rejected", problem: "six-field" };

  const cron = parseCron(text);
  return cron === undefined
    ? { kind: "rejected", problem: "invalid" }
    : { kind: "resolved", recurrence: { expression: text, nextFire: cron.nextFire } };
}

/** {@link resolveSchedule} for the callers that only ask "is there a schedule?". */
export function parseSchedule(expression: string): Recurrence | undefined {
  const resolution = resolveSchedule(expression);
  return resolution.kind === "resolved" ? resolution.recurrence : undefined;
}
