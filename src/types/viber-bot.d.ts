declare module "viber-bot" {
  export class Bot {
    constructor(logger: any, options: { authToken: string; name: string; avatar?: string });
    on(event: string, handler: (...args: any[]) => void): void;
    middleware(): any;
    setWebhook(url: string): Promise<void>;
    sendMessage(userProfile: { id: string }, messages: any): Promise<void>;
  }
  export const Events: {
    MESSAGE_RECEIVED: string;
    [key: string]: string;
  };
  export const Message: {
    Text: new (text: string) => any;
    [key: string]: any;
  };
}
