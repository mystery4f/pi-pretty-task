/**
 * The `/tasks` settings view (`mode = "settings"`, ADR-0029): inspect and edit the
 * ten runtime settings across the four layers (`env` > `project` > `agent` > `default`),
 * see which layer owns each effective value, and write changes atomically to either
 * `<project>/.pi/pretty-task.json` or `$PI_CODING_AGENT_DIR/pretty-task.json`
 * without disturbing `"templates"` in the same file.
 *
 * @author mystery4f <40482524+mystery4f@users.noreply.github.com>
 */

import { formatBytes } from "../../tasks/base/format.js";
import {
  isReloadRequiredSetting,
  isSettingShadowedByEnv,
  SETTING_ENV_BY_KEY,
  type SettingKey,
  type SettingScope,
  type SettingSource,
  type Settings,
  type SettingsFileLayer,
  settingKeysForPlatform,
} from "../../tasks/base/settings.js";
import {
  POSIX_SHELL_ENV,
  POSIX_SHELLS,
  SHELL_ENV,
  WINDOWS_SHELLS,
} from "../../tasks/process/shell.js";
import { fittedFooter, pad, SETTINGS_EDIT_KEYS, SETTINGS_KEYS } from "./keys.js";
import type { PanelView } from "./view.js";

const KEY_COL_WIDTH = 26;
const VALUE_COL_WIDTH = 22;
const SOURCE_COL_WIDTH = 10;
const FILE_COL_WIDTH = 18;

const SETTING_SUMMARY: Readonly<Record<SettingKey, string>> = {
  outputCapBytes: "Maximum bytes kept in a process task's output file before it is stopped.",
  maxRunningTasks: "Maximum concurrent running process tasks in one session (children included).",
  notify: "Whether an ending task emits an OSC 9 terminal notification (on | off).",
  retentionDays: "Whole days a finished session's records and outputs are kept before pruning.",
  adoptForeground: "Whether built-in bash/powershell tools and ! commands are adopted (on | off).",
  foregroundTimeoutSeconds:
    "Whole seconds a foreground command waits before detaching to a background task (0 = off).",
  shell: "Default Windows shell for process tasks (bash | cmd).",
  shellPath: "Explicit Windows executable path for the configured shell (paired with shell).",
  posixShell: "Default POSIX shell for process tasks (bash | sh | inherit).",
  posixShellPath:
    "Explicit POSIX executable path for the configured posixShell (paired with posixShell).",
};

/** Keys visible on the settings page for the given snapshot's platform. */
export function visibleSettingKeys(settings: Settings): readonly SettingKey[] {
  return settingKeysForPlatform(settings.platform);
}

/** Whether pressing Enter on `key` cycles a closed set of values instead of opening text input. */
export function isCycleSettingKey(key: SettingKey): boolean {
  return key === "notify" || key === "adoptForeground" || key === "shell" || key === "posixShell";
}

/** Compute the patch that cycles an enum/toggle setting to its next allowed value. */
export function nextCycledSettingPatch(
  key: SettingKey,
  scope: SettingScope,
  settings: Settings,
): Partial<Record<SettingKey, SettingsFileLayer[SettingKey] | undefined>> {
  const layer = settings.layers[scope];
  const current = layer[key] ?? settings.effective[key];
  if (key === "notify") {
    return { notify: current === "off" ? "on" : "off" };
  }
  if (key === "adoptForeground") {
    return { adoptForeground: current === "on" ? "off" : "on" };
  }
  if (key === "shell") {
    const idx = WINDOWS_SHELLS.indexOf((current as "cmd" | "bash") ?? "bash");
    const next = WINDOWS_SHELLS[(idx + 1) % WINDOWS_SHELLS.length] ?? "bash";
    // Changing the shell in a file that also pinned a path for the old shell drops
    // the old path so the new shell resolves cleanly unless re-pinned.
    return layer.shellPath !== undefined ? { shell: next, shellPath: undefined } : { shell: next };
  }
  if (key === "posixShell") {
    const idx = POSIX_SHELLS.indexOf((current as "inherit" | "bash" | "sh") ?? "bash");
    const next = POSIX_SHELLS[(idx + 1) % POSIX_SHELLS.length] ?? "bash";
    return layer.posixShellPath !== undefined
      ? { posixShell: next, posixShellPath: undefined }
      : { posixShell: next };
  }
  return {};
}

