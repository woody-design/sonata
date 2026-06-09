import fs from "node:fs";

const DEFAULT_POLL_MS = 400;
const READ_CHUNK_BYTES = 256 * 1024;

export interface JsonlTailerOptions {
  path: string;
  pollMs?: number;
  onLines: (lines: string[]) => void;
  onTruncated?: () => void;
  onError?: (error: Error) => void;
}

/**
 * Incremental JSONL reader. Polls file size and reads appended bytes,
 * carrying partial trailing lines between reads. Polling is deliberate:
 * a single stat per tick is cheap and immune to fs.watch rename quirks.
 */
export class JsonlTailer {
  private readonly options: JsonlTailerOptions;
  private readonly pollMs: number;
  private offset = 0;
  private carry = "";
  private timer: NodeJS.Timeout | null = null;
  private reading = false;

  constructor(options: JsonlTailerOptions) {
    this.options = options;
    this.pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Read everything currently in the file. Usable without start(). */
  drain(): void {
    this.poll();
  }

  private poll(): void {
    if (this.reading) {
      return;
    }
    this.reading = true;
    try {
      const size = fs.statSync(this.options.path).size;
      if (size < this.offset) {
        this.offset = 0;
        this.carry = "";
        this.options.onTruncated?.();
      }
      while (this.offset < size) {
        const chunk = this.readChunk(Math.min(READ_CHUNK_BYTES, size - this.offset));
        if (chunk === null) {
          break;
        }
        this.emitLines(chunk);
      }
    } catch (error) {
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.reading = false;
    }
  }

  private readChunk(length: number): string | null {
    const fd = fs.openSync(this.options.path, "r");
    try {
      const buffer = Buffer.alloc(length);
      const bytesRead = fs.readSync(fd, buffer, 0, length, this.offset);
      if (bytesRead <= 0) {
        return null;
      }
      this.offset += bytesRead;
      return buffer.toString("utf8", 0, bytesRead);
    } finally {
      fs.closeSync(fd);
    }
  }

  private emitLines(chunk: string): void {
    const combined = `${this.carry}${chunk}`;
    const lines = combined.split("\n");
    this.carry = lines.pop() ?? "";
    const complete = lines.filter((line) => line.trim().length > 0);
    if (complete.length > 0) {
      this.options.onLines(complete);
    }
  }
}
