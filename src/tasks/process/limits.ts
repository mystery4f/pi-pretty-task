/**
 * The limits a process task runs under: how many output bytes are kept, and how
 * long an optional runtime cap lasts.
 *
 * Values that come from outside are parsed here, explicitly, and never coerced
 * on the way to the store. `Number()` on a typo yields `NaN`, and a `NaN` byte
 * cap compares false against every byte count, so the first chunk of every task
 * would look like the cap and every task would die at once. An invalid value has
 * to stop the extension with a message that names the key instead.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/** Output bytes a task keeps when the environment configures no cap. */
export const DEFAULT_OUTPUT_CAP_BYTES = 20 * 1024 * 1024;

/** The environment key for the output byte cap. */
export const OUTPUT_CAP_ENV = "PI_PRETTY_TASK_OUTPUT_CAP_BYTES";

/** The longest delay `setTimeout` honours; a longer one fires immediately. */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Read the output byte cap from the environment.
 *
 * An absent key means the default. Every other value must be a positive whole
 * number of bytes: the thrown error is the user-facing report, so it names the
 * key, what is accepted and what was found — a failed extension load then says
 * exactly what to fix.
 */
export function parseOutputCapBytes(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[OUTPUT_CAP_ENV];
  if (raw === undefined) return DEFAULT_OUTPUT_CAP_BYTES;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `${OUTPUT_CAP_ENV} must be a positive whole number of bytes; received ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

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
