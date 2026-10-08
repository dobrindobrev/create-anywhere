import { type ClaudeProcessOptions } from "./process.js";
import { SupervisedProcess } from "./supervisor.js";
import { saveState, loadState, type PersistedSession } from "./persistence.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("session");

export interface Session {
  id: string;
  process: SupervisedProcess;
  projectId: string;
  projectPath: string;
  chatId: string;
  userId: string;
  platform: string;
  autoApprove: boolean;
  lastActivity: number;
  createdAt: number;
}

export interface SessionManagerConfig {
  maxConcurrent: number;
  idleTimeoutMs: number;
  maxSessionDurationMs: number;
  claudeOpts: Omit<ClaudeProcessOptions, "projectPath" | "systemPrompt">;
  defaultAutoApprove: boolean;
  /** Build a per-session system prompt with project context */
  buildSystemPrompt?: (projectId: string, projectPath: string) => string;
}

export type TextCallback = (session: Session, text: string) => void | Promise<void>;
export type ToolUseCallback = (
  session: Session,
  tool: string,
  input: Record<string, unknown>,
  toolUseId: string
) => void | Promise<void>;
export type ResultCallback = (
  session: Session,
  text: string,
  costUsd?: number
) => void | Promise<void>;
export type ErrorCallback = (session: Session, err: Error) => void | Promise<void>;
export type ExitCallback = (session: Session, code: number | null) => void | Promise<void>;
export type RestartedCallback = (session: Session, attempt: number) => void | Promise<void>;
export type FailedCallback = (session: Session) => void | Promise<void>;

/**
 * Manages per-chat Claude Code sessions using the stream-json protocol.
 * Each session is a supervised Claude Code child process with auto-restart.
 */
export class SessionManager {
  private sessions = new Map<string, Session>();
  /** Maps platform:chatId -> active session id */
  private activeSession = new Map<string, string>();
  private config: SessionManagerConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | undefined;

  // Callbacks for routing events back to IM adapters
  private onText?: TextCallback;
  private onToolUse?: ToolUseCallback;
  private onResult?: ResultCallback;
  private onError?: ErrorCallback;
  private onExit?: ExitCallback;
  private onRestarted?: RestartedCallback;
  private onFailed?: FailedCallback;

  constructor(config: SessionManagerConfig) {
    this.config = config;
    this.cleanupTimer = setInterval(() => this.cleanup(), 30_000);
  }

  /** Register event callbacks for routing output to IM */
  setCallbacks(cbs: {
    onText?: TextCallback;
    onToolUse?: ToolUseCallback;
    onResult?: ResultCallback;
    onError?: ErrorCallback;
    onExit?: ExitCallback;
    onRestarted?: RestartedCallback;
    onFailed?: FailedCallback;
  }): void {
    this.onText = cbs.onText;
    this.onToolUse = cbs.onToolUse;
    this.onResult = cbs.onResult;
    this.onError = cbs.onError;
    this.onExit = cbs.onExit;
    this.onRestarted = cbs.onRestarted;
    this.onFailed = cbs.onFailed;
  }

  static chatKey(platform: string, chatId: string): string {
    return `${platform}:${chatId}`;
  }

  static sessionId(platform: string, chatId: string, projectId: string): string {
    return `${platform}:${chatId}:${projectId}`;
  }

