import { z } from "zod";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "dotenv/config";

const PlatformConfigSchema = z.object({
  enabled: z.boolean().default(false),
});

const ViberConfigSchema = PlatformConfigSchema.extend({
  webhookPort: z.number().int().positive().default(8080),
});

const SessionConfigSchema = z.object({
  maxConcurrent: z.number().int().positive().default(5),
  idleTimeoutMs: z.number().int().positive().default(300_000),
  maxSessionDurationMs: z.number().int().positive().default(3_600_000),
});

const LoggingConfigSchema = z.object({
  level: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .default("info"),
});

const FileConfigSchema = z.object({
  telegram: PlatformConfigSchema.default({}),
  whatsapp: PlatformConfigSchema.default({}),
  viber: ViberConfigSchema.default({}),
  session: SessionConfigSchema.default({}),
  logging: LoggingConfigSchema.default({}),
  /** Map of project identifiers to absolute paths on disk */
  projects: z.record(z.string(), z.string()).default({}),
  /** Per-platform user allowlists. If empty, all users are allowed. */
  allowlist: z
    .object({
      telegram: z.array(z.string()).default([]),
      whatsapp: z.array(z.string()).default([]),
      viber: z.array(z.string()).default([]),
    })
    .default({}),
  /** Environment variables passed to all Claude Code child processes */
  globalEnv: z.record(z.string(), z.string()).default({}),
  /** Whether new sessions start with auto-approve on */
  defaultAutoApprove: z.boolean().default(false),
  /** Base path for /new command project creation */
  projectsRoot: z.string().optional(),
  /** Claude model to use (e.g. "sonnet", "opus", "haiku") */
  model: z.string().optional(),
});

/** Treat missing or empty env vars as undefined so unused platforms don't fail validation */
const optionalString = z.string().optional().transform(v => v || undefined);
const optionalUrl = z.string().optional().transform(v => v || undefined).pipe(z.string().url().optional());

const EnvSchema = z.object({
  TELEGRAM_BOT_TOKEN: optionalString,
  VIBER_BOT_TOKEN: optionalString,
  VIBER_BOT_NAME: optionalString,
  VIBER_BOT_AVATAR: optionalUrl,
  VIBER_WEBHOOK_URL: optionalUrl,
  CLAUDE_CODE_PATH: z.string().default("claude"),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace"])
    .optional(),
});

export type AppConfig = z.infer<typeof FileConfigSchema> & {
  env: z.infer<typeof EnvSchema>;
};

export function loadConfig(): AppConfig {
  const configPath = resolve(process.cwd(), "config", "default.json");
  let raw: unknown = {};
  try {
    raw = JSON.parse(readFileSync(configPath, "utf-8"));
  } catch {
    // use defaults if config file missing
  }

  const fileConfig = FileConfigSchema.parse(raw);
  const env = EnvSchema.parse(process.env);

  if (env.LOG_LEVEL) {
    fileConfig.logging.level = env.LOG_LEVEL;
  }

  return { ...fileConfig, env };
}

/** Persist the current config back to default.json */
export function saveConfig(config: AppConfig): void {
  const configPath = resolve(process.cwd(), "config", "default.json");
  // Write everything except env (which comes from .env, not the config file)
  const { env, ...fileConfig } = config;
  writeFileSync(configPath, JSON.stringify(fileConfig, null, 2) + "\n", "utf-8");
}

/** Check if a user is authorized on a given platform */
export function isAuthorized(
  config: AppConfig,
  platform: string,
  userId: string
): boolean {
  const allowlist = (config.allowlist as Record<string, string[]>)[platform];
  if (!allowlist || allowlist.length === 0) return true;
  return allowlist.includes(userId);
}
