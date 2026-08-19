// CLI readiness S2 — the machine shapes the card is about, built on disk.
//
// The card is a statement about the user's CLIs, so an app-level test has to be
// able to say "this machine has no Claude Code" and "this one has it but is not
// signed in" — and then CHANGE that mid-run, the way a real install does. Four
// pieces do all of it:
//
//   1. a bin dir that is the app's ENTIRE PATH beyond the system dirs, so what is
//      in it is exactly what the probe can find (with the login-shell merge
//      disabled, since a merge would drag the developer's real CLIs in);
//   2. per-provider CLI stubs that answer the probe's two structured commands
//      from a CONTROL FILE, so the same binary can be signed out and then signed
//      in without being replaced;
//   3. a fake `curl` that prints whatever script the test currently wants and logs
//      the argv it was called with — which is what lets a test prove the SHIPPED
//      install command (D7) is the one that ran, rather than trusting a constant;
//   4. a signal a LIVE stub watches (`completeCliLogin`), so a test can make an
//      already-parked session finish its first-run flow and reach a prompt — which
//      the control files above cannot do, since only the probe reads them (S4).
//
// Provenance: the CLI stubs' output shapes are MEASURED (claude 2.1.222 /
// codex-cli 0.146.0, recorded in the S1 slice record and pinned by
// tests/smoke/cli-readiness-probe.mjs); the stub scripts themselves and the
// installer scripts are COMPOSED.

import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} root  a temp dir this fixture owns
 */
