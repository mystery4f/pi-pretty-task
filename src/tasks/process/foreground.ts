/**
 * A command this extension spawned and is still waiting for.
 *
 * The built-in shell tools run a command inside `exec` and cannot be interrupted
 * from outside: while pi waits, there is no handle to the process. A foreground
 * run keeps that handle (ADR-0020), so the wait can end in two ways — the process
 * exits, or it is let go and adopted as an ordinary process task. Nothing is
 * signalled in between: the pid, the output file and the command stay the same.
 *
 * Only the process that spawned a command can hand it over, which is why the
 * takeover (`PI_PRETTY_TASK_ADOPT_FOREGROUND`) exists at all: a tool this
 * extension does not own has its own process somewhere else.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { readOutputFrom } from "../base/output.js";
import type { TaskScope } from "../base/runtime-state.js";
import type { ProcessTasks } from "./process-tasks.js";
import type { RunningProcess } from "./supervisor.js";

/** How long the output poll waits between reads, in milliseconds. */
export const FOREGROUND_POLL_MS = 200;

/** Why the wait for a foreground command ended. */
export type ForegroundOutcome =
  /** The command exited on its own; the shell's code is the call's result. */
  | { readonly kind: "exited"; readonly exitCode: number }
  /** The command is a task now and keeps running; the call returns without it. */
  | DetachedResult
  /** The caller withdrew (Esc); the tree was stopped. */
  | { readonly kind: "aborted" }
  /** The call's own `timeout` ran out; the tree was stopped. */
  | { readonly kind: "timedOut"; readonly seconds: number }
  /** The run could not continue at all — the output cap, or a spawn error. */
  | { readonly kind: "failed"; readonly message: string };

/** What one detach attempt answered; the caller reports it and nothing else. */
/** What ended the wait early; both notices name it so neither reader has to guess. */
export type DetachTrigger = "shortcut" | "timeout" | "shutdown";

/**
 * One successful detach. The trigger travels with the result because the key press
 * and the deadline share one seam: without it the transcript would read the same
 * whether a person moved the command or the clock did.
 */
export interface DetachedResult {
  readonly kind: "detached";
  readonly taskId: string;
  readonly trigger: DetachTrigger;
  /** Whole seconds the command had held the front when the wait ended. */
  readonly afterSeconds: number;
}

/** What one detach attempt answered; the caller reports it and nothing else. */
export type DetachResult =
  | DetachedResult
  /** Nothing was waiting to move: no foreground command and no blocked call. */
  | { readonly kind: "nothing" }
  /** More than one call is waiting — a foreground command or a blocked call — so the key cannot pick one. The number is both kinds together, because one key serves both (ADR-0025). */
  | { readonly kind: "ambiguous"; readonly waiting: number }
  /** The task that would have been created was refused; the command keeps waiting. */
  | { readonly kind: "refused"; readonly message: string }
  /** A detach for this run is already under way. */
  | { readonly kind: "pending" };
/** What a caller supplies to put one command in the foreground. */
export interface StartForegroundInput extends TaskScope {
  readonly command: string;
  /** Directory to run in; the session's cwd unless the call names another. */
  readonly workingDirectory?: string;
  /** The environment pi prepared for this call, session variables included. */
  readonly env?: NodeJS.ProcessEnv;
  /** The call's own `timeout`, in seconds: this one kills. */
  readonly timeoutSeconds?: number;
}

export interface ForegroundRunnerOptions {
  readonly tasks: ProcessTasks;
  /**
   * Milliseconds a run may hold the turn before it detaches; `0` never detaches
   * on a timer and leaves the shortcuts as the only trigger.
   */
  readonly detachAfterMs: number;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
  /** Overrides the output poll interval, mostly for tests. */
  readonly pollMs?: number;
  /**
   * Called once per successful detach, before the caller hears the result. The
   * runner owns no UI: a key press and a deadline meet again here, so both can be
   * announced to the user instead of only the key press being visible.
   */
  readonly onDetached?: (detached: DetachedResult) => void;
}

