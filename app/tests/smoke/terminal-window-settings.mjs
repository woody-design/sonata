// Layer-1 fence — the terminal window's persisted appearance settings.
//
// Guards two seams:
//  A. The scheme vocabulary: every advertised TermSchemeId round-trips the
//     normalizer, and the default is duet.
//  B. The pre-scheme MIGRATION: records persisted before the scheme axis
//     carried `theme` (a reading-theme id — by then a no-op axis). They must
//     silently land on the default scheme while PRESERVING open + mode, and
//     the legacy key must not survive into the normalized shape.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_TERMINAL_WINDOW_SETTINGS,
  TERM_SCHEME_IDS,
  isTermSchemeId,
  normalizeTerminalWindowSettings,
} = require("../../dist/shared/types/terminal-window-settings");

const failures = [];
function check(name, condition) {
  if (!condition) {
    failures.push(name);
  }
}

// A. Vocabulary round-trip.
check("default scheme is duet", DEFAULT_TERMINAL_WINDOW_SETTINGS.scheme === "duet");
for (const scheme of TERM_SCHEME_IDS) {
  const normalized = normalizeTerminalWindowSettings({ open: false, scheme, mode: "dark" });
  check(`scheme ${scheme} round-trips`, normalized.scheme === scheme);
  check(`scheme ${scheme} preserves open/mode`, !normalized.open && normalized.mode === "dark");
}
check("guard accepts every advertised id", TERM_SCHEME_IDS.every(isTermSchemeId));
check("guard rejects a reading-theme id", !isTermSchemeId("paper"));

// B. Pre-scheme record migration (theme was the no-op reading-theme axis).
for (const legacyTheme of ["duet", "paper", "calm", "focus"]) {
  const migrated = normalizeTerminalWindowSettings({
    open: false,
    theme: legacyTheme,
    mode: "light",
  });
  check(`legacy theme=${legacyTheme} lands on duet`, migrated.scheme === "duet");
  check(
    `legacy theme=${legacyTheme} preserves open/mode`,
    !migrated.open && migrated.mode === "light",
  );
  check(`legacy key does not survive (${legacyTheme})`, !("theme" in migrated));
}

// Garbage tolerance (the store may hold anything).
for (const garbage of [null, 7, "duet", [], { scheme: "dracula" }, { scheme: 3, mode: "loud" }]) {
  const normalized = normalizeTerminalWindowSettings(garbage);
  check(
    `garbage ${JSON.stringify(garbage)} → defaults`,
    normalized.scheme === DEFAULT_TERMINAL_WINDOW_SETTINGS.scheme &&
      normalized.mode === DEFAULT_TERMINAL_WINDOW_SETTINGS.mode &&
      normalized.open === DEFAULT_TERMINAL_WINDOW_SETTINGS.open,
  );
}

if (failures.length > 0) {
  console.error("terminal-window-settings smoke FAILED:");
  for (const failure of failures) {
    console.error(`  ✗ ${failure}`);
  }
  process.exitCode = 1;
} else {
  console.log("terminal-window-settings smoke passed");
}
