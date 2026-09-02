import fs from "node:fs";
import path from "node:path";
import {
  claudeStatuslineCommand,
  claudeUsageDirectory,
  shellQuote,
  writeJsonIfChanged,
} from "../usage/claude-statusline";
import { approvalsDirectory } from "./approval-protocol";
import { asarUnpackedPath } from "../asar-unpacked";
import { SONATA_INTERPRETER_PREFIX } from "../interpreter";
import type { HookEventName } from "../../shared/types/cli-signal";

/**
 * The single `--settings` file sonata injects into every Claude spawn. It carries
 * BOTH the statusLine sink (usage) AND the hooks sink (signal layer). Phase 0
 * proved hooks UNION across all settings sources, so injecting our hooks here
 * does NOT clobber the user's own `~/.claude/settings.json` or project hooks —
 * we deliberately write ONLY sonata's entries and let Claude merge.
 */

/** Where the hook sink drops payload files; watched by HookWatcher. */
export function claudeHooksDirectory(runtimeDir: string): string {
  return path.join(runtimeDir, "hooks");
}

// Broker (S2): how long it HOLDS the CLI waiting for Sonata's card answer before
// giving up to the native panel. The hook's own timeout must exceed it so the
// CLI doesn't kill the broker mid-poll (which would look like a crash, not a
// graceful fallback).
//
// 580s/600s (drawer S0, 2026-07-17): the CLI's native permission prompt has no
// timeout of its own (upstream declined one, #37913), so the ONLY thing that
// forced answers back into the terminal was our own hold expiring. 600 is the
// documented per-hook `timeout` default/ceiling-of-record (seconds); the broker
// holds 20s less so it always expires gracefully (writes its marker) before the
// CLI would kill it. Values >600 are undocumented — deliberately not used.
const APPROVAL_BROKER_TIMEOUT_MS = 580_000;
const APPROVAL_HOOK_TIMEOUT_S = 600;

/**
 * Fire-and-forget hook events sonata injects (the sink). UserPromptSubmit/
 * PreToolUse drive busy, Stop drives turn-end, PostModelSwitch confirms a
 * mid-session model switch. The rest corroborate.
 * `PermissionRequest` is DELIBERATELY absent — it is owned by the approval
 * BROKER (S2), which holds the CLI and answers from the Reading card; a second
 * fire-and-forget sink on it would double-write the payload.
 *
 * Every entry names its CONSUMER (SL-9's rule): an injected event with no reader
 * is a line item nobody can retire, and this list is what the CLI executes on the
 * user's machine on every turn.
 */
const INJECTED_HOOK_EVENTS: HookEventName[] = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Notification",
  "Stop",
  // Fires when a turn ends by FAILING (API error after retries) — Stop stays
  // silent then; payload carries a structured `error` (probed S6,
  // s6-diags/stopfailure-probe). Completes the run + ends cli-state busy.
  "StopFailure",
  "SubagentStop",
  // The mid-session MODEL switch confirm (D2 U3). CONSUMER:
  // `RuntimeController.applyHookToTask` → `TerminalHost.noteModelSwitchConfirmed`
  // → `ControlSwitchEngine.noteModelSwitchConfirmed`, which SETTLES the pending
  // model switch when the payload's `requested_model` equals the alias Sonata
  // typed. It replaces the `Set model to …` pty scrape, whose needle could not be
  // anchored on the pending value and settled switches it did not belong to
  // (F19/F82–F90; probe `h4-model-switch-hooks`).
  //
  // `PreModelSwitch` is DELIBERATELY NOT INJECTED, and the reason is measured
  // rather than economical: it fires on every switch ATTEMPT, including the ones
  // the user then cancels (h4 arms b1/b2 — one `Pre`, no `Post`, `Kept model as`),
  // so on its own it confirms nothing. Injecting an event is not free either — the
  // CLI paints `Running <Event> hooks…` on the co-visible Terminal while it runs
  // them — so the list carries the event that decides something and not its
  // bracket-mate.
  "PostModelSwitch",
];

/** Events scoped by a tool/notification matcher; the rest take a bare entry. */
const MATCHER_EVENTS = new Set<HookEventName>(["PreToolUse", "PostToolUse", "Notification"]);

interface ClaudeHookCommandEntry {
  type: "command";
  command: string;
  timeout?: number;
}

interface ClaudeHookMatcherGroup {
  matcher?: string;
  hooks: ClaudeHookCommandEntry[];
}

