import assert from "node:assert/strict";
import { createRequire } from "node:module";

// Fixture table for the pure formatters (map step A1). Clocked functions get
// explicit nowMs — the default-param injection keeps app call sites unchanged
// while making these assertions deterministic.
const require = createRequire(import.meta.url);
const F = require("../../dist/reading-core/selectors/formatters");

const NOW = Date.parse("2026-07-03T12:00:00.000Z");
const agoMs = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

// 1) formatRelativeAge — every bucket, boundaries, and the preserved tail quirk.
{
  assert.equal(F.formatRelativeAge("not-a-date", NOW), "", "invalid → empty");
  assert.equal(F.formatRelativeAge(agoMs(30_000), NOW), "now", "<1m → now");
  assert.equal(F.formatRelativeAge(agoMs(59 * MIN), NOW), "59m", "59m");
  assert.equal(F.formatRelativeAge(agoMs(HOUR), NOW), "1h", "60m → 1h");
  assert.equal(F.formatRelativeAge(agoMs(23 * HOUR), NOW), "23h", "23h");
  assert.equal(F.formatRelativeAge(agoMs(DAY), NOW), "1d", "1d");
  assert.equal(F.formatRelativeAge(agoMs(6 * DAY), NOW), "6d", "6d");
  assert.equal(F.formatRelativeAge(agoMs(7 * DAY), NOW), "1w", "1w");
  assert.equal(F.formatRelativeAge(agoMs(34 * DAY), NOW), "4w", "34d → 4w");
  assert.equal(F.formatRelativeAge(agoMs(35 * DAY), NOW), "1mo", "35d → 1mo");
  assert.equal(F.formatRelativeAge(agoMs(359 * DAY), NOW), "11mo", "359d → 11mo");
  // Preserved quirk: 360–364d yields months=12 → falls through to years,
  // and floor(364/365)=0 → "0y". Pinned, not endorsed.
  assert.equal(F.formatRelativeAge(agoMs(364 * DAY), NOW), "0y", "364d → 0y (pinned quirk)");
  assert.equal(F.formatRelativeAge(agoMs(400 * DAY), NOW), "1y", "400d → 1y");
  // A future timestamp clamps to "now" (deltaMs floored at 0).
  assert.equal(F.formatRelativeAge(new Date(NOW + HOUR).toISOString(), NOW), "now", "future → now");
}

// 1c) Transcript timestamps are exact, fixed facts (not relative ages). Locale
// and time zone are injected so the visible separator/date/time contract pins
// independently of the machine running the fixture.
{
  assert.equal(F.formatTranscriptTimestamp("not-a-date", "en-US", "UTC"), null, "invalid → no time");
  assert.deepEqual(
    F.formatTranscriptTimestamp("2026-07-14T11:08:00.000Z", "en-US", "UTC"),
    {
      display: "Jul 14, 2026 · 11:08 AM",
      dateTime: "2026-07-14T11:08:00.000Z",
    },
    "English transcript time contains an exact date and minute",
  );
  assert.deepEqual(
    F.formatTranscriptTimestamp("2026-07-14T03:08:00.000Z", "en-GB", "Asia/Tokyo"),
    {
      display: "14 Jul 2026 · 12:08",
      dateTime: "2026-07-14T03:08:00.000Z",
    },
    "locale controls date order/hour cycle while the machine value stays canonical",
  );
}

// 2) formatIdleDuration.
{
  assert.equal(F.formatIdleDuration(5 * MIN), "5m", "5m");
  assert.equal(F.formatIdleDuration(59 * MIN), "59m", "59m");
  assert.equal(F.formatIdleDuration(90 * MIN), "1h 30m", "1h 30m");
  assert.equal(F.formatIdleDuration(2 * HOUR), "2h", "whole hours drop the rest");
  assert.equal(F.formatIdleDuration(47 * HOUR), "47h", "47h still hours");
  assert.equal(F.formatIdleDuration(48 * HOUR), "2d", "48h → 2d");
}

// 3) Token counts.
{
  assert.equal(F.formatTokenCount(999), "999", "sub-1k raw");
  assert.equal(F.formatTokenCount(1000), "1.0k", "1.0k keeps decimal");
  assert.equal(F.formatTokenCount(129_400), "129.4k", "129.4k");
  assert.equal(F.compactTokenCount(999), "999", "compact raw");
  assert.equal(F.compactTokenCount(1000), "1k", "compact 1k");
  assert.equal(F.compactTokenCount(1500), "2k", "compact rounds k");
  assert.equal(F.compactTokenCount(1_000_000), "1m", "1.0m trims to 1m");
  assert.equal(F.compactTokenCount(1_500_000), "1.5m", "1.5m keeps decimal");
  assert.equal(F.compactTokenCount(12_000_000), "12m", ">=10m rounds whole");
  assert.equal(F.trimTrailingZero("1.0"), "1", "trims .0");
  assert.equal(F.trimTrailingZero("1.5"), "1.5", "keeps .5");
}

// 4) formatUsagePercent — clamping and decimal display.
{
  assert.equal(F.formatUsagePercent(42), "42%", "integer");
  assert.equal(F.formatUsagePercent(42.55), "42.6%", "one decimal");
  assert.equal(F.formatUsagePercent(42.04), "42%", "x.0 collapses to integer display");
  assert.equal(F.formatUsagePercent(-5), "0%", "clamps low");
  assert.equal(F.formatUsagePercent(150), "100%", "clamps high");
}

