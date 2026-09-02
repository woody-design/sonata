import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { claudeArgs, codexArgs, ensureClaudeRuntimeSettings } = require("../../dist/runtime");

const codexFast = codexArgs({
  cwd: "/tmp/sonata launch settings",
  permissionMode: "ask-for-approval",
  model: "gpt-5.6-sol",
  reasoningEffort: "ultra",
  speedMode: "fast",
});
const codexDefaultSpeed = codexArgs({
  cwd: "/tmp/sonata launch settings",
  permissionMode: "full-access",
  model: "gpt-5.5",
  reasoningEffort: "medium",
  speedMode: "default",
});
// With the Sonata hook profile injected, the spawn MUST carry
// `--dangerously-bypass-hook-trust` — codex can't persist hook trust through a
// profile layer, so without it every session re-prompts for hook review (D4
// overturn 2026-07-06; spikes/codex-hook-trust-research). Gated on `profile`:
// a bare spawn (no hooks) must NOT carry the dangerous flag.
const codexWithProfile = codexArgs({
  cwd: "/tmp/sonata launch settings",
  permissionMode: "ask-for-approval",
  profile: "sonata",
});
const claude = claudeArgs({
  permissionMode: "default",
  model: "opus",
  reasoningEffort: "xhigh",
});
const claudeWithSettings = claudeArgs({
  permissionMode: "dontAsk",
  model: "fable",
  reasoningEffort: "high",
  settingsPath: "/tmp/sonata usage/claude-statusline-settings.json",
});
const claudeRemoteControl = claudeArgs({
  permissionMode: "default",
  model: "opus",
  settingsPath: "/tmp/sonata usage/claude-statusline-settings.json",
  remoteControl: true,
  // Reviewer-added coverage (SL-19 round 1): --effort is the flag emitted
  // immediately BEFORE --remote-control, so the must-stay-last invariant is
  // only exercised when the fixture carries one.
  reasoningEffort: "xhigh",
});

// Claude native fast mode has NO claudeArgs flag — it rides in the injected
// `--settings` file as `"fastMode": true` (probe: spikes/claude-fastmode-inject/,
// the `↯` glyph flips on iff this key is present). Assert both directions: fast
// writes the key; standard omits it entirely (not `false`) so repeat spawns of
// the same shape stay byte-stable.
const fastRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-launch-fast-"));
const standardRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-launch-standard-"));
const fastSettings = JSON.parse(
  fs.readFileSync(
    ensureClaudeRuntimeSettings(fastRuntimeDir, { approvalBroker: false, fastMode: true }),
    "utf8",
  ),
);
const standardSettings = JSON.parse(
  fs.readFileSync(
    ensureClaudeRuntimeSettings(standardRuntimeDir, { approvalBroker: false, fastMode: false }),
    "utf8",
  ),
);
fs.rmSync(fastRuntimeDir, { recursive: true, force: true });
fs.rmSync(standardRuntimeDir, { recursive: true, force: true });

