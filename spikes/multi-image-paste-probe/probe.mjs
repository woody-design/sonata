import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { createRequire } from "node:module";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const appRequire = createRequire(path.join(repoRoot, "app", "package.json"));
const pty = appRequire("node-pty");
const { Terminal } = appRequire("@xterm/headless");
const { Unicode11Addon } = appRequire("@xterm/addon-unicode11");

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const CSI_U_ENTER = "\x1b[13u";
const IMAGE_MARKER_RE = /\[Image\s+#\d+\]/gi;
const providers = process.argv.slice(2).filter((value) => value === "claude" || value === "codex");
const requestedProviders = providers.length > 0 ? providers : ["claude", "codex"];
const exactBins = {
  claude: process.env.CLAUDE_2_1_214_BIN,
  codex: process.env.CODEX_0_144_5_BIN,
};

for (const provider of requestedProviders) {
  if (!exactBins[provider]) {
    throw new Error(`Set ${provider === "claude" ? "CLAUDE_2_1_214_BIN" : "CODEX_0_144_5_BIN"}.`);
  }
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-multi-image-probe-"));
const imageSpecs = [
  [64, 64],
  [128, 128],
  [256, 256],
  [384, 384],
  [512, 512],
  [768, 768],
];
const images = imageSpecs.map(([width, height], index) => {
  const imagePath = path.join(tempRoot, `probe-${index + 1}-${width}x${height}.png`);
  fs.writeFileSync(imagePath, noisyPng(width, height, index + 1));
  return {
    ordinal: index + 1,
    path: imagePath,
    width,
    height,
    bytes: fs.statSync(imagePath).size,
  };
});

const results = {
  generatedAt: new Date().toISOString(),
  cwd: repoRoot,
  images: images.map(({ ordinal, width, height, bytes }) => ({ ordinal, width, height, bytes })),
  providers: {},
};

try {
  for (const provider of requestedProviders) {
    const version = await commandVersion(exactBins[provider]);
    const sequential = await runSequential(provider);
    const midConversion = await runMidConversion(provider);
    const singleFrame = await runSingleFrame(provider);
    results.providers[provider] = { version, sequential, midConversion, singleFrame };
  }
  console.log(JSON.stringify(results, null, 2));
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

async function runSequential(provider) {
  const session = await startSession(provider, "sequential");
  try {
    const before = await session.capture();
    const startedAt = Date.now();
    for (const image of images) {
      session.write(pasteFrame(quotePath(image.path)));
    }
    const observation = await observeMarkers(session, markerCount(before.viewport), startedAt, 12_000);
    return {
      firstSeenMsByOrdinal: observation.firstSeenMs,
      finalDelta: observation.finalDelta,
      finalViewport: redact(observation.viewport),
    };
  } finally {
    session.dispose();
  }
}

async function runMidConversion(provider) {
  const session = await startSession(provider, "mid-conversion");
  try {
    const before = await session.capture();
    const baseline = markerCount(before.viewport);
    const startedAt = Date.now();
    const prompt = `SONATA_MID_CONVERSION_${provider.toUpperCase()}: reply exactly PROBE_OK.`;
    for (const image of images) {
      session.write(pasteFrame(quotePath(image.path)));
    }
    const timedCaptures = [];
    await delay(120);
    session.write(pasteFrame(prompt));
    let markerCountAtEnter = null;
    const partialDeadline = Date.now() + 1000;
    while (Date.now() < partialDeadline) {
      const current = await session.capture();
      const delta = Math.max(0, markerCount(current.viewport) - baseline);
      if (delta > 0) {
        markerCountAtEnter = delta;
        break;
      }
      await delay(1);
    }
    const enterAtMs = Date.now() - startedAt;
    session.write(CSI_U_ENTER);
    for (const [label, afterEnterMs] of [
      ["enter+0", 0],
      ["enter+240", 240],
      ["enter+740", 740],
      ["enter+1740", 1740],
      ["enter+4740", 4740],
    ]) {
      await delay(Math.max(0, enterAtMs + afterEnterMs - (Date.now() - startedAt)));
      timedCaptures.push({ label, elapsedMs: Date.now() - startedAt, ...(await session.capture()) });
    }
    await delay(Math.max(0, 8000 - (Date.now() - startedAt)));
    const final = await session.capture();
    return {
      enterAtMs,
      markerCountAtEnter,
      baselineMarkers: baseline,
      timedCaptures: timedCaptures
        .sort((a, b) => a.elapsedMs - b.elapsedMs)
        .map(({ label, elapsedMs, viewport }) => ({
          label,
          elapsedMs,
          markerCount: markerCount(viewport),
          viewport: redact(viewport),
        })),
      finalMarkerCount: markerCount(final.viewport),
      finalViewport: redact(final.viewport),
    };
  } finally {
    session.dispose();
  }
}

async function runSingleFrame(provider) {
  const session = await startSession(provider, "single-frame");
  try {
    const before = await session.capture();
    const startedAt = Date.now();
    session.write(pasteFrame(images.map((image) => quotePath(image.path)).join(" ")));
    const observation = await observeMarkers(session, markerCount(before.viewport), startedAt, 12_000);
    return {
      firstSeenMsByOrdinal: observation.firstSeenMs,
      finalDelta: observation.finalDelta,
      finalViewport: redact(observation.viewport),
    };
  } finally {
    session.dispose();
  }
}

async function startSession(provider, scenario) {
  const command = exactBins[provider];
  const args =
    provider === "claude"
      ? ["--permission-mode", "plan", "--model", "haiku", "--session-id", crypto.randomUUID()]
      : [
          "--no-alt-screen",
          "-C",
          repoRoot,
          "-s",
          "read-only",
          "-a",
          "never",
          "-c",
          'approvals_reviewer="user"',
        ];
  const terminal = new Terminal({
    cols: 160,
    rows: 50,
    scrollback: 1000,
    allowProposedApi: true,
  });
  const unicode = new Unicode11Addon();
  terminal.loadAddon(unicode);
  terminal.unicode.activeVersion = "11";
  const child = pty.spawn(command, args, {
    name: "xterm-256color",
    cols: 160,
    rows: 50,
    cwd: repoRoot,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", FORCE_COLOR: "1" },
  });
  let exited = null;
  child.onData((data) => terminal.write(data));
  child.onExit((event) => {
    exited = event;
  });
  terminal.onData((data) => child.write(data));

  const session = {
    provider,
    scenario,
    write: (data) => child.write(data),
    capture: async () => {
      await flushTerminal(terminal);
      return { viewport: renderViewport(terminal) };
    },
    dispose: () => {
      try {
        child.write("\x03");
        child.write("\x04");
      } catch {}
      try {
        child.kill();
      } catch {}
      terminal.dispose();
    },
  };

  let lastStartupViewport = "";
  let handledUpdatePrompt = false;
  let handledTrustPrompt = false;
  await waitUntil(async () => {
    if (exited) {
      throw new Error(`${provider}/${scenario} exited during startup: ${JSON.stringify(exited)}`);
    }
    const { viewport } = await session.capture();
    lastStartupViewport = viewport;
    if (!handledUpdatePrompt && /Update available![\s\S]*Press enter to continue/i.test(viewport)) {
      handledUpdatePrompt = true;
      child.write("\x1b[B\r");
      return false;
    }
    if (!handledTrustPrompt && /Do you trust|trust this (?:folder|directory)|Yes, continue/i.test(viewport)) {
      handledTrustPrompt = true;
      child.write("\r");
      return false;
    }
    return provider === "claude"
      ? /❯/.test(viewport) && /shortcuts|for agents|plan mode/i.test(viewport)
      : /›/.test(viewport) && /context left|shortcuts|gpt-/i.test(viewport);
  }, 30_000, `${provider}/${scenario} composer readiness`).catch((error) => {
    throw new Error(`${error.message}\n\n${redact(lastStartupViewport)}`);
  });
  await delay(500);
  return session;
}

async function observeMarkers(session, baseline, startedAt, timeoutMs) {
  const firstSeenMs = Array(images.length).fill(null);
  let finalDelta = 0;
  let viewport = "";
  const deadline = startedAt + timeoutMs;
  while (Date.now() < deadline) {
    ({ viewport } = await session.capture());
    finalDelta = Math.max(0, markerCount(viewport) - baseline);
    for (let index = 0; index < Math.min(finalDelta, images.length); index += 1) {
      firstSeenMs[index] ??= Date.now() - startedAt;
    }
    if (finalDelta >= images.length) {
      break;
    }
    await delay(10);
  }
  return { firstSeenMs, finalDelta, viewport };
}

function renderViewport(terminal) {
  const buffer = terminal.buffer.active;
  const lines = [];
  for (let row = buffer.viewportY; row < buffer.viewportY + terminal.rows; row += 1) {
    lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

function flushTerminal(terminal) {
  return new Promise((resolve) => terminal.write("", resolve));
}

function pasteFrame(value) {
  return `${BRACKETED_PASTE_START}${value}${BRACKETED_PASTE_END}`;
}

function quotePath(value) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function markerCount(value) {
  return value.match(IMAGE_MARKER_RE)?.length ?? 0;
}

function redact(value) {
  return value.replaceAll(os.homedir(), "~").replaceAll(tempRoot, "$PROBE_TMP");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

async function commandVersion(command) {
  const { execFile } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    execFile(command, ["--version"], (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(`${stdout}${stderr}`.trim());
    });
  });
}

function noisyPng(width, height, seed) {
  const rowBytes = width * 3 + 1;
  const raw = Buffer.alloc(rowBytes * height);
  let state = seed >>> 0;
  for (let y = 0; y < height; y += 1) {
    const offset = y * rowBytes;
    raw[offset] = 0;
    for (let x = 1; x < rowBytes; x += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      raw[offset + x] = state >>> 24;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, data])), 0);
  return Buffer.concat([length, name, data, crc]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
