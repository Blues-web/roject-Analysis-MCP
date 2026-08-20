import type { RegisteredTool } from "../registry/types.js";
import type {
  AgentRuntimeConfig,
  ExecutionResult,
} from "./types.js";

function missingInputs(
  tool: RegisteredTool,
  args: Record<string, unknown>
): string[] {
  return (tool.inputSchema.required || []).filter(
    name => args[name] === undefined || args[name] === null || args[name] === ""
  );
}

function buildRequest(
  tool: RegisteredTool,
  args: Record<string, unknown>,
  config: AgentRuntimeConfig
): {
  url: URL;
  method: string;
  headers: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
} {
  if (!config.apiBaseURL) {
    throw new Error(`Tool ${tool.name} 未配置原系统 API baseURL`);
  }
  const url = new URL(tool.apiMapping.path, config.apiBaseURL);
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(config.extraHeaders || {}),
  };

  if (config.apiToken) {
    headers.Authorization = `Bearer ${config.apiToken}`;
  }

  for (const mapping of tool.apiMapping.requestMapping) {
    const value = args[mapping.toolParam] ?? args[mapping.apiParam];
    if (value === undefined || value === null) continue;
    switch (mapping.location) {
      case "query":
        query.set(mapping.apiParam, String(value));
        break;
      case "body":
        body[mapping.apiParam] = value;
        break;
      case "path":
        url.pathname = url.pathname
          .replace(`:${mapping.apiParam}`, encodeURIComponent(String(value)))
          .replace(`{${mapping.apiParam}}`, encodeURIComponent(String(value)));
        break;
      case "header":
        headers[mapping.apiParam] = String(value);
        break;
    }
  }

  if (Object.keys(body).length === 0 && tool.apiMapping.requestMapping.length === 0) {
    for (const [key, value] of Object.entries(args)) {
      if (tool.apiMapping.method.toUpperCase() === "GET") {
        query.set(key, String(value));
      } else {
        body[key] = value;
      }
    }
  }

  return {
    url,
    method: tool.apiMapping.method.toUpperCase(),
    headers,
    query,
    body,
  };
}

async function fetchWithRetry(
  request: ReturnType<typeof buildRequest>,
  config: AgentRuntimeConfig
): Promise<Response> {
  const maxRetries = Math.max(0, config.retryCount ?? 1);
  const timeoutMs = config.timeoutMs || 30000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = request.url;
    if (request.query.size > 0) {
      url.search = request.query.toString();
    }
    try {
      const response = await fetch(url, {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD"
          ? undefined
          : JSON.stringify(request.body),
        signal: controller.signal,
      });
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < maxRetries && /fetch|network|timeout|abort|ECONN/i.test(String(error))) {
        await new Promise(resolve => setTimeout(resolve, 300 * (attempt + 1)));
        continue;
      }
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("原系统 API 请求失败");
}

export async function executeTool(
  tool: RegisteredTool,
  args: Record<string, unknown>,
  config: AgentRuntimeConfig
): Promise<ExecutionResult> {
  const missing = missingInputs(tool, args);
  if (missing.length > 0) {
    return {
      success: false,
      toolName: tool.name,
      needsInput: true,
      missingInputs: missing,
      message: `Tool ${tool.name} 缺少参数: ${missing.join(", ")}`,
    };
  }

  if (tool.permission && !config.apiToken) {
    return {
      success: false,
      toolName: tool.name,
      error: `Tool ${tool.name} 需要原系统权限 ${tool.permission}，但未配置 apiToken`,
    };
  }

  const startedAt = Date.now();
  try {
    const request = buildRequest(tool, args, config);
    const response = await fetchWithRetry(request, config);
    const text = await response.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      // 保留原文
    }
    return {
      success: response.ok,
      toolName: tool.name,
      data,
      httpStatus: response.status,
      durationMs: Date.now() - startedAt,
      message: response.ok ? "调用成功" : `原系统 API 返回 ${response.status}`,
    };
  } catch (error) {
    return {
      success: false,
      toolName: tool.name,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - startedAt,
    };
  }
}
