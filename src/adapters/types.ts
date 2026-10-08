/** Incoming message from any IM platform */
export interface IncomingMessage {
  platform: "telegram" | "whatsapp" | "viber";
  userId: string;
  chatId: string;
  userName: string;
  text: string;
  isCommand: boolean;
  command?: string;
  args?: string[];
  timestamp: Date;
  raw?: unknown;
}

/** Button that can be sent alongside a message */
export interface MessageButton {
  label: string;
  callbackData: string;
}

/** Outgoing message to any IM platform */
export interface OutgoingMessage {
  chatId: string;
  text: string;
  buttons?: MessageButton[];
  parseMode?: "markdown" | "plain";
}

/** Handler for incoming text messages */
export type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

/** Handler for button/callback clicks */
export type ButtonClickHandler = (
  chatId: string,
  userId: string,
  callbackData: string
) => void | Promise<void>;

/** Every IM adapter must implement this interface */
export interface PlatformAdapter {
  readonly name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(msg: OutgoingMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onButtonClick(handler: ButtonClickHandler): void;
}

/**
 * Split text into chunks respecting a max length.
 * Tries to split on newlines, then on spaces.
 */
export function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    // Try to break at newline
    let splitAt = remaining.lastIndexOf("\n", maxLen);
    if (splitAt <= 0) {
      // Try space
      splitAt = remaining.lastIndexOf(" ", maxLen);
    }
    if (splitAt <= 0) {
      // Hard cut
      splitAt = maxLen;
    }
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, "");
  }
  return chunks;
}
