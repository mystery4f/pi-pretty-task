/**
 * The wakes a fire produced but pi has not been given yet (ADR-0009).
 *
 * `pi.sendMessage(..., { deliverAs: "followUp" })` sent while an agent run is
 * in flight is queued by pi and delivered only once the run has no more tool
 * calls — and pi offers no way to recall it. A loop stopped by `loop_update` or
 * `maxFires` in the meantime would still wake the model. So the extension keeps
 * its own queue: the pump records a fire here, and only an idle agent receives
 * it. A queued wake whose loop stopped first is dropped before it is ever sent.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { LoopFire } from "./loop-tasks.js";

/** What one flush does with the queue: the wakes to send, and the ones to drop. */
export interface WakeDrain {
  /** Wakes an idle agent may receive now, oldest first. */
  readonly deliver: LoopFire[];
  /** Wakes whose loop can no longer wake the model; they are dropped silently. */
  readonly drop: LoopFire[];
}

export class LoopWakes {
  private readonly entries: LoopFire[] = [];

  /** Remember one fire until a flush can hand it to pi. */
  record(fire: LoopFire): void {
    this.entries.push(fire);
  }

  /**
   * Take every queued fire, oldest first, split by whether it may still wake
   * the model. `deliverable` is asked now, not when the fire was recorded: a
   * pause, complete or delete may have happened while the wake waited.
   */
  drain(deliverable: (fire: LoopFire) => boolean): WakeDrain {
    const deliver: LoopFire[] = [];
    const drop: LoopFire[] = [];
    for (const fire of this.entries.splice(0)) {
      if (deliverable(fire)) deliver.push(fire);
      else drop.push(fire);
    }
    return { deliver, drop };
  }

  /**
   * Remove every queued fire of one loop, oldest first. The caller drops their
   * half-open records too: a fire that never wakes the model has no turn.
   */
  cancel(taskId: string): LoopFire[] {
    const cancelled: LoopFire[] = [];
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const fire = this.entries[index];
      if (fire === undefined || fire.task.id !== taskId) continue;
      this.entries.splice(index, 1);
      cancelled.unshift(fire);
    }
    return cancelled;
  }

  /** Wakes still waiting for an idle agent. */
  get size(): number {
    return this.entries.length;
  }
}
