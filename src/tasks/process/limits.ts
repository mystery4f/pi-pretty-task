/**
 * The limits a process task runs under: how long an optional runtime cap lasts,
 * and how long a wait may hold the turn.
 *
 * The output byte cap is configuration, so `settings.ts` reads it; the parsing
 * rule it needs is the same one that applies here — values that come from
 * outside are parsed explicitly and never coerced on the way to the store.
 * `Number()` on a typo yields `NaN`, and a `NaN` byte cap compares false against
 * every byte count, so the first chunk of every task would look like the cap and
 * every task would die at once. An invalid value has to stop the extension with a
 * message that names the key instead.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/** The longest delay `setTimeout` honours; a longer one fires immediately. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** Default wait for `bg_wait`, in seconds. */
export const DEFAULT_WAIT_SECONDS = 60;

/**
 * Longest wait `bg_wait` accepts. A wait holds the turn, so its bound is much
 * tighter than a task's runtime cap.
 */
export const MAX_WAIT_SECONDS = 600;

/**
 * Turn a runtime cap in seconds into milliseconds, or explain why it is not
 * usable. Whole milliseconds only, and no further than `setTimeout` can count:
 * past that Node clamps the delay to 1ms, which would time out every task at
 * once — a cliff to report, not to fall off.
 */
export function parseTimeoutSeconds(seconds: number): number {
  const timeoutMs = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || seconds <= 0 || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new RangeError(
      `timeoutSeconds must be a positive number of seconds no larger than ${String(MAX_TIMEOUT_MS / 1000)}; received ${String(seconds)}`,
    );
  }
  return timeoutMs;
}

/**
 * Turn a `bg_wait` timeout into milliseconds. Absent means the tool's default;
 * an explicit value must stay inside the wait's own, much tighter bound.
 */
export function parseWaitSeconds(seconds: number | undefined): number {
  if (seconds === undefined) return DEFAULT_WAIT_SECONDS * 1000;
  const timeoutMs = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_WAIT_SECONDS || timeoutMs < 1) {
    throw new RangeError(
      `timeoutSeconds must be a positive number no larger than ${String(MAX_WAIT_SECONDS)}; received ${String(seconds)}`,
    );
  }
  return timeoutMs;
}

/** Default window `bg_logs` follows a task's output for, in seconds. */
export const DEFAULT_FOLLOW_SECONDS = 10;

/** Longest window a single follow read may hold the turn for. */
export const MAX_FOLLOW_SECONDS = 60;

/**
 * Turn a `bg_logs` follow window into milliseconds. Absent means the tool's
 * default; an explicit value must stay inside the follow's tighter bound.
 */
export function parseFollowSeconds(seconds: number | undefined): number {
  if (seconds === undefined) return DEFAULT_FOLLOW_SECONDS * 1000;
  const windowMs = Math.round(seconds * 1000);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_FOLLOW_SECONDS || windowMs < 1) {
    throw new RangeError(
      `timeoutSeconds must be a positive number no larger than ${String(MAX_FOLLOW_SECONDS)}; received ${String(seconds)}`,
    );
  }
  return windowMs;
}
