// Codex CLI auto-update S1 — the check, and its refusal to ever throw.
//
// A check ALWAYS produces a fact. Codex absent, registry unreachable, shell
// hostile, output in a shape we do not recognize — every one of them yields a
// clean `ok: false` record, which is why nothing downstream has a catch block.
//
// Both effects are injected here, so this file makes no network request and
// spawns no process; the real ones are exercised by the recorded MEASURED
// fixtures below, captured from this machine on 2026-08-05.

import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const distRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../dist");
const { checkCodex, parseDistTagsLatest, CODEX_DIST_TAGS_URL, CHECK_TIMEOUT_MS } = require(
  path.join(distRoot, "main/cli-updater/checker"),
);

const results = {};

// MEASURED — `curl -sS https://registry.npmjs.org/-/package/@openai/codex/dist-tags`
// on this machine, 2026-08-05, verbatim. Note what the document contains besides
// `latest`: seven platform-suffixed tags and seven prerelease channels, none of
// which is a version anything should ever be updated to. That is exactly why the
// parse reads `latest` alone and requires a bare x.y.z.
const MEASURED_DIST_TAGS =
  '{"beta":"0.1.2505172116","native":"0.1.2505291658","linux-x64":"0.146.0-linux-x64",' +
  '"linux-arm64":"0.146.0-linux-arm64","darwin-x64":"0.146.0-darwin-x64",' +
  '"darwin-arm64":"0.146.0-darwin-arm64","win32-x64":"0.146.0-win32-x64",' +
  '"win32-arm64":"0.146.0-win32-arm64","latest":"0.146.0",' +
  '"alpha-linux-x64":"0.147.0-alpha.10-linux-x64","alpha":"0.147.0-alpha.10",' +
  '"alpha-darwin-arm64":"0.147.0-alpha.10-darwin-arm64",' +
  '"alpha-linux-arm64":"0.147.0-alpha.10-linux-arm64",' +
  '"alpha-darwin-x64":"0.147.0-alpha.10-darwin-x64",' +
  '"alpha-win32-arm64":"0.147.0-alpha.10-win32-arm64",' +
  '"alpha-win32-x64":"0.147.0-alpha.10-win32-x64"}';

// MEASURED — `codex --version` on this machine, 2026-08-05 (brew cask, 0.146.0).
const MEASURED_VERSION_OUTPUT = "codex-cli 0.146.0\n";

// 1) The real payload shapes, parsed.
{
  assert.equal(parseDistTagsLatest(MEASURED_DIST_TAGS), "0.146.0", "MEASURED dist-tags → latest");
  // COMPOSED — payloads that must yield nothing rather than a plausible guess.
  assert.equal(parseDistTagsLatest('{"alpha":"0.147.0-alpha.10"}'), null, "no latest tag → null");
  assert.equal(parseDistTagsLatest('{"latest":"0.147.0-alpha.10"}'), null, "prerelease latest → null");
  assert.equal(parseDistTagsLatest('{"latest":42}'), null, "non-string latest → null");
  assert.equal(parseDistTagsLatest("not json"), null, "unparseable body → null");
  assert.equal(parseDistTagsLatest("[]"), null, "array payload → null");
  assert.equal(parseDistTagsLatest("null"), null, "null payload → null");
  results.distTagsParse = parseDistTagsLatest(MEASURED_DIST_TAGS);
}

// 2) The happy path, on both measured payloads.
{
  const fact = await checkCodex({
    execVersion: async () => MEASURED_VERSION_OUTPUT,
    fetchDistTags: async () => MEASURED_DIST_TAGS,
    now: () => new Date("2026-08-05T12:00:00.000Z"),
  });
  assert.deepEqual(
    fact,
    { at: "2026-08-05T12:00:00.000Z", ok: true, installed: "0.146.0", latest: "0.146.0" },
    "a comparable pair, timestamped",
  );
  results.happyPath = fact;
}

