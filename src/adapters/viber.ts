import ViberBotModule from "viber-bot";
const { Bot: ViberBot, Events, Message } = ViberBotModule as any;
import type {
  PlatformAdapter,
  MessageHandler,
  ButtonClickHandler,
  OutgoingMessage,
  IncomingMessage,
} from "./types.js";
import { chunkText } from "./types.js";
import { getLogger } from "../utils/logger.js";
import http from "node:http";

const log = getLogger("viber");
const MAX_MSG_LEN = 7000;

interface ViberConfig {
  token: string;
  name: string;
  avatar?: string;
  webhookUrl: string;
  webhookPort: number;
}

export class ViberAdapter implements PlatformAdapter {
  readonly name = "viber";
  private bot: InstanceType<typeof ViberBot>;
  private server: http.Server | undefined;
  private config: ViberConfig;
  private messageHandlers: MessageHandler[] = [];
  private buttonHandlers: ButtonClickHandler[] = [];

  constructor(config: ViberConfig) {
    this.config = config;
    this.bot = new ViberBot(log as any, {
      authToken: config.token,
      name: config.name,
      avatar: config.avatar,
    });
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onButtonClick(handler: ButtonClickHandler): void {
    this.buttonHandlers.push(handler);
  }

  async start(): Promise<void> {
    this.bot.on(Events.MESSAGE_RECEIVED, (message: any, response: any) => {
      const text: string | undefined = message.text;
      if (!text) return;

      const { isCommand, command, args } = this.parseCommand(text);

      const incoming: IncomingMessage = {
        platform: "viber",
        chatId: response.userProfile.id,
        userId: response.userProfile.id,
        userName: response.userProfile.name ?? "Unknown",
        text,
        isCommand,
        command,
        args,
        timestamp: new Date(),
        raw: { message, response },
      };

      for (const h of this.messageHandlers) {
        h(incoming);
      }
    });

    // Handle keyboard callback (Viber sends these as regular text messages with tracking data)
    this.bot.on(Events.MESSAGE_RECEIVED, (message: any, response: any) => {
      const trackingData: string | undefined = message.trackingData;
      if (!trackingData) return;

      for (const h of this.buttonHandlers) {
        h(response.userProfile.id, response.userProfile.id, trackingData);
      }
    });

    await new Promise<void>((resolve, reject) => {
      try {
        this.server = http.createServer(this.bot.middleware());
        this.server.listen(this.config.webhookPort, () => {
          this.bot.setWebhook(this.config.webhookUrl);
          log.info(
            { port: this.config.webhookPort },
            "Viber adapter started"
          );
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private parseCommand(text: string): {
    isCommand: boolean;
    command?: string;
    args?: string[];
  } {
    if (!text.startsWith("/")) return { isCommand: false };
    const parts = text.split(/\s+/);
    return { isCommand: true, command: parts[0], args: parts.slice(1) };
  }

  async sendMessage(msg: OutgoingMessage): Promise<void> {
    const TextMessage = Message.Text;
    const chunks = chunkText(msg.text, MAX_MSG_LEN);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const textMsg = new TextMessage(chunks[i]);

      if (isLast && msg.buttons?.length) {
        // Viber keyboard
        (textMsg as any).keyboard = {
          Type: "keyboard",
          Buttons: msg.buttons.map((b) => ({
            ActionType: "reply",
            ActionBody: b.callbackData,
            Text: b.label,
            TextSize: "regular",
          })),
        };
      }

      await this.bot.sendMessage({ id: msg.chatId } as any, textMsg);
    }
  }

  async stop(): Promise<void> {
    this.server?.close();
    log.info("Viber adapter stopped");
  }
}
