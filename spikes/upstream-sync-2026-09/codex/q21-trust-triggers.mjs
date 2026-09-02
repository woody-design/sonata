// Q21 (2026-09 sync, SL-6) — the codex directory-trust TRIGGER matrix at
// 0.152.0.
//
// QUESTION: three upstream changes landed on this screen's trigger conditions
// between 0.146 and 0.152 — #36960 ("require explicit trust for unfamiliar
// local projects"), #36935 ("trust undecided local projects automatically") and
// #39616 (validate linked worktrees before inheriting the main checkout's
// trust). Two of those pull in opposite directions and shipped in one release.
// So: which directory SHAPES raise the dialog under Sonata's production spawn,
// and does Sonata's ledger still suppress it for each?
//
// SOURCE READ (hypothesis only — `codex-rs/config/src/loader/mod.rs`
// `decision_for_dir` at rust-v0.152.0): trust is looked up in three passes, in
// order — the cwd's own normalized keys, then the PROJECT ROOT's, then the REPO
// ROOT's, where repo root comes from `git-utils/src/trust.rs`
// `resolve_root_git_project_for_trust`. For a linked worktree that resolver
// walks to the MAIN checkout and then re-validates the relationship from both
// ends (the registered checkout must canonicalize to this checkout, the
// worktree's `commondir` must canonicalize to the common dir, and the main
// checkout's own `.git` must canonicalize to that same common dir). If any leg
// fails it returns None and no repo-root inheritance happens.
//
// EIGHT SHAPES, chosen so each one isolates a leg of that chain. Sonata's own
// container is a bare repo (`.bare/`) with a `gitdir:` pointer file at the
// container root and sibling worktrees, which is exactly the shape #39616
// touched — so it gets three of the eight rows.
//
// EVERY ARM gets its own fresh CODEX_HOME (auth seeded, no user config.toml) so
// the ONLY trust input is the ledger this probe writes. The user's own
// `~/.codex` is never read for config and never written.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  CodexBoot,
  EXPECT_CODEX_VERSION,
  assertCodexVersion,
  codexVersion,
  isCodexTrustDialog,
  seedCodexHome,
  sanitize,
  sleep,
  writeCapture,
} from "./driver.mjs";

const OUT_DIR = new URL(".", import.meta.url).pathname;
const ROOT = "/private/tmp/sonata-sync-2026-09/codex-trust-triggers";
const COLS = 120;
const ROWS = 40;
/** Long enough for the dialog to paint (measured at ~270ms in q20) and for a
 *  suppressed boot to reach its composer, with generous margin. */
const WATCH_MS = 12_000;

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    // stderr discarded: `describeGitLayout` deliberately interrogates
    // non-git directories too, and git's "fatal: not a git repository" for
    // those is an ANSWER, recorded in the capture — not console noise.
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });

/** A repo with one commit — the seed every git-shaped arm clones from. */
function makeSeedRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "-c", "user.email=probe@example.invalid", "-c", "user.name=probe", "commit", "-q", "--allow-empty", "-m", "init");
  return dir;
}

/**
 * Sonata's OWN container shape:
 *
 *   container/.bare/     the bare repo
 *   container/.git       a file: "gitdir: ./.bare"   ← the main-checkout pointer
 *   container/dev/       a linked worktree
 *
 * `withMainPointer:false` omits that `.git` file. Everything else is identical,
 * so the two arms differ ONLY in the leg #39616 added — whether the main
 * checkout can be proven to own the canonical common dir.
 */
function makeContainer(dir, seed, { withMainPointer }) {
  fs.mkdirSync(dir, { recursive: true });
  const bare = path.join(dir, ".bare");
  execFileSync("git", ["clone", "--bare", "-q", seed, bare], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
  });
  if (withMainPointer) {
    fs.writeFileSync(path.join(dir, ".git"), "gitdir: ./.bare\n");
  }
  const worktree = path.join(dir, "dev");
  git(bare, "worktree", "add", "-q", worktree, "main");
  return { container: dir, worktree, bare };
}