/** Initial text shown when the user opens inline editing on `key`. */
export function initialDraftForSetting(
  key: SettingKey,
  scope: SettingScope,
  settings: Settings,
): string {
  const raw = settings.layers[scope][key] ?? settings.effective[key];
  return raw === undefined ? "" : String(raw);
}

/**
 * Parse the inline text draft for `key` into a patch for `writeSettingsFile`.
 * An empty draft clears the key from the target file; a `*ShellPath` edit automatically
 * includes the current effective `*Shell` when the target file has not set it yet.
 */
export function parseDraftSettingPatch(
  key: SettingKey,
  draft: string,
  scope: SettingScope,
  settings: Settings,
): Partial<Record<SettingKey, SettingsFileLayer[SettingKey] | undefined>> {
  const trimmed = draft.trim();
  if (trimmed === "") {
    return { [key]: undefined };
  }
  if (
    key === "outputCapBytes" ||
    key === "maxRunningTasks" ||
    key === "retentionDays" ||
    key === "foregroundTimeoutSeconds"
  ) {
    const num = Number(trimmed);
    return { [key]: num as never };
  }
  if (key === "shellPath") {
    const shell = settings.layers[scope].shell ?? settings.effective.shell ?? "bash";
    return { shell, shellPath: trimmed };
  }
  if (key === "posixShellPath") {
    const posixShell = settings.layers[scope].posixShell ?? settings.effective.posixShell ?? "bash";
    return { posixShell, posixShellPath: trimmed };
  }
  return { [key]: trimmed as never };
}

/** Which environment variable is shadowing `key`, or `undefined` when not shadowed by env. */
export function shadowingEnvVar(key: SettingKey, settings: Settings): string | undefined {
  if (settings.sources[key] === "env") return SETTING_ENV_BY_KEY[key];
  if (key === "shellPath" && settings.sources.shell === "env") return SHELL_ENV;
  if (key === "posixShellPath" && settings.sources.posixShell === "env") return POSIX_SHELL_ENV;
  return undefined;
}

/** Build the status notice shown after saving or clearing `key` in `scope`. */
export function formatSettingSavedNotice(
  key: SettingKey,
  scope: SettingScope,
  cleared: boolean,
  settings: Settings,
): string {
  const targetFile =
    scope === "project" ? settings.templatePaths.projectFile : settings.templatePaths.agentFile;
  const action = cleared
    ? `Cleared settings.${key} from ${scope} (${targetFile})`
    : `Saved settings.${key} = ${formatRawValue(key, settings.layers[scope][key])} to ${scope} (${targetFile})`;
  const shadowedBy = shadowingEnvVar(key, settings);
  const reload = isReloadRequiredSetting(key) ? " · requires /reload" : " · active immediately";
  const shadow = shadowedBy !== undefined ? ` · shadowed by ${shadowedBy} in env` : "";
  return `${action}${reload}${shadow}`;
}

function formatRawValue(key: SettingKey, value: unknown): string {
  if (value === undefined) return "auto (default)";
  if (key === "outputCapBytes" && typeof value === "number") {
    return `${String(value)} (${formatBytes(value)})`;
  }
  if (key === "foregroundTimeoutSeconds" && typeof value === "number") {
    return value === 0 ? "0 (off)" : `${String(value)}s`;
  }
  if (key === "retentionDays" && typeof value === "number") {
    return `${String(value)}d`;
  }
  return typeof value === "string" ? value : String(value);
}

function sourceBadge(panel: PanelView, source: SettingSource): string {
  const label = pad(`[${source}]`, SOURCE_COL_WIDTH);
  if (source === "env") return panel.theme.fg("warning", label);
  if (source === "project" || source === "agent") return panel.theme.fg("accent", label);
  return panel.theme.fg("dim", label);
}

