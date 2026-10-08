import { loadConfig } from "./config/index.js";
import { initLogger, getLogger } from "./utils/logger.js";
import { SessionManager, type Session } from "./session/manager.js";
import { createHandlers } from "./commands/index.js";
import type { PlatformAdapter, MessageButton } from "./adapters/types.js";
import { TelegramAdapter } from "./adapters/telegram.js";
import { WhatsAppAdapter } from "./adapters/whatsapp.js";
import { ViberAdapter } from "./adapters/viber.js";

/** Build a per-session system prompt that includes the project context */
function buildSystemPrompt(projectId: string, projectPath: string): string {
  return [
    "You are being used through a messaging bot (Telegram/WhatsApp/Viber), not a terminal.",
    "",
    `PROJECT CONTEXT:`,
    `- Project name: "${projectId}"`,
    `- Project directory: ${projectPath}`,
    `- You MUST work exclusively within this directory. Do NOT navigate to parent directories or other projects.`,
    `- If the directory is empty, that means the project needs to be built from scratch IN THIS DIRECTORY.`,
    "",
    "IMPORTANT CONSTRAINTS:",
    "- Do NOT use AskUserQuestion, ExitPlanMode, or EnterPlanMode tools — they will fail in this environment.",
    "- When you need user input or want to present choices, write them as a NUMBERED LIST in your text output. Example:",
    '  "Which tech stack would you like?',
    "  1. Vanilla HTML/CSS/JS — no build step, works immediately",
    "  2. React + Vite — modern SPA with hot reload",
    '  3. Next.js — full-stack with SSR"',
    "- The user will reply with a number (1, 2, 3) or a text answer.",
    "- Keep responses concise — they're read on a phone screen.",
    "- Do NOT enter plan mode. Just proceed directly with implementation after getting user input.",
  ].join("\n");
}

/**
 * Detect numbered option lists in text and extract them as buttons.
 * Matches patterns like "1. Option label" or "1) Option label".
 */
function extractNumberedOptions(text: string): MessageButton[] | null {
  const lines = text.split("\n");
  const options: MessageButton[] = [];

  for (const line of lines) {
    const match = line.match(/^\s*(\d+)[.)]\s+(.+)/);
    if (match) {
      const num = match[1];
      // Truncate label to 40 chars for button display
      let label = match[2].replace(/\*\*/g, "").trim();
      // Strip description after em-dash or long dash
      const dashIdx = label.search(/\s[—–-]\s/);
      if (dashIdx > 0) label = label.slice(0, dashIdx);
      if (label.length > 40) label = label.slice(0, 37) + "...";
      options.push({
        label: `${num}. ${label}`,
        callbackData: `choice:${num}`,
      });
    }
  }

  // Only return buttons if we found 2-6 numbered options
  return options.length >= 2 && options.length <= 6 ? options : null;
}