// Remote Control's STARTUP half also has no claudeArgs flag: `--remote-control`
// only says ON. Saying OFF is `"remoteControlAtStartup": false` in this same
// injected file — the `flagSettings` scope claude's resolver accepts — because at
// 2.1.25x declining to pass the flag does not turn RC off (it auto-started 6/6
// production boots off a server-side default; upstream sync 2026-09 SL-11, F4e,
// lever measured in F4i / rc7, wired in SL-19). Assert both directions AND their
// pairing with the argv: OFF writes the key and passes no flag; ON omits the key
// entirely — never `true`, never a `false` contradicting its own `--remote-control`.
const rcOffRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-launch-rc-off-"));
const rcOnRuntimeDir = fs.mkdtempSync(path.join(os.tmpdir(), "sonata-launch-rc-on-"));
const rcOffSettingsPath = ensureClaudeRuntimeSettings(rcOffRuntimeDir, { approvalBroker: false });
const rcOnSettingsPath = ensureClaudeRuntimeSettings(rcOnRuntimeDir, {
  approvalBroker: false,
  remoteControl: true,
});
const rcOffSettings = JSON.parse(fs.readFileSync(rcOffSettingsPath, "utf8"));
const rcOnSettings = JSON.parse(fs.readFileSync(rcOnSettingsPath, "utf8"));
// Byte-stability per SHAPE: a repeat spawn of the same shape must reproduce the
// same bytes AND leave the file untouched (`writeJsonIfChanged` never churns) —
// the discipline the conditional keys exist to preserve.
const byteStable = [
  [rcOffSettingsPath, rcOffRuntimeDir, { approvalBroker: false }],
  [rcOnSettingsPath, rcOnRuntimeDir, { approvalBroker: false, remoteControl: true }],
].every(([settingsPath, runtimeDir, options]) => {
  const before = fs.readFileSync(settingsPath, "utf8");
  const mtimeBefore = fs.statSync(settingsPath).mtimeMs;
  const repeatPath = ensureClaudeRuntimeSettings(runtimeDir, options);
  return (
    repeatPath === settingsPath &&
    fs.readFileSync(settingsPath, "utf8") === before &&
    fs.statSync(settingsPath).mtimeMs === mtimeBefore
  );
});
fs.rmSync(rcOffRuntimeDir, { recursive: true, force: true });
fs.rmSync(rcOnRuntimeDir, { recursive: true, force: true });

