/**
 * The shared session hub: one loaded task record file per session, handed to
 * every kind of task store.
 *
 * Both kinds live in one `tasks.json` (ADR-0005). Loading it once here means a
 * loop-tool call and a process-task call see the same records, and a save from
 * either kind writes the whole map — a process task finishing can never drop a
 * loop record, and a loop update can never drop a process record.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { randomInt } from "node:crypto";
import { mkdir } from "node:fs/promises";

import type { TaskScope } from "./runtime-state.js";
import { sessionTaskDirectory } from "./runtime-state.js";
import type { Task, TaskKind } from "./task.js";
import { TaskStore } from "./task-store.js";

/** One session's loaded record set, shared by the stores that use it. */
export interface TaskSession {
  readonly directory: string;
  readonly store: TaskStore;
  /** Every record of the session, both kinds. */
  readonly tasks: Map<string, Task>;
}

export interface TaskSessionsOptions {
  /** Clock seam for tests; defaults to `Date.now`. */
  now?: () => number;
  /** Random source for id suffixes; tests pin it to prove collisions are skipped. */
  randomInt?: (max: number) => number;
}

/** No 0/O/1/l: an id is meant to be retyped by a human into a later message. */
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
/** Five random characters after the kind prefix (ADR-0011). */
const ID_SUFFIX_LENGTH = 5;
/**
 * The first characters of an id say which kind of task it names, so a quoted id
 * (`bg-1a2cf`, `lp-1a2cf`, `lc-1a2cf`, `ch-1a2cf`) is readable without the panel
 * in front of you.
 */
const ID_PREFIX: Record<TaskKind, string> = {
  process: "bg-",
  "llm-loop": "lp-",
  "cmd-loop": "lc-",
  chain: "ch-",
};

export class TaskSessions {
  private readonly now: () => number;
  private readonly randomInt: (max: number) => number;
  /**
   * Keyed by state directory, not session id: the directory already encodes cwd
   * and session, and the promise keeps two calls from loading the same history
   * twice.
   */
  private readonly sessions = new Map<string, Promise<TaskSession>>();

  constructor(options: TaskSessionsOptions = {}) {
    this.now = options.now ?? Date.now;
    this.randomInt = options.randomInt ?? randomInt;
  }

  /** The session's records, loaded from disk on first use. */
  session(scope: TaskScope): Promise<TaskSession> {
    const directory = sessionTaskDirectory(scope.cwd, scope.sessionId);
    const existing = this.sessions.get(directory);
    if (existing !== undefined) return existing;

    const opened = this.open(directory);
    this.sessions.set(directory, opened);
    return opened;
  }

  /** Every session touched so far, for work that belongs to no single turn (the pump). */
  loaded(): Promise<TaskSession[]> {
    return Promise.all([...this.sessions.values()]);
  }

  /** Write the whole record set; queued and best effort in the store itself. */
  persist(session: TaskSession): Promise<void> {
    return session.store.save([...session.tasks.values()]);
  }

  /**
   * A fresh id that is free in this session, whatever the kind. The prefix
   * carries the kind and the five random characters keep an id short enough to
   * retype; the collision check spans the whole id, so kind prefixes never
   * compete (ADR-0011). Records written before the prefix existed keep their
   * six-character ids: an id is a reference a later message may quote, and
   * rewriting one would break that reference.
   */
  createId(session: TaskSession, kind: TaskKind): string {
    const prefix = ID_PREFIX[kind];
    for (;;) {
      let id = prefix;
      for (let index = 0; index < ID_SUFFIX_LENGTH; index += 1) {
        id += ID_ALPHABET.charAt(this.randomInt(ID_ALPHABET.length));
      }
      if (!session.tasks.has(id)) return id;
    }
  }

  private async open(directory: string): Promise<TaskSession> {
    await mkdir(directory, { recursive: true });
    const store = new TaskStore(directory, { now: this.now });
    const tasks = new Map<string, Task>();
    for (const record of await store.load()) tasks.set(record.id, record);
    return { directory, store, tasks };
  }
}
