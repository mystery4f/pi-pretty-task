/**
 * Extension seam harness: a fake `ExtensionAPI` that captures what the extension
 * registers, and a fake tool context that stands in for one turn of a session.
 *
 * Tests drive the extension through the registered tools exactly as pi does, so
 * they observe the same tool results the model would see.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import extension from "../../src/index.js";

/** One turn's view of the session: its working directory and session id. */
export interface Turn {
  readonly cwd: string;
  readonly sessionId: string;
}

export interface Harness {
  /** Names of every tool the extension registered. */
  readonly toolNames: readonly string[];
  /** Call a registered tool as the model would, from the given turn. */
  call(
    toolName: string,
    params: Record<string, unknown>,
    turn?: Turn,
  ): Promise<AgentToolResult<unknown>>;
}

let callCounter = 0;

function createToolContext(turn: Turn): ExtensionToolContext {
  const context = {
    cwd: turn.cwd,
    sessionManager: { getSessionId: () => turn.sessionId },
  };
  return context as unknown as ExtensionToolContext;
}

/** Load the extension against a fake API and return a caller for its tools. */
export function createHarness(defaultTurn: Turn): Harness {
  const tools: ToolDefinition[] = [];
  const api = {
    registerTool(tool: ToolDefinition): void {
      tools.push(tool);
    },
  };

  extension(api as unknown as ExtensionAPI);

  return {
    toolNames: tools.map((tool) => tool.name),
    async call(toolName, params, turn = defaultTurn) {
      const tool = tools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        throw new Error(
          `tool ${toolName} is not registered; registered: ${tools.map((t) => t.name)}`,
        );
      }
      callCounter += 1;
      return tool.execute(
        `call-${String(callCounter)}`,
        params as never,
        undefined,
        undefined,
        createToolContext(turn),
      );
    },
  };
}

/** Text of a tool result, flattened for assertions. */
export function resultText(result: AgentToolResult<unknown>): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}
