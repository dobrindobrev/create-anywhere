# create-anywhere -- Product Specification

Version: 1.0 (text-only)

## Overview

create-anywhere bridges instant-messaging platforms (Telegram, WhatsApp, Viber) to Claude Code CLI sessions running on a server. Users can code from their phone by chatting with a bot that relays messages to and from Claude Code.

---

## Authentication

- **Allowlist-based**: A config file lists authorized user identifiers per platform.
- No self-registration in v1. An admin edits the allowlist manually.

```yaml
# Example (config.yaml)
auth:
  telegram:
    - "123456789"        # Telegram user ID
  whatsapp:
    - "14155551234"      # phone number (E.164)
  viber:
    - "viber_user_id_1"
```

Unauthorized users receive a single "Not authorized" reply and are ignored thereafter.

---

## Project Mapping

Projects are mapped by a short identifier to an absolute folder path on the server.

```yaml
projects:
  my-api:    /home/user/projects/my-api
  website:   /home/user/projects/website
```

- Identifiers are lowercase alphanumeric plus hyphens.
- The `/new` command creates a folder and adds a mapping entry at runtime (persisted to config).

---

## Session Model

- A **session** is one running Claude Code CLI process bound to a project directory.
- Each user can have **multiple concurrent sessions** (one per project).
- At any moment a user has one **active session** in a given chat -- messages route there.
- Sessions persist until explicitly stopped or the server restarts.

---

## Bot Commands

| Command | Description |
|---|---|
| `/start` | Welcome message and brief usage instructions. |
| `/help` | Full command reference. |
| `/projects` | List all mapped projects (with active-session indicator). |
| `/new <id> [path]` | Create a new project folder (default: `<projects_root>/<id>`), add mapping, and start a session. |
| `/open <id>` | Start or resume a session for an existing project. |
| `/stop` | Stop the active session in this chat. |
| `/stop <id>` | Stop a specific session by project identifier. |
| `/sessions` | List all active sessions for the current user. |
| `/switch <id>` | Switch the chat's active session to a different running session. |
| `/autoapprove on\|off` | Toggle automatic tool approval for the active session. |
| `/status` | Show info about the active session (project, uptime, autoapprove state). |

Any non-command text message in a chat with an active session is forwarded to Claude Code as user input.

---

## User Flows

### 1. First-Time Setup (admin)

1. Admin deploys the server and creates `config.yaml` with auth allowlist and initial project mappings.
2. Admin registers a bot on each target platform (BotFather for Telegram, Meta Business for WhatsApp, Viber Admin Panel).
3. Admin adds bot tokens/credentials to `config.yaml`.
4. Server starts and connects to all configured platforms.

### 2. Open an Existing Project

1. User sends `/open my-api`.
2. Bot looks up `my-api` in project mappings. If not found, replies with an error.
3. Bot spawns a Claude Code CLI process in `/home/user/projects/my-api`.
4. Bot replies: "Session started for **my-api**. Send your instructions."

### 3. Create a New Project

1. User sends `/new cool-app`.
2. Bot creates `/home/user/projects/cool-app`, adds it to the mapping, spawns a session.
3. Bot replies: "Created and opened **cool-app**."

### 4. Active Coding Session

1. User sends a plain text message, e.g. "Add a health-check endpoint to the Express server."
2. Bot forwards the text to the Claude Code CLI stdin.
3. Claude Code streams output. Bot collects output and sends it back as chat messages.
4. Long outputs are chunked to respect platform message-length limits (see Platform Notes).

### 5. Tool Approval Flow (default mode)

1. Claude Code requests permission to run a tool (e.g., write a file).
2. Bot sends the user a message describing the action, with **Approve** / **Deny** inline buttons.
3. User taps a button.
4. Bot sends the decision back to Claude Code, which proceeds or skips accordingly.

### 6. Tool Approval Flow (auto-approve mode)

1. User has previously sent `/autoapprove on`.
2. Claude Code requests permission -- bot automatically approves and notifies the user with a brief summary (no buttons).

### 7. Session Management

- `/sessions` shows a numbered list of active sessions with project IDs.
- `/switch website` makes the `website` session the active one for subsequent messages.
- `/stop` terminates the current session's Claude Code process. The project mapping remains.

---

## Platform-Specific Notes

### Telegram

- **Inline keyboards** for tool-approval buttons (native support).
- Message limit: 4096 characters. Longer outputs split into multiple messages.
- Bot created via BotFather; communicates over Telegram Bot API (long polling or webhook).
- Supports Markdown formatting in messages.

### WhatsApp

- Uses WhatsApp Business API (Cloud API via Meta).
- **Interactive buttons** (max 3 per message) for tool approval.
- Message limit: 4096 characters.
- No rich Markdown -- use plain text with minimal formatting.
- 24-hour messaging window: bot can only message users who have messaged in the last 24 hours (not an issue for active sessions).

### Viber

- Uses Viber REST API with webhook.
- **Keyboard buttons** for tool approval.
- Message limit: 7000 characters.
- Supports some Markdown-like formatting.

---

## Configuration Reference

```yaml
server:
  host: 0.0.0.0
  port: 3000
  projects_root: /home/user/projects   # default base path for /new

auth:
  telegram:
    - "123456789"
  whatsapp:
    - "14155551234"
  viber:
    - "viber_user_id_1"

platforms:
  telegram:
    bot_token: "BOT_TOKEN"
  whatsapp:
    phone_number_id: "PHONE_NUMBER_ID"
    access_token: "ACCESS_TOKEN"
    verify_token: "VERIFY_TOKEN"
  viber:
    auth_token: "AUTH_TOKEN"
    bot_name: "create-anywhere"

projects:
  my-api: /home/user/projects/my-api
  website: /home/user/projects/website

defaults:
  autoapprove: false
```

---

## Out of Scope for v1

- Image / file attachments (text-only).
- Voice messages.
- Self-service user registration.
- Web dashboard.
- Session persistence across server restarts.
- End-to-end encryption of relayed content.
- Rate limiting / abuse prevention beyond the allowlist.
