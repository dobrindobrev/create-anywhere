import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHandlers } from "./index.js";
import type { PlatformAdapter, IncomingMessage } from "../adapters/types.js";
import { SessionManager } from "../session/manager.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

vi.mock("../session/process.js", () => {
  return {
    ClaudeProcess: class MockClaudeProcess {
      sessionId = "mock-uuid";
      start = vi.fn();
      sendMessage = vi.fn();
      kill = vi.fn();
      isRunning = true;
      on = vi.fn();
      emit = vi.fn();
      constructor() {}
    },
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn().mockImplementation(() => {
    throw new Error("ENOENT");
  }),
}));

function mockAdapter(): PlatformAdapter {
  return {
    name: "telegram",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn(),
    onButtonClick: vi.fn(),
  };
}

function makeMsg(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    platform: "telegram",
    chatId: "chat1",
    userId: "user1",
    userName: "Test",
    text: "hello",
    isCommand: false,
    timestamp: new Date(),
    ...overrides,
  };
}

function makeConfig(overrides: Record<string, any> = {}) {
  return {
    telegram: { enabled: true },
    whatsapp: { enabled: false },
    viber: { enabled: false, webhookPort: 8080 },
    session: { maxConcurrent: 5, idleTimeoutMs: 300_000, maxSessionDurationMs: 3_600_000 },
    logging: { level: "info" as const },
    projects: {} as Record<string, string>,
    allowlist: { telegram: [] as string[], whatsapp: [] as string[], viber: [] as string[] },
    defaultAutoApprove: false,
    env: { CLAUDE_CODE_PATH: "claude" },
    ...overrides,
  };
}

describe("createHandlers", () => {
  let adapter: PlatformAdapter;
  let adapters: Map<string, PlatformAdapter>;
  let sessionManager: SessionManager;
  let config: ReturnType<typeof makeConfig>;

  beforeEach(() => {
    adapter = mockAdapter();
    adapters = new Map([["telegram", adapter]]);
    sessionManager = new SessionManager({
      maxConcurrent: 5,
      idleTimeoutMs: 300_000,
      maxSessionDurationMs: 3_600_000,
      claudeOpts: { claudePath: "claude" },
      defaultAutoApprove: false,
    });
    config = makeConfig();
  });

  afterEach(() => {
    sessionManager.shutdown();
  });

  it("rejects unauthorized users", async () => {
    config.allowlist.telegram = ["allowed-user"];
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(makeMsg({ userId: "not-allowed" }));
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "You are not authorized to use this bot.",
      })
    );
  });

  it("prompts to open a project when no active session", async () => {
    config.projects = { myapp: "/tmp/myapp" };
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(makeMsg({ text: "hi" }));
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("No active session"),
      })
    );
  });

  it("handles /help command", async () => {
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({ isCommand: true, command: "/help", text: "/help" })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Create Anywhere"),
      })
    );
  });

  it("handles /projects with no projects", async () => {
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({ isCommand: true, command: "/projects", text: "/projects" })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("No projects configured"),
      })
    );
  });

  it("handles /projects with projects", async () => {
    config.projects = { myapp: "/tmp/myapp" };
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({ isCommand: true, command: "/projects", text: "/projects" })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("myapp"),
      })
    );
  });

  it("handles /open with valid project", async () => {
    config.projects = { myapp: "/tmp/myapp" };
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({
        isCommand: true,
        command: "/open",
        args: ["myapp"],
        text: "/open myapp",
      })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Session opened"),
      })
    );
  });

  it("handles /open with unknown project", async () => {
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({
        isCommand: true,
        command: "/open",
        args: ["nope"],
        text: "/open nope",
      })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("not found"),
      })
    );
  });

  it("handles /status with no active session", async () => {
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({ isCommand: true, command: "/status", text: "/status" })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("No active session"),
      })
    );
  });

  it("handles /reset with no sessions", async () => {
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({ isCommand: true, command: "/reset", text: "/reset" })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Stopped 0 session"),
      })
    );
  });

  it("handles unknown command", async () => {
    const { messageHandler } = createHandlers(adapters, sessionManager, config as any);
    await messageHandler(
      makeMsg({ isCommand: true, command: "/unknown", text: "/unknown" })
    );
    expect(adapter.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Unknown command"),
      })
    );
  });
});
