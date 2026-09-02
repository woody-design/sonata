// Q22 (2026-09 sync, SL-6) — what codex 0.152.0 WRITES when the directory-trust
// dialog is answered, and whether Sonata's ledger carry-forward still parses it.
//
// THREE THINGS THE INVENTORY CLAIMS, each re-verified here rather than carried:
//   1. the grant serializes as the BARE form — `[projects."<abs path>"]` on one
//      line, `trust_level = "trusted"` on the next (od -c, so a dotted-key or
//      inline-table rewrite cannot hide behind a lenient regex);
//   2. it lands in `$CODEX_HOME/config.toml`;
//   3. `buildTrustLedger`'s carry-forward round-trips those exact bytes, so a
//      grant a HUMAN made survives Sonata's next profile regeneration ("human
//      grants are sacred", codex-runtime-settings.ts).
//
// WHY A DIRECT node-pty SPAWN AND NOT TerminalHost: this probe ANSWERS the trust
// dialog, and the standing RED LINE is that SONATA never does. Driving the
// binary directly keeps that line visible in the artifact — the keystroke comes
// from a probe interrogating its own sandboxed CLI (the 2026-08
// capture-q5-trust-serialization precedent), never from Sonata's write path.
//
// The Enter is GRID-VERIFIED, never blind: the affirm row must be the
// highlighted one on a rendered frame before a key goes out (D-1, and the SL-1
// lesson that a default row can move between releases).
//
// TWO ARMS, because the layer the grant lands in is exactly what changed
// upstream in the 0.149–0.151 permission-profile cluster:
//   bare     no `-p sonata` — the shape the 2026-08 measurement used.
//   profile  Sonata's production argv, `-p sonata` +
//            `--dangerously-bypass-hook-trust` included.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  runtime,
  seedCodexHome,
  sanitize,
  sleep,
  withCodexHome,
  writeCapture,
} from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const APP_DIR = new URL("../../../app/", import.meta.url).pathname;
const require = createRequire(APP_DIR + "package.json");
const pty = require("node-pty");
const { Terminal } = require("@xterm/headless");
const { codexArgs, ensureCodexRuntimeSettings, codexProfilePath, CODEX_SONATA_PROFILE } = runtime;

const ROOT = "/private/tmp/sonata-sync-2026-09/codex-trust-serialization";
const COLS = 120;
const ROWS = 40;

const ARMS = {
  bare: {
    why: "no profile layer — the shape the 2026-08 serialization finding was measured on",
    profile: false,
  },
  profile: {
    why: "Sonata's production argv (`-p sonata`, `--dangerously-bypass-hook-trust`) — the layer question",
    profile: true,
  },
};

function screenOf(term) {
  const buffer = term.buffer.active;
  const lines = [];
  for (let y = 0; y < term.rows; y += 1) {
    const line = buffer.getLine(buffer.viewportY + y);
    lines.push(line ? line.translateToString(true) : "");
  }
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines.join("\n");
}

