/**
 * The wakes one session owes the model: what is waiting, whether the agent can
 * take one yet, and which fires may no longer be delivered at all.
 *
 * A wake cannot be recalled once pi has it, so the decision to send waits for an
 * idle agent and is taken here, next to the queue it drains, instead of in the
 * composition root where the events that set the flag arrive (ADR-0009).
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { Iterations } from "./iterations.js";
import type { LoopFire } from "./loop-tasks.js";
import { LoopWakes } from "./wake-queue.js";

export interface WakeDeskOptions {
  /** Where a dropped wake takes its pending iteration with it. */
  readonly iterations: Iterations;
  /** Hand a wake to pi. Called only for a fire that can still be delivered. */
  readonly send: (fire: LoopFire) => void;
  /** Something left or was dropped: whatever counts wakes should look again. */
  readonly onChange?: () => void;
}

export class WakeDesk {
  private readonly queues = new LoopWakes();
  private readonly iterations: Iterations;
  private readonly send: (fire: LoopFire) => void;
  private readonly onChange: () => void;
  private idle = true;

  constructor(options: WakeDeskOptions) {
    this.iterations = options.iterations;
    this.send = options.send;
    this.onChange = options.onChange ?? (() => {});
  }

  /** How many wakes are waiting; a test reads it to see that nothing leaked. */
  get size(): number {
    return this.queues.size;
  }

  /** A loop fired: its wake waits for the next idle agent. */
  record(fire: LoopFire): void {
    this.queues.record(fire);
  }

  /** A loop ended while its wake waited: those wakes will never be delivered. */
  cancel(taskId: string): LoopFire[] {
    return this.queues.cancel(taskId);
  }

  /** A turn started, so nothing more goes out until it settles. */
  busy(): void {
    this.idle = false;
  }

  /** The agent settled: the wakes this turn was blocking may go out now. */
  async settled(): Promise<void> {
    this.idle = true;
    await this.flush();
  }

  /**
   * Deliver what an idle agent may receive, drop what may not. A wake goes out
   * only after its iteration binds, so the turn it wakes records its own calls;
   * a dropped wake takes its pending iteration with it (ADR-0009).
   */
  async flush(): Promise<void> {
    if (!this.idle) return;
    const { deliver, drop } = this.queues.drain((fire) => this.deliverable(fire));
    for (const fire of drop) await this.safely(this.iterations.drop(fire));
    for (const fire of deliver) {
      this.iterations.bind(fire);
      this.send(fire);
    }
    if (deliver.length > 0 || drop.length > 0) this.onChange();
  }

  /**
   * A queued wake still belongs to the model while its loop runs; a fire that
   * used the last of `maxFires` completed the loop and must still be delivered,
   * because that turn is the reason the count reached the limit. Every other
   * stopped loop drops its wake: pause, complete, expiry, delete.
   */
  private deliverable(fire: LoopFire): boolean {
    const task = fire.session.tasks.get(fire.task.id);
    if (task?.kind !== "prompt-loop") return false;
    return task.status === "running" || fire.final;
  }

  /** A dropped iteration is bookkeeping: a failure belongs on stderr, not in the turn. */
  private async safely(work: Promise<void>): Promise<void> {
    try {
      await work;
    } catch (error) {
      process.stderr.write(`pi-pretty-task: iteration record failed: ${String(error)}\n`);
    }
  }
}
