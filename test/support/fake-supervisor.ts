/**
 * A supervisor seam that spawns nothing: every command is a promise the test
 * settles, so a stop can be answered with `tree-survived` without hunting for a
 * process that refuses to die — and a record count stays put while the test talks.
 *
 * The real supervisor is the subject of `process-stop` and `process-limits`; this
 * one exists for the store's bookkeeping, where a fake is the only deterministic
 * way to make `taskkill /T /F` lose.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type {
  ProcessExit,
  RunningProcess,
  StartProcessOptions,
} from "../../src/tasks/process/supervisor.js";

/** One supervised command a test answers for, instead of a real process. */
export interface FakeProcess {
  readonly running: RunningProcess;
  /** The options the store passed in, so a test can drive `onOutputCap` itself. */
  readonly options: StartProcessOptions;
  /** How many stops reached this command. */
  stops: number;
  /** Answer every later stop with `tree-survived` and stay alive. */
  survive: boolean;
  /** End the command as a real exit would. */
  end(exitCode?: number | null): void;
}

/** The seam plus every command it was asked to supervise, in start order. */
export interface FakeSupervisor {
  supervise(options: StartProcessOptions): RunningProcess;
  readonly processes: FakeProcess[];
}

export function fakeSupervisor(): FakeSupervisor {
  const processes: FakeProcess[] = [];
  const supervise = (options: StartProcessOptions): RunningProcess => {
    let settle: (exit: ProcessExit) => void = () => {};
    const exit = new Promise<ProcessExit>((resolve) => {
      settle = resolve;
    });
    const fake: FakeProcess = {
      options,
      stops: 0,
      survive: false,
      running: {
        pid: undefined,
        exit,
        bytesWritten: () => 0,
        signalled: () => fake.stops > 0,
        stop: async () => {
          fake.stops += 1;
          if (fake.survive) {
            return { outcome: "tree-survived", tookMs: 1, detail: "the tree did not answer" };
          }
          // A killed command exits on its own just after the answer.
          setImmediate(() => {
            settle({ exitCode: null, signal: "SIGTERM" });
          });
          return { outcome: "stopped", tookMs: 1 };
        },
      },
      end: (exitCode = 0) => {
        settle({ exitCode, signal: null });
      },
    };
    processes.push(fake);
    return fake.running;
  };
  return { supervise, processes };
}
