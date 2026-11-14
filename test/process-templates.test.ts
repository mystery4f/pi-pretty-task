/**
 * Template configuration is the one file the process tools read. These tests pin
 * where it is read from, which file wins, and what a malformed file says — a
 * template that silently disappears would send a routine run back to retyping
 * flags the user already wrote down.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandTemplate,
  loadTemplates,
  parseTemplateConfig,
  templateConfigPaths,
} from "../src/tasks/process/templates.js";
import { makeTempDir } from "./support/processes.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function writeConfig(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

describe("template configuration files", () => {
  it("maps a name to its command, working directory and timeout", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, {
      templates: { test: { command: "npm test", cwd: "packages/app", timeoutSeconds: 600 } },
    });

    const catalog = loadTemplates(paths);

    expect(catalog.problems).toEqual([]);
    expect(catalog.templates.get("test")).toEqual({
      command: "npm test",
      cwd: "packages/app",
      timeoutSeconds: 600,
    });
  });

  it("lets the project file win a name while the agent file keeps its own", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, {
      templates: { test: { command: "npm test -- --run" } },
    });
    await writeConfig(paths.agentFile, {
      templates: {
        test: { command: "npm test -- --watch" },
        lint: { command: "npm run lint" },
      },
    });

    const catalog = loadTemplates(paths);

    expect(catalog.templates.get("test")?.command).toBe("npm test -- --run");
    expect(catalog.templates.get("lint")?.command).toBe("npm run lint");
  });

  it("treats a missing file as no templates rather than a problem", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));

    const catalog = loadTemplates(paths);

    expect(catalog.problems).toEqual([]);
    expect(catalog.templates.size).toBe(0);
  });

  it("names the file and the invalid JSON when a file cannot be parsed", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await mkdir(join(dir.path, ".pi"), { recursive: true });
    await writeFile(paths.projectFile, '{ "templates": ', "utf8");

    const catalog = loadTemplates(paths);

    expect(catalog.templates.size).toBe(0);
    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]).toContain(paths.projectFile);
    expect(catalog.problems[0]).toContain("invalid JSON");
  });

  it("keeps the other file usable when one file is malformed", async () => {
    const dir = await makeTempDir();
    cleanup.push(dir.dispose);
    const paths = templateConfigPaths(dir.path, join(dir.path, "agent"));
    await writeConfig(paths.projectFile, { templates: { broken: { command: 3 } } });
    await writeConfig(paths.agentFile, { templates: { lint: { command: "npm run lint" } } });

    const catalog = loadTemplates(paths);

    expect(catalog.templates.get("lint")?.command).toBe("npm run lint");
    expect(catalog.templates.has("broken")).toBe(false);
    expect(catalog.problems).toHaveLength(1);
    expect(catalog.problems[0]).toContain(paths.projectFile);
    expect(catalog.problems[0]).toContain('template "broken".command');
  });

  it("rejects an entry without a command, with the file and the template", () => {
    const path = "/work/.pi/pretty-task.json";
    expect(() => parseTemplateConfig('{ "templates": { "test": { "cwd": "app" } } }', path)).toThrow(
      /\/work\/\.pi\/pretty-task\.json.*template "test"\.command/,
    );
  });

  it("rejects a field a template does not carry, such as env", () => {
    const path = "/work/.pi/pretty-task.json";
    expect(() =>
      parseTemplateConfig(
        '{ "templates": { "test": { "command": "npm test", "env": { "CI": "1" } } } }',
        path,
      ),
    ).toThrow(/template "test".*unsupported field "env"/);
  });

  it("rejects a timeout that is not a positive number of seconds", () => {
    const path = "/work/.pi/pretty-task.json";
    expect(() =>
      parseTemplateConfig(
        '{ "templates": { "test": { "command": "npm test", "timeoutSeconds": 0 } } }',
        path,
      ),
    ).toThrow(/template "test"\.timeoutSeconds must be a positive number/);
  });
});

/** The map shape is the tool's read side; keep it honest after a parse. */
function names(templates: Map<string, CommandTemplate>): string[] {
  return [...templates.keys()].sort();
}

describe("parsing one template file", () => {
  it("reads every name in the file", () => {
    const parsed = parseTemplateConfig(
      '{ "templates": { "test": { "command": "npm test" }, "lint": { "command": "npm run lint" } } }',
      "/work/.pi/pretty-task.json",
    );
    expect(names(parsed)).toEqual(["lint", "test"]);
  });

  it("accepts an empty file shape as no templates", () => {
    expect(parseTemplateConfig("{}", "/work/.pi/pretty-task.json").size).toBe(0);
  });

  it("rejects a templates field that is not an object", () => {
    expect(() => parseTemplateConfig('{ "templates": [] }', "/work/.pi/pretty-task.json")).toThrow(
      /templates must be an object/,
    );
  });
});
