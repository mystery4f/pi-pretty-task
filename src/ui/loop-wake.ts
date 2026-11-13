/**
 * The loop wake: one session message per fire, carrying the loop's prompt.
 *
 * The prompt is the message content, not a description of the wake, because pi
 * delivers it as a follow-up that starts a turn. `details` carries the header
 * facts for the renderer, so the transcript shows which loop fired and how
 * often without the model having to parse that from the prompt.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type { ExtensionAPI, MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { LoopFire } from "../tasks/loop/loop-tasks.js";

/** Custom message type the loop-wake renderer is registered under. */
export const LOOP_WAKE_CUSTOM_TYPE = "loop-wake";

export interface LoopWakeDetails {
  readonly id: string;
  readonly name: string;
  /** Raw schedule text as the user wrote it. */
  readonly schedule: string;
  /** One-based fire number. */
  readonly fire: number;
}

/** Send one wake for a due loop; the prompt becomes a new turn. */
export function sendLoopWake(pi: ExtensionAPI, fire: LoopFire): void {
  const details: LoopWakeDetails = {
    id: fire.task.id,
    name: fire.task.name,
    schedule: fire.task.schedule,
    fire: fire.fire,
  };
  pi.sendMessage(
    {
      customType: LOOP_WAKE_CUSTOM_TYPE,
      content: fire.task.prompt,
      display: true,
      details,
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
}

/** Draws one wake: a header, then the prompt exactly as the loop stored it. */
export const renderLoopWake: MessageRenderer<LoopWakeDetails> = (message, _options, theme) => {
  const details = message.details;
  if (details === undefined) return undefined;
  const header = [
    theme.fg("accent", "↻ loop"),
    theme.bold(details.name),
    theme.fg("muted", `(${details.id})`),
    theme.fg("muted", `· ${details.schedule} · fire ${String(details.fire)}`),
  ].join(" ");
  return new Text([header, message.content].join("\n"), 0, 0);
};
