export interface ToolContext {
  projectPath: string;
  chatId: string;
  platform: string;
  sendMessage: (text: string) => Promise<void>;
}

export interface AgentTool {
  name: string;
  description: string;
  execute(args: string[], ctx: ToolContext): Promise<string>;
}