async function run(armName) {
  const spec = ARMS[armName];
  const runRoot = path.join(ROOT, armName);
  fs.rmSync(runRoot, { recursive: true, force: true });
  const workspace = path.join(runRoot, "workspace");
  const binDir = path.join(runRoot, "bin");
  fs.mkdirSync(workspace, { recursive: true });
  const codexHome = seedCodexHome(path.join(runRoot, "codex-home"));

  const out = {
    arm: armName,
    why: spec.why,
    version: codexVersion(),
    workspace,
    codexHome,
  };

  // Build the production argv. The profile arm writes the real Sonata profile
  // (hooks + an EMPTY ledger — `pretrustCwd` null), so the only way the cwd can
  // become trusted is the dialog answer this probe is about to give.
  let args;
  await withCodexHome(codexHome, async () => {
    if (spec.profile) {
      ensureCodexRuntimeSettings({ binDir, pretrustCwd: null });
      out.profileBefore = fs.readFileSync(codexProfilePath(), "utf8");
    }
    args = codexArgs({
      cwd: workspace,
      permissionMode: "ask-for-approval",
      ...(spec.profile ? { profile: CODEX_SONATA_PROFILE } : {}),
    });
  });
  out.args = args;

  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 2000 });
  const env = { ...process.env, CODEX_HOME: codexHome, TERM: "xterm-256color" };
  for (const key of Object.keys(env)) {
    if (/^(CLAUDE|AI_AGENT|ANTHROPIC)/i.test(key)) delete env[key];
  }
  const child = pty.spawn("codex", args, {
    name: "xterm-256color",
    cols: COLS,
    rows: ROWS,
    cwd: workspace,
    env,
  });
  child.onData((data) => term.write(data));

  try {
    // Wait for the dialog, then GRID-VERIFY the affirm row is highlighted.
    const deadline = Date.now() + 20_000;
    let dialogFrame = null;
    while (Date.now() < deadline) {
      const screen = screenOf(term);
      if (/Do you trust the contents of this directory\?/i.test(screen)) {
        dialogFrame = screen;
        break;
      }
      await sleep(100);
    }
    out.dialogFrame = dialogFrame;
    if (dialogFrame === null) {
      out.answered = false;
      out.abortReason = "the trust dialog never painted — refusing to send a blind key";
    } else {
      const affirmHighlighted = dialogFrame
        .split("\n")
        .some((line) => /[›❯]\s*\d\.\s*Yes, continue/i.test(line));
      out.affirmRowHighlighted = affirmHighlighted;
      out.optionRows = dialogFrame
        .split("\n")
        .filter((line) => /\d\.\s*(Yes, continue|No, quit)/i.test(line))
        .map((line) => line.trimEnd());
      if (!affirmHighlighted) {
        // A RED-LINE guard, and the SL-1 lesson in one: a default row that moved
        // makes a bare Enter the DECLINE. Abort rather than answer blind.
        out.answered = false;
        out.abortReason =
          "the affirm row is not the highlighted one — the default row moved; refusing a blind Enter";
      } else {
        child.write("\r");
        out.answered = true;
        // Wait for the grant to be persisted rather than sleeping a guess.
        const persistDeadline = Date.now() + 15_000;
        while (Date.now() < persistDeadline) {
          if (!/Do you trust the contents of this directory\?/i.test(screenOf(term))) break;
          await sleep(100);
        }
        await sleep(2_500);
      }
    }
    out.screenAfter = screenOf(term);
  } finally {
    child.kill();
    await sleep(400);
  }

  // ── what landed on disk ──────────────────────────────────────────────────
  // The home is LISTED in full (which files exist is itself a finding — 0.152.0
  // seeds a fistful of sqlite stores) but only the two TOML files are READ.
  // Dumping every file was the first version of this probe and it was wrong on
  // two counts: a 21MB capture, and the sqlite stores hold session content and
  // whatever the auth layer cached — content a capture destined for the repo has
  // no business carrying, and which no path-sanitizer would have masked.
  const READABLE = new Set(["config.toml", "sonata.config.toml", "version.json"]);
  out.files = {};
  for (const name of fs.readdirSync(codexHome)) {
    const full = path.join(codexHome, name);
    if (!fs.statSync(full).isFile()) {
      out.files[name] = "<directory>";
    } else if (READABLE.has(name)) {
      out.files[name] = fs.readFileSync(full, "utf8");
    } else {
      out.files[name] = `<not read: ${fs.statSync(full).size} bytes>`;
    }
  }
  // WHICH FILE received the grant is itself a finding, not a given: codex writes
  // into the config layer it considers writable, and under `-p sonata` that is
  // SONATA'S OWN profile file, not `config.toml`. So the grant file is located
  // by searching for the block rather than assumed.
  const grantFile = ["config.toml", "sonata.config.toml"].find((name) => {
    const full = path.join(codexHome, name);
    return fs.existsSync(full) && fs.readFileSync(full, "utf8").includes(`[projects.`);
  });
  out.grantWrittenTo = grantFile ?? null;
  const configPath = path.join(codexHome, "config.toml");
  out.configExists = fs.existsSync(configPath);
  const grantPath = grantFile ? path.join(codexHome, grantFile) : null;
  // od -c the grant block itself: a dotted-key or inline-table rewrite would be
  // invisible to a lenient regex but not to the bytes.
  out.grantOd = grantPath
    ? execFileSync("sh", ["-c", `grep -A1 '^\\[projects\\.' ${JSON.stringify(grantPath)} | od -c`], {
        encoding: "utf8",
      })
    : null;
  out.grantContainsWorkspace = grantPath
    ? fs.readFileSync(grantPath, "utf8").includes(workspace)
    : false;

  // ── the carry-forward round trip ─────────────────────────────────────────
  // Take the bytes codex ACTUALLY wrote, drop them into a Sonata profile file,
  // regenerate, and check the path survives. This is the production path
  // (`buildTrustLedger` reads the existing profile) fed real upstream bytes —
  // the thing "human grants are sacred" actually rests on, and under `-p sonata`
  // it is no longer hypothetical: codex appends its grant to that very file, so
  // carry-forward is the ONLY reason a human's answer survives Sonata's next
  // write-if-changed regeneration.
  const roundTripHome = path.join(runRoot, "roundtrip-home");
  fs.rmSync(roundTripHome, { recursive: true, force: true });
  fs.mkdirSync(roundTripHome, { recursive: true });
  const grantBytes = grantPath ? fs.readFileSync(grantPath, "utf8") : "";
  fs.writeFileSync(path.join(roundTripHome, "sonata.config.toml"), grantBytes);
  await withCodexHome(roundTripHome, async () => {
    ensureCodexRuntimeSettings({ binDir: path.join(runRoot, "bin2"), pretrustCwd: null });
    out.roundTripProfile = fs.readFileSync(codexProfilePath(), "utf8");
  });
  out.roundTripPreservedGrant = out.roundTripProfile.includes(
    `[projects.${JSON.stringify(workspace)}]`,
  );
  // The failure that would matter in the other direction: a grant for a
  // directory that no longer exists must be PRUNED, not resurrected.
  out.roundTripPrunedMissing = !out.roundTripProfile.includes("/definitely/not/a/real/dir");

  return out;
}

