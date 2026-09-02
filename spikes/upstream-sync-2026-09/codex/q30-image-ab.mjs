// Q30 (2026-09 sync) — WHY does codex fill every image slot with
// "image content omitted because it could not be processed"?
//
// SL-8 localized the failure to the MODEL side: the rollout's
// `item_completed/UserMessage.content` carries `{type:"local_image",path}` at
// full fidelity, while the paired `response_item` replaces every image with that
// placeholder. SL-8 then framed the open question as "codex defect vs Sonata's
// spawn shape vs the account".
//
// This probe answers it by A/B-ing the SPAWN SHAPE with everything else held
// fixed, and by A/B-ing the IMAGE BYTES with the spawn shape held fixed:
//
//   arm `bare` — plain `codex --no-alt-screen -C <cwd>` under node-pty. No
//                `-p sonata`, no hook profile, no `--dangerously-bypass-hook-trust`,
//                no `-s`/`-a`/`-c approvals_reviewer`.
//   arm `prod` — the production `TerminalHost` + `codexArgs` shape, via CodexBoot.
//
// Both arms paste IDENTICALLY (bracketed-paste of the shell-quoted path per
// image, then the prompt, then CSI-u Enter — terminal-host.ts:1834-1849's
// sequence), attach the SAME two fixtures, and run in freshly-seeded isolated
// CODEX_HOMEs. The only variable between the arms is the argv.
//
// The two fixtures are 69-byte 1x1 RGB PNGs that differ in EXACTLY ONE BYTE:
//
//   corrupt.png — `redPngBytes()` copied verbatim out of
//                 app/tests/smoke/native-image-attachments.mjs:471-476. Its IDAT
//                 chunk declares length 0x0b (11) for a 12-byte zlib stream, so
//                 the deflate stream is truncated one byte short of its Adler-32
//                 and the stored IDAT CRC no longer matches. `file(1)` and
//                 macOS `sips` still report "PNG 1x1" (they only parse IHDR);
//                 a real decoder rejects it.
//   valid.png   — the same 69 bytes with that one length byte set to 0x0c.
//
// Verdict is read off each arm's rollout JSONL: a real
// `{"type":"input_image","image_url":"data:image/png;base64,..."}` in the user
// `response_item` means the image reached the model; the placeholder means it
// did not.
//
// Nothing outside /private/tmp is written. Every captured byte goes through
// driver.mjs's `sanitize()` (the pre-push leak fence scans blob content).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import {
  CodexBoot,
  assertCodexVersion,
  codexVersion,
  runtime,
  sanitize,
  seedCodexHome,
  sleep,
  writeCapture,
} from "./driver.mjs";

const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const pty = require("node-pty");
const { shellQuotePath } = runtime;

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/q30-ab";
const COLS = 120;
const ROWS = 40;

const BRACKETED_PASTE_START = "\x1b[200~";
const BRACKETED_PASTE_END = "\x1b[201~";
const CSI_U_ENTER = "\x1b[13u";

/** app/tests/smoke/native-image-attachments.mjs:471-476, verbatim. */
const SMOKE_RED_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAAC0lEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

function writeFixtures(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const corrupt = Buffer.from(SMOKE_RED_PNG_B64, "base64");
  const valid = Buffer.from(corrupt);
  // Offset 33 is the IDAT chunk's 4-byte big-endian length. 0x0b -> 0x0c.
  valid[33 + 3] = 0x0c;
  const corruptPath = path.join(dir, "corrupt.png");
  const validPath = path.join(dir, "valid.png");
  fs.writeFileSync(corruptPath, corrupt);
  fs.writeFileSync(validPath, valid);
  return { corruptPath, validPath, corruptHex: corrupt.toString("hex"), validHex: valid.toString("hex") };
}

function pretrust(codexHome, cwd) {
  fs.appendFileSync(
    path.join(codexHome, "config.toml"),
    `\n[projects."${cwd}"]\ntrust_level = "trusted"\n`,
  );
}

/** The image-attachment write sequence from terminal-host.ts:1834-1849 + the
 *  CSI-u Enter at 1875 — replicated so BOTH arms deliver identically. */
function pasteSequence(write, paths, prompt) {
  for (const p of paths) write(`${BRACKETED_PASTE_START}${shellQuotePath(p)}${BRACKETED_PASTE_END}`);
  return async () => {
    await sleep(1500);
    write(`${BRACKETED_PASTE_START}${prompt}${BRACKETED_PASTE_END}`);
    await sleep(1500);
    write(CSI_U_ENTER);
  };
}

/** Read the freshest rollout under `codexHome` and report, per user
 *  `response_item`, what landed in each image slot. */
