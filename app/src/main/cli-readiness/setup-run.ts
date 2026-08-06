import * as os from "node:os";
import * as pty from "node-pty";
import type {
  CliSetupRun,
  CliSetupRunData,
  CliSetupRunKind,
  CliSetupRunRequest,
  CliSetupRunSnapshot,
} from "../../shared/types/cli-setup-run";
import type { RuntimeProvider } from "../../shared/types/domain";
import { cliCommandEnv } from "./cli-env";

/**
 * The readiness subsystem's recovery half (CLI readiness S2; plan D7, L7): run
 * ONE user-visible command in a real pty and let the CLI window show it.
 *
 * ## Why this is not a TerminalHost
 *
 * `runtime/terminal-host` is a provider-TUI engine: it parses screens, attributes
 * runs, brokers approvals, tracks idle prompts, and belongs to a Task. Every one
 * of those properties is wrong here, and two are actively forbidden. An installer
 * is not a TUI, so its output would be scraped for approval panels it does not
 * have; a login screen is the one surface Sonata is not allowed to read
 * (D1/D2 red line), so hosting it in a parser would make Sonata a participant in
 * an authentication ceremony. A setup run also has no Task — creating one would
 * leave a phantom session in the sidebar for every install attempt.
 *
 * So this is a SIBLING of terminal-host, not a change to it: ~one pty, no parsing,
 * no task, no persistence. terminal-host is untouched by this slice.
 *
 * ## What decides success
 *
 * Nothing in this file reads the command's output (L7). An install's verdict comes
 * from the injected `reprobe`, which re-runs the structured readiness probe with
 * the login-shell PATH cache busted — because both official installers edit the
 * user's shell profile, which makes the cached PATH stale at exactly the moment we
 * need it fresh. A non-zero exit or a still-`absent` re-probe is the failure.
 *
 * ## Single-run discipline
 *
 * At most one run at a time. A request arriving while one is live is answered by
 * bringing the window forward and nothing else: two installers writing the same
 * global prefix is a corruption hazard, and the card that could issue the second
 * request is already showing "Installing…" rather than a button.
 *
 * ## What a quit does (and does not do)
 *
 * The pty is not detached, so quitting Sonata mid-install interrupts the installer.
 * Accepted, not defended against — see {@link CliSetupRunController.dispose} for the
 * measurement and the reasoning.
 */

/**
 * The official first-choice install command per provider (D7, MEASURED against
 * both vendors' docs 2026-08-05). Self-contained scripts with no node/brew
 * prerequisite — deliberately NOT an npm path, since Electron's embedded node is
 * not the system node and cannot help.
 *
 * These strings are the product's promise to the user's machine, so they are
 * exported and pinned by a fence: an edit here changes what Sonata runs on
 * someone's computer with a privileged installer's reach.
 */
export const CLI_INSTALL_COMMANDS: Readonly<Record<RuntimeProvider, string>> = {
  claude: "curl -fsSL https://claude.ai/install.sh | bash",
  codex: "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
};

/** Output kept for replay into a (re)opened CLI window. Sized for an installer's
 *  progress chatter with room for a verbose failure, not for a session
 *  transcript — a setup run is minutes long at worst and has no scrollback UI. */
export const SETUP_RUN_OUTPUT_LIMIT_CHARS = 256_000;

/** The pty's geometry until the CLI window reports its own. The window resizes as
 *  soon as it mounts its xterm; an installer's line-based output survives a
 *  fraction of a second at a conventional width, and a wrong initial size is what
 *  every terminal emulator's first frame looks like. */
const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export interface CliSetupRunOptions {
  /** Push the run state to every window. main owns the fan-out (the
   *  `broadcastCliReadiness` convention). */
  readonly broadcastState: (run: CliSetupRun | null) => void;
  /** Push one output chunk to every window. */
  readonly broadcastData: (chunk: CliSetupRunData) => void;
  /**
   * Bring the CLI window to front, creating it if needed, and resolve once it can
   * receive messages. The run waits on this before spawning so the window is
   * there to show the first byte (the buffer covers the reopen case, not this
   * one).
   */
  readonly showTerminalWindow: () => Promise<void>;
  /**
   * Re-run the readiness probe and resolve when the facts are current. `install`
   * passes `bustPathCache` (L7); `start` does not — nothing moved on disk, and a
   * needless bust would pay a login-shell subprocess to learn the same PATH.
   */
  readonly reprobe: (options: { bustPathCache: boolean }) => Promise<void>;
  /** Whether this provider still has nothing to spawn, read AFTER the re-probe —
   *  the other half of the L7 verdict. */
  readonly isAbsent: (provider: RuntimeProvider) => boolean;
  readonly spawn?: (input: SetupRunSpawnInput) => SetupRunProcess;
  readonly log?: (message: string) => void;
}

