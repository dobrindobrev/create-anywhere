# create-anywhere

Bridge instant messaging platforms (Telegram, WhatsApp, Viber) to Claude Code CLI sessions. Code from your phone by chatting with a bot that relays messages to Claude Code.

## Prerequisites

- **Node.js** >= 18
- **Claude Code CLI** installed and available in PATH (or specify a custom path)
- Bot tokens for the platforms you want to use (see Platform Setup below)

## Installation

```bash
git clone <repo-url>
cd create-anywhere
npm install
```

## Configuration

### Environment Variables

Copy `.env.example` to `.env` and fill in the tokens (`.env` is gitignored):

```env
# Required for Telegram
TELEGRAM_BOT_TOKEN=your-telegram-bot-token

# Required for Viber
VIBER_BOT_TOKEN=your-viber-auth-token
VIBER_BOT_NAME=YourBotName
VIBER_BOT_AVATAR=https://example.com/avatar.png
VIBER_WEBHOOK_URL=https://your-server.com/viber

# Optional
CLAUDE_CODE_PATH=claude          # path to Claude Code CLI binary
LOG_LEVEL=info                   # fatal, error, warn, info, debug, trace
```

### Config File

Copy `config/default.example.json` to `config/default.json` (gitignored — the bot writes runtime changes back to it), then edit it to enable platforms, set session limits, define projects, and configure user allowlists:

```json
{
  "telegram": { "enabled": true },
  "whatsapp": { "enabled": false },
  "viber": { "enabled": false, "webhookPort": 8080 },
  "session": {
    "maxConcurrent": 5,
    "idleTimeoutMs": 300000,
    "maxSessionDurationMs": 3600000
  },
  "logging": { "level": "info" },
  "projects": {
    "my-api": "/absolute/path/to/my-api",
    "website": "/absolute/path/to/website"
  },
  "allowlist": {
    "telegram": ["123456789"],
    "whatsapp": [],
    "viber": []
  },
  "defaultAutoApprove": false
}
```

- **projects**: Map of project identifiers to absolute directory paths on disk.
- **allowlist**: Per-platform user ID allowlists. If empty, all users are allowed.

> ⚠️ **Security:** the bot runs Claude Code on your machine. Always set an allowlist, and never combine an empty allowlist with `defaultAutoApprove: true` — that would let anyone who finds your bot execute commands on your computer.
- **defaultAutoApprove**: Whether new sessions start with `--dangerously-skip-permissions`.

## Platform Setup

### Telegram

1. Open Telegram and message [@BotFather](https://t.me/BotFather).
2. Send `/newbot` and follow the prompts to create a bot.
3. Copy the bot token and set it as `TELEGRAM_BOT_TOKEN` in your `.env`.
4. Set `"telegram": { "enabled": true }` in `config/default.json`.

### WhatsApp

1. WhatsApp uses [@whiskeysockets/baileys](https://github.com/WhiskeySockets/Baileys) for connection.
2. Set `"whatsapp": { "enabled": true }` in config.
3. On first start, scan the QR code printed in the terminal with WhatsApp on your phone.
4. Auth state is saved in `auth_info_baileys/` for subsequent connections.

### Viber

1. Go to the [Viber Admin Panel](https://partners.viber.com/) and create a bot account.
2. Copy the auth token.
3. Set the environment variables: `VIBER_BOT_TOKEN`, `VIBER_BOT_NAME`, `VIBER_WEBHOOK_URL`.
4. Set `"viber": { "enabled": true, "webhookPort": 8080 }` in config.
5. Ensure the webhook URL is publicly accessible (use ngrok for local development).

## Running

```bash
# Development (with hot reload via tsx)
npm run dev

# Production
npm run build
npm start

# Run tests
npm test

# Type check
npm run typecheck
```

## Bot Commands

Once the bot is running, interact with it from any enabled IM platform:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/projects` | List configured projects |
| `/new <id> [path]` | Create a new project and start a session |
| `/open <id>` | Open a session for an existing project |
| `/stop [id]` | Stop the current or a specific session |
| `/switch <id>` | Switch the active session to another project |
| `/sessions` | List your active sessions |
| `/autoapprove on\|off` | Toggle auto-approve for tool calls |
| `/status` | Show current session info |
| `/reset` | Stop all your sessions |

Any non-command text message in a chat with an active session is forwarded to Claude Code.

## Usage Example

```
You:  /open my-api
Bot:  Session opened for "my-api". Send your instructions.

You:  Add a health check endpoint that returns { status: "ok" }
Bot:  I've added a GET /health endpoint to src/index.ts that returns...

You:  /status
Bot:  Project: my-api
      Path: /home/user/projects/my-api
      Auto-approve: OFF
      ...
```

## Architecture

See [docs/architecture.md](docs/architecture.md) for the full system design.

## Troubleshooting

- **"No adapters enabled"**: Make sure at least one platform is enabled in config and the required env vars are set.
- **Telegram bot not responding**: Verify the `TELEGRAM_BOT_TOKEN` is correct. Check logs for errors.
- **WhatsApp QR code not appearing**: Delete `auth_info_baileys/` and restart.
- **Viber webhook errors**: Ensure `VIBER_WEBHOOK_URL` is publicly accessible. Use ngrok for local dev.
- **"Maximum concurrent sessions reached"**: Increase `session.maxConcurrent` in config or stop idle sessions with `/stop`.
- **Claude Code errors**: Verify the CLI is installed and `CLAUDE_CODE_PATH` points to it. Run `claude --version` to check.

## License

Private