async function main() {
  const config = loadConfig();
  initLogger(config.logging.level);
  const log = getLogger("main");

  log.info("Starting create-anywhere...");

  const adapters = new Map<string, PlatformAdapter>();

  if (config.telegram.enabled && config.env.TELEGRAM_BOT_TOKEN) {
    adapters.set(
      "telegram",
      new TelegramAdapter(config.env.TELEGRAM_BOT_TOKEN)
    );
  }

  if (config.whatsapp.enabled) {
    adapters.set("whatsapp", new WhatsAppAdapter());
  }

  if (
    config.viber.enabled &&
    config.env.VIBER_BOT_TOKEN &&
    config.env.VIBER_BOT_NAME &&
    config.env.VIBER_WEBHOOK_URL
  ) {
    adapters.set(
      "viber",
      new ViberAdapter({
        token: config.env.VIBER_BOT_TOKEN,
        name: config.env.VIBER_BOT_NAME,
        avatar: config.env.VIBER_BOT_AVATAR,
        webhookUrl: config.env.VIBER_WEBHOOK_URL,
        webhookPort: config.viber.webhookPort,
      })
    );
  }

  if (adapters.size === 0) {
    log.fatal("No adapters enabled. Check config and env vars.");
    process.exit(1);
  }

  const sessionManager = new SessionManager({
    maxConcurrent: config.session.maxConcurrent,
    idleTimeoutMs: config.session.idleTimeoutMs,
    maxSessionDurationMs: config.session.maxSessionDurationMs,
    claudeOpts: {
      claudePath: config.env.CLAUDE_CODE_PATH,
      model: config.model,
      globalEnv: config.globalEnv,
    },
    buildSystemPrompt,
    defaultAutoApprove: config.defaultAutoApprove,
  });

  // Helper to send to the right adapter (with optional buttons)
  const sendToChat = async (
    session: Session,
    text: string,
    buttons?: MessageButton[]
  ) => {
    const adapter = adapters.get(session.platform);
    if (!adapter) return;
    await adapter.sendMessage({
      chatId: session.chatId,
      text,
      parseMode: "markdown",
      buttons,
    });
  };

  // Wire session events -> IM output
  sessionManager.setCallbacks({
    onText: async (session, text) => {
      // Detect numbered options and add inline buttons
      const buttons = extractNumberedOptions(text);
      await sendToChat(session, text, buttons ?? undefined);
    },
    onToolUse: async (_session, tool, _input, _toolId) => {
      // In --print mode, Claude Code handles tool execution internally.
      // Just log it — don't flood the user's chat with every tool call.
      log.info({ tool }, "Claude using tool");
    },
    onResult: async (session, _text, costUsd) => {
      // Text was already sent via onText — just show cost info
      if (costUsd !== undefined) {
        await sendToChat(session, `Done. (cost: $${costUsd.toFixed(4)})`);
      }
    },
    onError: async (session, err) => {
      await sendToChat(session, `Error: ${err.message}`);
    },
    onExit: async (session, code) => {
      if (code !== 0 && code !== null) {
        await sendToChat(session, `Session ended unexpectedly (code ${code}).`);
      }
    },
    onRestarted: async (session, attempt) => {
      await sendToChat(
        session,
        `Claude process crashed and was restarted (attempt ${attempt}/3). You can continue working.`
      );
    },
    onFailed: async (session) => {
      await sendToChat(
        session,
        `Claude process failed after 3 restart attempts. Use /stop and /open to start a fresh session.`
      );
    },
  });

  const { messageHandler, buttonHandler } = createHandlers(
    adapters,
    sessionManager,
    config
  );

  for (const [name, adapter] of adapters) {
    adapter.onMessage(messageHandler);
    adapter.onButtonClick(buttonHandler);
    try {
      await adapter.start();
      log.info({ adapter: name }, "Adapter started");
    } catch (err) {
      log.error({ err, adapter: name }, "Failed to start adapter");
    }
  }

  // Restore sessions from disk
  const restored = sessionManager.restoreFromDisk(config.projects);
  if (restored.length > 0) {
    log.info({ count: restored.length }, "Restored sessions from disk");
    for (const session of restored) {
      sendToChat(session, `Reconnected to project "${session.projectId}".`).catch(
        () => {}
      );
    }
  }

  log.info(
    { adapters: [...adapters.keys()] },
    "create-anywhere is running"
  );

  // Send startup greeting to all allowlisted users on each platform
  const greetings = [
    "Hey there, creator! I'm awake, caffeinated, and ready to turn your wildest ideas into code. Let's build something amazing together!",
    "",
    "Send /help to see what I can do, or just tell me what you want to work on.",
  ].join("\n");

  for (const [platform, adapter] of adapters) {
    const userIds =
      config.allowlist[platform as keyof typeof config.allowlist] ?? [];
    for (const userId of userIds) {
      adapter
        .sendMessage({ chatId: userId, text: greetings })
        .catch((err) => {
          log.debug(
            { err, platform, userId },
            "Could not send startup greeting (user may not have started the bot yet)"
          );
        });
    }
  }

  const shutdown = async () => {
    log.info("Shutting down...");
    sessionManager.shutdown();
    for (const [, adapter] of adapters) {
      await adapter.stop();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
