/**
 * The terminal notification: one OSC 9 escape per task that ended, written to the
 * terminal's own stdout.
 *
 * The rule from issue #15 is "emit always, let the terminal decide": whether the
 * terminal is focused cannot be observed, so nothing here tries to guess. A
 * terminal without notification support ignores an OSC 9 string it does not know
 * and prints nothing, which is why no external command and no dependency is
 * needed — the bytes are the entire mechanism.
 *
 * Nothing here runs, waits or throws on behalf of a task: a task's ending is
 * already announced in the session, and this is the extra trace for the terminal
 * the user may be looking at.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import type { TaskStatus } from "../tasks/base/task.js";

/** The OSC 9 introducer: `ESC ] 9 ;` starts a terminal notification. */
export const OSC9_START = "\u001b]9;";

/** BEL ends an OSC 9 string; the sequence takes no other terminator. */
export const STRING_TERMINATOR = "\u0007";

/**
 * Whole escapes stay under this many bytes. A terminal is free to drop a string
 * it considers too long, and a name is user text: capping it keeps the escape
 * recognisable instead of leaving the decision to the terminal's buffer.
 */
export const MAX_NOTIFICATION_BYTES = 200;

/** The statuses that end a task; a running or paused task never notifies. */
const ENDINGS: readonly TaskStatus[] = ["completed", "failed", "killed", "interrupted"];

/** What a name that is empty after sanitising falls back to. */
const EMPTY_NAME = "task";

/** C0 controls, DEL and C1 controls: BEL and ESC included, so the ring is closed. */
const CONTROL_CHARACTERS = /\p{Cc}/gu;

/**
 * One escape carrying the task name and its ending: `ESC ] 9 ; <name> <ending> BEL`.
 *
 * The name is user text, so it is sanitised first: a raw BEL would end the string
 * early and a raw ESC would start another one. Printable non-ASCII is kept —
 * task names are written in the user's own language, and a notification without
 * its name would not say which task ended.
 */
export function terminalNotification(name: string, status: TaskStatus): string {
  const safe = sanitiseName(name);
  const ending = ` ${status}`;
  const room =
    MAX_NOTIFICATION_BYTES -
    byteLength(OSC9_START) -
    byteLength(ending) -
    byteLength(STRING_TERMINATOR);
  return `${OSC9_START}${truncate(safe, room)}${ending}${STRING_TERMINATOR}`;
}

/** Where the escape goes; the default is stdout, but only when it is a terminal. */
export type TerminalWrite = (text: string) => void;

export interface TerminalNotificationOptions {
  /** `PI_PRETTY_TASK_NOTIFY`, already validated into a boolean by Settings. */
  readonly enabled: boolean;
  /** Whether a terminal UI is attached to this session right now. */
  readonly attached: () => boolean;
  /** Test seam: where the bytes go. Defaults to a TTY-checked stdout. */
  readonly write?: TerminalWrite;
}

export interface TerminalNotifications {
  /** Raise the notification for a task that just ended; silent in every other case. */
  finished(name: string, status: TaskStatus): void;
}

/**
 * The notifier the extension holds for its whole life. It is silent unless all
 * three hold: notifications are enabled, a terminal UI is attached, and the task
 * actually ended.
 */
export function createTerminalNotifications(
  options: TerminalNotificationOptions,
): TerminalNotifications {
  const write = options.write ?? writeToStdout;
  return {
    finished(name, status) {
      if (!options.enabled || !ENDINGS.includes(status) || !options.attached()) return;
      write(terminalNotification(name, status));
    },
  };
}

/**
 * stdout is the terminal only when it is one: a TUI whose stdout is a pipe
 * (`pi | tee`) must not find escape bytes in the pipe, so the default writer
 * refuses anything that is not a TTY instead of assuming pi's own mode.
 */
function writeToStdout(text: string): void {
  if (process.stdout.isTTY !== true) return;
  process.stdout.write(text);
}

/**
 * Printable text only, whitespace collapsed, never empty. A control byte becomes a
 * space rather than vanishing, so the words either side of it do not fuse.
 */
function sanitiseName(name: string): string {
  const printable = name.replace(CONTROL_CHARACTERS, " ");
  const collapsed = printable.replace(/\s+/g, " ").trim();
  return collapsed.length > 0 ? collapsed : EMPTY_NAME;
}

/** Cut on a character boundary, so a multi-byte name is never left half written. */
function truncate(text: string, maxBytes: number): string {
  if (byteLength(text) <= maxBytes) return text;
  let used = 0;
  let kept = "";
  for (const character of text) {
    const size = byteLength(character);
    if (used + size > maxBytes) break;
    kept += character;
    used += size;
  }
  return kept.trimEnd();
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}
