# create-anywhere - System Architecture

## Overview

create-anywhere bridges instant messaging platforms (Telegram, WhatsApp, Viber) to Claude Code CLI sessions, allowing users to write code remotely from their phone. Each IM conversation maps to a Claude Code subprocess working in a specific project directory.

## Component Diagram

```
+-------------------+     +-------------------+     +-------------------+
|  Telegram Bot API |     | WhatsApp Business |     |   Viber Bot API   |
+--------+----------+     +--------+----------+     +--------+----------+
         |                         |                         |
         v                         v                         v
+--------+----------+     +--------+----------+     +--------+----------+
|  TelegramAdapter  |     |  WhatsAppAdapter   |     |   ViberAdapter    |
+--------+----------+     +--------+----------+     +--------+----------+
         |                         |                         |
         +------------+------------+------------+------------+
                      |                         |
                      v                         v
             +--------+----------+     +--------+----------+
             |  MessageRouter    |     |   AuthManager      |
             +--------+----------+     +--------------------+
                      |
                      v
             +--------+----------+
             |  SessionManager   |
             +--------+----------+
                      |
                      v
             +--------+----------+
             | ClaudeCodeProcess |  (one per active session)
             +--------+----------+
                      |
                      v
             +--------+----------+
             |  Claude Code CLI  |
             |  (child process)  |
             +-------------------+
```

## Core Components

### 1. IM Platform Adapters

Each adapter implements a common `MessagingAdapter` interface:

```typescript
interface IncomingMessage {
  platform: "telegram" | "whatsapp" | "viber";
  userId: string;        // platform-specific user ID
  chatId: string;        // platform-specific chat/conversation ID
  text: string;
  messageId: string;
  replyToMessageId?: string;
}

interface OutgoingMessage {
  chatId: string;
  text: string;
  replyToMessageId?: string;
  inlineButtons?: InlineButton[][];  // rows of buttons
}

interface InlineButton {
  label: string;
  callbackData: string;
}

interface ButtonCallback {
  platform: string;
  userId: string;
  chatId: string;
  callbackData: string;
  messageId: string;     // message the button belongs to
}

interface MessagingAdapter {
  readonly platform: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(msg: OutgoingMessage): Promise<string>;  // returns messageId
  editMessage(chatId: string, messageId: string, msg: Partial<OutgoingMessage>): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  onButtonCallback(handler: (cb: ButtonCallback) => void): void;
}
```

**Platform specifics:**

| Platform | Library | Message Limit | Webhook/Polling | Inline Buttons |
|----------|---------|---------------|-----------------|----------------|
| Telegram | `telegraf` or `grammy` | 4096 chars | Webhook preferred, polling fallback | Yes (InlineKeyboard) |
| WhatsApp | `whatsapp-web.js` or Meta Cloud API | 4096 chars | Webhook (Cloud API) | Yes (Interactive buttons, max 3) |
| Viber | `viber-bot` | 7000 chars | Webhook | Yes (Keyboard) |

### 2. AuthManager

Simple allowlist-based authentication. On every incoming message, check if `(platform, userId)` is in the allowlist. Reject unauthorized users with a generic message.

```typescript
interface AuthManager {
  isAuthorized(platform: string, userId: string): boolean;
}
```

The allowlist is defined in the config file (see Config section).

### 3. MessageRouter

Routes authenticated messages to the correct session based on a session key. The session key is derived from user commands:

- `/start <project>` - Start/resume a session for a named project
- `/stop` - End the current session
- `/status` - Show active session info
- `/projects` - List available projects

Each `(platform, chatId)` maps to at most one active session at a time. Users switch projects with `/start <project>`.

### 4. SessionManager

Manages the lifecycle of Claude Code sessions. Maintains a map of active sessions:

```typescript
interface Session {
  id: string;                    // UUID
  projectName: string;
  projectPath: string;           // filesystem path
  chatKey: string;               // "platform:chatId"
  claudeSessionId: string;       // Claude Code --session-id value
  process: ClaudeCodeProcess;
  state: "starting" | "active" | "idle" | "stopping";
  createdAt: Date;
  lastActivityAt: Date;
  toolApprovalMode: "auto" | "interactive";
}
```

**Session lifecycle:**

1. **starting** - User sends `/start <project>`. Spawn Claude Code process.
2. **active** - Process running, messages flowing bidirectionally.
3. **idle** - No messages for `idleTimeoutMinutes`. Optionally notify user.
4. **stopping** - User sends `/stop` or idle timeout exceeded. Kill process, clean up.

