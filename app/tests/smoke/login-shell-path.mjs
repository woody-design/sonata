// Mine 2 smoke — login-shell PATH resolution + merge.
// A Finder-launched .app inherits launchd's minimal PATH; the host must merge
// the user's login-shell PATH so node/claude/codex/git resolve. This exercises
// the pure resolver (with an injected shell) and the merge, plus the three ways
// resolution declines: non-darwin, escape hatch, and timeout/error fallback.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const {
  resolveLoginShellPath,
  mergePath,
  loginShellPath,
  __resetLoginShellPathCache,
} = require(path.join(distRoot, "runtime/terminal-host/login-shell-path"));

const results = {};

// Marker-wrapped output the way `$SHELL -ilc 'printf ...'` emits it, plus MOTD
// noise on either side to prove the sentinel extraction survives banner spam.
function fakeShellOutput(pathValue) {
  return `Welcome to your shell!\n__SONATA_PATH_BEGIN__${pathValue}__SONATA_PATH_END__`;
}

// 1) darwin + healthy shell → parses PATH out from between the markers.
{
  const captured = {};
  const value = resolveLoginShellPath({
    platform: "darwin",
    shell: "/bin/zsh",
    disabled: false,
    exec: (shell, args, timeoutMs) => {
      captured.shell = shell;
      captured.args = args;
      captured.timeoutMs = timeoutMs;
      return fakeShellOutput("/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin");
    },
  });
  assert.equal(value, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", "extracts PATH between markers");
  assert.equal(captured.shell, "/bin/zsh", "runs the user's $SHELL");
  assert.deepEqual(captured.args.slice(0, 1), ["-ilc"], "interactive login shell (-ilc)");
  assert.equal(captured.timeoutMs, 2000, "~2s timeout");
  results.resolveHealthy = value;
}

// 2) non-darwin → never resolves (leave PATH untouched off macOS).
{
  let called = false;
  const value = resolveLoginShellPath({
    platform: "linux",
    shell: "/bin/bash",
    exec: () => {
      called = true;
      return fakeShellOutput("/should/not/happen");
    },
  });
  assert.equal(value, null, "non-darwin returns null");
  assert.equal(called, false, "non-darwin does not spawn a shell");
  results.nonDarwin = value;
}

// 3) escape hatch SONATA_DISABLE_LOGIN_SHELL_PATH → null, no shell spawn.
{
  let called = false;
  const value = resolveLoginShellPath({
    platform: "darwin",
    shell: "/bin/zsh",
    disabled: true,
    exec: () => {
      called = true;
      return fakeShellOutput("/should/not/happen");
    },
  });
  assert.equal(value, null, "escape hatch returns null");
  assert.equal(called, false, "escape hatch does not spawn a shell");
  results.escapeHatch = value;
}

// 4) timeout / shell error → null (fall back to inherited PATH, never worse).
{
  const value = resolveLoginShellPath({
    platform: "darwin",
    shell: "/bin/zsh",
    exec: () => {
      const err = new Error("ETIMEDOUT");
      throw err;
    },
  });
  assert.equal(value, null, "shell error/timeout returns null");
  results.timeoutFallback = value;
}

// 5) missing $SHELL → null.
{
  const value = resolveLoginShellPath({ platform: "darwin", shell: undefined, exec: () => "" });
  assert.equal(value, null, "no $SHELL returns null");
  results.noShell = value;
}

// 6) shell emitted no markers / empty PATH → null.
{
  assert.equal(
    resolveLoginShellPath({ platform: "darwin", shell: "/bin/zsh", exec: () => "garbage only" }),
    null,
    "no markers returns null",
  );
  assert.equal(
    resolveLoginShellPath({ platform: "darwin", shell: "/bin/zsh", exec: () => fakeShellOutput("") }),
    null,
    "empty PATH between markers returns null",
  );
  results.noMarkers = null;
}

// 7) mergePath — FALLBACK semantics: inherited PATH entries keep their order and
//    win; login-shell entries not already present are APPENDED; duplicates
//    collapse; a null login PATH leaves the current PATH intact.
{
  assert.equal(
    mergePath("/opt/homebrew/bin:/usr/bin", "/usr/bin:/bin:/usr/sbin:/sbin"),
    "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin",
    "inherited PATH kept in order; login-only entry (/opt/homebrew/bin) appended; no dupes",
  );
  assert.equal(mergePath(null, "/usr/bin:/bin"), "/usr/bin:/bin", "null login PATH → current unchanged");
  assert.equal(mergePath(null, undefined), undefined, "null login + no current → undefined");
  assert.equal(
    mergePath("/a:/b:/a:", "/b:/c"),
    "/b:/c:/a",
    "inherited (/b:/c) first; login-only (/a) appended; internal dupes/empty dropped",
  );
  results.merge = "ok";
}

// 7b) Regression guard (the field-found bug): a caller that DELIBERATELY
//     prepends a dir (e2e fake CLI, direnv/nvm shim) must keep it FIRST — the
//     login-shell PATH must never demote it below the real toolchain.
{
  const withFakeFirst = mergePath(
    "/opt/homebrew/bin:/usr/bin:/bin", // login shell (has the real codex/claude)
    "/tmp/fake-cli:/usr/bin:/bin", // caller prepended the fake
  );
  assert.equal(
    withFakeFirst,
    "/tmp/fake-cli:/usr/bin:/bin:/opt/homebrew/bin",
    "caller-prepended fake dir stays first; login toolchain only fills the gap",
  );
  assert.ok(
    withFakeFirst.indexOf("/tmp/fake-cli") < withFakeFirst.indexOf("/opt/homebrew/bin"),
    "fake CLI resolves before the real /opt/homebrew toolchain",
  );
  results.regressionGuard = withFakeFirst;
}

// 8) loginShellPath() caches the result across calls (including the null the
//    real environment may produce here — this test runs under plain node).
{
  __resetLoginShellPathCache();
  const first = loginShellPath();
  const second = loginShellPath();
  assert.equal(first, second, "cached value is stable across calls");
  results.cachedValue = first;
}

console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
