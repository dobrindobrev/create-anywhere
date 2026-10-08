import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { getLogger } from "../utils/logger.js";
import type { ClaudeStreamEvent, ContentBlock } from "./types.js";

const log = getLogger("process");

export interface ClaudeProcessOptions {
  claudePath: string;
  projectPath: string;
  sessionId?: string;
  autoApprove?: boolean;
  allowedTools?: string[];
  model?: string;
  systemPrompt?: string;
  /** Extra env vars injected into the child process (e.g. API keys) */
  globalEnv?: Record<string, string>;
}

/**
 * Events emitted:
 *  - "text"      (text: string)                          — buffered text output
 *  - "toolUse"   (tool: string, input: object, id: string) — tool approval needed
 *  - "toolResult"(id: string, output: string, isError: boolean)
 *  - "result"    (text: string, costUsd?: number)        — final result
 *  - "error"     (err: Error)
 *  - "exit"      (code: number | null)
 */
export class ClaudeProcess extends EventEmitter {
  private proc: ChildProcess | null = null;
  private opts: ClaudeProcessOptions;
  readonly sessionId: string;
  private _isRunning = false;
  private textBuffer = "";
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private pendingMessages: string[] = [];

  constructor(opts: ClaudeProcessOptions) {
    super();
    this.opts = opts;
    this.sessionId = opts.sessionId ?? randomUUID();
  }

  /** Build the base args (without --print and prompt) */
  private buildArgs(): string[] {
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--input-format", "stream-json",
      "--session-id", this.sessionId,
      "--verbose",
    ];

    if (this.opts.autoApprove) {
      args.push("--dangerously-skip-permissions");
    }

    if (this.opts.allowedTools?.length) {
      args.push("--allowedTools", ...this.opts.allowedTools);
    }

    if (this.opts.model) {
      args.push("--model", this.opts.model);
    }

    if (this.opts.systemPrompt) {
      args.push("--system-prompt", this.opts.systemPrompt);
    }

    return args;
  }

  /**
   * Spawn the Claude Code process with the first user message as the prompt.
   * --print requires a prompt argument, so we defer spawning until the first message.
   */
  start(): void {
    // Just mark as ready — actual spawn happens on first sendMessage
    this._isRunning = true;
  }

  private spawnProcess(initialPrompt: string): void {
    const args = this.buildArgs();
    // Don't pass prompt as CLI arg — with --input-format stream-json,
    // the prompt must be sent via stdin

    // Clean env: remove all CLAUDE* vars to prevent nesting detection
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (key.startsWith("CLAUDE")) {
        delete env[key];
      }
    }
    // Merge global env vars (API keys etc.)
    if (this.opts.globalEnv) {
      Object.assign(env, this.opts.globalEnv);
    }

    log.info(
      { sessionId: this.sessionId, cwd: this.opts.projectPath, claudePath: this.opts.claudePath, args },
      "Spawning Claude process"
    );

    this.proc = spawn(this.opts.claudePath, args, {
      cwd: this.opts.projectPath,
      stdio: ["pipe", "pipe", "pipe"],
      env,
    });

    // Parse newline-delimited JSON from stdout
    const rl = createInterface({ input: this.proc.stdout! });
    rl.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const event: ClaudeStreamEvent = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        log.debug({ line }, "Non-JSON stdout line");
      }
    });

    // Log stderr at warn level so it's visible with default log settings
    const stderrRl = createInterface({ input: this.proc.stderr! });
    stderrRl.on("line", (line) => {
      log.warn({ line }, "Claude stderr");
    });

    this.proc.on("error", (err) => {
      log.error({ err }, "Claude process spawn error");
      this._isRunning = false;
      this.proc = null;
      this.emit("error", err);
    });

    this.proc.on("close", (code) => {
      log.info({ code, sessionId: this.sessionId }, "Claude process exited");
      this._isRunning = false;
      this.proc = null;
      this.flushTextBuffer();
      this.emit("exit", code);
    });

    this.started = true;

    // Send the initial prompt via stdin
    this.sendStreamMessage(initialPrompt);

    // Send any messages that queued while we were spawning
    for (const msg of this.pendingMessages) {
      this.sendStreamMessage(msg);
    }
    this.pendingMessages = [];
  }

  /** Send a user message — spawns the process on first call */
  sendMessage(text: string): void {
    if (!this._isRunning) {
      throw new Error("Claude process is not running");
    }

    if (!this.started) {
      // First message becomes the prompt argument
      this.spawnProcess(text);
      return;
    }

    this.sendStreamMessage(text);
  }

  private sendStreamMessage(text: string): void {
    if (!this.proc?.stdin?.writable) {
      this.pendingMessages.push(text);
      return;
    }
    const msg = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text }],
      },
    });
    this.proc.stdin.write(msg + "\n");
    log.info({ sessionId: this.sessionId }, "Sent user message via stdin");
  }

  /** Handle a parsed stream-json event from stdout */
  private handleEvent(event: ClaudeStreamEvent): void {
    log.info({ type: event.type, event: JSON.stringify(event).slice(0, 500) }, "Received Claude event");
    // Emit activity on every event so session manager can track liveness
    this.emit("activity");
    switch (event.type) {
      case "system": {
        log.info({ sessionId: this.sessionId }, "Claude session initialized");
        break;
      }

      case "assistant": {
        const msg = (event as any).message;
        if (!msg?.content) break;
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "text" && block.text) {
            this.bufferText(block.text);
          } else if (block.type === "tool_use" && block.name && block.id) {
            this.flushTextBuffer();
            this.emit("toolUse", block.name, block.input ?? {}, block.id);
          }
        }
        break;
      }

      case "content_block_delta": {
        const delta = (event as any).delta;
        if (delta?.type === "text_delta" && delta.text) {
          this.bufferText(delta.text);
        }
        break;
      }

      case "result": {
        this.flushTextBuffer();
        const resultText = (event as any).result ?? "";
        const cost = (event as any).cost_usd;
        this.emit("result", resultText, cost);
        break;
      }

      case "error": {
        this.flushTextBuffer();
        const errMsg =
          (event as any).error?.message ??
          (event as any).message ??
          "Unknown error";
        this.emit("error", new Error(errMsg));
        break;
      }

      default:
        log.debug({ type: event.type }, "Unhandled stream event type");
    }
  }

  /** Buffer text and flush after a short delay to coalesce streaming chunks */
  private bufferText(text: string): void {
    this.textBuffer += text;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => this.flushTextBuffer(), 300);
  }

  private flushTextBuffer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.textBuffer) {
      this.emit("text", this.textBuffer);
      this.textBuffer = "";
    }
  }

  /** Kill the child process */
  kill(): void {
    if (this.proc) {
      this.proc.kill("SIGTERM");
      const p = this.proc;
      const forceKillTimer = setTimeout(() => {
        try {
          p.kill("SIGKILL");
        } catch {
          // already dead
        }
      }, 5000);
      p.on("close", () => clearTimeout(forceKillTimer));
    }
  }

  get isRunning(): boolean {
    return this._isRunning;
  }
}