  /** Open or resume a session for a project */
  openSession(
    platform: string,
    chatId: string,
    userId: string,
    projectId: string,
    projectPath: string
  ): Session {
    const id = SessionManager.sessionId(platform, chatId, projectId);
    let session = this.sessions.get(id);

    if (session) {
      session.lastActivity = Date.now();
      this.activeSession.set(SessionManager.chatKey(platform, chatId), id);
      return session;
    }

    if (this.sessions.size >= this.config.maxConcurrent) {
      throw new Error(
        "Maximum concurrent sessions reached. Use /stop to close a session first."
      );
    }

    const systemPrompt = this.config.buildSystemPrompt?.(projectId, projectPath);
    const proc = new SupervisedProcess({
      ...this.config.claudeOpts,
      projectPath,
      autoApprove: this.config.defaultAutoApprove,
      ...(systemPrompt ? { systemPrompt } : {}),
    });

    session = {
      id,
      process: proc,
      projectId,
      projectPath,
      chatId,
      userId,
      platform,
      autoApprove: this.config.defaultAutoApprove,
      lastActivity: Date.now(),
      createdAt: Date.now(),
    };

    // Wire process events to callbacks
    this.wireProcessEvents(session);

    // Start the persistent process
    proc.start();

    this.sessions.set(id, session);
    this.activeSession.set(SessionManager.chatKey(platform, chatId), id);
    log.info({ id, projectId, projectPath }, "Session opened");
    this.persistState();
    return session;
  }

  /** Wire SupervisedProcess events to session manager callbacks */
  private wireProcessEvents(session: Session): void {
    const proc = session.process;

    proc.on("text", (text: string) => {
      session.lastActivity = Date.now();
      this.onText?.(session, text);
    });

    proc.on("toolUse", (tool: string, input: Record<string, unknown>, toolUseId: string) => {
      session.lastActivity = Date.now();
      this.onToolUse?.(session, tool, input, toolUseId);
    });

    proc.on("result", (text: string, costUsd?: number) => {
      session.lastActivity = Date.now();
      this.onResult?.(session, text, costUsd);
    });

    proc.on("error", (err: Error) => {
      log.error({ err, sessionId: session.id }, "Session error");
      this.onError?.(session, err);
    });

    proc.on("exit", (code: number | null) => {
      log.info({ sessionId: session.id, code }, "Session process exited");
      this.onExit?.(session, code);
      // Clean up the session on exit
      if (this.sessions.has(session.id)) {
        this.sessions.delete(session.id);
        const chatKey = SessionManager.chatKey(session.platform, session.chatId);
        if (this.activeSession.get(chatKey) === session.id) {
          this.activeSession.delete(chatKey);
        }
        this.persistState();
      }
    });

    proc.on("restarted", (attempt: number) => {
      log.info({ sessionId: session.id, attempt }, "Session process restarted");
      this.onRestarted?.(session, attempt);
    });

    proc.on("failed", () => {
      log.error({ sessionId: session.id }, "Session process failed after max restarts");
      this.onFailed?.(session);
    });

    // Track any stream activity to prevent idle timeout during long operations
    proc.on("activity", () => {
      session.lastActivity = Date.now();
    });
  }

  /** Send a user message to the active session */
  sendMessage(platform: string, chatId: string, text: string): void {
    const session = this.getActiveSession(platform, chatId);
    if (!session) {
      throw new Error(
        "No active session. Use /open <project> to start one."
      );
    }
    session.lastActivity = Date.now();
    session.process.sendMessage(text);
  }

  /** Get the active session for a chat */
  getActiveSession(platform: string, chatId: string): Session | undefined {
    const chatKey = SessionManager.chatKey(platform, chatId);
    const id = this.activeSession.get(chatKey);
    if (!id) return undefined;
    const session = this.sessions.get(id);
    if (!session) {
      this.activeSession.delete(chatKey);
      return undefined;
    }
    return session;
  }

  /** List all sessions for a user */
  getUserSessions(platform: string, userId: string): Session[] {
    return [...this.sessions.values()].filter(
      (s) => s.platform === platform && s.userId === userId
    );
  }

  /** Switch active session to a different project */
  switchSession(
    platform: string,
    chatId: string,
    projectId: string
  ): Session | undefined {
    const id = SessionManager.sessionId(platform, chatId, projectId);
    const session = this.sessions.get(id);
    if (session) {
      this.activeSession.set(SessionManager.chatKey(platform, chatId), id);
      session.lastActivity = Date.now();
    }
    return session;
  }

