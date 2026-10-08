import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getLogger } from "../utils/logger.js";

const log = getLogger("persistence");

const DIR = join(homedir(), ".create-anywhere");
const STATE_FILE = join(DIR, "sessions.json");

export interface PersistedSession {
  id: string;
  projectId: string;
  projectPath: string;
  chatId: string;
  userId: string;
  platform: string;
  autoApprove: boolean;
  sessionId: string; // Claude --session-id UUID
  createdAt: number;
}

export function saveState(sessions: PersistedSession[]): void {
  try {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(sessions, null, 2), "utf-8");
    log.debug({ count: sessions.length }, "Sessions persisted to disk");
  } catch (err) {
    log.error({ err }, "Failed to persist sessions");
  }
}

export function loadState(): PersistedSession[] {
  try {
    const data = readFileSync(STATE_FILE, "utf-8");
    const sessions = JSON.parse(data) as PersistedSession[];
    log.info({ count: sessions.length }, "Loaded persisted sessions");
    return sessions;
  } catch {
    return [];
  }
}
