// Layer-1 fence — the terminal window's persisted appearance settings.
//
// Guards two seams:
//  A. The scheme vocabulary: every advertised TermSchemeId round-trips the
//     normalizer, and the default is `default`.
//  B. The pre-scheme MIGRATION: records persisted before the scheme axis
//     carried `theme` (a reading-theme id — by then a no-op axis). They must
//     silently land on the default scheme while PRESERVING open + mode, and
//     the legacy key must not survive into the normalized shape.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  DEFAULT_TERMINAL_WINDOW_SETTINGS,
  TERM_FONT_SIZES,
  TERM_SCHEME_IDS,
  isTermFontSize,
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
check("CLI defaults open", DEFAULT_TERMINAL_WINDOW_SETTINGS.open === true);
check("default scheme is default", DEFAULT_TERMINAL_WINDOW_SETTINGS.scheme === "default");
for (const scheme of TERM_SCHEME_IDS) {
  const normalized = normalizeTerminalWindowSettings({ open: false, scheme, mode: "dark" });
  check(`scheme ${scheme} round-trips`, normalized.scheme === scheme);
  check(`scheme ${scheme} preserves open/mode`, !normalized.open && normalized.mode === "dark");
}
check("guard accepts every advertised id", TERM_SCHEME_IDS.every(isTermSchemeId));
check("guard rejects a reading-theme id", !isTermSchemeId("paper"));

// Font-size ladder round-trip; default is the pre-M2 hardcoded 13.
check("default font size is 13", DEFAULT_TERMINAL_WINDOW_SETTINGS.fontSize === 13);
for (const fontSize of TERM_FONT_SIZES) {
  const normalized = normalizeTerminalWindowSettings({ open: true, scheme: "default", fontSize });
  check(`fontSize ${fontSize} round-trips`, normalized.fontSize === fontSize);
}
for (const bad of [10, 17, 13.5, "13", null]) {
  const normalized = normalizeTerminalWindowSettings({ open: true, fontSize: bad });
  check(`fontSize ${JSON.stringify(bad)} → default`, normalized.fontSize === 13);
}
check("size guard rejects a non-step", !isTermFontSize(20));

// Pre-M2 records carry no fontSize at all — they land on the default.
check(
  "record without fontSize lands on 13",
  normalizeTerminalWindowSettings({ open: true, scheme: "gruvbox", mode: "dark" }).fontSize === 13,
);

// B. Pre-scheme record migration (theme was the no-op reading-theme axis).
// Values span the pre-rename shipped id ("duet"), the never-shipped dev
// transient ("sonata"), the neutralized default, and the reading themes — the
// `theme` key is ignored wholesale, so every one falls through to the default.
for (const legacyTheme of ["duet", "sonata", "default", "paper", "calm", "focus"]) {
  const migrated = normalizeTerminalWindowSettings({
    open: false,
    theme: legacyTheme,
    mode: "light",
  });
  check(
    `legacy theme=${legacyTheme} lands on default`,
    migrated.scheme === DEFAULT_TERMINAL_WINDOW_SETTINGS.scheme,
  );
  check(
    `legacy theme=${legacyTheme} preserves open/mode`,
    !migrated.open && migrated.mode === "light",
  );
  check(`legacy key does not survive (${legacyTheme})`, !("theme" in migrated));
}

// C. Rename degradation — a persisted SCHEME naming the product (pre-rename
// "duet", or the never-shipped dev transient "sonata") is no longer part of the
// neutralized vocabulary and must degrade to the default scheme while
// preserving the rest of the record.
for (const staleScheme of ["duet", "sonata"]) {
  check(`guard rejects stale scheme ${staleScheme}`, !isTermSchemeId(staleScheme));
  const normalized = normalizeTerminalWindowSettings({
    open: true,
    scheme: staleScheme,
    mode: "dark",
  });
  check(
    `stale scheme=${staleScheme} → default`,
    normalized.scheme === DEFAULT_TERMINAL_WINDOW_SETTINGS.scheme,
  );
  check(
    `stale scheme=${staleScheme} preserves open/mode`,
    normalized.open && normalized.mode === "dark",
  );
}

// Garbage tolerance (the store may hold anything).
for (const garbage of [null, 7, "sonata", [], { scheme: "dracula" }, { scheme: 3, mode: "loud" }]) {
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
