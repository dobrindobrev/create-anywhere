import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  type WASocket,
} from "@whiskeysockets/baileys";
import type {
  PlatformAdapter,
  MessageHandler,
  ButtonClickHandler,
  OutgoingMessage,
  IncomingMessage,
} from "./types.js";
import { chunkText } from "./types.js";
import { getLogger } from "../utils/logger.js";
import { Boom } from "@hapi/boom";

const log = getLogger("whatsapp");
const MAX_MSG_LEN = 65536; // WhatsApp doesn't have a strict low limit

export class WhatsAppAdapter implements PlatformAdapter {
  readonly name = "whatsapp";
  private sock: WASocket | undefined;
  private messageHandlers: MessageHandler[] = [];
  private buttonHandlers: ButtonClickHandler[] = [];

  onMessage(handler: MessageHandler): void {
    this.messageHandlers.push(handler);
  }

  onButtonClick(handler: ButtonClickHandler): void {
    this.buttonHandlers.push(handler);
  }

  async start(): Promise<void> {
    await this.connect();
  }

  private async connect(): Promise<void> {
    const { state, saveCreds } = await useMultiFileAuthState(
      "auth_info_baileys"
    );

    const sock = makeWASocket({
      auth: state,
      printQRInTerminal: true,
      logger: log as any,
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
      if (connection === "close") {
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        if (statusCode !== DisconnectReason.loggedOut) {
          log.info("WhatsApp reconnecting...");
          this.connect();
        } else {
          log.warn("WhatsApp logged out");
        }
      } else if (connection === "open") {
        log.info("WhatsApp adapter connected");
      }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;

        const text =
          m.message.conversation ?? m.message.extendedTextMessage?.text;
        if (!text) continue;

        const { isCommand, command, args } = this.parseCommand(text);

        const incoming: IncomingMessage = {
          platform: "whatsapp",
          chatId: m.key.remoteJid ?? "",
          userId: m.key.participant ?? m.key.remoteJid ?? "",
          userName: m.pushName ?? "Unknown",
          text,
          isCommand,
          command,
          args,
          timestamp: new Date((m.messageTimestamp as number) * 1000),
          raw: m,
        };

        for (const h of this.messageHandlers) {
          await h(incoming);
        }

        // Handle button responses (list replies)
        const buttonReply =
          m.message.buttonsResponseMessage?.selectedButtonId;
        if (buttonReply) {
          for (const h of this.buttonHandlers) {
            await h(
              m.key.remoteJid ?? "",
              m.key.participant ?? m.key.remoteJid ?? "",
              buttonReply
            );
          }
        }
      }
    });

    this.sock = sock;
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
    if (!this.sock) throw new Error("WhatsApp not connected");
    const chunks = chunkText(msg.text, MAX_MSG_LEN);

    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;

      if (isLast && msg.buttons?.length) {
        // Send interactive buttons via WhatsApp sections
        await this.sock.sendMessage(msg.chatId, {
          text: chunks[i],
          buttons: msg.buttons.map((b, idx) => ({
            buttonId: b.callbackData,
            buttonText: { displayText: b.label },
            type: 1 as const,
          })),
        } as any);
      } else {
        await this.sock.sendMessage(msg.chatId, { text: chunks[i] });
      }
    }
  }

  async stop(): Promise<void> {
    this.sock?.end(undefined);
    log.info("WhatsApp adapter stopped");
  }
}
