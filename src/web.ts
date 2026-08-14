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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..", "web");
const PORT = Number(process.env.PORT || 9527);
const HOST = process.env.HOST || "127.0.0.1";

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

  if (pathname === "/api/projects") {
    const projects = listAllKnowledge()
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
      .map(toProjectSummary);
    sendJson(res, 200, { projects });
    return;
  }

  if (pathname.startsWith("/api/projects/")) {
    const rawName = pathname.slice("/api/projects/".length);
    const projectName = decodeURIComponent(rawName);
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