interface ClaudeRuntimeSettings {
  statusLine: { type: "command"; command: string };
  hooks: Record<string, ClaudeHookMatcherGroup[]>;
  /** Emoji-autocomplete kill switch (Claude 2.1.217+ surface). ALWAYS written —
   *  a standing suppression of an upstream composer affordance that is pure
   *  interference in a Sonata-driven composer, not a per-launch option.
   *  Measured (claude 2.1.220 — spikes/upstream-sync-2026-08/claude, Q6): the
   *  popup is NOT keystroke-gated — a BRACKETED PASTE whose last token is a
   *  colon token (`…:hea`) opens it too, which is exactly Sonata's delivery
   *  path. While it is open BOTH submit encodings are swallowed — CSI-u Enter
   *  (`\x1b[13u`, the paste-path submit) and raw `\r` — so the prompt is
   *  mutated with an emoji and never sent, stalling delivery until the receipt
   *  timeout. `false` suppresses the popup for typed AND pasted input
   *  (verified live). This is a correctness fix, not polish. */
  emojiCompletionEnabled: false;
  /** Native launch-time fast mode (Claude 2.1.205+). Written ONLY when the
   *  task's speedMode is `fast` (Opus-gated in the launch UI) — a standard-speed
   *  spawn carries no `fastMode` key at all, so same-shape spawns stay
   *  byte-identical to each other and `writeJsonIfChanged` never churns. Fast
   *  mode UNIONs from `--settings` like the hooks do; there is no CLI flag. */
  fastMode?: true;
  /**
   * STARTUP-ONLY Remote Control policy (Claude 2.1.25x). Written ONLY as
   * `false`, and only when the task's RC intent is OFF.
   *
   * WHY IT HAS TO BE WRITTEN AT ALL (upstream sync 2026-09, SL-11 F4e/F4i).
   * `defaultRemoteControl: false` used to mean nothing more than "do not pass
   * `--remote-control`", and MEASURED at 2.1.258 that is not what decides it:
   * six of six production boots with no flag anywhere auto-started RC and went
   * phone-reachable while Sonata's own setting said OFF. Claude's resolver reads
   *
   *     project/local `false` → policy | FLAG | user settings → legacy global
   *       → default: remote env / persistent remote session / org policy
   *         / GrowthBook `tengu_cobalt_harbor`
   *
   * and on this account that last term is server-side, cached in `~/.claude.json`,
   * refreshed asynchronously — it flipped twice during SL-11 with no local action,
   * i.e. it flaps on a timescale of MINUTES. Not passing a flag is therefore not a
   * decision; it merely declines to override a default that may already be ON.
   * `--settings` IS the `flagSettings` source (the one scope the resolver accepts
   * in both directions, unlike project/local which may only disable), so this one
   * key is what makes the setting say the truth. MEASURED (rc7, N=2, three legs,
   * `tengu_cobalt_harbor` true throughout): with the key absent RC auto-started
   * 2/2, with `false` it did not, 2/2 — no `connecting…`, no pill, no link, in a
   * 45s window sitting between two legs that auto-started minutes either side.
   *
   * WHY THE ON PATH OMITS IT rather than writing `true`. Three reasons, in order
   * of weight:
   *   1. The ON intent already has claude's own channel — the `--remote-control`
   *      flag — and it is measured to connect at +0ms (rc4 leg 3, rc5 6/6). This
   *      key exists for the direction that has NO flag.
   *   2. `false` must never ride alongside `--remote-control`. rc4 leg 3 measured
   *      the flag winning over the key, but "measured winning" is a fact about one
   *      binary at one version, not a licence to emit a file that contradicts the
   *      argv it ships with.
   *   3. `true` is UNMEASURED in the enabling direction and always will be
   *      superfluous: rc4's leg 2 tried it and landed inside one of the
   *      non-auto-starting windows, so it cannot separate "the source is not
   *      accepted for enabling" from "nothing was auto-starting then" (F4i states
   *      exactly this). Shipping an unmeasured assertion to buy behaviour the flag
   *      already buys is cost without benefit. Absence is not a lie — it says
   *      "Sonata states no startup policy here", and the argv states the policy.
   *
   * STARTUP-ONLY IS THE RED LINE. The key names a boot-time default; it is not a
   * capability switch (that one is `disableRemoteControl`, a MANAGED-settings key
   * a `--settings` file cannot reach — F4e). A mid-session `/remote-control`
   * stays fully available under an OFF-intent spawn: MEASURED live through the
   * production `injectRemoteControl` under this exact file (rc8 arm A), the
   * injection connects and the session link lands on the grid. An honest default,
   * never a weakened capability.
   *
   * WHAT THIS DELIBERATELY OUTRANKS, read off the resolver order above. Managed
   * `policySettings` are consulted BEFORE `flagSettings`, so an org that mandates
   * startup RC still wins — this key cannot be used to escape policy. A USER-scope
   * `remoteControlAtStartup: true` (the scope claude's own `/config` steers people
   * to) does NOT win, and that is the intended semantics rather than an oversight:
   * inside a Sonata session, Sonata's own `defaultRemoteControl` toggle is the
   * SSOT for what the user asked for, in both directions.
   *
   * Same conditional-inclusion discipline as `fastMode`, inverted: the key is
   * present exactly when it carries information, so each spawn SHAPE has one
   * stable byte image and `writeJsonIfChanged` never churns across repeats.
   */
  remoteControlAtStartup?: false;
}

