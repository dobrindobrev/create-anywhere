import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AgentTool, ToolContext } from "./types.js";
import { detectBuildDir } from "../utils/detect-project.js";

const execFileAsync = promisify(execFile);

export const deployTool: AgentTool = {
  name: "deploy",
  description: "Deploy project to Vercel, Netlify, or Cloudflare",

  async execute(args: string[], ctx: ToolContext): Promise<string> {
    const target = args[0];

    if (!target) {
      return [
        "Usage: /deploy <target>",
        "",
        "Targets:",
        "  vercel     — Deploy to Vercel",
        "  netlify    — Deploy to Netlify",
        "  cloudflare — Deploy to Cloudflare Pages",
        "  local      — Start local preview (alias for /preview)",
      ].join("\n");
    }

    switch (target) {
      case "local":
        // Delegate to preview tool — caller handles this
        return "Use /preview instead.";

      case "vercel":
        return runDeploy(ctx, "npx", ["vercel", "--yes"], "Vercel");

      case "netlify": {
        const buildDir = detectBuildDir(ctx.projectPath);
        return runDeploy(
          ctx,
          "npx",
          ["netlify", "deploy", "--prod", "--dir", buildDir],
          "Netlify"
        );
      }

      case "cloudflare": {
        const buildDir = detectBuildDir(ctx.projectPath);
        return runDeploy(
          ctx,
          "npx",
          ["wrangler", "pages", "deploy", buildDir],
          "Cloudflare Pages"
        );
      }

      default:
        return `Unknown deploy target: "${target}". Use vercel, netlify, or cloudflare.`;
    }
  },
};

async function runDeploy(
  ctx: ToolContext,
  cmd: string,
  args: string[],
  label: string
): Promise<string> {
  await ctx.sendMessage(`Deploying to ${label}...`);

  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd: ctx.projectPath,
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env },
    });

    const output = (stdout + stderr).trim();

    // Try to extract URL from output
    const urlMatch = output.match(/https?:\/\/[^\s]+/);
    if (urlMatch) {
      return `Deployed to ${label}!\nURL: ${urlMatch[0]}`;
    }
    return `${label} deploy output:\n${output.slice(-2000)}`;
  } catch (err: any) {
    const msg = err.stderr || err.stdout || err.message || "Unknown error";
    return `${label} deploy failed:\n${msg.toString().trim().slice(-2000)}`;
  }
}
