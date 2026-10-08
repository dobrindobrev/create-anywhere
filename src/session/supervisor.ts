import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { ClaudeProcess, type ClaudeProcessOptions } from "./process.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("supervisor");

const MAX_RESTARTS = 3;
const BACKOFF_BASE_MS = 1000;

/**
 * Wraps ClaudeProcess with auto-restart on crash.
 * Same EventEmitter interface: text, toolUse, toolResult, result, error, exit.
 * Emits "restarted" when a restart occurs and "failed" after max retries exceeded.
 */
export class SupervisedProcess extends EventEmitter {
  private proc: ClaudeProcess;
  private opts: ClaudeProcessOptions;
  private restartCount = 0;
  private pendingMessages: string[] = [];
  private restarting = false;
  private killed = false;

  constructor(opts: ClaudeProcessOptions) {
    super();
    this.opts = opts;
    this.proc = new ClaudeProcess(opts);
    this.wireEvents();
  }

  get sessionId(): string {
    return this.proc.sessionId;
  }

  get isRunning(): boolean {
    return this.proc.isRunning;
  }

  start(): void {
    this.proc.start();
  }

  sendMessage(text: string): void {
    if (this.restarting) {
      this.pendingMessages.push(text);
      return;
    }
    this.proc.sendMessage(text);
  }

  kill(): void {
    this.killed = true;
    this.proc.kill();
  }

  private wireEvents(): void {
    this.proc.on("text", (text: string) => this.emit("text", text));
    this.proc.on("toolUse", (tool: string, input: Record<string, unknown>, id: string) =>
      this.emit("toolUse", tool, input, id)
    );
    this.proc.on("toolResult", (id: string, output: string, isError: boolean) =>
      this.emit("toolResult", id, output, isError)
    );
    this.proc.on("result", (text: string, costUsd?: number) =>
      this.emit("result", text, costUsd)
    );
    this.proc.on("error", (err: Error) => this.emit("error", err));
    this.proc.on("activity", () => this.emit("activity"));

    this.proc.on("exit", (code: number | null) => {
      if (this.killed) {
        this.emit("exit", code);
        return;
      }

      // Normal exit (code 0) — don't restart
      if (code === 0 || code === null) {
        this.emit("exit", code);
        return;
      }

      // Abnormal exit — attempt restart
      if (this.restartCount >= MAX_RESTARTS) {
        log.error({ restartCount: this.restartCount }, "Max restarts exceeded");
        this.emit("failed");
        this.emit("exit", code);
        return;
      }

      this.restartCount++;
      const delay = BACKOFF_BASE_MS * Math.pow(2, this.restartCount - 1);
      log.warn(
        { restartCount: this.restartCount, delay, sessionId: this.sessionId },
        "Restarting Claude process"
      );

      this.restarting = true;
      setTimeout(() => {
        this.restarting = false;
        // Create new process with a fresh session-id to avoid "already in use" locks
        this.proc = new ClaudeProcess({
          ...this.opts,
          sessionId: randomUUID(),
        });
        this.wireEvents();
        this.proc.start();
        this.emit("restarted", this.restartCount);

        // Drain queued messages
        for (const msg of this.pendingMessages) {
          this.proc.sendMessage(msg);
        }
        this.pendingMessages = [];
      }, delay);
    });
  }
}
