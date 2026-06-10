import fs from "node:fs";
import path from "node:path";

const outputDirectory = process.argv[2];

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});

process.stdin.on("end", () => {
  if (!outputDirectory) {
    return;
  }

  const payload = parsePayload(raw);
  const sessionId = typeof payload?.session_id === "string" ? payload.session_id : null;
  if (!sessionId) {
    return;
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const filePath = path.join(outputDirectory, `claude-${safeFilename(sessionId)}.json`);
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, raw.trimEnd(), "utf8");
  fs.renameSync(tmpPath, filePath);
});

function parsePayload(rawPayload: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function safeFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "-");
}