/**
 * The line a detached call ends with, in pi's own status-line shape.
 *
 * The last sentence is the only reminder the model is guaranteed to read at the
 * moment it matters: it comes back in the tool result of this very call, so the
 * next long command it considers meets the rule before the refusal has to state it
 * again (ADR-0026).
 */
export function detachedNotice(detached: DetachedResult): string {
  return (
    `↪ moved to ${detached.taskId} — ${detachReason(detached)}. ` +
    `Still running in the background. ` +
    `Follow: pretty_task_bg_logs ${detached.taskId} · Stop: pretty_task_bg_kill ${detached.taskId}. ` +
    `A long command belongs in pretty_task_bg_run from here: another one in the front would only be moved the same way.`
  );
}

/**
 * Why the wait ended before the command did, in one clause shared by the transcript
 * and the user's notice. The shortcut and the deadline are one seam, so the clause
 * is the only place either reader can learn which of them fired.
 */
export function detachReason(detached: Pick<DetachedResult, "trigger" | "afterSeconds">): string {
  // pi-lens-ignore: switch-without-default -- exhaustive over the closed trigger union; a default would hide a new trigger from the compiler
  switch (detached.trigger) {
    case "shortcut":
      return "the user moved it off the front with ctrl+shift+b";
    case "timeout":
      return `it had held the front for ${String(detached.afterSeconds)}s, so the foreground timeout moved it`;
    case "shutdown":
      return "the session is shutting down";
  }
}

/**
 * How long a detach closes the front, in milliseconds.
 *
 * The model's next action comes within seconds, so a minute covers the rest of the
 * turn with room to spare; longer would start refusing commands the user asked for
 * after the model had already read the rule. Not a setting on purpose — a rule that
 * cannot be stated in one sentence is not a rule (ADR-0026).
 */
export const DETACH_QUIET_MS = 60_000;

/** The detach a session just lived through, and when it happened. */
export interface DetachMark {
  readonly taskId: string;
  readonly trigger: DetachTrigger;
  /** Whole seconds the command had held the front, so the reason reads right. */
  readonly afterSeconds: number;
  readonly at: number;
}

/**
 * The minute after a detach, in which the front is closed.
 *
 * It holds no task state: a detach is already recorded on the task itself
 * (`detached`), and what a refusal needs is only "how long ago" plus "which id to
 * name". Kept in memory because it constrains one model's next moves — a reload
 * starts a new context, and a stale window from before it would refuse work nobody
 * was warned about (ADR-0026).
 */
export class DetachWindow {
  private mark: DetachMark | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly quietMs: number = DETACH_QUIET_MS,
  ) {}

  /** Note a detach that just happened; the newest one wins. */
  note(detached: Pick<DetachedResult, "taskId" | "trigger" | "afterSeconds">): void {
    this.mark = {
      taskId: detached.taskId,
      trigger: detached.trigger,
      afterSeconds: detached.afterSeconds,
      at: this.now(),
    };
  }

  /** The detach still inside the window, or undefined once it has passed. */
  open(): DetachMark | undefined {
    if (this.mark === undefined) return undefined;
    return this.now() - this.mark.at < this.quietMs ? this.mark : undefined;
  }

  /**
   * The refusal text while the window is open, or undefined. The text is the
   * reminder: it says what just happened, what to use instead, and how long is left,
   * so the model can act on it without another turn.
   */
  refusal(): string | undefined {
    const mark = this.open();
    if (mark === undefined) return undefined;
    const left = Math.max(1, Math.ceil((this.quietMs - (this.now() - mark.at)) / 1000));
    return (
      `${mark.taskId} was just moved to the background (${detachReason(mark)}), ` +
      `so a command in the front would land exactly where the last one did. ` +
      `Use pretty_task_bg_run for anything that may run long; a foreground command or \`wait: true\` is refused for ${String(left)}s more.`
    );
  }
}

