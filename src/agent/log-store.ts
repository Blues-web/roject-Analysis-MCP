import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  ExecutionLogEntry,
  ExecutionLogType,
} from "./types.js";

const LOG_DIR = path.join(
  process.env.HOME || "/tmp",
  ".project-analysis-mcp",
  "agent",
  "logs"
);

function ensureDir(): void {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function logPath(sessionId: string): string {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(LOG_DIR, `${safe}.jsonl`);
}

export function appendExecutionLog(
  sessionId: string,
  projectName: string,
  type: ExecutionLogType,
  message: string,
  details?: Record<string, unknown>
): ExecutionLogEntry {
  ensureDir();
  const entry: ExecutionLogEntry = {
    id: `log_${crypto.randomBytes(8).toString("hex")}`,
    sessionId,
    projectName,
    timestamp: new Date().toISOString(),
    type,
    message,
    details,
  };
  fs.appendFileSync(logPath(sessionId), `${JSON.stringify(entry)}\n`, "utf-8");
  return entry;
}

export function listExecutionLogs(sessionId: string): ExecutionLogEntry[] {
  const filePath = logPath(sessionId);
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
  return lines
    .map(line => {
      try {
        return JSON.parse(line) as ExecutionLogEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is ExecutionLogEntry => Boolean(entry));
}

export function deleteExecutionLogs(sessionId: string): boolean {
  const filePath = logPath(sessionId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}
