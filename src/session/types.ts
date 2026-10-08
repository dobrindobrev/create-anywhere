/** Types for Claude Code CLI stream-json protocol */

export interface ClaudeStreamEvent {
  type: string;
  [key: string]: unknown;
}

export interface AssistantMessageEvent extends ClaudeStreamEvent {
  type: "assistant" | "assistant_message";
  message: {
    content: ContentBlock[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface ContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  content?: string;
  is_error?: boolean;
}

export interface ResultEvent extends ClaudeStreamEvent {
  type: "result";
  result?: string;
  cost_usd?: number;
  duration_ms?: number;
  session_id?: string;
  [key: string]: unknown;
}

export interface ErrorEvent extends ClaudeStreamEvent {
  type: "error";
  error?: { message?: string; type?: string };
  message?: string;
}

export interface SystemEvent extends ClaudeStreamEvent {
  type: "system";
  message?: string;
}

export type SessionState = "idle" | "starting" | "active" | "stopping" | "stopped";

export interface SessionInfo {
  id: string;
  projectName: string;
  projectPath: string;
  chatKey: string;
  sessionId: string; // Claude --session-id UUID
  state: SessionState;
  createdAt: Date;
  lastActivityAt: Date;
  autoApprove: boolean;
}
