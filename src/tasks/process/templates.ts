/**
 * Named commands a user writes down once and runs by name through `bg_run`.
 *
 * The file is read from the project first, then the agent settings directory,
 * and the project wins a shared name. A bad file is a loud problem, not a
 * silent gap: an unknown template has to be distinguishable from one that was
 * never loaded because a comma was missing.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTimeoutSeconds } from "./limits.js";

/** One command a template fills in. `env` is deliberately not templated. */
export interface CommandTemplate {
  readonly command: string;
  readonly cwd?: string;
  readonly timeoutSeconds?: number;
}

/** The two files templates come from, in precedence order. */
export interface TemplateConfigPaths {
  readonly projectFile: string;
  readonly agentFile: string;
}

/** Every template available to this session, plus why a file could not be used. */
export interface TemplateCatalog {
  readonly templates: ReadonlyMap<string, CommandTemplate>;
  readonly problems: readonly string[];
}

/** Name of the configuration file in both locations. */
export const TEMPLATE_CONFIG_FILE = "pretty-task.json";

/** Directory under the project root that holds the project-level file. */
export const PROJECT_CONFIG_DIR = ".pi";

const TEMPLATE_FIELDS: ReadonlySet<string> = new Set(["command", "cwd", "timeoutSeconds"]);

/** Locate both template files for a project and an agent settings directory. */
export function templateConfigPaths(projectDir: string, agentDir: string): TemplateConfigPaths {
  return {
    projectFile: join(projectDir, PROJECT_CONFIG_DIR, TEMPLATE_CONFIG_FILE),
    agentFile: join(agentDir, TEMPLATE_CONFIG_FILE),
  };
}

/**
 * Read both files and merge them, project over agent.
 *
 * A missing file is normal. A malformed one is reported in `problems` with the
 * file and the defect, and the other file still supplies its templates.
 */
export function loadTemplates(paths: TemplateConfigPaths): TemplateCatalog {
  const problems: string[] = [];
  const project = readTemplateFile(paths.projectFile, problems);
  const agent = readTemplateFile(paths.agentFile, problems);

  const templates = new Map<string, CommandTemplate>(agent);
  for (const [name, template] of project) templates.set(name, template);

  return { templates, problems };
}

/**
 * Parse one template file. Throws with the file name and the exact defect; the
 * caller decides whether that ends the load or becomes a reported problem.
 */
export function parseTemplateConfig(text: string, file: string): Map<string, CommandTemplate> {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch (error) {
    fail(file, `invalid JSON (${messageOf(error)})`);
  }

  if (!isObject(raw)) fail(file, `the top level must be an object; received ${received(raw)}`);
  if (!("templates" in raw)) return new Map();

  const section = raw.templates;
  if (!isObject(section)) {
    fail(file, `templates must be an object; received ${received(section)}`);
  }

  const templates = new Map<string, CommandTemplate>();
  for (const [name, value] of Object.entries(section)) {
    templates.set(name, parseTemplate(name, value, file));
  }
  return templates;
}

function parseTemplate(name: string, value: unknown, file: string): CommandTemplate {
  const label = `template ${JSON.stringify(name)}`;
  if (name.trim() === "") fail(file, "a template name must not be empty");
  if (!isObject(value)) fail(file, `${label} must be an object; received ${received(value)}`);

  for (const field of Object.keys(value)) {
    if (!TEMPLATE_FIELDS.has(field)) {
      fail(
        file,
        `${label} has an unsupported field ${JSON.stringify(field)}; a template carries command, cwd and timeoutSeconds`,
      );
    }
  }

  const command = value.command;
  if (typeof command !== "string" || command.trim() === "") {
    fail(file, `${label}.command must be a non-empty string; received ${received(command)}`);
  }

  const template: { command: string; cwd?: string; timeoutSeconds?: number } = { command };

  if (value.cwd !== undefined) {
    if (typeof value.cwd !== "string" || value.cwd.trim() === "") {
      fail(file, `${label}.cwd must be a non-empty string; received ${received(value.cwd)}`);
    }
    template.cwd = value.cwd;
  }

  if (value.timeoutSeconds !== undefined) {
    if (typeof value.timeoutSeconds !== "number") {
      fail(
        file,
        `${label}.timeoutSeconds must be a number; received ${received(value.timeoutSeconds)}`,
      );
    }
    try {
      parseTimeoutSeconds(value.timeoutSeconds);
    } catch (error) {
      fail(file, `${label}.${messageOf(error)}`);
    }
    template.timeoutSeconds = value.timeoutSeconds;
  }

  return template;
}

function readTemplateFile(file: string, problems: string[]): Map<string, CommandTemplate> {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return new Map();
    problems.push(`template configuration ${file}: cannot be read (${messageOf(error)})`);
    return new Map();
  }

  try {
    return parseTemplateConfig(text, file);
  } catch (error) {
    problems.push(messageOf(error));
    return new Map();
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function received(value: unknown): string {
  const json = JSON.stringify(value);
  return json === undefined ? String(value) : json;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(file: string, detail: string): never {
  throw new Error(`template configuration ${file}: ${detail}`);
}