// 3) Codex not installed. A clean no-op fact — and NO registry request, because
//    a machine that only runs Claude Code should not be querying npm on
//    Sonata's behalf every twelve hours.
{
  let fetched = false;
  const fact = await checkCodex({
    execVersion: async () => {
      const error = new Error("spawn codex ENOENT");
      error.code = "ENOENT";
      throw error;
    },
    fetchDistTags: async () => {
      fetched = true;
      return MEASURED_DIST_TAGS;
    },
  });
  assert.equal(fact.ok, false, "not comparable");
  assert.equal(fact.installed, null, "no installed version");
  assert.equal(fact.latest, null, "no latest version");
  assert.ok(fact.at, "still a timestamped fact, never a throw");
  assert.equal(fetched, false, "and no request was made");
  results.codexAbsent = "clean no-op, no fetch";
}

// 4) Registry unreachable: we know what is installed and nothing else.
{
  const fact = await checkCodex({
    execVersion: async () => MEASURED_VERSION_OUTPUT,
    fetchDistTags: async () => {
      throw new Error("AbortError: timeout");
    },
  });
  assert.equal(fact.installed, "0.146.0", "the installed version survives");
  assert.equal(fact.latest, null, "the latest version does not");
  assert.equal(fact.ok, false, "so nothing is comparable, and nothing is pending");
  results.registryDown = "installed only";
}

// 5) Output we do not recognize is treated as no answer at all. A version string
//    we cannot parse must never be allowed to decide that an update is pending.
{
  const cases = [
    ["empty output", ""],
    ["a shell error banner", "zsh: command not found: codex\n"],
    ["a two-part version", "codex-cli 0.147\n"],
  ];
  for (const [label, output] of cases) {
    const fact = await checkCodex({
      execVersion: async () => output,
      fetchDistTags: async () => MEASURED_DIST_TAGS,
    });
    assert.equal(fact.installed, null, `${label} → no installed version`);
    assert.equal(fact.ok, false, `${label} → not comparable`);
  }
  results.unrecognizedOutput = cases.length;
}

// 6) The timeout is handed to both effects (the AbortController bound on the
//    fetch, the exec timeout on the version probe).
{
  const seen = [];
  await checkCodex({
    execVersion: async (timeoutMs) => {
      seen.push(["exec", timeoutMs]);
      return MEASURED_VERSION_OUTPUT;
    },
    fetchDistTags: async (timeoutMs) => {
      seen.push(["fetch", timeoutMs]);
      return MEASURED_DIST_TAGS;
    },
    timeoutMs: 1234,
  });
  assert.deepEqual(seen, [["exec", 1234], ["fetch", 1234]], "the bound reaches both effects, in order");

  const defaults = [];
  await checkCodex({
    execVersion: async (timeoutMs) => {
      defaults.push(timeoutMs);
      return MEASURED_VERSION_OUTPUT;
    },
    fetchDistTags: async (timeoutMs) => {
      defaults.push(timeoutMs);
      return MEASURED_DIST_TAGS;
    },
  });
  assert.deepEqual(defaults, [CHECK_TIMEOUT_MS, CHECK_TIMEOUT_MS], "default bound applied");
  // MEASURED on this machine 2026-08-05: `codex --version` ~0.02s, the dist-tags
  // GET ~0.19s. The bound is two orders of magnitude of headroom.
  assert.equal(CHECK_TIMEOUT_MS, 5_000, "5s bound");
  results.timeouts = CHECK_TIMEOUT_MS;
}

// 7) The endpoint: npm dist-tags, not the GitHub API (60/hr unauthenticated) and
//    not the brew cask API (install-method detection is `codex update`'s job).
{
  assert.equal(
    CODEX_DIST_TAGS_URL,
    "https://registry.npmjs.org/-/package/@openai/codex/dist-tags",
    "the measured endpoint",
  );
  results.endpoint = CODEX_DIST_TAGS_URL;
}

console.log(JSON.stringify({ success: true, results }, null, 2));
process.exitCode = 0;
