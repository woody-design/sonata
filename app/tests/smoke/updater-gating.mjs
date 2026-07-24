import assert from "node:assert/strict";
import { createRequire } from "node:module";

// The gate is pure — require it directly (no Electron).
const require = createRequire(import.meta.url);
const { evaluateUpdaterGate } = require("../../dist/main/updater/updater-gate");

/** A packaged app sitting in /Applications with no env overrides — the default
 *  "real install" baseline; every row below perturbs one axis. */
const base = {
  isPackaged: true,
  disableEnv: false,
  allowUnpackaged: false,
  feedOverride: false,
  inApplicationsFolder: true,
};
const gate = (overrides) => evaluateUpdaterGate({ ...base, ...overrides });

// Truth table. Each row: [overrides, expected, why].
const rows = [
  [{}, "active", "packaged + in /Applications"],
  [{ inApplicationsFolder: false }, "disabled-location", "packaged but not in /Applications"],
  [{ inApplicationsFolder: null }, "active", "API unavailable is not a wrong-location signal"],
  [{ isPackaged: false }, "disabled-dev", "unpackaged dev build"],
  [
    { isPackaged: false, allowUnpackaged: true },
    "active",
    "unpackaged bypass + (defaulted) in /Applications",
  ],
  [
    { isPackaged: false, allowUnpackaged: true, inApplicationsFolder: false },
    "disabled-location",
    "unpackaged bypass still honors the location gate",
  ],
  [
    { isPackaged: false, allowUnpackaged: true, inApplicationsFolder: false, feedOverride: true },
    "active",
    "feed override relaxes location for the harness",
  ],
  [
    { inApplicationsFolder: false, feedOverride: true },
    "active",
    "feed override bypasses the /Applications requirement",
  ],
  [
    { isPackaged: false, feedOverride: true },
    "disabled-dev",
    "feed override does NOT relax the packaged requirement",
  ],
  [{ disableEnv: true }, "disabled-env", "kill switch on a real install"],
  [
    { disableEnv: true, isPackaged: false },
    "disabled-env",
    "kill switch wins over the dev gate",
  ],
  [
    { disableEnv: true, inApplicationsFolder: false },
    "disabled-env",
    "kill switch wins over the location gate",
  ],
];

for (const [overrides, expected, why] of rows) {
  assert.equal(gate(overrides), expected, `${why} → ${expected}`);
}

console.log(`updater-gating smoke: OK (${rows.length} rows)`);
