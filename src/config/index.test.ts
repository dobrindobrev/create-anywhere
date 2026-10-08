import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { loadConfig } from "./index.js";
import { readFileSync } from "node:fs";

vi.mock("node:fs", () => ({
  readFileSync: vi.fn(),
}));

vi.mock("dotenv/config", () => ({}));

const mockedReadFileSync = vi.mocked(readFileSync);

describe("loadConfig", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...origEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("returns defaults when config file is missing", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const config = loadConfig();
    expect(config.telegram.enabled).toBe(false);
    expect(config.whatsapp.enabled).toBe(false);
    expect(config.viber.enabled).toBe(false);
    expect(config.session.maxConcurrent).toBe(5);
    expect(config.session.idleTimeoutMs).toBe(300_000);
    expect(config.session.maxSessionDurationMs).toBe(3_600_000);
    expect(config.logging.level).toBe("info");
    expect(config.projects).toEqual({});
    expect(config.allowlist).toEqual({
      telegram: [],
      whatsapp: [],
      viber: [],
    });
    expect(config.defaultAutoApprove).toBe(false);
    expect(config.env.CLAUDE_CODE_PATH).toBe("claude");
  });

  it("parses config file correctly", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({
        telegram: { enabled: true },
        session: { maxConcurrent: 10 },
        projects: { myapp: "/tmp/myapp" },
        allowlist: { telegram: ["123"] },
      })
    );

    const config = loadConfig();
    expect(config.telegram.enabled).toBe(true);
    expect(config.session.maxConcurrent).toBe(10);
    expect(config.projects).toEqual({ myapp: "/tmp/myapp" });
    expect(config.allowlist.telegram).toEqual(["123"]);
    // defaults still applied for missing fields
    expect(config.whatsapp.enabled).toBe(false);
  });

  it("uses LOG_LEVEL env var to override config", () => {
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ logging: { level: "warn" } })
    );
    process.env.LOG_LEVEL = "debug";

    const config = loadConfig();
    expect(config.logging.level).toBe("debug");
  });

  it("reads env vars into config.env", () => {
    mockedReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    process.env.CLAUDE_CODE_PATH = "/usr/local/bin/claude";

    const config = loadConfig();
    expect(config.env.TELEGRAM_BOT_TOKEN).toBe("test-token");
    expect(config.env.CLAUDE_CODE_PATH).toBe("/usr/local/bin/claude");
  });
});