function readVerdict(codexHome) {
  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  const sessions = path.join(codexHome, "sessions");
  if (!fs.existsSync(sessions)) return { rollout: null, slots: [], localImages: [] };
  walk(sessions);
  if (files.length === 0) return { rollout: null, slots: [], localImages: [] };
  files.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  const rollout = files[0];
  const slots = [];
  const localImages = [];
  let cliVersion = null;
  for (const line of fs.readFileSync(rollout, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (cliVersion === null && typeof record?.payload?.cli_version === "string") {
      cliVersion = record.payload.cli_version;
    }
    const payload = record?.payload ?? {};
    // The DELIVERY channel (what SL-8 measured as perfect).
    const asText = JSON.stringify(payload);
    if (record?.type === "event_msg" || record?.type === "item_completed" || asText.includes('"local_image"')) {
      for (const match of asText.matchAll(/"type":"local_image","path":"((?:[^"\\]|\\.)*)"/g)) {
        localImages.push(JSON.parse(`"${match[1]}"`));
      }
    }
    // The MODEL channel.
    if (record?.type === "response_item" && payload.type === "message" && payload.role === "user") {
      let label = null;
      for (const item of payload.content ?? []) {
        if (item.type === "input_text") {
          const text = item.text ?? "";
          const tag = /^<image name=\[Image #\d+\] path="(.*)">$/.exec(text);
          if (tag) {
            label = tag[1];
            continue;
          }
          if (text.startsWith("image content omitted")) {
            slots.push({ label, verdict: "OMITTED", detail: text });
            label = null;
          }
        } else if (item.type === "input_image") {
          slots.push({
            label,
            verdict: "IMAGE",
            detail: `${(item.image_url ?? "").slice(0, 40)}… (${(item.image_url ?? "").length} chars, detail=${item.detail})`,
          });
          label = null;
        }
      }
    }
  }
  return { rollout: path.basename(rollout), cliVersion, slots, localImages };
}

async function runBare({ cwd, codexHome, fixtures, prompt }) {
  const args = ["--no-alt-screen", "-C", cwd];
  const child = pty.spawn("codex", args, {
    name: "xterm-256color",
    cols: COLS,
    rows: ROWS,
    cwd,
    env: { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" },
  });
  let raw = "";
  child.onData((data) => {
    raw += data;
  });
  // Boot settle — the bare TUI has no readiness API, so wait on the composer
  // footer painting (the same signal the production host's MEDIUM-confidence
  // gate uses) with a hard floor.
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !/\bcodex\b/i.test(raw)) await sleep(200);
  await sleep(6000);
  const submit = pasteSequence((s) => child.write(s), fixtures, prompt);
  await submit();
  await sleep(45_000);
  try {
    child.kill();
  } catch {
    /* teardown is best effort */
  }
  return { args, raw };
}

async function runProd({ cwd, codexHome, runtimeDir, binDir, fixtures, prompt }) {
  const boot = new CodexBoot({
    taskId: "task-q30-prod",
    cwd,
    runtimeDir,
    binDir,
    pretrustCwd: cwd,
    codexHome,
    rows: ROWS,
    cols: COLS,
    approvalBroker: true,
  });
  await boot.start();
  await boot.waitUntil((b) => b.ready(), 45_000);
  await sleep(4000);
  const submit = pasteSequence((s) => boot.host.writeRaw(s), fixtures, prompt);
  await submit();
  await sleep(45_000);
  const args = boot.spawnedArgs;
  boot.dispose();
  return { args, raw: boot.raw };
}

async function run() {
  const version = assertCodexVersion("q30 start");
  fs.rmSync(ROOT, { recursive: true, force: true });

  const out = { probe: "q30-image-ab", version, arms: {} };

  for (const arm of ["bare", "prod"]) {
    const cwd = path.join(ROOT, arm, "workspace");
    const codexHome = seedCodexHome(path.join(ROOT, arm, "codex-home"));
    const runtimeDir = path.join(ROOT, arm, "runtime");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(runtimeDir, { recursive: true });
    pretrust(codexHome, cwd);
    const { corruptPath, validPath, corruptHex, validHex } = writeFixtures(cwd);
    const prompt = `Reply with exactly the token Q30_${arm.toUpperCase()}_OK and nothing else.`;
    const fixtures = [corruptPath, validPath];

    const result =
      arm === "bare"
        ? await runBare({ cwd, codexHome, fixtures, prompt })
        : await runProd({
            cwd,
            codexHome,
            runtimeDir,
            binDir: path.join(ROOT, arm, "bin"),
            fixtures,
            prompt,
          });

    out.arms[arm] = {
      args: result.args,
      fixtureBytes: { corrupt: corruptHex, valid: validHex },
      ...readVerdict(codexHome),
      tail: sanitize(result.raw.slice(-2500)),
    };
  }

  out.endVersion = codexVersion();
  const capture = writeCapture(OUT_DIR, "q30-image-ab.capture.txt", out);
  for (const [arm, data] of Object.entries(out.arms)) {
    console.log(`\n== ${arm} ==`);
    console.log("argv:", JSON.stringify(data.args));
    console.log("rollout:", data.rollout, "cli:", data.cliVersion);
    console.log("local_image recorded:", data.localImages.map((p) => path.basename(p)).join(", ") || "(none)");
    for (const slot of data.slots) console.log(`  ${slot.label ?? "?"} -> ${slot.verdict}: ${slot.detail.slice(0, 90)}`);
  }
  console.log("\ncapture:", capture);
  console.log("version start/end:", version, "/", out.endVersion);
}

run().catch((error) => {
  console.error(sanitize(String(error?.stack ?? error)));
  process.exitCode = 1;
});
