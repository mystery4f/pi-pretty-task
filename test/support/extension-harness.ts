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
  ExtensionCommandContext,
  ExtensionToolContext,
  MessageRenderer,
  MessageRenderOptions,
  Theme,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import type { Component, KeybindingsManager, TUI } from "@earendil-works/pi-tui";

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
  /** Names of every command the extension registered. */
  readonly commandNames: readonly string[];
  /** Run a registered command the way the user would, and wait for it to return. */
  runCommand(name: string, args?: string, turn?: Turn): Promise<void>;
  /** The component the most recent `ctx.ui.custom` handed to pi, if any. */
  lastCustom(): Component | undefined;
  /** The options the most recent `ctx.ui.custom` was opened with. */
  lastCustomOptions(): CustomOptions | undefined;
  /** Every status-line update the extension made, oldest first. */
  readonly statuses: readonly StatusUpdate[];
  /** Keys passed to `setWidget`; stays empty because the panel is not a widget. */
  readonly widgetKeys: readonly string[];
}

/** One call the extension made to `ctx.ui.setStatus`. */
export interface StatusUpdate {
  readonly key: string;
  readonly text: string | undefined;
}

/** The parts of the `ctx.ui.custom` options a panel cares about. */
export interface CustomOptions {
  readonly overlay?: boolean;
  readonly overlayOptions?: unknown;
}

let callCounter = 0;

/** What pi accepts for a command: everything but the name and source info it fills in. */
type CommandDefinition = Parameters<ExtensionAPI["registerCommand"]>[1];

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

/**
 * Load the extension against a fake API and return a caller for its tools.
 *
 * The environment is explicit so a test can set a limit without touching the
 * process's own environment, and so an invalid value can be handed to the loader.
 */
export function createHarness(defaultTurn: Turn, env: NodeJS.ProcessEnv = process.env): Harness {
  const tools: ToolDefinition[] = [];
  const renderers = new Map<string, MessageRenderer>();
  const messages: SentMessage[] = [];
  const commands = new Map<string, CommandDefinition>();
  const statuses: StatusUpdate[] = [];
  const widgetKeys: string[] = [];
  let opened: { component: Component; options: CustomOptions } | undefined;

  const fakeTui = { requestRender: () => undefined } as unknown as TUI;
  const ui = {
    custom<T>(
      factory: (
        tui: TUI,
        theme: Theme,
        keybindings: KeybindingsManager,
        done: (result: T) => void,
      ) => Component | Promise<Component>,
      options?: CustomOptions,
    ): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const open = (component: Component): void => {
          opened = { component, options: options ?? {} };
        };
        try {
          const produced = factory(fakeTui, fakeTheme(), {} as KeybindingsManager, resolve);
          if (produced instanceof Promise) produced.then(open, reject);
          else open(produced);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    },
    setStatus(key: string, text: string | undefined): void {
      statuses.push({ key, text });
    },
    setWidget(key: string): void {
      widgetKeys.push(key);
    },
    notify(): void {
      // Notices are not what these tests assert; recorded nowhere on purpose.
    },
  };

  const commandContext = (turn: Turn): ExtensionCommandContext =>
    ({
      cwd: turn.cwd,
      mode: "tui",
      hasUI: true,
      sessionManager: { getSessionId: () => turn.sessionId },
      isIdle: () => true,
      ui,
    }) as unknown as ExtensionCommandContext;

  const api = {
    registerCommand(name: string, definition: CommandDefinition): void {
      commands.set(name, definition);
    },
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

  extension(api as unknown as ExtensionAPI, env);

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
    commandNames: [...commands.keys()],
    async runCommand(name, args = "", turn = defaultTurn) {
      const command = commands.get(name);
      if (command === undefined) {
        throw new Error(
          `command ${name} is not registered; registered: ${[...commands.keys()].join(", ")}`,
        );
      }
      await command.handler(args, commandContext(turn));
    },
    lastCustom: () => opened?.component,
    lastCustomOptions: () => opened?.options,
    statuses,
    widgetKeys,
  };
}

/** Text of a tool result, flattened for assertions. */
export function resultText(result: AgentToolResult<unknown>): string {
  return result.content.map((item) => (item.type === "text" ? item.text : "")).join("\n");
}
