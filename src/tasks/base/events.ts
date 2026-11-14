/**
 * What this extension publishes on pi's shared event bus: one event when a task
 * ends, one when a loop fires (issue #23).
 *
 * A listener never has to poll this extension's store to notice a change: the
 * payload names the record and the few numbers a reader acts on. Every payload
 * is published after the write that produced it has landed, so a listener that
 * loads the record finds the state the event describes.
 *
 * The payloads are deliberately shallow. A task's output text and the values of
 * its environment are never copied onto the bus — a transcript stays in its
 * output file, and a secret stays out of another extension's transcript.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";
import type { Iteration } from "../loop/iteration.js";
import type { TaskBase, TaskKind, TaskStatus } from "./task.js";

/** Channel of one task reaching its end. */
export const TASK_FINISHED_EVENT = "pi-pretty-task:task-finished";

/** Channel of one loop fire, with whatever that fire opened or started. */
export const LOOP_FIRED_EVENT = "pi-pretty-task:loop-fired";

/**
 * A task ended, whichever kind it was. `exitCode` is present only for a process
 * task whose end has one: `null` means a signal ended it, and a loop task never
 * carries an exit code at all.
 */
export interface TaskFinishedEvent {
  readonly id: string;
  readonly kind: TaskKind;
  readonly name: string;
  readonly status: TaskStatus;
  readonly exitCode?: number | null;
  /** Milliseconds from creation to end. */
  readonly durationMs: number;
}

/** What a fire has in common with every other fire, both kinds. */
interface LoopFiredBase {
  /** The loop task's id. */
  readonly id: string;
  readonly name: string;
  /** One-based fire number, unique within its loop. */
  readonly fire: number;
  /** Epoch milliseconds the fire was handled at. */
  readonly at: number;
}

/** A `llm-loop` fire opened an iteration on its loop. */
export interface LlmLoopFiredEvent extends LoopFiredBase {
  readonly kind: "llm-loop";
  /**
   * The iteration the fire opened: the loop's child record, in the two fields a
   * reader needs to find it — the fire number is its key within the loop.
   */
  readonly iteration: Pick<Iteration, "fire" | "startedAt">;
}

/** A `cmd-loop` fire started a process task of its own. */
export interface CmdLoopFiredEvent extends LoopFiredBase {
  readonly kind: "cmd-loop";
  /** The child process task this fire started, an ordinary task id. */
  readonly taskId: string;
}

/** Every shape a fire event takes: exactly one of the two produced something. */
export type LoopFiredEvent = LlmLoopFiredEvent | CmdLoopFiredEvent;

/**
 * A finished task as the payload builder sees it: the record plus how long it
 * ran. Structural, so the process arm's own view fits without this module
 * importing the arm it is the supertype of.
 */
export interface FinishedTaskView {
  readonly task: TaskBase & { readonly exitCode?: number | null };
  readonly elapsedMs: number;
}

/** The payload `TASK_FINISHED_EVENT` carries for one ending. */
export function taskFinishedEvent(view: FinishedTaskView): TaskFinishedEvent {
  const { task } = view;
  return {
    id: task.id,
    kind: task.kind,
    name: task.name,
    status: task.status,
    // Absent, not `undefined`, for a kind that has no exit code: a listener that
    // serializes the event gets the same bytes a strict reader expects.
    ...(task.exitCode === undefined ? {} : { exitCode: task.exitCode }),
    durationMs: view.elapsedMs,
  };
}

/**
 * Publish one task ending. The record is already on disk when this runs.
 *
 * The call is guarded rather than trusted: `emit` runs listeners this extension
 * does not own, and pi's own bus refuses once the extension is deactivated. The
 * ending has happened either way, so a bus failure is a note on stderr and
 * nothing more.
 */
export function publishTaskFinished(events: EventBus, view: FinishedTaskView): void {
  publish(events, TASK_FINISHED_EVENT, taskFinishedEvent(view));
}

/** Publish one fire, after the iteration or the child task it names is on disk. */
export function publishLoopFired(events: EventBus, event: LoopFiredEvent): void {
  publish(events, LOOP_FIRED_EVENT, event);
}

/** Send one payload and swallow whatever the bus or its listeners do with it. */
function publish(events: EventBus, channel: string, payload: unknown): void {
  try {
    events.emit(channel, payload);
  } catch (error) {
    process.stderr.write(`pi-pretty-task: ${channel} event failed: ${String(error)}\n`);
  }
}
