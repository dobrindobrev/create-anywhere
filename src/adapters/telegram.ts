import { Telegraf, Markup } from "telegraf";
import type {
  PlatformAdapter,
  MessageHandler,
  ButtonClickHandler,
  OutgoingMessage,
  IncomingMessage,
} from "./types.js";
import { chunkText } from "./types.js";
import { getLogger } from "../utils/logger.js";
import { withRetry } from "../utils/retry.js";

const log = getLogger("telegram");
const MAX_MSG_LEN = 4096;

function parseCommand(text: string): {
  isCommand: boolean;
  command?: string;
  args?: string[];
} {
  if (!text.startsWith("/")) return { isCommand: false };
  const parts = text.split(/\s+/);
  const command = parts[0].replace(/@\S+$/, ""); // strip @botname
  return { isCommand: true, command, args: parts.slice(1) };
}

export class TelegramAdapter implements PlatformAdapter {
  readonly name = "telegram";
  private bot: Telegraf;
  private messageHandlers: MessageHandler[] = [];
  private buttonHandlers: ButtonClickHandler[] = [];

  constructor(token: string) {
    this.bot = new Telegraf(token);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onButtonClick(handler: ButtonClickHandler): void {
    this.buttonHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.bot.on("text", async (ctx) => {
      const msg = ctx.message;
      const { isCommand, command, args } = parseCommand(msg.text);

      const incoming: IncomingMessage = {
        platform: "telegram",
        chatId: String(msg.chat.id),
        userId: String(msg.from.id),
        userName:
          msg.from.username ??
          [msg.from.first_name, msg.from.last_name].filter(Boolean).join(" "),
        text: msg.text,
        isCommand,
        command,
        args,
        timestamp: new Date(msg.date * 1000),
        raw: msg,
      };

      for (const h of this.messageHandlers) {
        await h(incoming);
      }
    });

    this.bot.on("callback_query", async (ctx) => {
      const cb = ctx.callbackQuery;
      if (!("data" in cb) || !cb.data) return;
      await ctx.answerCbQuery();

      for (const h of this.buttonHandlers) {
        await h(
          String(cb.message?.chat.id ?? ""),
          String(cb.from.id),
          cb.data
        );
      }
    });

    this.bot.catch((err) => {
      log.error({ err }, "Telegraf error");
    });

    // launch() starts long-polling — don't await it or it blocks startup
    this.bot.launch().catch((err) => {
      log.error({ err }, "Telegram polling error");
    });
    log.info("Telegram adapter started");
  }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    const chunks = chunkText(msg.text, MAX_MSG_LEN);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const extra: Record<string, any> = {};

      if (msg.parseMode === "markdown") {
        extra.parse_mode = "Markdown";
      }

      // Attach buttons only to the last chunk
      if (isLast && msg.buttons?.length) {
        const keyboard = Markup.inlineKeyboard(
          msg.buttons.map((b) =>
            Markup.button.callback(b.label, b.callbackData)
          )
        );
        Object.assign(extra, keyboard);
      }

      try {
        await withRetry(
          () => this.bot.telegram.sendMessage(msg.chatId, chunks[i], extra),
          {
            maxAttempts: 3,
            delayMs: 1000,
            retryIf: (err: any) => {
              const code = err?.response?.error_code;
              return code === 429 || code === 500 || code === 502 || err?.code === "ECONNRESET";
            },
          }
        );
      } catch (err: any) {
        // If markdown parsing fails, retry as plain text
        if (err?.response?.description?.includes("can't parse entities")) {
          log.warn("Markdown parse failed, retrying as plain text");
          const plainExtra = { ...extra };
          delete plainExtra.parse_mode;
          await this.bot.telegram.sendMessage(msg.chatId, chunks[i], plainExtra);
        } else {
          throw err;
        }
      }
    }
  }

  async stop(): Promise<void> {
    this.bot.stop("graceful shutdown");
    log.info("Telegram adapter stopped");
  }
}
