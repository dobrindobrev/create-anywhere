import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SessionManager } from "./manager.js";

vi.mock("./process.js", () => {
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

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

function makeManager(
  overrides?: Partial<ConstructorParameters<typeof SessionManager>[0]>
) {
  return new SessionManager({
    maxConcurrent: 3,
    idleTimeoutMs: 60_000,
    maxSessionDurationMs: 600_000,
    claudeOpts: { claudePath: "claude" },
    defaultAutoApprove: false,
    ...overrides,
  });
}

describe("SessionManager", () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    manager = makeManager();
  });

  afterEach(() => {
    manager.shutdown();
    vi.useRealTimers();
  });

  describe("chatKey / sessionId", () => {
    it("creates a chatKey from platform and chatId", () => {
      expect(SessionManager.chatKey("telegram", "123")).toBe("telegram:123");
    });

    it("creates a sessionId from platform, chatId, projectId", () => {
      expect(SessionManager.sessionId("telegram", "123", "myapp")).toBe(
        "telegram:123:myapp"
      );
    });
  });

  describe("openSession", () => {
    it("creates a session and sets it as active", () => {
      const session = manager.openSession(
        "telegram", "chat1", "user1", "myapp", "/tmp/myapp"
      );
      expect(session.projectId).toBe("myapp");
      expect(session.platform).toBe("telegram");
      expect(manager.activeCount).toBe(1);
      expect(manager.getActiveSession("telegram", "chat1")).toBe(session);
    });

    it("returns existing session if already open", () => {
      const s1 = manager.openSession("telegram", "chat1", "user1", "myapp", "/tmp/myapp");
      const s2 = manager.openSession("telegram", "chat1", "user1", "myapp", "/tmp/myapp");
      expect(s1.id).toBe(s2.id);
      expect(manager.activeCount).toBe(1);
    });

    it("allows multiple sessions for different projects", () => {
      manager.openSession("telegram", "chat1", "user1", "app1", "/tmp/app1");
      manager.openSession("telegram", "chat1", "user1", "app2", "/tmp/app2");
      expect(manager.activeCount).toBe(2);
    });

    it("throws when max concurrent sessions reached", () => {
      manager.openSession("telegram", "c1", "u1", "p1", "/tmp/p1");
      manager.openSession("telegram", "c2", "u2", "p2", "/tmp/p2");
      manager.openSession("telegram", "c3", "u3", "p3", "/tmp/p3");
      expect(() =>
        manager.openSession("telegram", "c4", "u4", "p4", "/tmp/p4")
      ).toThrow("Maximum concurrent sessions reached");
    });
  });

  describe("getActiveSession", () => {
    it("returns undefined for non-existent session", () => {
      expect(manager.getActiveSession("telegram", "nope")).toBeUndefined();
    });
  });

  describe("switchSession", () => {
    it("switches active session", () => {
      manager.openSession("telegram", "chat1", "user1", "app1", "/tmp/app1");
      const s2 = manager.openSession("telegram", "chat1", "user1", "app2", "/tmp/app2");
      // active is now app2 (last opened)
      expect(manager.getActiveSession("telegram", "chat1")!.projectId).toBe("app2");
      // switch back to app1
      const switched = manager.switchSession("telegram", "chat1", "app1");
      expect(switched).toBeDefined();
      expect(manager.getActiveSession("telegram", "chat1")!.projectId).toBe("app1");
    });

    it("returns undefined for non-existent project", () => {
      expect(manager.switchSession("telegram", "chat1", "nope")).toBeUndefined();
    });
  });

  describe("getUserSessions", () => {
    it("returns all sessions for a user", () => {
      manager.openSession("telegram", "chat1", "user1", "app1", "/tmp/app1");
      manager.openSession("telegram", "chat1", "user1", "app2", "/tmp/app2");
      manager.openSession("telegram", "chat2", "user2", "app3", "/tmp/app3");
      expect(manager.getUserSessions("telegram", "user1")).toHaveLength(2);
      expect(manager.getUserSessions("telegram", "user2")).toHaveLength(1);
    });
  });

  describe("setAutoApprove", () => {
    it("returns false for non-existent session", () => {
      expect(manager.setAutoApprove("telegram", "nope", true)).toBe(false);
    });

    it("toggles autoApprove on active session", () => {
      manager.openSession("telegram", "chat1", "user1", "app", "/tmp/app");
      expect(manager.setAutoApprove("telegram", "chat1", true)).toBe(true);
      expect(manager.getActiveSession("telegram", "chat1")!.autoApprove).toBe(true);
    });
  });

  describe("destroySession", () => {
    it("removes session", () => {
      const s = manager.openSession("telegram", "chat1", "user1", "app", "/tmp/app");
      manager.destroySession(s.id);
      expect(manager.activeCount).toBe(0);
      expect(manager.getActiveSession("telegram", "chat1")).toBeUndefined();
    });
  });

  describe("stopByProject", () => {
    it("stops session by project id", () => {
      manager.openSession("telegram", "chat1", "user1", "app", "/tmp/app");
      expect(manager.stopByProject("telegram", "chat1", "app")).toBe(true);
      expect(manager.activeCount).toBe(0);
    });

    it("returns false for non-existent project", () => {
      expect(manager.stopByProject("telegram", "chat1", "nope")).toBe(false);
    });
  });

  describe("cleanup", () => {
    it("removes idle sessions", () => {
      manager.openSession("telegram", "chat1", "user1", "app", "/tmp/app");
      vi.advanceTimersByTime(65_000);
      vi.advanceTimersByTime(30_000);
      expect(manager.activeCount).toBe(0);
    });

    it("removes expired sessions", () => {
      const m = makeManager({
        idleTimeoutMs: 999_999,
        maxSessionDurationMs: 60_000,
      });
      m.openSession("telegram", "chat1", "user1", "app", "/tmp/app");
      vi.advanceTimersByTime(65_000);
      vi.advanceTimersByTime(30_000);
      expect(m.activeCount).toBe(0);
      m.shutdown();
    });
  });

  describe("shutdown", () => {
    it("clears all sessions", () => {
      manager.openSession("telegram", "c1", "u1", "p1", "/tmp/p1");
      manager.openSession("telegram", "c2", "u2", "p2", "/tmp/p2");
      manager.shutdown();
      expect(manager.activeCount).toBe(0);
    });
  });
});