/** What the shortcut's notification says, one line per outcome. */
export function describeDetach(result: DetachResult): string {
  // pi-lens-ignore: switch-without-default -- exhaustive over the closed outcome union; a default would hide a new outcome from the compiler
  switch (result.kind) {
    case "detached": {
      const held =
        result.trigger === "timeout"
          ? `The command in front held for ${String(result.afterSeconds)}s; `
          : "";
      return `${held}Moved to ${result.taskId}. Follow: pretty_task_bg_logs ${result.taskId}`;
    }
    case "nothing":
      return "Nothing is waiting: no foreground command and no blocked call.";
    case "ambiguous":
      return `${String(result.waiting)} calls are waiting; the shortcut lets exactly one go.`;
    case "refused":
      return `Cannot move it to the background: ${result.message}`;
    case "pending":
      return "This command is already moving to the background.";
  }
}

/**
 * One foreground command: the process, the file it writes to, and the single
 * outcome that ends the wait.
 *
 * `settled` resolves exactly once, so both a natural exit and a detach can race
 * for it and the loser does nothing. That is the whole safety story of a detach:
 * whoever wins leaves the process where it is.
 */
export class ForegroundRun {
  readonly id: string;
  readonly sessionId: string;
  /** Directory the session lives in; a detached record belongs here, not in the command's. */
  readonly sessionCwd: string;
  readonly command: string;
  readonly workingDirectory: string;
  readonly outputPath: string;
  readonly startedAt: number;
  /** Milliseconds the run may hold the turn; `0` never detaches on a timer. */
  readonly detachAfterMs: number;

  private process: RunningProcess | undefined;
  private outcome: ForegroundOutcome | undefined;
  private killIntent: "aborted" | { readonly seconds: number } | undefined;
  private detaching = false;
  private settle!: (outcome: ForegroundOutcome) => void;
  /** Resolves once, with the outcome that ended this run. */
  readonly settled: Promise<ForegroundOutcome>;

  constructor(fields: {
    readonly id: string;
    readonly sessionId: string;
    readonly sessionCwd: string;
    readonly command: string;
    readonly workingDirectory: string;
    readonly outputPath: string;
    readonly startedAt: number;
    readonly detachAfterMs: number;
  }) {
    this.id = fields.id;
    this.sessionId = fields.sessionId;
    this.sessionCwd = fields.sessionCwd;
    this.command = fields.command;
    this.workingDirectory = fields.workingDirectory;
    this.outputPath = fields.outputPath;
    this.startedAt = fields.startedAt;
    this.detachAfterMs = fields.detachAfterMs;
    this.settled = new Promise<ForegroundOutcome>((resolve) => {
      this.settle = resolve;
    });
  }

  get running(): RunningProcess | undefined {
    return this.process;
  }

  /** True once the wait has ended, whichever way it ended. */
  get done(): boolean {
    return this.outcome !== undefined;
  }

  /** True while a detach is between its decision and its task record. */
  get detachInFlight(): boolean {
    return this.detaching;
  }

  /** Attach the process, and end the run when it ends. */
  bind(running: RunningProcess): void {
    this.process = running;
    void running.exit.then(
      (exit) => {
        // A stop this side asked for is reported as what it was: a signalled
        // process carries a code the shell made up, and saying "exit 143" would
        // hide that nobody typed anything.
        const intent = this.killIntent;
        if (intent === "aborted") this.finish({ kind: "aborted" });
        else if (intent !== undefined) this.finish({ kind: "timedOut", seconds: intent.seconds });
        else this.finish({ kind: "exited", exitCode: exit.exitCode ?? 1 });
      },
      (error: unknown) => this.finish({ kind: "failed", message: errorMessage(error) }),
    );
  }