const SHAPES = {
  plain: {
    why: "a plain non-git directory — the simplest 'unfamiliar local project' (#36960)",
    build: (root) => {
      const cwd = path.join(root, "plain");
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd, ledger: [] };
    },
    expectDialog: true,
  },
  "git-root": {
    why: "a git repository root",
    build: (root) => ({ cwd: makeSeedRepo(path.join(root, "repo")), ledger: [] }),
    expectDialog: true,
  },
  "git-subdir": {
    why: "a subdirectory of a git repo — the widget's git-root note case (trust_target != cwd)",
    build: (root) => {
      const repo = makeSeedRepo(path.join(root, "repo"));
      const cwd = path.join(repo, "packages", "web");
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd, ledger: [] };
    },
    expectDialog: true,
  },
  worktree: {
    why: "Sonata's own container shape (bare repo + gitdir pointer + linked worktree), nothing trusted",
    build: (root) => {
      const seed = makeSeedRepo(path.join(root, "seed"));
      const { worktree } = makeContainer(path.join(root, "container"), seed, {
        withMainPointer: true,
      });
      return { cwd: worktree, ledger: [] };
    },
    expectDialog: true,
  },
  "worktree-container-trusted": {
    why: "the same container with the MAIN CHECKOUT ROOT trusted and the worktree NOT — does #39616's validated inheritance fire?",
    build: (root) => {
      const seed = makeSeedRepo(path.join(root, "seed"));
      const { container, worktree } = makeContainer(path.join(root, "container"), seed, {
        withMainPointer: true,
      });
      return { cwd: worktree, ledger: [container] };
    },
    expectDialog: null, // the question
  },
  "worktree-no-main-pointer": {
    why: "the same, MINUS the container's `.git` pointer file — the one leg #39616 added; inheritance must be REFUSED",
    build: (root) => {
      const seed = makeSeedRepo(path.join(root, "seed"));
      const { container, worktree } = makeContainer(path.join(root, "container"), seed, {
        withMainPointer: false,
      });
      return { cwd: worktree, ledger: [container] };
    },
    expectDialog: null, // the question
  },
  "git-subdir-root-trusted": {
    why: "cwd is a repo SUBDIR and only the repo ROOT is in the ledger — the practical 'user opened a subfolder' case",
    build: (root) => {
      const repo = makeSeedRepo(path.join(root, "repo"));
      const cwd = path.join(repo, "packages", "web");
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd, ledger: [repo] };
    },
    expectDialog: null, // the question
  },
  "cwd-in-ledger": {
    why: "CONTROL — the exact cwd in the ledger, which is what runtime-controller's unconditional pre-trust policy writes",
    build: (root) => {
      const cwd = path.join(root, "plain");
      fs.mkdirSync(cwd, { recursive: true });
      return { cwd, ledger: [cwd] };
    },
    expectDialog: false,
  },
};

/**
 * Seed the Sonata profile file with an arbitrary ledger, in the EXACT bytes
 * `projectTrustBlock` emits. The spawn then runs with `pretrustCwd: null`, so
 * what reaches codex is `buildTrustLedger`'s CARRY-FORWARD of these entries —
 * which exercises the parse-and-re-emit path as well as the suppression.
 */
function seedLedger(codexHome, paths) {
  if (paths.length === 0) return null;
  const body = paths
    .map((dirPath) => `[projects.${JSON.stringify(dirPath)}]\ntrust_level = "trusted"\n`)
    .join("\n");
  const profilePath = path.join(codexHome, "sonata.config.toml");
  fs.writeFileSync(profilePath, `# seeded by q21\n\n${body}`);
  return profilePath;
}

