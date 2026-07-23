import fs from "node:fs";
import path from "node:path";
import { asarUnpackedPath } from "../asar-unpacked";
import { SONATA_INTERPRETER_PREFIX } from "../interpreter";

interface ClaudeStatuslineSettings {
  statusLine: {
    type: "command";
    command: string;
  };
}

export function claudeUsageDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, "usage");
}

/**
 * The statusLine `command` Claude runs each tick — the Sonata interpreter prefix
 * (`ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}"`) followed by `<sink> <usageDir>`.
 * Exported so the unified runtime-settings builder (cli-signal) can compose it
 * with the hooks block into the single `--settings` file we inject. The prefix
 * rationale (ships-our-own-runtime, version pinning, fallback) lives on
 * SONATA_INTERPRETER_PREFIX.
 */
export function claudeStatuslineCommand(usageDirectory: string): string {
  return [
    SONATA_INTERPRETER_PREFIX,
    // asarUnpackedPath: the CLI runs this statusLine command with the external
    // interpreter process (Sonata-as-node or fallback PATH node), which cannot
    // read inside app.asar — point it at the unpacked-to-disk copy. No-op in
    // dev / source-tree.
    shellQuote(asarUnpackedPath(path.join(__dirname, "claude-statusline-sink.js"))),
    shellQuote(usageDirectory),
  ].join(" ");
}

export function ensureClaudeStatuslineSettings(cwd: string): string {
  const usageDirectory = claudeUsageDirectory(cwd);
  fs.mkdirSync(usageDirectory, { recursive: true });

  const settingsPath = path.join(usageDirectory, "claude-statusline-settings.json");
  const settings: ClaudeStatuslineSettings = {
    statusLine: {
      type: "command",
      command: claudeStatuslineCommand(usageDirectory),
    },
  };
  writeJsonIfChanged(settingsPath, settings);
  return settingsPath;
}

export function writeJsonIfChanged(filePath: string, value: unknown): void {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (fs.readFileSync(filePath, "utf8") === next) {
      return;
    }
  } catch {
    // File will be created below.
  }
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, next, "utf8");
  fs.renameSync(tmpPath, filePath);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