  /** Record this run's one outcome; a second caller changes nothing. */
  finish(outcome: ForegroundOutcome): boolean {
    if (this.outcome !== undefined) return false;
    this.outcome = outcome;
    this.settle(outcome);
    return true;
  }

  /** Claim the detach; false when one is under way or the run already ended. */
  beginDetach(): boolean {
    if (this.detaching || this.done) return false;
    this.detaching = true;
    return true;
  }

  /** The detach was refused, so the run keeps waiting as a foreground command. */
  abandonDetach(): void {
    this.detaching = false;
  }

  /** The caller withdrew: stop the tree and report the withdrawal. */
  abort(): void {
    // A run that already ended has nothing to withdraw: after a detach the process
    // belongs to a task the caller was told to follow, and a late abort from the
    // same call must not stop it (ADR-0020).
    if (this.done) return;
    this.killIntent = "aborted";
    void this.process?.stop();
  }

  /** The call's own timeout ran out: stop the tree and report the timeout. */
  expire(seconds: number): void {
    // Same rule as an abort: a detached command is no longer this call's to stop.
    if (this.done) return;
    this.killIntent = { seconds };
    void this.process?.stop();
  }
}

/**
 * The foreground commands of one extension instance, and the two triggers that
 * can let one go: a shortcut, or the configured timeout.
 */
export class ForegroundRunner {
  private readonly tasks: ProcessTasks;
  private readonly detachAfterMs: number;
  private readonly now: () => number;
  private readonly platform: NodeJS.Platform;
  private readonly pollMs: number;
  private readonly runs = new Map<string, ForegroundRun>();
  private readonly onDetached: ((detached: DetachedResult) => void) | undefined;
  /** The minute a detach closes the front for, shared with the run tool (ADR-0026). */
  readonly window: DetachWindow;
  private scope: TaskScope | undefined;

  constructor(options: ForegroundRunnerOptions) {
    this.tasks = options.tasks;
    this.detachAfterMs = options.detachAfterMs;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.pollMs = options.pollMs ?? FOREGROUND_POLL_MS;
    this.onDetached = options.onDetached;
    this.window = new DetachWindow(this.now);
  }

  /**
   * The session these runs belong to. `BashOperations.exec` gets no context, so
   * the scope arrives from the events that do have one.
   */
  setScope(scope: TaskScope): void {
    this.scope = scope;
  }

  /** Foreground commands that are still being waited for. */
  live(): ForegroundRun[] {
    return [...this.runs.values()].filter((run) => !run.done);
  }

  /** How many runs the runner still holds; a finished one must not stay. */
  get held(): number {
    return this.runs.size;
  }

  /**
   * Spawn a command in the foreground and hand back the handle.
   *
   * The reservation comes first so the record that a detach may create keeps the
   * id the output file already carries; the process is spawned into that file.
   * The configured timeout arms here, which is what makes "run a long command,
   * stop waiting after N minutes" work without any key press.
   */
  async start(input: StartForegroundInput): Promise<ForegroundRun> {
    const reservation = await this.tasks.reserveForeground({
      cwd: input.cwd,
      sessionId: input.sessionId,
      ...(input.workingDirectory !== undefined ? { workingDirectory: input.workingDirectory } : {}),
    });
    const run = new ForegroundRun({
      id: reservation.id,
      sessionId: input.sessionId,
      sessionCwd: input.cwd,
      command: input.command,
      workingDirectory: reservation.cwd,
      outputPath: reservation.outputPath,
      startedAt: this.now(),
      detachAfterMs: this.detachAfterMs,
    });
    let process: RunningProcess;
    process = this.tasks.spawnForeground({
      command: input.command,
      cwd: reservation.cwd,
      outputPath: reservation.outputPath,
      ...(input.env !== undefined ? { env: definedEnv(input.env) } : {}),
      onOutputCap: () => {
        run.finish({
          kind: "failed",
          message:
            "Foreground output reached the session's output cap; the command was stopped. " +
            "Start it as a background task to keep a longer tail.",
        });
        void process.stop();
      },
    });
    run.bind(process);
    this.runs.set(run.id, run);

    // The table holds waits, not history: a run leaves it the moment it ends, or the
    // session's every command would keep its process handle reachable (ADR-0020).
    void run.settled.then(() => this.runs.delete(run.id));
    this.armTimers(run, input.timeoutSeconds);
    return run;
  }

