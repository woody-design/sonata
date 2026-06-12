import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type { TaskId } from "../../shared/types/domain";
import type { RuntimeEvent } from "../../shared/types/events";
import type {
  SessionIndexResponse,
  SessionSnapshotResponse,
} from "../../shared/types/sessions";
import {
  LOCAL_API_ERRORS,
  LOCAL_API_PROTOCOL_VERSION,
  type LocalApiNotificationFrame,
  type LocalApiRequestFrame,
  type LocalApiResponseFrame,
} from "../../shared/types/local-api";
import { TaskNotFoundError } from "../errors";

/**
 * The slice of RuntimeController the Local API may touch. Keeping the
 * facade this narrow is the design: companions read sessions, follow
 * events, submit prompts, and resume tasks — nothing else.
 */
export interface LocalApiFacade {
  readSessionIndex(): SessionIndexResponse;
  readSessionSnapshot(taskId: TaskId): SessionSnapshotResponse;
  submitPrompt(taskId: TaskId, text: string): void;
  openTask(taskId: TaskId): void;
}

export interface LocalApiServerOptions {
  socketPath: string;
  appVersion: string;
  facade: LocalApiFacade;
  log?: (message: string) => void;
}

/** Outbound buffer ceiling per connection; a consumer this far behind
 *  is reconnect-first by contract, so dropping it is the correct move. */
const MAX_WRITABLE_BUFFER = 4 * 1024 * 1024;
/** Inbound line ceiling — nothing legitimate approaches this. */
const MAX_LINE_LENGTH = 1 * 1024 * 1024;
/** Recently executed commandIds, replayed instead of re-executed. */
const COMMAND_CACHE_CAPACITY = 256;
/** macOS caps sockaddr_un.sun_path at ~104 bytes; fail loud below it. */
const MAX_SOCKET_PATH_BYTES = 100;
/** Probe deadline when checking a leftover socket for a live owner. */
const STALE_PROBE_TIMEOUT_MS = 1000;

export class LocalApiServer {
  private readonly socketPath: string;
  private readonly appVersion: string;
  private readonly facade: LocalApiFacade;
  private readonly log: (message: string) => void;
  private readonly connections = new Set<net.Socket>();
  private readonly commandResults = new Map<string, unknown>();
  private server: net.Server | null = null;

  constructor(options: LocalApiServerOptions) {
    this.socketPath = options.socketPath;
    this.appVersion = options.appVersion;
    this.facade = options.facade;
    this.log = options.log ?? ((message) => console.log(`[local-api] ${message}`));
  }

