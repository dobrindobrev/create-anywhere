import type {
  IncomingMessage,
  PlatformAdapter,
  ButtonClickHandler,
} from "../adapters/types.js";
import { SessionManager } from "../session/manager.js";
import { type AppConfig, saveConfig } from "../config/index.js";
import { getLogger } from "../utils/logger.js";
import { execFile } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import { ToolRegistry } from "../tools/registry.js";
import type { ToolContext } from "../tools/types.js";
import { gitTool } from "../tools/git.js";
import { previewTool } from "../tools/preview.js";
import { deployTool } from "../tools/deploy.js";

const log = getLogger("commands");

type AdapterMap = Map<string, PlatformAdapter>;

function isAllowed(
  config: AppConfig,
  platform: string,
  userId: string
): boolean {
  const list =
    config.allowlist[platform as keyof typeof config.allowlist] ?? [];
  return list.length === 0 || list.includes(userId);
}

/**
 * Creates the message and button-click handlers that wire
 * adapters -> commands -> session manager.
 */
// Initialize tool registry
const toolRegistry = new ToolRegistry();
toolRegistry.register(gitTool);
toolRegistry.register(previewTool);
toolRegistry.register(deployTool);

export function createHandlers(
  adapters: AdapterMap,
  sessionManager: SessionManager,
  config: AppConfig
): {
  messageHandler: (msg: IncomingMessage) => Promise<void>;
  buttonHandler: ButtonClickHandler;
} {
  const messageHandler = async (msg: IncomingMessage): Promise<void> => {
    const adapter = adapters.get(msg.platform);
    if (!adapter) return;

    // Auth check
    if (!isAllowed(config, msg.platform, msg.userId)) {
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: "You are not authorized to use this bot.",
      });
      return;
    }

    // Route commands
    if (msg.isCommand) {
      await handleCommand(msg, adapter, sessionManager, config);
      return;
    }

    // If no active session, prompt user
    log.info({ platform: msg.platform, chatId: msg.chatId, userId: msg.userId, text: msg.text }, "Non-command message received");
    const active = sessionManager.getActiveSession(msg.platform, msg.chatId);
    log.info({ hasActiveSession: !!active, sessionId: active?.id }, "Session lookup result");
    if (!active) {
      const projects = Object.keys(config.projects);
      if (projects.length === 0) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "No projects configured. Use /new <name> <path> to create one.",
        });
      } else {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `No active session. Use /open <project> to start.\n\nAvailable projects: ${projects.join(", ")}`,
        });
      }
      return;
    }

    // Forward to Claude Code (streaming — response comes via callbacks)
    try {
      log.info(
        {
          platform: msg.platform,
          chatId: msg.chatId,
          project: active.projectId,
        },
        "Forwarding to Claude"
      );
      sessionManager.sendMessage(msg.platform, msg.chatId, msg.text.trim());
    } catch (err: any) {
      log.error({ err, chatId: msg.chatId }, "Error processing message");
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Error: ${err.message ?? "Something went wrong."}`,
      });
    }
  };

  const buttonHandler: ButtonClickHandler = async (
    chatId,
    _userId,
    callbackData
  ) => {
    log.debug({ chatId, callbackData }, "Button click received");

    // Handle connect buttons (connect:<project-id>)
    if (callbackData.startsWith("connect:")) {
      const projectId = callbackData.slice("connect:".length);
      const projectPath = config.projects[projectId];
      for (const [platform, adapter] of adapters) {
        try {
          if (!projectPath) {
            await adapter.sendMessage({ chatId, text: `Project "${projectId}" not found.` });
            return;
          }
          sessionManager.openSession(platform, chatId, _userId, projectId, projectPath);
          await adapter.sendMessage({
            chatId,
            text: `Session opened for "${projectId}". Send your first instruction!`,
          });
          return;
        } catch (err: any) {
          await adapter.sendMessage({ chatId, text: `Error: ${err.message}` });
          return;
        }
      }
    }

    // Handle numbered choice buttons (choice:1, choice:2, etc.)
    if (callbackData.startsWith("choice:")) {
      const choiceNum = callbackData.split(":")[1];
      // Find which platform this chat belongs to by checking all adapters
      for (const [platform] of adapters) {
        const active = sessionManager.getActiveSession(platform, chatId);
        if (active) {
          try {
            sessionManager.sendMessage(platform, chatId, choiceNum);
            const adapter = adapters.get(platform);
            if (adapter) {
              await adapter.sendMessage({
                chatId,
                text: `Selected: ${choiceNum}`,
              });
            }
          } catch (err: any) {
            log.error({ err, chatId }, "Error forwarding button choice");
          }
          return;
        }
      }
    }
  };

  return { messageHandler, buttonHandler };
}

async function handleCommand(
  msg: IncomingMessage,
  adapter: PlatformAdapter,
  sm: SessionManager,
  config: AppConfig
): Promise<void> {
  const args = msg.args ?? [];

  switch (msg.command) {
    case "/start":
    case "/help":
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: [
          "Create Anywhere - Claude Code via IM",
          "",
          "/projects - List configured projects",
          "/new <id> [path] - Create and open a new project",
          "/open <id> - Open an existing project session",
          "/connect [id] - Connect to a project (shows buttons if no id)",
          "/stop [id] - Stop current or specified session",
          "/switch <id> - Switch active session",
          "/sessions - List your active sessions",
          "/autoapprove on|off - Toggle auto-approve",
          "/status - Current session info",
          "/reset - Stop all your sessions",
          "/env - List global env vars (keys only)",
          "/env set KEY VALUE - Set a global env var",
          "/env del KEY - Remove a global env var",
          "",
          "Git Branches:",
          "/branch - Show branches",
          "/branch <name> - Switch to branch",
          "/branch new <name> - Create & switch to new branch",
          "/branch delete <name> - Delete a branch",
          "",
          "Agent Tools:",
          "/git <args> - Run git in project dir",
          "/preview - Start dev server + ngrok tunnel",
          "/preview stop - Stop preview",
          "/deploy <target> - Deploy (vercel/netlify/cloudflare)",
          "/tools - List available agent tools",
          "",
          "/help - Show this message",
        ].join("\n"),
      });
      break;

    case "/projects": {
      const projects = Object.entries(config.projects);
      if (projects.length === 0) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "No projects configured. Add them to config/default.json or use /new.",
        });
      } else {
        const list = projects
          .map(([id, path]) => `  ${id} -> ${path}`)
          .join("\n");
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Projects:\n${list}`,
        });
      }
      break;
    }

    case "/new": {
      if (args.length < 1) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "Usage: /new <project-id> [absolute-path]",
        });
        return;
      }
      const projectId = args[0];
      const projectPath = args[1]
        ? resolve(args[1])
        : resolve(process.cwd(), "projects", projectId);

      if (!existsSync(projectPath)) {
        mkdirSync(projectPath, { recursive: true });
      }

      config.projects[projectId] = projectPath;
      saveConfig(config);

      try {
        sm.openSession(
          msg.platform,
          msg.chatId,
          msg.userId,
          projectId,
          projectPath
        );
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Project "${projectId}" created at ${projectPath}. Session ready — send your first instruction to start coding!`,
        });
      } catch (err: any) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${err.message}`,
        });
      }
      break;
    }

    case "/open": {
      if (args.length < 1) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "Usage: /open <project-id>",
        });
        return;
      }
      const projectId = args[0];
      const projectPath = config.projects[projectId];
      if (!projectPath) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Project "${projectId}" not found. Use /projects to see available ones.`,
        });
        return;
      }

      try {
        sm.openSession(
          msg.platform,
          msg.chatId,
          msg.userId,
          projectId,
          projectPath
        );
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Session opened for "${projectId}". Send your first instruction to start coding!`,
        });
      } catch (err: any) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Error: ${err.message}`,
        });
      }
      break;
    }

    case "/stop": {
      const projectId = args[0];
      if (projectId) {
        const stopped = sm.stopByProject(msg.platform, msg.chatId, projectId);
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: stopped
            ? `Session for "${projectId}" stopped.`
            : `No active session for "${projectId}".`,
        });
      } else {
        const active = sm.getActiveSession(msg.platform, msg.chatId);
        if (active) {
          sm.destroySession(active.id);
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Session for "${active.projectId}" stopped.`,
          });
        } else {
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: "No active session.",
          });
        }
      }
      break;
    }

    case "/switch": {
      if (args.length < 1) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "Usage: /switch <project-id>",
        });
        return;
      }
      const session = sm.switchSession(msg.platform, msg.chatId, args[0]);
      if (session) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Switched to "${session.projectId}".`,
        });
      } else {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `No open session for "${args[0]}". Use /open first.`,
        });
      }
      break;
    }

    case "/sessions": {
      const sessions = sm.getUserSessions(msg.platform, msg.userId);
      if (sessions.length === 0) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "No active sessions.",
        });
      } else {
        const active = sm.getActiveSession(msg.platform, msg.chatId);
        const list = sessions
          .map(
            (s) =>
              `  ${s.projectId}${s.id === active?.id ? " (active)" : ""}`
          )
          .join("\n");
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Your sessions:\n${list}`,
        });
      }
      break;
    }

    case "/autoapprove": {
      if (args.length < 1 || !["on", "off"].includes(args[0])) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "Usage: /autoapprove on|off",
        });
        return;
      }
      const value = args[0] === "on";
      const ok = sm.setAutoApprove(msg.platform, msg.chatId, value);
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: ok
          ? `Auto-approve is now ${value ? "ON" : "OFF"}.`
          : "No active session.",
      });
      break;
    }

    case "/status": {
      const active = sm.getActiveSession(msg.platform, msg.chatId);
      if (active) {
        let branchInfo = "";
        try {
          const { stdout } = await execFileAsync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd: active.projectPath, timeout: 5_000 }
          );
          branchInfo = `Branch: ${stdout.trim()}\n`;
        } catch {
          // not a git repo or git not available
        }
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: [
            `Project: ${active.projectId}`,
            `Path: ${active.projectPath}`,
            ...(branchInfo ? [branchInfo.trim()] : []),
            `Auto-approve: ${active.autoApprove ? "ON" : "OFF"}`,
            `Active since: ${new Date(active.createdAt).toISOString()}`,
            `Total sessions: ${sm.activeCount}`,
          ].join("\n"),
        });
      } else {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `No active session. Total sessions: ${sm.activeCount}`,
        });
      }
      break;
    }

    case "/reset": {
      const sessions = sm.getUserSessions(msg.platform, msg.userId);
      for (const s of sessions) {
        sm.destroySession(s.id);
      }
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Stopped ${sessions.length} session(s).`,
      });
      break;
    }

    case "/env": {
      if (args.length === 0) {
        // List keys (not values, for security)
        const keys = Object.keys(config.globalEnv);
        if (keys.length === 0) {
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: "No global env vars set. Use /env set KEY VALUE to add one.",
          });
        } else {
          const list = keys
            .map((k) => {
              const v = config.globalEnv[k];
              const masked = v.length > 4 ? v.slice(0, 4) + "..." : "****";
              return `  ${k} = ${masked}`;
            })
            .join("\n");
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Global env vars:\n${list}`,
          });
        }
      } else if (args[0] === "set" && args.length >= 3) {
        const key = args[1];
        const value = args.slice(2).join(" ");
        config.globalEnv[key] = value;
        saveConfig(config);
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Set ${key}. Active sessions need /stop + /open to pick it up.`,
        });
      } else if (args[0] === "del" && args.length >= 2) {
        const key = args[1];
        delete config.globalEnv[key];
        saveConfig(config);
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Removed ${key}.`,
        });
      } else {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "Usage: /env, /env set KEY VALUE, /env del KEY",
        });
      }
      break;
    }

    case "/tools": {
      const tools = toolRegistry.list();
      const list = tools.map((t) => `  /${t.name} — ${t.description}`).join("\n");
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Available agent tools:\n${list}`,
      });
      break;
    }

    case "/git":
    case "/preview":
    case "/deploy": {
      const toolName = msg.command!.slice(1); // remove leading /
      const tool = toolRegistry.get(toolName);
      if (!tool) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Tool "${toolName}" not found.`,
        });
        return;
      }

      const active = sm.getActiveSession(msg.platform, msg.chatId);
      if (!active) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "No active session. Use /open <project> first.",
        });
        return;
      }

      const ctx: ToolContext = {
        projectPath: active.projectPath,
        chatId: msg.chatId,
        platform: msg.platform,
        sendMessage: async (text: string) => {
          await adapter.sendMessage({ chatId: msg.chatId, text });
        },
      };

      try {
        const result = await tool.execute(args, ctx);
        await adapter.sendMessage({ chatId: msg.chatId, text: result });
      } catch (err: any) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Tool error: ${err.message}`,
        });
      }
      break;
    }

    case "/connect": {
      const projects = Object.entries(config.projects);
      if (projects.length === 0) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "No projects configured. Use /new <name> <path> to create one.",
        });
        break;
      }

      if (args.length >= 1) {
        // Same as /open
        const projectId = args[0];
        const projectPath = config.projects[projectId];
        if (!projectPath) {
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Project "${projectId}" not found. Use /connect to see available ones.`,
          });
          return;
        }
        try {
          sm.openSession(msg.platform, msg.chatId, msg.userId, projectId, projectPath);
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Session opened for "${projectId}". Send your first instruction!`,
          });
        } catch (err: any) {
          await adapter.sendMessage({ chatId: msg.chatId, text: `Error: ${err.message}` });
        }
      } else {
        // Show project list with buttons
        const buttons = projects.map(([id]) => ({
          label: id,
          callbackData: `connect:${id}`,
        }));
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "Select a project to connect:",
          buttons,
        });
      }
      break;
    }

    case "/branch": {
      const active = sm.getActiveSession(msg.platform, msg.chatId);
      if (!active) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: "No active session. Use /open or /connect first.",
        });
        break;
      }

      const cwd = active.projectPath;

      try {
        if (args.length === 0) {
          // Show current branch + list all
          const { stdout } = await execFileAsync("git", ["branch", "--no-color"], {
            cwd,
            timeout: 10_000,
          });
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Branches:\n${stdout.trim()}`,
          });
        } else if (args[0] === "new" && args.length >= 2) {
          // Create and switch to new branch
          const branchName = args[1];
          await execFileAsync("git", ["checkout", "-b", branchName], {
            cwd,
            timeout: 10_000,
          });
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Created and switched to branch "${branchName}".`,
          });
        } else if (args[0] === "delete" && args.length >= 2) {
          // Delete a branch
          const branchName = args[1];
          // Check if it's the current branch
          const { stdout: currentBranch } = await execFileAsync(
            "git",
            ["rev-parse", "--abbrev-ref", "HEAD"],
            { cwd, timeout: 10_000 }
          );
          if (currentBranch.trim() === branchName) {
            await adapter.sendMessage({
              chatId: msg.chatId,
              text: `Cannot delete the current branch "${branchName}". Switch to another branch first.`,
            });
            break;
          }
          await execFileAsync("git", ["branch", "-d", branchName], {
            cwd,
            timeout: 10_000,
          });
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Deleted branch "${branchName}".`,
          });
        } else {
          // Switch to existing branch
          const branchName = args[0];
          await execFileAsync("git", ["checkout", branchName], {
            cwd,
            timeout: 10_000,
          });
          await adapter.sendMessage({
            chatId: msg.chatId,
            text: `Switched to branch "${branchName}".`,
          });
        }
      } catch (err: any) {
        await adapter.sendMessage({
          chatId: msg.chatId,
          text: `Git error: ${err.stderr?.trim() || err.message}`,
        });
      }
      break;
    }

    default:
      await adapter.sendMessage({
        chatId: msg.chatId,
        text: `Unknown command: ${msg.command}. Use /help for available commands.`,
      });
  }
}