async function run(shapeName) {
  const spec = SHAPES[shapeName];
  const runRoot = path.join(ROOT, shapeName);
  fs.rmSync(runRoot, { recursive: true, force: true });
  fs.mkdirSync(runRoot, { recursive: true });
  const { cwd, ledger } = spec.build(runRoot);
  const runtimeDir = path.join(runRoot, "runtime");
  fs.mkdirSync(runtimeDir, { recursive: true });
  const codexHome = seedCodexHome(path.join(runRoot, "codex-home"));
  seedLedger(codexHome, ledger);

  const boot = new CodexBoot({
    taskId: `task-q21-${shapeName}`,
    cwd,
    runtimeDir,
    binDir: path.join(runRoot, "bin"),
    // NULL on purpose in every arm: the ledger under test is the seeded one,
    // carried forward by buildTrustLedger. An arm that also pre-trusted the cwd
    // would answer a different question in every row.
    pretrustCwd: null,
    codexHome,
    rows: ROWS,
    cols: COLS,
    approvalBroker: true,
  });

  const out = {
    shape: shapeName,
    why: spec.why,
    version: codexVersion(),
    cwd,
    seededLedger: ledger,
    expectDialog: spec.expectDialog,
    gitLayout: describeGitLayout(cwd),
  };

  try {
    await boot.start();
    out.args = (await Promise.resolve(boot.spawnedArgs)) ?? null;
    out.profileToml = fs.readFileSync(path.join(codexHome, "sonata.config.toml"), "utf8");

    let dialogFrame = null;
    let dialogAtMs = null;
    let readyAtMs = null;
    const deadline = Date.now() + WATCH_MS;
    while (Date.now() < deadline) {
      const frameText = boot.screen();
      if (dialogFrame === null && isCodexTrustDialog(frameText)) {
        dialogFrame = frameText;
        dialogAtMs = boot.at();
      }
      if (readyAtMs === null && boot.ready() && !isCodexTrustDialog(frameText)) {
        readyAtMs = boot.at();
      }
      // Once the dialog is up it stays up (nothing answers it here — RED LINE),
      // and once a suppressed boot is ready it stays ready. Either way the
      // question is settled: stop early rather than idle for the full budget.
      if (dialogFrame !== null) break;
      if (readyAtMs !== null && boot.at() > 3_000) break;
      if (boot.ptyExited) break;
      await sleep(100);
    }

    out.dialogRaised = dialogFrame !== null;
    out.dialogAtMs = dialogAtMs;
    out.readyAtMs = readyAtMs;
    out.dialogFrame = dialogFrame;
    out.finalScreen = boot.screen();
    out.ptyExited = boot.ptyExited;
    out.exitInfo = boot.exitInfo;
    // The widget prints its own trust TARGET when it differs from the cwd — the
    // single most informative line about which key codex would have written.
    out.trustTargetNote =
      dialogFrame
        ?.split("\n")
        .find((line) => /Trusting will apply to the repository root/i.test(line))
        ?.trim() ?? null;
    out.agreesWithExpectation =
      spec.expectDialog === null ? null : out.dialogRaised === spec.expectDialog;
  } catch (error) {
    out.error = String(error?.stack ?? error?.message ?? error);
  } finally {
    boot.dispose();
    await sleep(300);
  }
  return out;
}

/** What git itself thinks the shape is — recorded so a row's verdict can be
 *  read against ground truth rather than against the probe's intent. */
function describeGitLayout(cwd) {
  const safe = (args) => {
    try {
      return git(cwd, ...args).trim();
    } catch (error) {
      return `<error: ${String(error?.message ?? error).split("\n")[0]}>`;
    }
  };
  return {
    toplevel: safe(["rev-parse", "--show-toplevel"]),
    gitDir: safe(["rev-parse", "--absolute-git-dir"]),
    commonDir: safe(["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    isInsideWorktree: safe(["rev-parse", "--is-inside-work-tree"]),
  };
}

assertCodexVersion("start");
const only = process.argv[2] ?? null;
const shapes = only ? [only] : Object.keys(SHAPES);
for (const shape of shapes) {
  if (!SHAPES[shape]) {
    console.error(`unknown shape ${shape}; expected one of ${Object.keys(SHAPES).join(", ")}`);
    process.exit(64);
  }
}

const results = [];
for (const shape of shapes) {
  results.push(await run(shape));
}
const endVersion = codexVersion();
const capture = {
  probe: "q21-trust-triggers",
  startVersion: EXPECT_CODEX_VERSION,
  endVersion,
  versionDrift: endVersion.includes(EXPECT_CODEX_VERSION) ? null : `drifted to ${endVersion}`,
  results,
};
const outPath = writeCapture(OUT_DIR, "q21-trust-triggers.capture.txt", capture);

console.log(
  sanitize(
    JSON.stringify(
      {
        endVersion,
        matrix: results.map((result) => ({
          shape: result.shape,
          why: result.why,
          seededLedger: result.seededLedger.length,
          dialogRaised: result.dialogRaised,
          dialogAtMs: result.dialogAtMs,
          readyAtMs: result.readyAtMs,
          expectDialog: result.expectDialog,
          agreesWithExpectation: result.agreesWithExpectation,
          trustTargetNote: result.trustTargetNote,
          gitCommonDir: result.gitLayout?.commonDir ?? null,
          gitToplevel: result.gitLayout?.toplevel ?? null,
          error: result.error ?? null,
        })),
      },
      null,
      2,
    ),
  ),
);
console.log(`\nwrote ${outPath}`);
process.exit(results.some((result) => result.error || result.agreesWithExpectation === false) ? 1 : 0);