/** Render the `mode = "settings"` page inside the panel frame. */
export function renderSettingsView(panel: PanelView, width: number): string[] {
  const theme = panel.theme;
  const settings = panel.currentSettings();
  const keys = visibleSettingKeys(settings);
  const scope = panel.settingsScope;
  const targetFile =
    scope === "project" ? settings.templatePaths.projectFile : settings.templatePaths.agentFile;

  const projectChip =
    scope === "project"
      ? theme.bold(theme.fg("accent", "[project: .pi/pretty-task.json]"))
      : theme.fg("dim", " project: .pi/pretty-task.json ");
  const agentChip =
    scope === "agent"
      ? theme.bold(theme.fg("accent", `[agent: ${settings.templatePaths.agentFile}]`))
      : theme.fg("dim", ` agent: ${settings.templatePaths.agentFile} `);

  const title = `SETTINGS · target: ${scope} (${targetFile})`;
  const subtitle =
    "precedence: env > project (.pi/pretty-task.json) > agent (pretty-task.json) > default";

  const body: string[] = [
    ` Target file (t): ${projectChip}  │  ${agentChip}`,
    ` ${theme.fg("dim", `${pad("KEY", KEY_COL_WIDTH + 2)}${pad("EFFECTIVE", VALUE_COL_WIDTH)}${pad("SOURCE", SOURCE_COL_WIDTH)}${pad(`${scope.toUpperCase()} FILE`, FILE_COL_WIDTH)}APPLY`)}`,
  ];

  const selectedIndex = Math.min(keys.length - 1, Math.max(0, panel.settingsIndex));
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i] ?? "outputCapBytes";
    const isSelected = i === selectedIndex;
    const pointer = isSelected ? theme.fg("accent", "▸") : " ";
    const keyCell = isSelected
      ? theme.bold(theme.fg("accent", pad(key, KEY_COL_WIDTH)))
      : pad(key, KEY_COL_WIDTH);

    const effectiveText =
      isSelected && panel.settingsEditing
        ? `[${panel.settingsDraft}▏]`
        : formatRawValue(key, settings.effective[key]);
    const valueCell =
      isSelected && panel.settingsEditing
        ? theme.bold(theme.fg("accent", pad(effectiveText, VALUE_COL_WIDTH)))
        : pad(effectiveText, VALUE_COL_WIDTH);

    const badge = sourceBadge(panel, settings.sources[key]);
    const fileRaw = settings.layers[scope][key];
    const fileText = fileRaw === undefined ? "—" : formatRawValue(key, fileRaw);
    const fileCell =
      fileRaw === undefined
        ? theme.fg("dim", pad(fileText, FILE_COL_WIDTH))
        : pad(fileText, FILE_COL_WIDTH);

    const shadowed = isSettingShadowedByEnv(key, settings);
    const reload = isReloadRequiredSetting(key);
    const tags: string[] = [
      reload ? theme.fg("warning", "requires /reload") : theme.fg("success", "live"),
    ];
    if (shadowed) {
      tags.push(theme.fg("warning", `shadowed by ${shadowingEnvVar(key, settings) ?? "env"}`));
    }

    body.push(` ${pointer} ${keyCell}${valueCell}${badge}${fileCell}${tags.join(" · ")}`);
  }

  const selectedKey = keys[selectedIndex] ?? "outputCapBytes";
  const envName = SETTING_ENV_BY_KEY[selectedKey];
  const shadowedBy = shadowingEnvVar(selectedKey, settings);
  body.push("");
  body.push(
    ` ${theme.bold(selectedKey)} ${theme.fg("dim", `(${envName})`)} — ${SETTING_SUMMARY[selectedKey]}`,
  );
  body.push(
    ` ${theme.fg("dim", "Layers:")} env=${formatLayerEntry(selectedKey, settings.layers.env)} · project=${formatLayerEntry(selectedKey, settings.layers.project)} · agent=${formatLayerEntry(selectedKey, settings.layers.agent)} · default=${formatLayerEntry(selectedKey, settings.layers.default)}`,
  );
  if (shadowedBy !== undefined) {
    body.push(
      ` ${theme.fg("warning", `⚠ Shadowed by ${shadowedBy} in process.env — file edits save to ${scope} (${targetFile}) but stay inactive while ${shadowedBy} is set.`)}`,
    );
  }
  if (panel.notice !== undefined) {
    body.push(` ${theme.fg("warning", panel.notice)}`);
  }

  const footer = fittedFooter(
    panel.settingsEditing ? SETTINGS_EDIT_KEYS : SETTINGS_KEYS,
    Math.max(1, width - 3),
  );
  return panel.frame(title, subtitle, body, footer, width);
}

function formatLayerEntry(key: SettingKey, layer: SettingsFileLayer): string {
  const value = layer[key];
  return value === undefined ? "—" : JSON.stringify(value);
}