Idle sessions are reaped after a configurable timeout (default 30 minutes).

### 5. ClaudeCodeProcess

Wraps a Claude Code CLI child process. This is the critical integration point.

**Spawn strategy - using `--print` with `stream-json`:**

```typescript
const child = spawn(
  "~/.local/bin/claude",
  [
    "--print",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--session-id", sessionUuid,
    "--add-dir", projectPath,
    // Tool approval mode:
    // auto-approve: "--dangerously-skip-permissions"
    // interactive: omit the flag, handle tool prompts via stream events
  ],
  {
    cwd: projectPath,
    env: { ...process.env, CLAUDECODE: undefined },  // unset to avoid nesting check
  }
);
```

**Communication protocol:**

The `stream-json` format provides newline-delimited JSON objects on stdout. Each object has a `type` field:

- **Input to Claude** (write to stdin):
  ```json
  {"type": "user_message", "content": "fix the bug in auth.ts"}
  ```

- **Output from Claude** (read from stdout): Various event types including:
  - `assistant_message` - Text response chunks
  - `tool_use` - Tool being called (file edit, bash command, etc.)
  - `tool_result` - Result of tool execution
  - `result` - Final aggregated result
  - `error` - Error event

**Tool approval flow (interactive mode):**

When Claude Code wants to use a tool and permissions are not auto-approved, the stream emits a tool_use event. The bridge:

1. Sends an IM message with the tool description and Approve/Reject inline buttons
2. Waits for the user's button callback
3. Writes the approval/rejection back to stdin

For `auto` mode, pass `--dangerously-skip-permissions` and no tool prompts occur.

**Alternatively**, use `--allowedTools` to pre-approve a safe subset (e.g., `"Read Edit Glob Grep"`) while requiring approval for `Bash` commands.

### 6. MessageChunker

IM platforms enforce message length limits. The chunker splits long Claude responses:

```typescript
function chunkMessage(text: string, maxLength: number): string[] {
  // Split on paragraph boundaries first, then sentence boundaries,
  // then hard-split at maxLength as last resort.
  // Preserve markdown code blocks (don't split mid-block).
}
```

Platform-specific limits are defined per adapter (Telegram: 4096, WhatsApp: 4096, Viber: 7000).

## Configuration

Single config file at `config.yaml` (or `config.json`):

```yaml
# Authentication - authorized users per platform
auth:
  telegram:
    - "123456789"       # Telegram user IDs
  whatsapp:
    - "359888123456"    # Phone numbers
  viber:
    - "viber_user_id"

# Project definitions - name to directory mapping
projects:
  myapp:
    path: "/path/to/myapp"
    toolApproval: "auto"            # "auto" | "interactive"
    allowedTools:                    # optional, only if toolApproval != "auto"
      - "Read"
      - "Edit"
      - "Glob"
      - "Grep"
  website:
    path: "/path/to/website"
    toolApproval: "interactive"

# Platform bot credentials
platforms:
  telegram:
    enabled: true
    token: "${TELEGRAM_BOT_TOKEN}"  # env var reference
  whatsapp:
    enabled: true
    # whatsapp-web.js uses QR code auth, or Cloud API credentials:
    phoneNumberId: "${WHATSAPP_PHONE_NUMBER_ID}"
    accessToken: "${WHATSAPP_ACCESS_TOKEN}"
    verifyToken: "${WHATSAPP_VERIFY_TOKEN}"
  viber:
    enabled: true
    token: "${VIBER_BOT_TOKEN}"
    name: "CreateAnywhere"

# Server settings
server:
  port: 3000                        # webhook server port
  webhookBaseUrl: "https://example.com"  # public URL for webhooks
  idleTimeoutMinutes: 30
  maxConcurrentSessions: 5

# Claude Code settings
claude:
  path: "~/.local/bin/claude"
  model: "claude-sonnet-4-6"       # optional model override
  systemPrompt: ""                  # optional additional system prompt
```

Environment variables are referenced with `${VAR_NAME}` syntax and resolved at startup.

## Data Flow

### User sends a coding message