  async start(): Promise<void> {
    const pathBytes = Buffer.byteLength(this.socketPath);
    if (pathBytes > MAX_SOCKET_PATH_BYTES) {
      throw new Error(
        `Local API socket path is too long (${pathBytes} bytes; macOS caps ~104): ${this.socketPath}`,
      );
    }
    await this.removeStaleSocket();
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    const server = net.createServer((socket) => this.handleConnection(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        // Don't leak a server that never bound (e.g. EADDRINUSE).
        server.close();
        this.server = null;
        reject(error);
      };
      server.once("error", onError);
      server.listen(this.socketPath, () => {
        server.removeListener("error", onError);
        try {
          fs.chmodSync(this.socketPath, 0o600);
        } catch {
          // The 0700 parent directory already guards access.
        }
        resolve();
      });
    });
    this.log(`listening at ${this.socketPath}`);
  }

  stop(): void {
    for (const socket of this.connections) {
      socket.destroy();
    }
    this.connections.clear();
    this.server?.close();
    this.server = null;
    try {
      fs.rmSync(this.socketPath, { force: true });
    } catch {
      // Best-effort cleanup; a stale file is handled on next start.
    }
  }

  /** Mirror a runtime event to every connected companion. Raw terminal
   *  bytes never leave the app — the semantic events carry everything
   *  a companion may know. */
  broadcastEvent(event: RuntimeEvent): void {
    if (event.type === "pty:data" || this.connections.size === 0) {
      return;
    }
    const notification: LocalApiNotificationFrame = {
      method: "event",
      params: { event },
    };
    const line = `${JSON.stringify(notification)}\n`;
    for (const socket of this.connections) {
      if (socket.writableLength > MAX_WRITABLE_BUFFER) {
        socket.destroy();
        this.connections.delete(socket);
        continue;
      }
      socket.write(line);
    }
  }

  /** A leftover socket file from a crashed instance refuses new binds.
   *  Probe it: a live listener answers (abort — another Duet owns it);
   *  a refused/failed connect means the file is stale and removable. */
  private async removeStaleSocket(): Promise<void> {
    if (!fs.existsSync(this.socketPath)) {
      return;
    }
    const alive = await new Promise<boolean>((resolve) => {
      const probe = net.connect(this.socketPath);
      probe.once("connect", () => {
        probe.destroy();
        resolve(true);
      });
      probe.once("error", () => resolve(false));
      // A wedged socket file that neither connects nor errors must not
      // hang start() forever; treat a silent probe as not-alive.
      probe.setTimeout(STALE_PROBE_TIMEOUT_MS, () => {
        probe.destroy();
        resolve(false);
      });
    });
    if (alive) {
      throw new Error(`Local API socket already in use: ${this.socketPath}`);
    }
    fs.rmSync(this.socketPath, { force: true });
  }

  private handleConnection(socket: net.Socket): void {
    this.connections.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim().length > 0) {
          this.handleLine(socket, line);
        }
        newlineIndex = buffer.indexOf("\n");
      }
      // Bound only the unterminated remainder: a single chunk carrying
      // many complete lines is legitimate; an endless line is not.
      if (buffer.length > MAX_LINE_LENGTH) {
        socket.destroy();
      }
    });
    const drop = () => {
      this.connections.delete(socket);
    };
    socket.on("close", drop);
    socket.on("error", drop);
  }

  private handleLine(socket: net.Socket, line: string): void {
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      this.log("dropped malformed frame");
      return;
    }
    if (!frame || typeof frame !== "object") {
      return;
    }
    const { id, method, params } = frame as {
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    if (typeof id !== "number") {
      // No recoverable id — notifications are not part of the inbound
      // protocol, so there is nobody to answer.
      return;
    }
    if (typeof method !== "string") {
      // A request with an id but no method: answer so the companion's
      // awaited reply resolves instead of hanging forever.
      this.respond(socket, {
        id,
        error: { code: LOCAL_API_ERRORS.invalidRequest, message: "method must be a string" },
      });
      return;
    }
    const request: LocalApiRequestFrame = { id, method, params };
    try {
      const result = this.dispatch(request.method, request.params);
      this.respond(socket, { id: request.id, result });
    } catch (error) {
      if (error instanceof LocalApiError) {
        this.respond(socket, {
          id: request.id,
          error: { code: error.code, message: error.message },
        });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        this.respond(socket, {
          id: request.id,
          error: { code: LOCAL_API_ERRORS.internal, message },
        });
      }
    }
  }

  private respond(socket: net.Socket, frame: LocalApiResponseFrame): void {
    socket.write(`${JSON.stringify(frame)}\n`);
  }

  private dispatch(method: string, params: unknown): unknown {
    switch (method) {
      case "hello":
        return {
          app: "duet",
          appVersion: this.appVersion,
          protocolVersion: LOCAL_API_PROTOCOL_VERSION,
        };
      case "sessionIndex":
        return this.facade.readSessionIndex();
      case "sessionSnapshot": {
        const taskId = stringParam(params, "taskId");
        return this.withTask(taskId, () => this.facade.readSessionSnapshot(taskId));
      }
      case "submitPrompt": {
        const taskId = stringParam(params, "taskId");
        const text = stringParam(params, "text");
        const commandId = stringParam(params, "commandId");
        if (text.trim().length === 0) {
          throw new LocalApiError(LOCAL_API_ERRORS.invalidParams, "text must not be empty");
        }
        return this.executeCommand(commandId, () =>
          this.withTask(taskId, () => {
            this.facade.submitPrompt(taskId, text);
            return { accepted: true };
          }),
        );
      }
      case "openTask": {
        const taskId = stringParam(params, "taskId");
        const commandId = stringParam(params, "commandId");
        return this.executeCommand(commandId, () =>
          this.withTask(taskId, () => {
            this.facade.openTask(taskId);
            return { accepted: true };
          }),
        );
      }
      default:
        throw new LocalApiError(
          LOCAL_API_ERRORS.methodNotFound,
          `unknown method: ${method}`,
        );
    }
  }

  /** Companions retry commands with the same commandId; replay the
   *  prior result instead of re-executing. Dedup lives here — at the
   *  final writer — and nowhere else. */
  private executeCommand(commandId: string, run: () => unknown): unknown {
    if (this.commandResults.has(commandId)) {
      const cached = this.commandResults.get(commandId);
      return cached && typeof cached === "object"
        ? { ...(cached as Record<string, unknown>), deduped: true }
        : cached;
    }
    const result = run();
    this.commandResults.set(commandId, result);
    if (this.commandResults.size > COMMAND_CACHE_CAPACITY) {
      const oldest = this.commandResults.keys().next().value;
      if (oldest !== undefined) {
        this.commandResults.delete(oldest);
      }
    }
    return result;
  }

  private withTask<T>(taskId: string, run: () => T): T {
    try {
      return run();
    } catch (error) {
      // Match the typed error, not its wording — the controller may
      // reword these messages without telling us.
      if (error instanceof TaskNotFoundError) {
        throw new LocalApiError(LOCAL_API_ERRORS.taskNotFound, error.message);
      }
      throw error;
    }
  }
}

class LocalApiError extends Error {
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

function stringParam(params: unknown, key: string): string {
  const value =
    params && typeof params === "object"
      ? (params as Record<string, unknown>)[key]
      : undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new LocalApiError(LOCAL_API_ERRORS.invalidParams, `${key} must be a string`);
  }
  return value;
}

export function localApiSocketPath(userDataPath: string): string {
  // Honor an explicit override for hermetic tests / app-level e2e,
  // mirroring how the settings stores honor DUET_SETTINGS_DIR.
  return (
    process.env.DUET_LOCAL_API_SOCKET ||
    path.join(userDataPath, "run", "control.sock")
  );
}
