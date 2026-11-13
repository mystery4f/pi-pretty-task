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
  MessageRenderer,
  MessageRenderOptions,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import extension from "../../src/index.js";

/** One turn's view of the session: its working directory and session id. */
export interface Turn {
  readonly cwd: string;
  readonly sessionId: string;
}

/** One custom message the extension sent into the session. */
export interface SentMessage {
  readonly customType: string;
  /** Content flattened to text, whichever form the extension used. */
  readonly content: string;
  readonly display: boolean;
  readonly details?: unknown;
  readonly options: {
    readonly deliverAs?: "steer" | "followUp" | "nextTurn";
    readonly triggerTurn?: boolean;
  };
}

export interface Harness {
  /** Names of every tool the extension registered. */
  readonly toolNames: readonly string[];
  /** Every message sent with `sendMessage`, oldest first. */
  readonly messages: readonly SentMessage[];
  /** Custom types the extension registered a message renderer for. */
  readonly rendererTypes: readonly string[];
  /** Call a registered tool as the model would, from the given turn. */
  call(
    toolName: string,
    params: Record<string, unknown>,
    turn?: Turn,
  ): Promise<AgentToolResult<unknown>>;
  /** Draw a sent message through the renderer registered for its custom type. */
  /** Draw a custom message through the renderer registered for its type. */
  render(customType: string, details: unknown, options?: Partial<MessageRenderOptions>): string;
}

let callCounter = 0;

function createToolContext(turn: Turn): ExtensionToolContext {
  const context = {
    cwd: turn.cwd,
    sessionManager: { getSessionId: () => turn.sessionId },
  };
  return context as unknown as ExtensionToolContext;
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as ReadonlyArray<{ text?: string }>).map((item) => item.text ?? "").join("\n");
}

/**
 * A stand-in `Theme` that wraps styled text in `<token>…</token>` markers, so a
 * test can see which theme token a renderer used without depending on ANSI.
 */
export function fakeTheme(): Theme {
  const style = (token: string, text: string): string => `<${token}>${text}</${token}>`;
  return {
    fg: style,
    bg: style,
    bold: (text: string) => style("bold", text),
    italic: (text: string) => style("italic", text),
    underline: (text: string) => style("underline", text),
    inverse: (text: string) => style("inverse", text),
    strikethrough: (text: string) => style("strikethrough", text),
  } as unknown as Theme;
}

/** Load the extension against a fake API and return a caller for its tools. */
export function createHarness(defaultTurn: Turn): Harness {
  const tools: ToolDefinition[] = [];
  const renderers = new Map<string, MessageRenderer>();
  const messages: SentMessage[] = [];
  const api = {
    registerTool(tool: ToolDefinition): void {
      tools.push(tool);
    },
    registerMessageRenderer(customType: string, renderer: MessageRenderer): void {
      renderers.set(customType, renderer);
    },
    sendMessage(
      message: {
        customType: string;
        content: unknown;
        display: boolean;
        details?: unknown;
      },
      options?: SentMessage["options"],
    ): void {
      messages.push({
        customType: message.customType,
        content: messageText(message.content),
        display: message.display,
        details: message.details,
        options: options ?? {},
      });
    },
  };

  extension(api as unknown as ExtensionAPI);

  return {
    toolNames: tools.map((tool) => tool.name),
    messages,
    rendererTypes: [...renderers.keys()],
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
    render(customType, details, options) {
      const renderer = renderers.get(customType);
      if (renderer === undefined) {
        throw new Error(
          `no message renderer for ${customType}; registered: ${[...renderers.keys()]}`,
        );
      }
      const component = renderer(
        { role: "custom", customType, content: "", display: true, details, timestamp: Date.now() },
        { expanded: false, outputPad: 0, keyText: () => "", keyHint: () => "", ...options },
        fakeTheme(),
      );
      return component === undefined ? "" : component.render(80).join("\n");
    },
  };
}

/** Text of a tool result, flattened for assertions. */
export function resultText(result: AgentToolResult<unknown>): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}
