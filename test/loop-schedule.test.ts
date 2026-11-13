/**
 * Schedule seam: the one function that turns the raw schedule text into a
 * next-fire time. Interval shorthand is the only syntax today; the cron ticket
 * plugs into the same {@link Recurrence} without the pump or the panel moving.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { describe, expect, it } from "vitest";

import { MIN_INTERVAL_MS, parseDurationMs, parseSchedule } from "../src/tasks/loop/schedule.js";

describe("interval shorthand", () => {
  it("parses seconds, minutes and hours", () => {
    expect(parseDurationMs("30s")).toBe(30_000);
    expect(parseDurationMs("10m")).toBe(600_000);
    expect(parseDurationMs("2h")).toBe(7_200_000);
    expect(parseDurationMs(" 5m ")).toBe(300_000);
  });

  it("rejects everything that is not a whole number with a unit", () => {
    for (const input of [
      "",
      "10",
      "10m30s",
      "1.5h",
      "10d",
      "10 minutes",
      "-5m",
      "+5m",
      "0s",
      "0.5s",
    ]) {
      expect(parseDurationMs(input), input).toBeUndefined();
    }
  });

  it("never accepts a fire closer together than one second", () => {
    expect(MIN_INTERVAL_MS).toBe(1_000);
    expect(parseDurationMs("1s")).toBe(MIN_INTERVAL_MS);
  });

  it("computes the next fire strictly after the supplied instant", () => {
    const schedule = parseSchedule("10m");
    expect(schedule).toBeDefined();
    expect(schedule?.expression).toBe("10m");
    expect(schedule?.nextFire(1_700_000_000_000)).toBe(1_700_000_600_000);
  });

  it("keeps the schedule text as written, trimmed", () => {
    expect(parseSchedule(" 30s ")?.expression).toBe("30s");
  });

  it("rejects invalid schedule text", () => {
    expect(parseSchedule("every 10 minutes")).toBeUndefined();
    expect(parseSchedule("")).toBeUndefined();
  });
});
