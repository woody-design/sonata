import fs from "node:fs";
import path from "node:path";

interface ClaudeStatuslineSettings {
  statusLine: {
    type: "command";
    command: string;
  };
}

export function claudeUsageDirectory(cwd: string): string {
  return path.join(cwd, ".duet", "usage");
}

export function ensureClaudeStatuslineSettings(cwd: string): string {
  const usageDirectory = claudeUsageDirectory(cwd);
  fs.mkdirSync(usageDirectory, { recursive: true });

  const settingsPath = path.join(usageDirectory, "claude-statusline-settings.json");
  const settings: ClaudeStatuslineSettings = {
    statusLine: {
      type: "command",
      command: [
        "node",
        shellQuote(path.join(__dirname, "claude-statusline-sink.js")),
        shellQuote(usageDirectory),
      ].join(" "),
    },
  };
  writeJsonIfChanged(settingsPath, settings);
  return settingsPath;
}

function writeJsonIfChanged(filePath: string, value: unknown): void {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
