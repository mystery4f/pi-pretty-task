/**
 * Cron schedules through the one seam the loop pump knows: raw expression in,
 * `nextFire(after)` out, with the instant supplied by the test (ADR-0006).
 *
 * Every expectation is an absolute UTC instant and every block pins the time
 * zone, so a run does not depend on the machine's own zone — and the same
 * expression resolves differently in two zones, which is what "local time"
 * means here.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it } from "vitest";

import { parseSchedule, resolveSchedule } from "../src/tasks/loop/schedule.js";

/** The zone this machine runs in; set back after every pinned block. */
const MACHINE_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

function inZone<T>(zone: string, body: () => T): T {
  process.env.TZ = zone;
  try {
    return body();
  } finally {
    process.env.TZ = MACHINE_ZONE;
  }
}

function nextFire(expression: string, after: number): number | null {
  const schedule = parseSchedule(expression);
  if (schedule === undefined) throw new Error(`schedule rejected: ${expression}`);
  return schedule.nextFire(after);
}

describe("cron expressions", () => {
  it("fires at the wall-clock minute the expression names, in the local zone", () => {
    inZone("Europe/Berlin", () => {
      // Mon 2026-01-05 08:59 local (07:59Z): a workday 09:00 schedule is a minute away.
      expect(nextFire("0 9 * * 1-5", Date.UTC(2026, 0, 5, 7, 59))).toBe(Date.UTC(2026, 0, 5, 8, 0));
    });

    inZone("America/New_York", () => {
      // The same expression in the same minute of another zone: 09:00 EST is 14:00Z.
      expect(nextFire("0 9 * * 1-5", Date.UTC(2026, 0, 5, 13, 59))).toBe(
        Date.UTC(2026, 0, 5, 14, 0),
      );
    });
  });

  it("is strictly after the instant it is given", () => {
    inZone("Europe/Berlin", () => {
      // Mon 2026-01-05 09:00 local has already fired; the next one is Tuesday's.
      expect(nextFire("0 9 * * 1-5", Date.UTC(2026, 0, 5, 8, 0))).toBe(Date.UTC(2026, 0, 6, 8, 0));
    });
  });
  it("takes *, lists, ranges and steps", () => {
    inZone("Europe/Berlin", () => {
      // Mon 2026-01-05 01:00 local (00:00Z): every expectation below is that day.
      const after = Date.UTC(2026, 0, 5, 0, 0);
      expect(nextFire("*/15 * * * *", after)).toBe(Date.UTC(2026, 0, 5, 0, 15)); // 01:15 local
      expect(nextFire("0 9,17 * * *", after)).toBe(Date.UTC(2026, 0, 5, 8, 0)); // 09:00 local
      expect(nextFire("30 8-10 * * *", after)).toBe(Date.UTC(2026, 0, 5, 7, 30)); // 08:30 local
      expect(nextFire("0 6-18/6 * * *", after)).toBe(Date.UTC(2026, 0, 5, 5, 0)); // 06:00 local
      expect(nextFire("0 0 1,15 * *", after)).toBe(Date.UTC(2026, 0, 14, 23, 0)); // 15th, 00:00 local
      expect(nextFire("0 0 * * 7", after)).toBe(Date.UTC(2026, 0, 10, 23, 0)); // Sunday 00:00 local
    });
  });

  it("skips to Monday when every workday is already past", () => {
    inZone("Europe/Berlin", () => {
      // Fri 2026-01-09 18:00 local (17:00Z) → Mon 2026-01-12 09:00 local.
      expect(nextFire("0 9 * * 1-5", Date.UTC(2026, 0, 9, 17, 0))).toBe(
        Date.UTC(2026, 0, 12, 8, 0),
      );
    });
  });

  it("treats a written day-of-month and day-of-week as alternatives", () => {
    inZone("Europe/Berlin", () => {
      // Tue 2026-01-06 01:00 local: the 1st is past, so the next match is a Monday.
      expect(nextFire("0 0 1 * 1", Date.UTC(2026, 0, 6, 0, 0))).toBe(Date.UTC(2026, 0, 11, 23, 0));
    });
  });

  it("finds a leap day and gives up on an impossible calendar", () => {
    inZone("Europe/Berlin", () => {
      // 2024-02-29 00:00 local is 2024-02-28 23:00Z.
      expect(nextFire("0 0 29 2 *", Date.UTC(2024, 0, 1))).toBe(Date.UTC(2024, 1, 28, 23, 0));
      // February never has a 31st: no fire, rather than a clamp to the 28th.
      expect(nextFire("0 0 31 2 *", Date.UTC(2024, 0, 1))).toBeNull();
    });
  });
  it("skips the hour a spring-forward transition deletes, without getting stuck", () => {
    inZone("America/New_York", () => {
      // Sat 2024-03-09 02:30 EST (07:30Z): the 10th has no 02:30, so Monday the 11th.
      expect(nextFire("30 2 * * *", Date.UTC(2024, 2, 9, 7, 30))).toBe(
        Date.UTC(2024, 2, 11, 6, 30),
      );
      // And the fire after that is a day later, not the same instant again.
      expect(nextFire("30 2 * * *", Date.UTC(2024, 2, 11, 6, 30))).toBe(
        Date.UTC(2024, 2, 12, 6, 30),
      );
    });

    inZone("Europe/Berlin", () => {
      // Sat 2024-03-30 02:30 CET (01:30Z): the 31st has no 02:30 either.
      expect(nextFire("30 2 * * *", Date.UTC(2024, 2, 30, 1, 30))).toBe(
        Date.UTC(2024, 3, 1, 0, 30),
      );
    });
  });

  it("fires once in the hour a fall-back transition repeats", () => {
    inZone("America/New_York", () => {
      const first = Date.UTC(2024, 10, 3, 5, 30); // Sun 01:30 EDT, the first 01:30 of the day
      expect(nextFire("30 1 * * *", first - 60_000)).toBe(first);
      // The repeat an hour later is not a second fire; the next one is Monday's.
      expect(nextFire("30 1 * * *", first)).toBe(Date.UTC(2024, 10, 4, 6, 30));
    });
  });

  it("keeps an interval on the clock across a transition", () => {
    inZone("America/New_York", () => {
      const before = Date.UTC(2024, 2, 10, 6, 55); // 01:55 EST, five minutes before the gap
      expect(nextFire("10m", before)).toBe(before + 600_000);
    });
  });
  it("keeps the raw expression and classifies what it refuses", () => {
    expect(parseSchedule("  0 9 * * 1-5 ")?.expression).toBe("0 9 * * 1-5");

    // Six fields means the caller wrote a seconds column; that is a different complaint.
    expect(resolveSchedule("0 0 9 * * 1-5")).toEqual({ kind: "rejected", problem: "six-field" });

    for (const bad of [
      "60 * * * *",
      "0 24 * * *",
      "0 0 0 * *",
      "0 0 * 13 *",
      "0 0 * * 8",
      "*/0 * * * *",
      "1-5-7 * * * *",
      "0 9 L * *",
      "@daily",
      "0 9 * *",
      "every 10 minutes",
      "",
    ]) {
      expect(resolveSchedule(bad), bad).toEqual({ kind: "rejected", problem: "invalid" });
    }

    expect(resolveSchedule("10m").kind).toBe("resolved");
    expect(resolveSchedule("2h").kind).toBe("resolved");
  });
});
