/**
 * Human-readable durations and sizes, shared by tool output and (later) the
 * panel, so both say the same thing about the same task.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

/** `0.4s`, `12.3s`, `2m 05s`, `1h 03m`. */
export function formatDuration(milliseconds: number): string {
  const total = Math.max(0, Math.round(milliseconds));
  if (total < 60_000) return `${(total / 1000).toFixed(1)}s`;

  const totalSeconds = Math.round(total / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${String(minutes)}m ${String(seconds).padStart(2, "0")}s`;

  const hours = Math.floor(minutes / 60);
  return `${String(hours)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** `512 B`, `1.5 KiB`, `20.0 MiB`. */
export function formatBytes(bytes: number): string {
  const total = Math.max(0, Math.round(bytes));
  if (total < 1024) return `${String(total)} B`;

  let value = total / 1024;
  let unit = "KiB";
  if (value >= 1024) {
    value /= 1024;
    unit = "MiB";
  }
  if (value >= 1024) {
    value /= 1024;
    unit = "GiB";
  }
  return `${value.toFixed(1)} ${unit}`;
}

/**
 * The first line of a command, cut to a preview length. A record read without
 * `full` shows this; reading with `full` shows the command as it was given.
 */
export function commandPreview(command: string, maxLength = 80): string {
  const firstLine = command.split("\n", 1)[0] ?? "";
  const suffix = command.includes("\n") ? " …" : "";
  if (firstLine.length + suffix.length <= maxLength) return `${firstLine}${suffix}`;
  return `${firstLine.slice(0, Math.max(1, maxLength - 1))}…`;
}