```
1. User types "fix the login bug" in Telegram
2. TelegramAdapter receives update, emits IncomingMessage
3. MessageRouter:
   a. AuthManager.isAuthorized("telegram", userId) -> true
   b. Look up active session for "telegram:chatId"
   c. If no session: reply "No active session. Use /start <project>"
   d. If session exists: forward to SessionManager
4. SessionManager:
   a. Write {"type":"user_message","content":"fix the login bug"} to process stdin
   b. Update lastActivityAt
5. ClaudeCodeProcess stdout emits stream-json events:
   a. assistant_message chunks -> buffer and forward to IM
   b. tool_use events -> if interactive mode, send approval prompt
   c. result event -> send final response
6. MessageChunker splits response if needed
7. TelegramAdapter.sendMessage() for each chunk
```

### Tool approval flow (interactive mode)

```
1. Claude Code emits tool_use: {tool: "Bash", input: {command: "npm test"}}
2. Bridge sends IM message:
   "Claude wants to run: `npm test`"
   [Approve] [Reject]
3. User taps [Approve]
4. ButtonCallback received, routed to SessionManager
5. Approval written to Claude Code stdin
6. Claude Code proceeds with tool execution
```

## Error Handling

| Scenario | Action |
|----------|--------|
| Claude Code process exits unexpectedly | Notify user, set session to stopped, clean up |
| Claude Code process hangs (no output for 5min) | Send warning to user, offer to restart |
| IM platform API error (rate limit, network) | Retry with exponential backoff (3 attempts), then notify user |
| Invalid project path in config | Log error at startup, skip project |
| User sends message during tool approval wait | Queue the message, process after approval resolves |
| Process spawn fails | Notify user with error details |

## Process Management

- Each session owns exactly one Claude Code child process
- Processes are spawned with `child_process.spawn()` (not exec) for streaming I/O
- On graceful shutdown (SIGTERM/SIGINT), all child processes are killed
- Idle reaper runs on interval, kills sessions exceeding `idleTimeoutMinutes`
- `maxConcurrentSessions` limits total active processes (reject new `/start` if at limit)
- Process stdout/stderr are consumed via Node.js stream readline for line-delimited JSON parsing

## Project Structure

```
create-anywhere/
  src/
    index.ts                  # entry point
    config/
      loader.ts               # config file loading + env var resolution
      schema.ts               # config type definitions + validation
    adapters/
      types.ts                # MessagingAdapter interface
      telegram.ts
      whatsapp.ts
      viber.ts
    auth/
      manager.ts              # allowlist auth
    router/
      message-router.ts       # routes messages to sessions
      commands.ts             # /start, /stop, /status, /projects
    session/
      session-manager.ts      # session lifecycle
      types.ts                # Session interface
    claude/
      process.ts              # ClaudeCodeProcess wrapper
      stream-parser.ts        # stream-json stdout parser
      types.ts                # Claude stream event types
    utils/
      chunker.ts              # message chunking
      logger.ts               # structured logging
  config.example.yaml
  docs/
    architecture.md
  package.json
  tsconfig.json
```

## Key Design Decisions

1. **`--print` + `stream-json` mode over interactive TTY**: The CLI's `--print` flag with `--input-format stream-json` and `--output-format stream-json` provides a clean machine-readable protocol. This avoids parsing ANSI escape codes or dealing with TTY emulation.

2. **One process per session**: Simplest model. Each project conversation gets its own Claude Code process with its own `--session-id`. Process isolation means one crash does not affect others.

3. **Config file over database**: For a single-server deployment used by one person (or a small team), a YAML config file is simpler than a database. No migration tooling needed.

4. **Webhook server for IM platforms**: A single Express/Fastify HTTP server handles webhooks for all three platforms at different routes (`/webhook/telegram`, `/webhook/whatsapp`, `/webhook/viber`). Telegram can also fall back to long-polling for local development.

5. **`CLAUDECODE` env var unset**: The CLI refuses to run inside another Claude Code session. The bridge must unset this environment variable when spawning child processes.

6. **Session resumption via `--session-id`**: Each session stores its UUID. If a process dies and the user sends another message, the bridge can respawn with the same `--session-id` and `--resume` to continue the conversation.

## Security Considerations

- Bot tokens and API keys stored in environment variables, never in config file directly
- Allowlist auth checked before any message processing
- `--dangerously-skip-permissions` only used when explicitly configured per project
- Project paths validated to exist at startup; no dynamic path creation from user input
- No shell injection possible: project names are config keys, not user-supplied strings
- Webhook endpoints should verify platform signatures (Telegram: secret token, WhatsApp: signature verification, Viber: signature header)
