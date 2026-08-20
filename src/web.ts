import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  listAllKnowledge,
  loadKnowledge,
} from "./utils/knowledge-store.js";
import type { ProjectKnowledge } from "./utils/knowledge-store.js";
import { searchKnowledge } from "./utils/knowledge-search.js";
import { runAgentTurn } from "./agent/agent-runtime.js";
import {
  listSessions,
  loadSession,
} from "./agent/session-store.js";
import { listExecutionLogs } from "./agent/log-store.js";
import {
  loadAgentConfig,
  maskAgentConfig,
  saveAgentConfig,
} from "./provider/config-store.js";
import { loadToolRegistry } from "./registry/tool-registry.js";
import { loadWorkflowRegistry } from "./workflow/workflow-store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..", "web");
const PORT = Number(process.env.PORT || 9527);
const HOST = process.env.HOST || "0.0.0.0";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) as Record<string, unknown> : {});
      } catch {
        reject(new Error("invalid_json"));
      }
    });
    req.on("error", reject);
  });
}

function sortByRecordedAtDesc(
  insights: ProjectKnowledge["insights"]
): ProjectKnowledge["insights"] {
  return [...insights].sort((a, b) =>
    String(b.recordedAt).localeCompare(String(a.recordedAt))
  );
}

function toProjectSummary(knowledge: ProjectKnowledge) {
  const categoryCounts: Record<string, number> = {};
  const statusCounts: Record<string, number> = {};

  for (const insight of knowledge.insights) {
    categoryCounts[insight.category] =
      (categoryCounts[insight.category] || 0) + 1;
    const status = insight.status || "active";
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  }

  const recentInsights = sortByRecordedAtDesc(knowledge.insights)
    .slice(0, 5)
    .map((insight) => ({
      id: insight.id,
      question: insight.question,
      category: insight.category,
      status: insight.status || "active",
      version: insight.version || 1,
      recordedAt: insight.recordedAt,
    }));

  return {
    name: knowledge.name,
    projectPath: knowledge.projectPath,
    businessSummary: knowledge.businessSummary,
    createdAt: knowledge.createdAt,
    lastUpdated: knowledge.lastUpdated,
    insightCount: knowledge.insights.length,
    categoryCounts,
    statusCounts,
    recentInsights,
  };
}

function serveStatic(
  res: http.ServerResponse,
  pathname: string
): void {
  let relativePath: string;
  try {
    relativePath = decodeURIComponent(pathname).replace(/^\/+/, "");
  } catch {
    sendJson(res, 400, { error: "invalid_path" });
    return;
  }

  if (!relativePath) relativePath = "index.html";

  const filePath = path.resolve(WEB_ROOT, relativePath);
  const isInsideWebRoot =
    filePath === WEB_ROOT || filePath.startsWith(WEB_ROOT + path.sep);

  if (!isInsideWebRoot) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }

    const contentType = MIME[path.extname(filePath)] || "application/octet-stream";
    res.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
    });
    res.end(data);
  });
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;

  if (pathname === "/api/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (pathname === "/api/llm/config") {
    if (req.method === "POST") {
      try {
        const body = await readJsonBody(req);
        const existing = loadAgentConfig();
        const provider = String(body.provider || "");
        const baseURL = String(body.baseURL || "");
        const apiKey = body.apiKey && body.apiKey !== "***"
          ? String(body.apiKey)
          : existing?.apiKey || "";
        const model = String(body.model || "");
        if (!provider || !baseURL || !apiKey || !model) {
          sendJson(res, 400, { error: "provider/baseURL/apiKey/model are required" });
          return;
        }
        const config = saveAgentConfig({
          provider,
          baseURL,
          apiKey,
          model,
          apiBaseURL: body.apiBaseURL ? String(body.apiBaseURL) : undefined,
          apiToken: body.apiToken && body.apiToken !== "***"
            ? String(body.apiToken)
            : existing?.apiToken,
          allowedPermissions: Array.isArray(body.allowedPermissions)
            ? (body.allowedPermissions as string[])
            : undefined,
          maxIterations: typeof body.maxIterations === "number" ? body.maxIterations : undefined,
          timeoutMs: typeof body.timeoutMs === "number" ? body.timeoutMs : undefined,
          temperature: typeof body.temperature === "number" ? body.temperature : undefined,
          retryCount: typeof body.retryCount === "number" ? body.retryCount : undefined,
        });
        sendJson(res, 200, { config: maskAgentConfig(config) });
      } catch (error) {
        sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }
    const config = loadAgentConfig();
    sendJson(res, 200, { config: config ? maskAgentConfig(config) : null });
    return;
  }

  if (pathname === "/api/agent/chat" && req.method === "POST") {
    try {
      const body = await readJsonBody(req);
      const projectName = String(body.projectName || "");
      const message = String(body.message || "");
      if (!projectName || !message) {
        sendJson(res, 400, { error: "projectName and message are required" });
        return;
      }
      const result = await runAgentTurn({
        projectName,
        message,
        sessionId: body.sessionId ? String(body.sessionId) : undefined,
      });
      sendJson(res, 200, { result });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (pathname === "/api/agent/sessions") {
    sendJson(res, 200, { sessions: listSessions() });
    return;
  }

  if (pathname.startsWith("/api/agent/sessions/")) {
    const rawSession = pathname.slice("/api/agent/sessions/".length);
    const sessionId = decodeURIComponent(rawSession.replace(/\/logs$/, ""));
    const isLogs = rawSession.endsWith("/logs");
    if (isLogs) {
      sendJson(res, 200, { logs: listExecutionLogs(sessionId) });
      return;
    }
    const session = loadSession(sessionId);
    if (!session) {
      sendJson(res, 404, { error: "session_not_found" });
      return;
    }
    sendJson(res, 200, { session });
    return;
  }

  if (pathname === "/api/projects") {
    const projects = listAllKnowledge()
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
      .map(toProjectSummary);
    sendJson(res, 200, { projects });
    return;
  }

  if (pathname.startsWith("/api/projects/")) {
    const parts = pathname.slice("/api/projects/".length).split("/").filter(Boolean);
    const projectName = decodeURIComponent(parts[0] || "");
    const suffix = parts[1];
    if (suffix === "tools") {
      const registry = loadToolRegistry(projectName);
      sendJson(res, 200, { tools: registry?.tools || [] });
      return;
    }
    if (suffix === "workflows") {
      const registry = loadWorkflowRegistry(projectName);
      sendJson(res, 200, { workflows: registry?.workflows || [] });
      return;
    }
    const knowledge = loadKnowledge(projectName);

    if (!knowledge) {
      sendJson(res, 404, { error: "project_not_found" });
      return;
    }

    sendJson(res, 200, { project: knowledge });
    return;
  }

  if (pathname === "/api/search") {
    const query = (url.searchParams.get("q") || "").trim();
    if (!query) {
      sendJson(res, 200, { query, total: 0, results: [] });
      return;
    }

    const results = searchKnowledge(query);
    sendJson(res, 200, { query, total: results.length, results });
    return;
  }

  if (pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  serveStatic(res, pathname);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    console.error("[web] request error", error);
    if (!res.headersSent) {
      sendJson(res, 500, { error: "internal_error" });
    } else {
      res.end();
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[web] project-analysis web UI: http://${HOST}:${PORT}`);
});
