import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool, ToolContext } from "./types.js";

const execFileAsync = promisify(execFile);

const BLOCKED_PATTERNS = [
  /push\s+--force/,
  /push\s+-f\b/,
  /reset\s+--hard/,
];

export const gitTool: AgentTool = {
  name: "git",
  description: "Run git commands in the project directory",

  async execute(args: string[], ctx: ToolContext): Promise<string> {
    if (args.length === 0) {
      return "Usage: /git <subcommand> [args]\nExamples: /git status, /git log --oneline -10, /git commit -m \"msg\"";
    }

    const fullCmd = args.join(" ");
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(fullCmd)) {
        return `Blocked: "${fullCmd}" is a destructive operation. Run it manually if you're sure.`;
      }
    }

    try {
      const { stdout, stderr } = await execFileAsync("git", args, {
        cwd: ctx.projectPath,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      const output = (stdout + stderr).trim();
      return output || "(no output)";
    } catch (err: any) {
      const msg = err.stderr || err.stdout || err.message || "Unknown git error";
      return `Git error:\n${msg.trim()}`;
    }
  },
};