const success =
  includesSequence(codexFast, ["-m", "gpt-5.6-sol"]) &&
  includesSequence(codexFast, ["-c", 'model_reasoning_effort="ultra"']) &&
  includesSequence(codexFast, ["-c", 'service_tier="priority"']) &&
  includesSequence(codexFast, ["-C", "/tmp/sonata launch settings"]) &&
  // ask-for-approval fans out to the workspace-write / on-request / user row.
  includesSequence(codexFast, ["-s", "workspace-write"]) &&
  includesSequence(codexFast, ["-a", "on-request"]) &&
  includesSequence(codexFast, ["-c", 'approvals_reviewer="user"']) &&
  // full-access fans out to the danger-full-access / never / user row.
  includesSequence(codexDefaultSpeed, ["-s", "danger-full-access"]) &&
  includesSequence(codexDefaultSpeed, ["-a", "never"]) &&
  includesSequence(codexDefaultSpeed, ["-c", 'approvals_reviewer="user"']) &&
  includesSequence(codexDefaultSpeed, ["-c", 'model_reasoning_effort="medium"']) &&
  !codexDefaultSpeed.includes('service_tier="priority"') &&
  // profile → bypass flag present, right after `-p sonata`
  includesSequence(codexWithProfile, ["-p", "sonata"]) &&
  codexWithProfile.includes("--dangerously-bypass-hook-trust") &&
  // no profile → NO bypass flag (gating: bare spawn stays clean)
  !codexFast.includes("--dangerously-bypass-hook-trust") &&
  !codexDefaultSpeed.includes("--dangerously-bypass-hook-trust") &&
  includesSequence(claude, ["--permission-mode", "default"]) &&
  includesSequence(claude, ["--model", "opus"]) &&
  includesSequence(claude, ["--effort", "xhigh"]) &&
  includesSequence(claudeWithSettings, ["--permission-mode", "dontAsk"]) &&
  includesSequence(claudeWithSettings, [
    "--settings",
    "/tmp/sonata usage/claude-statusline-settings.json",
  ]) &&
  includesSequence(claudeWithSettings, ["--model", "fable"]) &&
  !claude.includes("service_tier") &&
  // Fast injection: the key is present and true, and the file still carries the
  // statusLine + hooks sinks (fastMode UNIONs, it does not replace them).
  fastSettings.fastMode === true &&
  Boolean(fastSettings.statusLine) &&
  Boolean(fastSettings.hooks) &&
  // Standard: no fastMode key at all — omitted, never written as `false`, so
  // repeat standard-speed spawns stay byte-stable.
  !("fastMode" in standardSettings) &&
  Boolean(standardSettings.statusLine) &&
  Boolean(standardSettings.hooks) &&
  // Emoji-autocomplete kill switch: UNCONDITIONAL, unlike fastMode. Claude
  // 2.1.217+ opens the popup on a bracketed paste ending in a colon token and
  // then swallows both submit encodings — the prompt is mutated and never sent
  // (measured 2.1.220, spikes/upstream-sync-2026-08/claude Q6). Every spawn
  // shape must carry it, so assert on BOTH settings files.
  fastSettings.emojiCompletionEnabled === false &&
  standardSettings.emojiCompletionEnabled === false &&
  // RC startup lever, OFF intent: the key is written, and written as `false` —
  // the only value it ever takes. `--remote-control` must be absent, or the file
  // would contradict the argv it ships with.
  rcOffSettings.remoteControlAtStartup === false &&
  !claudeWithSettings.includes("--remote-control") &&
  // …and it UNIONs, exactly like fastMode: the sinks are still there.
  Boolean(rcOffSettings.statusLine) &&
  Boolean(rcOffSettings.hooks) &&
  rcOffSettings.emojiCompletionEnabled === false &&
  // OFF is the DEFAULT for every existing call shape — a caller that states no RC
  // intent gets the honest default, not the server-side one.
  fastSettings.remoteControlAtStartup === false &&
  standardSettings.remoteControlAtStartup === false &&
  // RC startup lever, ON intent: the key is OMITTED — not `true` (unmeasured in
  // the enabling direction, and superfluous next to the flag) and emphatically
  // not `false` (that would be a file arguing with its own argv). The flag is the
  // ON channel, and it MUST stay last: `--remote-control [name]` takes an
  // optional positional, so any flag after it is swallowed as the name.
  !("remoteControlAtStartup" in rcOnSettings) &&
  Boolean(rcOnSettings.statusLine) &&
  Boolean(rcOnSettings.hooks) &&
  // D2 U3: `PostModelSwitch` is INJECTED — it is the mid-session model switch's
  // confirm, consumed by `RuntimeController.applyHookToTask` →
  // `TerminalHost.noteModelSwitchConfirmed`. Asserted on every spawn shape,
  // because a switch is available from any of them, and pointed at the SAME sink
  // command the other fire-and-forget events use (an entry pointing somewhere
  // else would write payloads no watcher reads).
  [fastSettings, standardSettings, rcOffSettings, rcOnSettings].every(
    (settings) =>
      Array.isArray(settings.hooks.PostModelSwitch) &&
      settings.hooks.PostModelSwitch.length === 1 &&
      // Session-scoped, so a BARE entry — no `matcher`, which is for tool-scoped
      // events only.
      !("matcher" in settings.hooks.PostModelSwitch[0]) &&
      settings.hooks.PostModelSwitch[0].hooks[0].command === settings.hooks.Stop[0].hooks[0].command &&
      // …and `PreModelSwitch` is NOT injected. Measured to fire on every switch
      // ATTEMPT including cancelled ones (h4 arms b1/b2), so it confirms nothing
      // on its own — and injecting an event is not free, since the CLI paints
      // `Running <Event> hooks…` on the co-visible Terminal while it runs them.
      !("PreModelSwitch" in settings.hooks),
  ) &&
  claudeRemoteControl.includes("--remote-control") &&
  claudeRemoteControl[claudeRemoteControl.length - 1] === "--remote-control" &&
  // Repeat spawns of either shape: same bytes, no rewrite.
  byteStable;

console.log(
  JSON.stringify(
    {
      codexFast,
      codexDefaultSpeed,
      codexWithProfile,
      claude,
      claudeWithSettings,
      claudeRemoteControl,
      fastSettingsKeys: Object.keys(fastSettings),
      standardSettingsKeys: Object.keys(standardSettings),
      rcOffSettingsKeys: Object.keys(rcOffSettings),
      rcOnSettingsKeys: Object.keys(rcOnSettings),
      rcOffRemoteControlAtStartup: rcOffSettings.remoteControlAtStartup,
      byteStable,
      success,
    },
    null,
    2,
  ),
);

process.exitCode = success ? 0 : 1;

function includesSequence(values, sequence) {
  return values.some((value, index) =>
    sequence.every((expected, offset) => values[index + offset] === expected),
  );
}