function buildHooks(
  sinkCommand: string,
  brokerCommand: string | null,
): Record<string, ClaudeHookMatcherGroup[]> {
  const hooks: Record<string, ClaudeHookMatcherGroup[]> = {};
  for (const event of INJECTED_HOOK_EVENTS) {
    const entry: ClaudeHookCommandEntry = { type: "command", command: sinkCommand };
    hooks[event] = MATCHER_EVENTS.has(event)
      ? [{ matcher: "*", hooks: [entry] }]
      : [{ hooks: [entry] }];
  }
  hooks.PermissionRequest = brokerCommand
    ? // The broker holds the CLI until Sonata's card answers (or times out to the
      // native panel). Its hook timeout exceeds the broker's internal poll
      // ceiling so the CLI never kills it mid-decision.
      [{ matcher: "*", hooks: [{ type: "command", command: brokerCommand, timeout: APPROVAL_HOOK_TIMEOUT_S }] }]
    : // Native-approval mode (broker off): fall back to the fire-and-forget sink
      // (drives waiting-approval) + the scrape/keys answer path, as pre-S2.
      [{ matcher: "*", hooks: [{ type: "command", command: sinkCommand }] }];
  return hooks;
}

/** Where the broker drops ask/reply/expired files; watched by ApprovalWatcher.
 *  Delegates to the neutral `approvalsDirectory` — the layout is a shared
 *  protocol constant, not a Claude-owned one. */
export function claudeApprovalsDirectory(runtimeDir: string): string {
  return approvalsDirectory(runtimeDir);
}

/**
 * Ensure (and return the path to) sonata's merged Claude `--settings` file: the
 * statusLine sink + hook sink, both pointed at subdirs of `runtimeDir`.
 *
 * `runtimeDir` is the session's Sonata-owned runtime home — `~/.sonata/data/runtime/
 * <taskId>` in the app (D8), so nothing Sonata-owned is written into the agent's
 * working directory. All three paths the file carries are absolute; G1 verified
 * Claude fires hooks from a `--settings` file located outside the agent cwd.
 */
export function ensureClaudeRuntimeSettings(
  runtimeDir: string,
  options: {
    approvalBroker?: boolean;
    fastMode?: boolean;
    /** The task's Remote Control INTENT — the same value that decides whether the
     *  spawn carries `--remote-control`, threaded here so the file and the argv
     *  cannot disagree. The projection onto the CLI's own key (write `false` when
     *  OFF, omit when ON) lives on `remoteControlAtStartup` with its measured
     *  basis; the caller states intent, this writer owns the translation.
     *  Absent/false = OFF, matching `claudeArgs`' reading of the same field. */
    remoteControl?: boolean | undefined;
  } = {},
): string {
  const usageDirectory = claudeUsageDirectory(runtimeDir);
  const hooksDirectory = claudeHooksDirectory(runtimeDir);
  const approvalsDirectory = claudeApprovalsDirectory(runtimeDir);
  fs.mkdirSync(usageDirectory, { recursive: true });
  fs.mkdirSync(hooksDirectory, { recursive: true });
  fs.mkdirSync(approvalsDirectory, { recursive: true });

  // SONATA_INTERPRETER_PREFIX binds the shim to Sonata's own Electron-as-node
  // (`ELECTRON_RUN_AS_NODE=1 "${SONATA_NODE:-node}"`) instead of an undeclared host
  // `node` — see that constant for the full rationale.
  // asarUnpackedPath: in a packaged app __dirname names the packed app.asar path,
  // but this command is run by the CLI's EXTERNAL interpreter process, which can
  // only read the unpacked-to-disk copy. No-op in dev / source-tree.
  const sinkCommand = `${SONATA_INTERPRETER_PREFIX} ${shellQuote(
    asarUnpackedPath(path.join(__dirname, "hook-sink.js")),
  )} ${shellQuote(hooksDirectory)}`;
  // Broker on by default; native-approval mode (opt-out) routes PermissionRequest
  // back to the scrape/keys fallback.
  const brokerCommand =
    options.approvalBroker === false
      ? null
      : `${SONATA_INTERPRETER_PREFIX} ${shellQuote(
          asarUnpackedPath(path.join(__dirname, "approval-broker.js")),
        )} ${shellQuote(approvalsDirectory)} ${APPROVAL_BROKER_TIMEOUT_MS}`;

  const settings: ClaudeRuntimeSettings = {
    statusLine: { type: "command", command: claudeStatuslineCommand(usageDirectory) },
    hooks: buildHooks(sinkCommand, brokerCommand),
    // Unconditional: the emoji popup swallows Sonata's submit on any prompt that
    // ends in a colon token, whatever the task's options are.
    emojiCompletionEnabled: false,
    // Only present when fast: a standard-speed spawn omits the key entirely, so
    // repeat spawns of the same shape are byte-stable via writeJsonIfChanged.
    ...(options.fastMode ? { fastMode: true as const } : {}),
    // The mirror image of fastMode's rule, because the informative direction is
    // the other one: an OFF-intent spawn STATES the suppression (nothing else
    // does — the default this overrides is server-side and flaps), an ON-intent
    // spawn says nothing and lets `--remote-control` speak. Full rationale and
    // the measured legs: `remoteControlAtStartup` above.
    ...(options.remoteControl ? {} : { remoteControlAtStartup: false as const }),
  };

  const settingsPath = path.join(runtimeDir, "claude-runtime-settings.json");
  writeJsonIfChanged(settingsPath, settings);
  return settingsPath;
}
