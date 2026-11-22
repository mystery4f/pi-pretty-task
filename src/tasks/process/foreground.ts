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
  | { readonly kind: "detached"; readonly taskId: string }
  /** The caller withdrew (Esc); the tree was stopped. */
  | { readonly kind: "aborted" }
  /** The call's own `timeout` ran out; the tree was stopped. */
  | { readonly kind: "timedOut"; readonly seconds: number }
  /** The run could not continue at all — the output cap, or a spawn error. */
  | { readonly kind: "failed"; readonly message: string };

/** What one detach attempt answered; the caller reports it and nothing else. */
export type DetachResult =
  | { readonly kind: "detached"; readonly taskId: string }
  /** Nothing was in the foreground to move. */
  | { readonly kind: "nothing" }
  /** More than one foreground command is running, so the key cannot pick one. */
  | { readonly kind: "ambiguous"; readonly running: number }
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
}

/** The line a detached call ends with, in pi's own status-line shape. */
export function detachedNotice(taskId: string): string {
  return (
    `↪ moved to ${taskId} — still running in the background. ` +
    `Follow: pretty_task_bg_logs ${taskId} · Stop: pretty_task_bg_kill ${taskId}`
  );
}

/** What the shortcut's notification says, one line per outcome. */
export function describeDetach(result: DetachResult): string {
  switch (result.kind) {
    case "detached":
      return `Moved to ${result.taskId}. Follow: pretty_task_bg_logs ${result.taskId}`;
    case "nothing":
      return "Nothing is running in the foreground.";
    case "ambiguous":
      return `${String(result.running)} commands are running in the foreground; the shortcut moves exactly one.`;
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
    readonly command: string;
    readonly workingDirectory: string;
    readonly outputPath: string;
    readonly startedAt: number;
    readonly detachAfterMs: number;
  }) {
    this.id = fields.id;
    this.sessionId = fields.sessionId;
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
    this.killIntent = "aborted";
    void this.process?.stop();
  }

  /** The call's own timeout ran out: stop the tree and report the timeout. */
  expire(seconds: number): void {
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
  private scope: TaskScope | undefined;

  constructor(options: ForegroundRunnerOptions) {
    this.tasks = options.tasks;
    this.detachAfterMs = options.detachAfterMs;
    this.now = options.now ?? Date.now;
    this.platform = options.platform ?? process.platform;
    this.pollMs = options.pollMs ?? FOREGROUND_POLL_MS;
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
        if (options.signal?.aborted === true) run.abort();
        else options.signal?.addEventListener("abort", () => run.abort(), { once: true });
        return this.awaitRun(run, options.onData);
      },
    };
  }

  /** Let exactly one foreground command go; nothing happens with zero or several. */
  async detachOnlyOne(): Promise<DetachResult> {
    const live = this.live();
    if (live.length === 0) return { kind: "nothing" };
    if (live.length > 1) return { kind: "ambiguous", running: live.length };
    const [only] = live;
    if (only === undefined) return { kind: "nothing" };
    return this.detach(only);
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
  async detach(run: ForegroundRun): Promise<DetachResult> {
    if (run.done) return { kind: "nothing" };
    const process = run.running;
    if (process === undefined) return { kind: "nothing" };
    if (!run.beginDetach()) return { kind: "pending" };
    try {
      const task = await this.tasks.adoptForeground({
        cwd: run.workingDirectory,
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
      });
      run.finish({ kind: "detached", taskId: task.id });
      this.runs.delete(run.id);
      return { kind: "detached", taskId: task.id };
    } catch (error) {
      run.abandonDetach();
      return { kind: "refused", message: errorMessage(error) };
    }
  }

  /** Arm the call's own timeout and the configured detach deadline, in that order. */
  private armTimers(run: ForegroundRun, timeoutSeconds: number | undefined): void {
    if (timeoutSeconds !== undefined) {
      const kill = setTimeout(() => run.expire(timeoutSeconds), timeoutSeconds * 1000);
      kill.unref?.();
      void run.settled.then(() => clearTimeout(kill));
    }
    if (this.detachAfterMs > 0) {
      const release = setTimeout(() => void this.detach(run), this.detachAfterMs);
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
      switch (outcome.kind) {
        case "detached":
          onData(Buffer.from(`\n${detachedNotice(outcome.taskId)}\n`, "utf8"));
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
  const defined: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) defined[key] = value;
  return defined;
}