  /**
   * The operations pi's own shell tools and `!` commands run on when the takeover
   * is on. Output streams from the run's file into pi's accumulator, so a
   * command looks the same in the transcript as it did before the takeover.
   */
  operations(): BashOperations {
    return {
      exec: async (command, cwd, options) => {
        // A detach closes the front for a minute: starting another command here
        // would repeat what the detach just fixed, and the refusal itself carries
        // the reminder (ADR-0026).
        const closed = this.window.refusal();
        if (closed !== undefined) throw new Error(closed);
        const scope = this.scope;
        if (scope === undefined) {
          throw new Error(
            "pi-pretty-task: no session to run this command in yet; reload the extension",
          );
        }
        const run = await this.start({
          cwd: scope.cwd,
          sessionId: scope.sessionId,
          command,
          workingDirectory: cwd,
          ...(options.env !== undefined ? { env: options.env } : {}),
          ...(options.timeout !== undefined ? { timeoutSeconds: options.timeout } : {}),
        });
        const withdraw = (): void => run.abort();
        if (options.signal?.aborted === true) withdraw();
        else options.signal?.addEventListener("abort", withdraw, { once: true });
        // The listener goes with the wait: a signal that arrives after a detach must
        // not reach a run that no longer has anything to withdraw.
        void run.settled.then(() => options.signal?.removeEventListener("abort", withdraw));
        return this.awaitRun(run, options.onData);
      },
    };
  }

  /** Let exactly one foreground command go; nothing happens with zero or several. */
  async detachOnlyOne(): Promise<DetachResult> {
    const live = this.live();
    if (live.length === 0) return { kind: "nothing" };
    if (live.length > 1) return { kind: "ambiguous", waiting: live.length };
    const [only] = live;
    if (only === undefined) return { kind: "nothing" };
    return this.detach(only, "shortcut");
  }

  /**
   * Let one run go: it becomes a task under the id it already had, and the call
   * that was waiting returns without an exit code.
   *
   * A refusal — the session's task ceiling — leaves the run in the foreground,
   * because a command that could not become a task must not vanish from the call
   * that is still waiting for it. A second trigger while the first is asking
   * answers `pending` rather than creating a second record.
   */
  async detach(run: ForegroundRun, trigger: DetachTrigger): Promise<DetachResult> {
    if (run.done) return { kind: "nothing" };
    const process = run.running;
    if (process === undefined) return { kind: "nothing" };
    // The process can end between the caller's key press and this line; adopting it
    // then would report a failure as a successful detach, with no exit code in the
    // transcript. Leaving the wait alone keeps the real code in front of the reader.
    if (process.hasExited()) return { kind: "nothing" };
    if (!run.beginDetach()) return { kind: "pending" };
    try {
      const task = await this.tasks.adoptForeground({
        cwd: run.sessionCwd,
        sessionId: run.sessionId,
        command: run.command,
        reservation: {
          id: run.id,
          cwd: run.workingDirectory,
          outputPath: run.outputPath,
        },
        running: process,
        // The process began before it was a task: the record's age starts there, so
        // a 91-second command is not reported as a 74-second one (ADR-0020).
        startedAt: run.startedAt,
        // Which trigger moved it and how long it held the front: without these a
        // `origin: "foreground"` record cannot say who moved it or why (ADR-0026).
        detached: { trigger, heldSeconds: Math.round((this.now() - run.startedAt) / 1000) },
      });
      const detached: DetachedResult = {
        kind: "detached",
        taskId: task.id,
        trigger,
        // Whole seconds, the unit the deadline and the panel both speak: "40.527s"
        // would only invite a wrong comparison with the number PI_PRETTY_TASK_
        // FOREGROUND_TIMEOUT was set to.
        afterSeconds: Math.round((this.now() - run.startedAt) / 1000),
      };
      run.finish(detached);
      this.window.note(detached);
      this.onDetached?.(detached);
      return detached;
    } catch (error) {
      run.abandonDetach();
      return { kind: "refused", message: errorMessage(error) };
    }
  }