  /** Toggle auto-approve for the active session */
  setAutoApprove(platform: string, chatId: string, value: boolean): boolean {
    const session = this.getActiveSession(platform, chatId);
    if (!session) return false;
    session.autoApprove = value;
    log.info({ id: session.id, autoApprove: value }, "Auto-approve toggled");
    return true;
  }

  /** Destroy a session by id */
  destroySession(id: string): void {
    const session = this.sessions.get(id);
    if (session) {
      session.process.kill();
      this.sessions.delete(id);
      const chatKey = SessionManager.chatKey(session.platform, session.chatId);
      if (this.activeSession.get(chatKey) === id) {
        this.activeSession.delete(chatKey);
      }
      log.info({ id }, "Session destroyed");
      this.persistState();
    }
  }

  /** Stop a session by project id for a chat */
  stopByProject(
    platform: string,
    chatId: string,
    projectId: string
  ): boolean {
    const id = SessionManager.sessionId(platform, chatId, projectId);
    if (this.sessions.has(id)) {
      this.destroySession(id);
      return true;
    }
    return false;
  }

  /** Stop the active session for a chat */
  stopActive(platform: string, chatId: string): boolean {
    const session = this.getActiveSession(platform, chatId);
    if (session) {
      this.destroySession(session.id);
      return true;
    }
    return false;
  }

  /** Restore sessions from disk on startup */
  restoreFromDisk(projects: Record<string, string>): Session[] {
    const persisted = loadState();
    const restored: Session[] = [];

    for (const ps of persisted) {
      // Only restore if the project still exists in config
      if (!projects[ps.projectId]) {
        log.warn({ projectId: ps.projectId }, "Skipping persisted session — project not in config");
        continue;
      }

      try {
        // Use a fresh session ID — old ones may be locked by Claude Code
        const systemPrompt = this.config.buildSystemPrompt?.(ps.projectId, ps.projectPath);
        const proc = new SupervisedProcess({
          ...this.config.claudeOpts,
          projectPath: ps.projectPath,
          autoApprove: ps.autoApprove,
          ...(systemPrompt ? { systemPrompt } : {}),
        });

        const session: Session = {
          id: ps.id,
          process: proc,
          projectId: ps.projectId,
          projectPath: ps.projectPath,
          chatId: ps.chatId,
          userId: ps.userId,
          platform: ps.platform,
          autoApprove: ps.autoApprove,
          lastActivity: Date.now(),
          createdAt: ps.createdAt,
        };

        this.wireProcessEvents(session);
        proc.start();

        this.sessions.set(session.id, session);
        this.activeSession.set(
          SessionManager.chatKey(session.platform, session.chatId),
          session.id
        );
        restored.push(session);
        log.info({ id: session.id }, "Session restored from disk");
      } catch (err) {
        log.error({ err, id: ps.id }, "Failed to restore session");
      }
    }

    return restored;
  }

  private persistState(): void {
    const sessions: PersistedSession[] = [...this.sessions.values()].map((s) => ({
      id: s.id,
      projectId: s.projectId,
      projectPath: s.projectPath,
      chatId: s.chatId,
      userId: s.userId,
      platform: s.platform,
      autoApprove: s.autoApprove,
      sessionId: s.process.sessionId,
      createdAt: s.createdAt,
    }));
    saveState(sessions);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      const idle = now - session.lastActivity > this.config.idleTimeoutMs;
      const expired =
        now - session.createdAt > this.config.maxSessionDurationMs;
      if (idle || expired) {
        log.info({ id, idle, expired }, "Cleaning up session");
        this.destroySession(id);
      }
    }
  }

  shutdown(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const id of this.sessions.keys()) {
      this.destroySession(id);
    }
    log.info("All sessions shut down");
  }

  get activeCount(): number {
    return this.sessions.size;
  }
}
