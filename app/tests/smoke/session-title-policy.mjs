import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const T = require("../../dist/shared/session-title");

// Creation uses the local calendar date, not the UTC substring.
{
  const instant = "2026-07-14T03:30:00.000Z";
  assert.equal(T.formatSessionStartPrefix(instant, "America/New_York"), "0713-");
  assert.equal(T.formatSessionStartPrefix(instant, "Asia/Tokyo"), "0714-");
  assert.equal(
    T.formatSessionStartPrefix("2026-01-05T12:00:00.000Z", "UTC"),
    "0105-",
    "month/day are zero-padded",
  );
  assert.throws(() => T.formatSessionStartPrefix("not-a-date", "UTC"), RangeError);
}

// Explicit titles are outer-trimmed once; whitespace-only is automatic.
{
  assert.deepEqual(
    T.initialSessionTitle("  Custom  ", "2026-07-14T12:00:00.000Z", "UTC"),
    { title: "Custom", titleOrigin: "user" },
  );
  assert.deepEqual(
    T.initialSessionTitle(" \n ", "2026-07-14T12:00:00.000Z", "UTC"),
    { title: "0714-New task", titleOrigin: "automatic" },
  );
}

// Composition is exact-prefix idempotent and rejects empty candidates.
{
  assert.equal(T.composeAutomaticSessionTitle("0714-", "Research"), "0714-Research");
  assert.equal(T.composeAutomaticSessionTitle("0714-", "  0714-Research  "), "0714-Research");
  assert.equal(T.composeAutomaticSessionTitle("0714-", "0715-Research"), "0714-0715-Research");
  assert.equal(T.composeAutomaticSessionTitle("0714-", "  "), null);
}

// New automatic titles preserve their creation prefix across later clocks.
{
  const first = T.adoptAutomaticSessionTitle(
    { title: "0714-New task", titleOrigin: "automatic" },
    "First prompt",
    "first-prompt",
  );
  assert.deepEqual(first, { title: "0714-First prompt", titleOrigin: "automatic" });
  assert.deepEqual(
    T.adoptAutomaticSessionTitle(first, "Provider title", "provider"),
    { title: "0714-Provider title", titleOrigin: "automatic" },
  );
  assert.equal(T.adoptAutomaticSessionTitle(first, "0714-First prompt", "first-prompt"), null);
  assert.equal(
    T.adoptAutomaticSessionTitle(
      { title: "0714-Provider native", titleOrigin: "automatic" },
      "Second prompt",
      "first-prompt",
    ),
    null,
    "a later prompt never downgrades a provider-native title",
  );
}

// User ownership is terminal for automation—even for automatic-looking text.
{
  assert.equal(
    T.adoptAutomaticSessionTitle(
      { title: "0714-New task", titleOrigin: "user" },
      "Provider title",
      "provider",
    ),
    null,
  );
  assert.equal(
    T.adoptAutomaticSessionTitle(
      { title: "Renamed", titleOrigin: "user" },
      "Provider title",
      "provider",
    ),
    null,
  );
}

// Legacy tasks remain undated and retain absent ownership. The process-local
// compatibility seam allows same-runtime provider refinement only.
{
  const first = T.adoptAutomaticSessionTitle(
    { title: "New Task" },
    "Legacy first prompt",
    "first-prompt",
  );
  assert.deepEqual(first, { title: "Legacy first prompt" });
  assert.deepEqual(
    T.adoptAutomaticSessionTitle(
      first,
      "Legacy provider title",
      "provider",
      "Legacy first prompt",
    ),
    { title: "Legacy provider title" },
  );
  assert.equal(
    T.adoptAutomaticSessionTitle(first, "Second prompt", "first-prompt", "Legacy first prompt"),
    null,
    "legacy second prompt preserves the first automatic title",
  );
  assert.equal(T.adoptAutomaticSessionTitle(first, "After restart", "provider", null), null);
  assert.equal(
    T.adoptAutomaticSessionTitle({ title: "Legacy custom" }, "Provider title", "provider"),
    null,
  );
}

// Inconsistent/unknown manifest metadata fails closed.
{
  assert.equal(
    T.adoptAutomaticSessionTitle(
      { title: "Quarterly plan", titleOrigin: "automatic" },
      "Provider overwrite",
      "provider",
    ),
    null,
  );
  assert.equal(
    T.adoptAutomaticSessionTitle(
      { title: "9999-New task", titleOrigin: "automatic" },
      "Provider overwrite",
      "provider",
    ),
    null,
  );
  assert.equal(
    T.adoptAutomaticSessionTitle(
      { title: "0230-New task", titleOrigin: "automatic" },
      "Provider overwrite",
      "provider",
    ),
    null,
  );
}

// Notification suppression is ownership-aware.
{
  assert.equal(T.isAutomaticSessionPlaceholder("0714-New task", "automatic"), true);
  assert.equal(T.isAutomaticSessionPlaceholder("0714-New task", "user"), false);
  assert.equal(T.isAutomaticSessionPlaceholder("New Task"), true);
  assert.equal(T.isAutomaticSessionPlaceholder("0714-Research", "automatic"), false);
  assert.equal(
    T.isAutomaticSessionPlaceholder("New Task", "unknown-runtime-value"),
    false,
    "unknown persisted ownership fails closed at the notification boundary",
  );
}

console.log("session-title-policy: creation, ownership, compatibility, and suppression pass");