/** What a run needs from a pty, and nothing more — so a test drives the whole
 *  controller with a ten-line fake and no subprocess. */
export interface SetupRunProcess {
  onData(listener: (data: string) => void): void;
  /**
   * The exit code, and deliberately not the signal. A signal death reports
   * `exitCode: 0` through node-pty, so a killed installer would look successful on
   * this axis alone — and it is caught anyway by the OTHER half of the L7 verdict
   * (the re-probe still reads `absent`). Carrying the signal would add a field with
   * no decision behind it.
   */
  onExit(listener: (exit: { exitCode: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

export interface SetupRunSpawnInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cols: number;
  readonly rows: number;
}

export class CliSetupRunController {
  private readonly options: CliSetupRunOptions;
  private readonly spawnProcess: (input: SetupRunSpawnInput) => SetupRunProcess;
  private readonly log: (message: string) => void;

  private run: CliSetupRun | null = null;
  private process: SetupRunProcess | null = null;
  private output: string = "";
  private outputSeq = 0;
  private nextId = 1;
  /** Set the moment the pty exits, so a late `write` cannot reach a dead handle
   *  and a second exit (pty + our own teardown) cannot decide the verdict twice. */
  private settling = false;
  private disposed = false;

  constructor(options: CliSetupRunOptions) {
    this.options = options;
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.log = options.log ?? ((message) => console.log(`[cli-setup-run] ${message}`));
  }

  /** The pull channel: the run plus its output so far (see the snapshot doc for
   *  why the buffer exists). */
  read(): CliSetupRunSnapshot {
    return { run: this.run, output: this.output, outputSeq: this.outputSeq };
  }

  /**
   * Start a run, or — when one is already live — just bring the window forward.
   *
   * Never rejects and never throws at the caller: this is invoked from an IPC
   * handler behind a button, and a failure to spawn is a STATE the card must show
   * (the failed variant), not an exception for the renderer to interpret.
   */
  async start(request: CliSetupRunRequest): Promise<void> {
    if (this.disposed) {
      return;
    }
    if (this.run?.phase === "running") {
      this.log(`ignored ${describe(request)}: run #${this.run.id} is still going`);
      await this.options.showTerminalWindow();
      return;
    }

    const id = this.nextId;
    this.nextId += 1;
    // Publish `running` and clear the previous run's output BEFORE the window
    // work: the card's "Installing…" must be on screen while the window opens,
    // not after, and a retry must not show the failed attempt's log.
    this.output = "";
    this.outputSeq = 0;
    this.settling = false;
    this.setRun({ id, kind: request.kind, provider: request.provider, phase: "running" });

    try {
      await this.options.showTerminalWindow();
    } catch (error) {
      // A window that cannot be shown does not stop the run: the command is still
      // the honest thing to do, and the re-probe still decides. Only the
      // "follow along" promise is degraded, and that is logged.
      this.log(`could not show the CLI window for run #${id}: ${describeError(error)}`);
    }
    if (this.disposed || this.run?.id !== id) {
      return;
    }

    const spawnInput = spawnInputFor(request);
    this.log(`run #${id} ${describe(request)}: ${spawnInput.command} ${spawnInput.args.join(" ")}`);
    let child: SetupRunProcess;
    try {
      child = this.spawnProcess(spawnInput);
    } catch (error) {
      // ENOENT on the shell itself, a node-pty failure — indistinguishable from
      // an installer that could not run, and treated identically.
      this.log(`run #${id} could not spawn: ${describeError(error)}`);
      this.ingest(id, `\r\nSonata could not run this command: ${describeError(error)}\r\n`);
      void this.settle(id, request, 1);
      return;
    }
    this.process = child;
    child.onData((data) => this.ingest(id, data));
    child.onExit((exit) => {
      void this.settle(id, request, exit.exitCode);
    });
  }

  /** A keystroke from the CLI window. Silently dropped when it names a run that
   *  is no longer the live one — the pty it was typed at is gone. */
  write(id: number, data: string): void {
    if (this.disposed || this.settling || this.run?.id !== id || this.run.phase !== "running") {
      return;
    }
    try {
      this.process?.write(data);
    } catch (error) {
      this.log(`run #${id} write failed: ${describeError(error)}`);
    }
  }

  resize(id: number, cols: number, rows: number): void {
    if (this.disposed || this.settling || this.run?.id !== id || this.run.phase !== "running") {
      return;
    }
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
      return;
    }
    const safeCols = Math.max(2, Math.trunc(cols));
    const safeRows = Math.max(1, Math.trunc(rows));
    try {
      this.process?.resize(safeCols, safeRows);
    } catch (error) {
      this.log(`run #${id} resize failed: ${describeError(error)}`);
    }
  }

  /**
   * Stop broadcasting. This method kills nothing — but be precise about what that
   * buys, because the obvious stronger claim is FALSE.
   *
   * The pty is spawned NOT detached and Sonata holds its master, so **quitting
   * Sonata mid-install takes the installer with it** (MEASURED 2026-08-05: a
   * node-pty child stops dead when its parent process exits). Only the survivable
   * case survives: on macOS, closing every window does not end the process, and
   * this method's job is to stop broadcasting into a torn-down window set while the
   * run continues.
   *
   * That interruption is ACCEPTED rather than defended against (orchestrator
   * ruling, review O1). The `cli-updater` executor's detach-and-unref machinery is
   * the real fix and is deliberately heavier than this slice warrants: both vendor
   * installers are re-runnable, and a half-written install reads `absent` to the
   * next launch's probe — which is exactly the card that offers to install it again.
   * The recovery path is retry, and it is the same path a failed install already
   * takes.
   */
  dispose(): void {
    this.disposed = true;
  }

  /** Decide an outcome exactly once per run. */
  private async settle(
    id: number,
    request: CliSetupRunRequest,
    exitCode: number,
  ): Promise<void> {
    if (this.run?.id !== id || this.settling) {
      return;
    }
    this.settling = true;
    this.process = null;
    const bustPathCache = request.kind === "install";
    try {
      await this.options.reprobe({ bustPathCache });
    } catch (error) {
      // reprobe swallows its own failures; this is belt-and-braces so a throwing
      // seam cannot leave the card stuck on "Installing…" forever.
      this.log(`run #${id} re-probe failed: ${describeError(error)}`);
    }
    if (this.disposed || this.run?.id !== id) {
      return;
    }

    // A `start` run has no verdict to give (see CliSetupRunPhase): clear it and
    // let the re-probed facts say whether the login took.
    if (request.kind !== "install") {
      this.log(`run #${id} finished (exit ${exitCode}); facts re-probed`);
      this.setRun(null);
      return;
    }

    // L7, literally: a non-zero exit OR a CLI that is still absent is a failure.
    // Never the installer's output — a script that prints "Success!" and installs
    // nothing must not be believed, and one that prints nothing at all while
    // working must not be doubted.
    const stillAbsent = this.options.isAbsent(request.provider);
    if (exitCode !== 0 || stillAbsent) {
      this.log(
        `run #${id} install failed (exit ${exitCode}, ` +
          `${request.provider} ${stillAbsent ? "still absent" : "present"})`,
      );
      this.setRun({ ...this.run, phase: "failed" });
      return;
    }
    this.log(`run #${id} installed ${request.provider}`);
    this.setRun(null);
  }

  private setRun(run: CliSetupRun | null): void {
    this.run = run;
    this.options.broadcastState(run);
  }

  private ingest(id: number, data: string): void {
    if (this.disposed || this.run?.id !== id || data.length === 0) {
      return;
    }
    this.outputSeq += 1;
    this.output = capTail(this.output + data, SETUP_RUN_OUTPUT_LIMIT_CHARS);
    this.options.broadcastData({ id, seq: this.outputSeq, data });
  }
}

/**
 * How each kind reaches the machine.
 *
 * `install` needs a shell, because D7's command is a pipeline. It gets the user's
 * own `$SHELL` — the vendors' scripts are written for "the user pasted this into
 * their terminal", and some of them inspect `$SHELL` to decide which profile file
 * to edit — invoked with **`-c`, NOT `-lc`**.
 *
 * That distinction is load-bearing and was MEASURED the hard way (2026-08-05). A
 * login shell on macOS sources `/etc/profile`, which runs `path_helper`, which
 * REPLACES `PATH` with the system list plus `/etc/paths.d`. So `-lc` silently
 * discards the merged login-shell PATH this module just built — reintroducing,
 * inside the install path, exactly the detect/run inconsistency `cli-env.ts` exists
 * to prevent (D2, Anthropic Desktop #42350). `-c` keeps the env we hand it, and
 * loses nothing: that env ALREADY contains the login-shell PATH, captured by the
 * same code the probe and the session spawn use.
 *
 * `start` spawns the binary DIRECTLY — the same resolution the session spawn uses
 * (D2). A shell layer would sit between the user's keystrokes and the CLI's
 * first-run screens for no gain, and a `claude` that exists only as a shell alias
 * would have read as `absent` anyway, so there is nothing a shell would find that
 * the probe did not.
 *
 * Home is the cwd for both: setting up a CLI is not project work, and a
 * project-scoped cwd would invite the CLI's directory-trust dialog into a flow
 * that has nothing to do with a directory.
 */
export function spawnInputFor(request: CliSetupRunRequest): SetupRunSpawnInput {
  const env = setupRunEnv();
  const shared = { cwd: os.homedir(), env, cols: DEFAULT_COLS, rows: DEFAULT_ROWS };
  if (request.kind === "install") {
    const shell = env.SHELL && env.SHELL.length > 0 ? env.SHELL : "/bin/sh";
    return { command: shell, args: ["-c", CLI_INSTALL_COMMANDS[request.provider]], ...shared };
  }
  return { command: request.provider, args: [], ...shared };
}

/**
 * The run's environment — the pty-spawn treatment, for the same reasons
 * `terminal-host`'s `ptyEnvironment` applies it:
 *
 * - `ELECTRON_RUN_AS_NODE` must go, or a child that shells out to node inherits
 *   Electron's node-mode marker.
 * - the nested-session markers must go: a `claude` that sees `CLAUDECODE` /
 *   `CLAUDE_CODE_*` registers no session side channel (research 2026-06-12 §4.2),
 *   and this run exists to let `claude` do its FIRST RUN properly.
 *   `CLAUDE_CONFIG_DIR` stays — user-owned configuration, not a marker.
 * - `TERM`/`COLORTERM` so the CLI paints in the window's xterm as it would in a
 *   real terminal.
 *
 * The PATH comes from `cliCommandEnv()`, i.e. the same merge the probe and the
 * session spawn use — the D2 property that keeps "we could not find it" and "we
 * could not run it" from ever disagreeing.
 */
export function setupRunEnv(): NodeJS.ProcessEnv {
  const env = cliCommandEnv();
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.CLAUDECODE;
  for (const key of Object.keys(env)) {
    if (key.startsWith("CLAUDE_CODE_")) {
      delete env[key];
    }
  }
  return { ...env, TERM: "xterm-256color", COLORTERM: "truecolor" };
}

/** Keep the TAIL: when an install floods, the end is the part that says what
 *  happened. */
function capTail(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(text.length - limit);
}

function defaultSpawn(input: SetupRunSpawnInput): SetupRunProcess {
  const child = pty.spawn(input.command, [...input.args], {
    name: "xterm-256color",
    cols: input.cols,
    rows: input.rows,
    cwd: input.cwd,
    env: input.env as Record<string, string>,
  });
  return {
    onData: (listener) => {
      child.onData(listener);
    },
    onExit: (listener) => {
      child.onExit(({ exitCode }) => listener({ exitCode }));
    },
    write: (data) => child.write(data),
    resize: (cols, rows) => child.resize(cols, rows),
  };
}

function describe(request: CliSetupRunRequest): string {
  return `${request.kind} ${request.provider}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
