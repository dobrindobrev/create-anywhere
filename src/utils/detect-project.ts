import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface ProjectInfo {
  startCommand: string;
  args: string[];
  port: number;
  buildCommand?: string;
}

export function detectProject(projectPath: string): ProjectInfo {
  const pkgPath = join(projectPath, "package.json");

  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};

      if (scripts.dev) {
        // Vite uses 5173 by default, Next.js uses 3000
        const port = scripts.dev.includes("vite") ? 5173 : 3000;
        return { startCommand: "npm", args: ["run", "dev"], port };
      }
      if (scripts.start) {
        return { startCommand: "npm", args: ["start"], port: 3000 };
      }
    } catch {
      // fall through
    }
  }

  if (existsSync(join(projectPath, "index.html"))) {
    return { startCommand: "npx", args: ["serve", "."], port: 3000 };
  }

  return { startCommand: "npx", args: ["serve", "."], port: 3000 };
}

export function detectBuildDir(projectPath: string): string {
  for (const dir of ["dist", "build", "out", ".next", "public"]) {
    if (existsSync(join(projectPath, dir))) {
      return dir;
    }
  }
  return ".";
}
