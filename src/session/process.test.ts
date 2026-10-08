import { describe, it, expect, vi } from "vitest";
import { ClaudeProcess } from "./process.js";

vi.mock("../utils/logger.js", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }),
}));

describe("ClaudeProcess", () => {
  it("constructs with options and generates sessionId", () => {
    const proc = new ClaudeProcess({
      claudePath: "/usr/bin/claude",
      projectPath: "/tmp",
    });
    expect(proc.isRunning).toBe(false);
    expect(proc.sessionId).toBeTruthy();
  });

  it("uses provided sessionId", () => {
    const proc = new ClaudeProcess({
      claudePath: "claude",
      projectPath: "/tmp",
      sessionId: "my-id",
    });
    expect(proc.sessionId).toBe("my-id");
  });

  it("sendMessage throws when no process running", () => {
    const proc = new ClaudeProcess({
      claudePath: "claude",
      projectPath: "/tmp",
    });
    expect(() => proc.sendMessage("test")).toThrow(
      "Claude process is not running"
    );
  });

  it("kill is safe when no process running", () => {
    const proc = new ClaudeProcess({
      claudePath: "claude",
      projectPath: "/tmp",
    });
    proc.kill();
    expect(proc.isRunning).toBe(false);
  });
});
