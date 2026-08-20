import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentSession } from "./types.js";

const SESSION_DIR = path.join(
  process.env.HOME || "/tmp",
  ".project-analysis-mcp",
  "agent",
  "sessions"
);

function ensureDir(): void {
  if (!fs.existsSync(SESSION_DIR)) {
    fs.mkdirSync(SESSION_DIR, { recursive: true });
  }
}

function safeSessionId(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sessionPath(sessionId: string): string {
  return path.join(SESSION_DIR, `${safeSessionId(sessionId)}.json`);
}

export function createSession(projectName: string): AgentSession {
  const now = new Date().toISOString();
  const id = `sess_${crypto.randomBytes(8).toString("hex")}`;
  const session: AgentSession = {
    id,
    projectName,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  saveSession(session);
  return session;
}

export function loadSession(sessionId: string): AgentSession | null {
  const filePath = sessionPath(sessionId);
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as AgentSession;
  } catch {
    return null;
  }
}

export function saveSession(session: AgentSession): AgentSession {
  ensureDir();
  session.updatedAt = new Date().toISOString();
  const filePath = sessionPath(session.id);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(session, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
  return session;
}

export function deleteSession(sessionId: string): boolean {
  const filePath = sessionPath(sessionId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function listSessions(): AgentSession[] {
  ensureDir();
  const files = fs.readdirSync(SESSION_DIR).filter(file => file.endsWith(".json"));
  return files
    .map(file => {
      try {
        return JSON.parse(
          fs.readFileSync(path.join(SESSION_DIR, file), "utf-8")
        ) as AgentSession;
      } catch {
        return null;
      }
    })
    .filter((session): session is AgentSession => Boolean(session))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