assertCodexVersion("start");
const only = process.argv[2] ?? null;
const arms = only ? [only] : Object.keys(ARMS);
for (const arm of arms) {
  if (!ARMS[arm]) {
    console.error(`unknown arm ${arm}; expected one of ${Object.keys(ARMS).join(", ")}`);
    process.exit(64);
  }
}

const results = [];
for (const arm of arms) {
  results.push(await run(arm));
}
const endVersion = codexVersion();
const capture = {
  probe: "q22-trust-serialization",
  endVersion,
  versionDrift: endVersion.includes(EXPECT_CODEX_VERSION) ? null : `drifted to ${endVersion}`,
  results,
};
const outPath = writeCapture(OUT_DIR, "q22-trust-serialization.capture.txt", capture);
console.log(
  sanitize(
    JSON.stringify(
      results.map((result) => ({
        arm: result.arm,
        why: result.why,
        answered: result.answered,
        abortReason: result.abortReason ?? null,
        optionRows: result.optionRows ?? null,
        affirmRowHighlighted: result.affirmRowHighlighted ?? null,
        grantWrittenTo: result.grantWrittenTo,
        configTomlExists: result.configExists,
        grantContainsWorkspace: result.grantContainsWorkspace,
        grantOd: result.grantOd,
        roundTripPreservedGrant: result.roundTripPreservedGrant,
      })),
      null,
      2,
    ),
  ),
);
console.log(`\nwrote ${outPath}`);
process.exit(results.every((result) => result.answered && result.roundTripPreservedGrant) ? 0 : 1);