  /**
   * Let every command still in front go, for a shutdown. A detached run leaves a
   * record and an id to follow after the reload; a run nobody adopted leaves
   * neither, and its tree outlives the extension as an orphan (ADR-0020).
   */
  async releaseAll(): Promise<void> {
    await Promise.all(this.live().map((run) => this.detach(run, "shutdown")));
  }

  /** Arm the call's own timeout and the configured detach deadline, in that order. */
  private armTimers(run: ForegroundRun, timeoutSeconds: number | undefined): void {
    if (timeoutSeconds !== undefined) {
      const kill = setTimeout(() => run.expire(timeoutSeconds), timeoutSeconds * 1000);
      kill.unref?.();
      void run.settled.then(() => clearTimeout(kill));
    }
    if (this.detachAfterMs > 0) {
      const release = setTimeout(() => void this.detach(run, "timeout"), this.detachAfterMs);
      release.unref?.();
      void run.settled.then(() => clearTimeout(release));
    }
  }

  /**
   * Wait for the run's outcome and translate it into what pi's shell tool expects:
   * an exit code, or the exception its own message is built from. The output is
   * pumped from the file until the wait ends, so the transcript keeps filling
   * while the command runs.
   */
  private async awaitRun(
    run: ForegroundRun,
    onData: (data: Buffer) => void,
  ): Promise<{ exitCode: number | null }> {
    let offset = 0;
    // Reads are chained, never concurrent: two overlapping reads of one file would
    // share an offset and drop bytes. Chaining also means `await pump()` after the
    // outcome drains whatever the last tick had already started.
    let queue: Promise<void> = Promise.resolve();
    const pump = (): Promise<void> => {
      queue = queue.then(async () => {
        try {
          const delta = await readOutputFrom(run.outputPath, offset, { platform: this.platform });
          offset = delta.to;
          if (delta.text.length > 0) onData(Buffer.from(delta.text, "utf8"));
        } catch {
          // The run's own outcome carries the failure; a read that lost a race with
          // the file's creation has nothing to add to it.
        }
      });
      return queue;
    };
    const timer = setInterval(() => void pump(), this.pollMs);
    timer.unref?.();
    try {
      const outcome = await run.settled;
      await pump();
      // pi-lens-ignore: switch-without-default -- exhaustive over the closed outcome union; a default would hide a new outcome from the compiler
      switch (outcome.kind) {
        case "detached":
          // The one line a model gets about this ending, so it names the trigger:
          // the shortcut and the deadline share this seam. Zero, because pi turns a
          // null exit code into a failure message (ADR-0020 keeps the output intact).
          onData(Buffer.from(`\n${detachedNotice(outcome)}\n`, "utf8"));
          return { exitCode: 0 };
        case "exited":
          return { exitCode: outcome.exitCode };
        case "aborted":
          // pi turns this message into "Command aborted" and keeps the output.
          throw new Error("aborted");
        case "timedOut":
          // pi reads the seconds out of this prefix for its own timeout message.
          throw new Error(`timeout:${String(outcome.seconds)}`);
        case "failed":
          onData(Buffer.from(`\n${outcome.message}\n`, "utf8"));
          return { exitCode: 1 };
      }
    } finally {
      clearInterval(timer);
    }
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * pi hands a call's environment as `ProcessEnv`, where a variable may be absent.
 * The supervisor takes only real strings, and a dropped variable is the same as
 * an unset one.
 */
function definedEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
