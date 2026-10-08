import { spawn, type ChildProcess } from "node:child_process";
import type { AgentTool, ToolContext } from "./types.js";
import { detectProject } from "../utils/detect-project.js";
import { getLogger } from "../utils/logger.js";

const log = getLogger("preview");

interface RunningPreview {
  serverProc: ChildProcess;
  ngrokProc: ChildProcess | null;
  url: string | null;
  port: number;
}

const previews = new Map<string, RunningPreview>();

async function findAvailablePort(start: number, end: number): Promise<number> {
  const net = await import("node:net");
  for (let port = start; port <= end; port++) {
    const available = await new Promise<boolean>((resolve) => {
      const srv = net.createServer();
      srv.once("error", () => resolve(false));
      srv.listen(port, () => {
        srv.close(() => resolve(true));
      });
    });
    if (available) return port;
  }
  throw new Error(`No available ports in range ${start}-${end}`);
}

async function getNgrokUrl(): Promise<string | null> {
  try {
    const resp = await fetch("http://127.0.0.1:4040/api/tunnels");
    const data = (await resp.json()) as any;
    const tunnel = data.tunnels?.[0];
    return tunnel?.public_url ?? null;
  } catch {
    return null;
  }
}

export const previewTool: AgentTool = {
  name: "preview",
  description: "Start a dev server with ngrok tunnel for phone preview",

  async execute(args: string[], ctx: ToolContext): Promise<string> {
    if (args[0] === "stop") {
      return stopPreview(ctx.projectPath);
    }

    const existing = previews.get(ctx.projectPath);
    if (existing) {
      return `Preview already running${existing.url ? ` at ${existing.url}` : ` on port ${existing.port}`}`;
    }

    const project = detectProject(ctx.projectPath);
    let port: number;
    try {
      port = await findAvailablePort(3100, 3199);
    } catch {
      port = project.port;
    }

    await ctx.sendMessage("Starting dev server...");

    // Set PORT env for the dev server
    const env = { ...process.env, PORT: String(port) };
    const serverProc = spawn(project.startCommand, project.args, {
      cwd: ctx.projectPath,
      env,
      stdio: "pipe",
    });

    serverProc.on("error", (err) => {
      log.error({ err }, "Dev server error");
    });

    serverProc.on("close", () => {
      previews.delete(ctx.projectPath);
    });

    const preview: RunningPreview = {
      serverProc,
      ngrokProc: null,
      url: null,
      port,
    };
    previews.set(ctx.projectPath, preview);

    // Wait a bit for server to start
    await new Promise((r) => setTimeout(r, 3000));

    // Start ngrok tunnel
    try {
      const ngrokProc = spawn("ngrok", ["http", String(port)], {
        stdio: "pipe",
      });
      preview.ngrokProc = ngrokProc;

      ngrokProc.on("error", (err) => {
        log.warn({ err }, "Ngrok failed to start");
      });

      ngrokProc.on("close", () => {
        if (preview.ngrokProc === ngrokProc) {
          preview.ngrokProc = null;
          preview.url = null;
        }
      });

      // Wait for ngrok to establish tunnel
      await new Promise((r) => setTimeout(r, 2000));
      const url = await getNgrokUrl();
      preview.url = url;

      if (url) {
        return `Preview running!\nLocal: http://localhost:${port}\nPublic: ${url}`;
      }
      return `Dev server running on http://localhost:${port}\n(ngrok tunnel couldn't be established — is ngrok installed and authed?)`;
    } catch {
      return `Dev server running on http://localhost:${port}\n(ngrok not available)`;
    }
  },
};

function stopPreview(projectPath: string): string {
  const preview = previews.get(projectPath);
  if (!preview) return "No preview running.";

  preview.serverProc.kill("SIGTERM");
  preview.ngrokProc?.kill("SIGTERM");
  previews.delete(projectPath);
  return "Preview stopped.";
}