export function createCliReadinessFixture(root) {
  const binDir = path.join(root, "bin");
  const controlDir = path.join(root, "control");
  const homeDir = path.join(root, "home");
  const dataDir = path.join(root, "data");
  const settingsDir = path.join(root, "settings");
  const codexHome = path.join(root, "codex-home");
  for (const dir of [binDir, controlDir, homeDir, dataDir, settingsDir, codexHome]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const curlScript = path.join(controlDir, "install-script.sh");
  const curlLog = path.join(controlDir, "curl-argv.log");
  fs.writeFileSync(curlScript, "echo 'no installer configured' >&2\nexit 1\n", "utf8");
  fs.writeFileSync(curlLog, "", "utf8");
  writeFakeCurl(binDir, curlScript, curlLog);

  const authFile = (provider) => path.join(controlDir, `${provider}-auth`);
  // The "the user finished the setup on screen" signal (S4). Watched by a LIVE stub,
  // unlike the auth control files, which only the probe reads.
  const loginDoneFile = path.join(controlDir, "login-done");

  return {
    binDir,
    homeDir,
    dataDir,
    settingsDir,
    codexHome,
    curlScript,
    curlLog,

    /** The launch environment: an app that can see exactly this fixture's CLIs. */
    env() {
      return {
        ...process.env,
        HOME: homeDir,
        CODEX_HOME: codexHome,
        SONATA_DATA_DIR: dataDir,
        SONATA_WORKSPACES_DIR: path.join(root, "workspaces"),
        SONATA_SETTINGS_DIR: settingsDir,
        SONATA_NOTIFICATIONS: "0",
        // The login-shell merge would append the developer's real PATH and with it
        // their real CLIs — the one thing this fixture must be able to exclude.
        SONATA_DISABLE_LOGIN_SHELL_PATH: "1",
        // A predictable shell for the install command's `$SHELL -c` (NOT `-lc` —
        // see setup-run.ts: a login shell's path_helper would replace the merged
        // PATH, which is also what would let the real installer escape this
        // fixture). Production picks `$SHELL`; this only fixes WHICH one.
        SHELL: "/bin/bash",
        PATH: `${binDir}:/usr/bin:/bin:/usr/sbin:/sbin`,
        // Consumed by the COMPOSED installer scripts below (they run in the pty,
        // which inherits main's environment).
        SONATA_E2E_BIN: binDir,
        SONATA_E2E_CONTROL: controlDir,
      };
    },

    /** Put a provider's CLI on this machine, signed in or not. */
    installCli(provider, { signedIn = true } = {}) {
      writeAuthState(authFile(provider), signedIn);
      writeCliStub(binDir, provider, authFile(provider), loginDoneFile);
    },

    /** Remove it again (an uninstalled machine). */
    removeCli(provider) {
      fs.rmSync(path.join(binDir, provider), { force: true });
    },

    /** Flip a present CLI's answer without replacing the binary — what finishing a
     *  login looks like to the probe. */
    setSignedIn(provider, signedIn) {
      writeAuthState(authFile(provider), signedIn);
    },

    /**
     * What finishing a login looks like to a RUNNING CLI (S4): the already-spawned
     * process leaves its first-run screen and paints its composer prompt.
     *
     * The probe half (`setSignedIn`) is not enough on its own. A signed-out session's
     * PTY is alive and parked, and the only thing that can un-park it is that process
     * itself — so a test that needs the REAL heal (the CLI's own prompt appears, the
     * delivery pump latches, the queued message goes out) has to reach the live
     * process, not the control file the probe reads. The stub polls for this signal
     * and then prints the provider's own composer glyph + idle footer.
     *
     * One signal for all live stubs, which is what a test wants: it is answering
     * "the user finished the setup that was on screen". Carried only by the stub this
     * fixture writes — a stub written by the fake INSTALLER (`cliStubScriptWriter`)
     * has no need of it, since a machine that just installed a CLI reaches its login
     * screen fresh.
     */
    completeCliLogin() {
      fs.writeFileSync(loginDoneFile, "done", "utf8");
    },

    /** What `curl` will print next, i.e. what the install command will run. */
    setInstallScript(script) {
      fs.writeFileSync(curlScript, script, "utf8");
    },

    /** Every argv the fake curl has seen, so a test can prove the official command
     *  string (D7) is the one that ran. */
    curlInvocations() {
      return fs
        .readFileSync(curlLog, "utf8")
        .split("\n")
        .filter((line) => line.length > 0);
    },

    /**
     * An installer that succeeds: prints, installs the provider's stub, exits 0.
     * `holdFile` (optional) makes it WAIT until that file appears — which is how a
     * test can photograph the "Installing…" state instead of racing it.
     */
    successInstallScript(provider, { holdFile = null, signedIn = true } = {}) {
      return [
        `echo "Downloading ${provider} installer..."`,
        `echo "Installing to $SONATA_E2E_BIN"`,
        ...(holdFile
          ? [
              `printf 'waiting'`,
              `while [ ! -f ${shellQuote(holdFile)} ]; do printf '.'; sleep 0.2; done`,
              `echo`,
            ]
          : []),
        cliStubScriptWriter(provider, signedIn),
        `echo "${provider} installed."`,
        `exit 0`,
        "",
      ].join("\n");
    },

    /** An installer that fails the way a real one does: says so, exits non-zero. */
    failingInstallScript() {
      return [
        `echo "Downloading installer..."`,
        `echo "install.sh: permission denied writing to /usr/local/bin" >&2`,
        `exit 1`,
        "",
      ].join("\n");
    },
  };
}

function writeAuthState(file, signedIn) {
  fs.writeFileSync(file, signedIn ? "in" : "out", "utf8");
}

/**
 * A CLI stub that answers the probe's two structured commands from a control file.
 * Output shapes MEASURED on claude 2.1.222 / codex-cli 0.146.0 (S1): claude
 * answers `auth status --json` with a `loggedIn` boolean on stdout; codex answers
 * `login status` on STDERR with one of two line-anchored phrases.
 *
 * Anything else it is asked to do, it prints a first-run screen and sits there —
 * which is what a `start` run needs: a process that stays alive on a first-run
 * screen until the user finishes with it. `completeCliLogin` is that "finishes with
 * it": the stub then paints this provider's own composer prompt and keeps running.
 */
function writeCliStub(binDir, provider, authFile, loginDoneFile) {
  const answer =
    provider === "claude"
      ? `  if [ "$state" = "in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; fi\n` +
        `  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1\n`
      : `  if [ "$state" = "in" ]; then echo 'Logged in using ChatGPT' >&2; exit 0; fi\n` +
        `  echo 'Not logged in' >&2; exit 1\n`;
  // The STATUS query is `auth status` / `login status`; the LOGIN COMMAND is
  // `auth login` / bare `login` (the login-run redesign, 2026-08-19). The status
  // shapes are MEASURED; the login flow below is COMPOSED to the commands'
  // documented shape — line-oriented, waits for its browser/paste ceremony, exits
  // 0 when done. `loginDoneFile` stands in for that ceremony finishing, the same
  // "the user finished the login that was on screen" signal the parked-session
  // stub watches.
  const statusCond =
    provider === "claude"
      ? `[ "$1" = "auth" ] && [ "$2" != "login" ]`
      : `[ "$1" = "login" ] && [ "$2" = "status" ]`;
  const loginCond =
    provider === "claude" ? `[ "$1" = "auth" ] && [ "$2" = "login" ]` : `[ "$1" = "login" ]`;
  const version =
    provider === "claude" ? `echo '2.1.222 (Claude Code)'` : `echo 'codex-cli 0.146.0'`;
  fs.writeFileSync(
    path.join(binDir, provider),
    `#!/bin/sh
state=$(cat ${shellQuote(authFile)} 2>/dev/null)
if [ "$1" = "--version" ]; then ${version}; exit 0; fi
if ${statusCond}; then
${answer}fi
if ${loginCond}; then
  echo "Open the URL to authorize, then return here:"
  echo "https://example.invalid/oauth"
  while [ ! -f ${shellQuote(loginDoneFile)} ]; do sleep 0.2; done
  echo "Login successful"
  exit 0
fi
# Any other invocation is the CLI itself being run: print a first-run screen and
# stay alive, exactly as a real CLI waiting on its login flow would — until the test
# says the user finished with it, at which point paint the composer prompt and keep
# running, as the real CLI does after its first-run flow. The prompt glyph + idle
# footer are what \`detectIdlePrompt\` accepts for this provider, so this is the ONLY
# way a test can make a parked session genuinely reach a prompt.
echo "Welcome to ${provider === "claude" ? "Claude Code" : "Codex"}"
echo "Choose a login method:"
echo "  1. Subscription"
echo "  2. API key"
prompted=no
while :; do
  if [ "$prompted" = "no" ] && [ -f ${shellQuote(loginDoneFile)} ]; then
    prompted=yes
    echo "${provider === "claude" ? "❯ sonnet high ~  ? for shortcuts" : "› gpt-5.6-sol high ~"}"
  fi
  sleep 0.2
done
`,
    { mode: 0o755 },
  );
  fs.chmodSync(path.join(binDir, provider), 0o755);
}

/** The line an installer script uses to put a CLI on this machine — the same stub
 *  writer as above, emitted as shell so it runs inside the install pty. */
function cliStubScriptWriter(provider, signedIn) {
  return (
    `printf '%s' ${shellQuote(signedIn ? "in" : "out")} > "$SONATA_E2E_CONTROL/${provider}-auth"\n` +
    `cat > "$SONATA_E2E_BIN/${provider}" <<'SONATA_STUB_EOF'\n` +
    cliStubBody(provider) +
    `SONATA_STUB_EOF\n` +
    `chmod +x "$SONATA_E2E_BIN/${provider}"`
  );
}

function cliStubBody(provider) {
  const version =
    provider === "claude" ? `echo '2.1.222 (Claude Code)'` : `echo 'codex-cli 0.146.0'`;
  // The same status/login split as `writeCliStub` above (the login-run redesign):
  // an installer-written stub must also answer `auth login` / `login` as the
  // LOGIN COMMAND, not fall into the status branch and exit — section E of the
  // card e2e runs against THIS stub, since its claude arrived via the installer.
  const statusCond =
    provider === "claude"
      ? `[ "$1" = "auth" ] && [ "$2" != "login" ]`
      : `[ "$1" = "login" ] && [ "$2" = "status" ]`;
  const loginCond =
    provider === "claude" ? `[ "$1" = "auth" ] && [ "$2" = "login" ]` : `[ "$1" = "login" ]`;
  const answer =
    provider === "claude"
      ? `  if [ "$state" = "in" ]; then echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0; fi\n` +
        `  echo '{"loggedIn":false,"authMethod":"none"}'; exit 1\n`
      : `  if [ "$state" = "in" ]; then echo 'Logged in using ChatGPT' >&2; exit 0; fi\n` +
        `  echo 'Not logged in' >&2; exit 1\n`;
  return `#!/bin/sh
state=$(cat "$SONATA_E2E_CONTROL/${provider}-auth" 2>/dev/null)
if [ "$1" = "--version" ]; then ${version}; exit 0; fi
if ${statusCond}; then
${answer}fi
if ${loginCond}; then
  echo "Open the URL to authorize, then return here:"
  echo "https://example.invalid/oauth"
  while [ ! -f "$SONATA_E2E_CONTROL/login-done" ]; do sleep 0.2; done
  echo "Login successful"
  exit 0
fi
echo "Welcome to ${provider === "claude" ? "Claude Code" : "Codex"}"
while :; do sleep 0.2; done
`;
}

/** The fake `curl`: logs its argv, prints the currently configured script. The
 *  install command pipes that into `bash`/`sh`, so the SHIPPED command string
 *  (D7) is what drives this — no test seam inside the product. */
function writeFakeCurl(binDir, scriptFile, logFile) {
  fs.writeFileSync(
    path.join(binDir, "curl"),
    `#!/bin/sh
echo "$@" >> ${shellQuote(logFile)}
cat ${shellQuote(scriptFile)}
`,
    { mode: 0o755 },
  );
  fs.chmodSync(path.join(binDir, "curl"), 0o755);
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