// 5) formatRelativeUsageTime — |delta| formatting (future resets included).
{
  assert.equal(F.formatRelativeUsageTime(NOW - 30_000, NOW), "now", "<45s → now");
  assert.equal(F.formatRelativeUsageTime(NOW - 5 * MIN, NOW), "5m", "5m");
  assert.equal(F.formatRelativeUsageTime(NOW + 5 * MIN, NOW), "5m", "future symmetric");
  assert.equal(F.formatRelativeUsageTime(NOW - (HOUR + 5 * MIN), NOW), "1h 5m", "1h 5m");
  assert.equal(F.formatRelativeUsageTime(NOW - 2 * HOUR, NOW), "2h", "whole hours");
  assert.equal(F.formatRelativeUsageTime(NOW - 30 * HOUR, NOW), "1d", "30h → 1d (rounded)");
}

// 6) usageLimitDisplayLabel.
{
  assert.equal(F.usageLimitDisplayLabel("5h"), "5-hour limit");
  assert.equal(F.usageLimitDisplayLabel("daily"), "Daily");
  assert.equal(F.usageLimitDisplayLabel("weekly"), "Weekly");
  assert.equal(F.usageLimitDisplayLabel("monthly"), "Monthly");
  assert.equal(F.usageLimitDisplayLabel("session"), "session limit", "unknown → suffixed");
}

// 7) formatLiveElapsed — the "Xm Ys" live-clock shape.
{
  assert.equal(F.formatLiveElapsed(null, NOW), "", "null → empty");
  assert.equal(F.formatLiveElapsed("garbage", NOW), "", "unparseable → empty");
  assert.equal(F.formatLiveElapsed(agoMs(42_000), NOW), "42s", "seconds only");
  assert.equal(F.formatLiveElapsed(agoMs(4 * MIN + 44_000), NOW), "4m 44s", "minutes + seconds");
  assert.equal(F.formatLiveElapsed(new Date(NOW + MIN).toISOString(), NOW), "0s", "future clamps to 0s");
}

// 8) String utilities.
{
  assert.equal(F.condensedPromptText("  a\n\n  b\tc  "), "a b c", "whitespace collapses");
  assert.equal(F.condensedPromptText("   "), "(empty prompt)", "blank → placeholder");
  assert.equal(F.fileExtension("report.PDF"), ".pdf", "lowercased extension");
  assert.equal(F.fileExtension("Makefile"), "", "no dot → empty");
  assert.equal(F.folderName("/Users/w/Work/duet-dev"), "duet-dev", "posix tail");
  assert.equal(F.folderName("C:\\Work\\duet-dev\\"), "duet-dev", "windows tail + trailing sep");
  assert.equal(F.clamp(5, 0, 10), 5, "clamp inside");
  assert.equal(F.clamp(-1, 0, 10), 0, "clamp low");
  assert.equal(F.clamp(11, 0, 10), 10, "clamp high");
}

// 9) errorMessage — IPC prefix stripping.
{
  assert.equal(
    F.errorMessage(new Error("Error invoking remote method 'task:create': Error: boom")),
    "boom",
    "strips ipc + Error: prefix",
  );
  assert.equal(
    F.errorMessage(new Error("Error invoking remote method 'task:create': boom")),
    "boom",
    "strips ipc prefix without Error:",
  );
  assert.equal(F.errorMessage(new Error("plain failure")), "plain failure", "plain error untouched");
  assert.equal(F.errorMessage(42), "42", "non-Error stringified");
}

// 10) Label lookup tables.
{
  assert.equal(F.providerLabel("claude"), "Claude");
  assert.equal(F.providerLabel("codex"), "Codex");
  assert.equal(F.readingThemeLabel("paper"), "Paper");
  assert.equal(F.readingThemeLabel("calm"), "Calm");
  assert.equal(F.readingThemeLabel("focus"), "Focus");
  assert.equal(F.readingThemeLabel("duet"), "Duet", "default theme label");
  assert.equal(F.readingModeLabel("light"), "Light");
  assert.equal(F.readingModeLabel("dark"), "Dark");
  assert.equal(F.readingModeLabel("auto"), "Auto");
  assert.equal(F.permissionModeLabel("acceptEdits"), "Accept edits");
  assert.equal(F.permissionModeLabel("auto"), "Auto");
  assert.equal(F.permissionModeLabel("default"), "Manual");
  assert.equal(F.resumePolicyLabel("summary"), "Resume from summary");
  assert.equal(F.resumePolicyLabel("full"), "Resume full session");
  assert.equal(F.resumePolicyLabel("ask"), "Ask each time");
}

// 11) Approval titles + kind labels (all kinds + fallbacks).
{
  const titles = {
    "workspace-trust": "Workspace trust requested",
    "file-edit": "File edit approval requested",
    "file-read": "File read approval requested",
    command: "Command approval requested",
    "dangerous-bypass": "Bypass Permissions mode — confirm",
  };
  for (const [kind, title] of Object.entries(titles)) {
    assert.equal(F.approvalTitle(kind), title, `title: ${kind}`);
  }
  assert.equal(F.approvalTitle(null), "Native approval requested", "title fallback");
  const kinds = {
    "workspace-trust": "Workspace trust",
    "file-edit": "File edit",
    "file-read": "File read",
    command: "Command",
    "dangerous-bypass": "Bypass mode",
  };
  for (const [kind, label] of Object.entries(kinds)) {
    assert.equal(F.approvalKindLabel(kind), label, `kind label: ${kind}`);
  }
  assert.equal(F.approvalKindLabel(undefined), "Native", "kind fallback");
}

// 12) settingsDateLabel — invalid passes through; valid is locale-dependent,
// so assert shape, not exact text.
{
  assert.equal(F.settingsDateLabel("not-a-date"), "not-a-date", "invalid → input");
  const label = F.settingsDateLabel("2026-07-03T10:00:00.000Z");
  assert.ok(label.includes("2026"), "valid date carries the year");
}

console.log("reading-core formatters: all fixture tables hold");
