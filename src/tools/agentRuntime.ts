import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { runAgentTurn } from "../agent/agent-runtime.js";
import { listExecutionLogs } from "../agent/log-store.js";
import {
  listSessions,
  loadSession,
} from "../agent/session-store.js";
import {
  loadAgentConfig,
  maskAgentConfig,
  saveAgentConfig,
} from "../provider/config-store.js";

export function registerAgentRuntimeTools(server: McpServer): void {
  server.tool(
    "configure_llm_provider",
    "配置 Agent Runtime 使用的统一 LLM Provider，支持 OpenAI 和 OpenAI Compatible API。apiKey 会写入本地配置目录，不会写入项目知识。",
    {
      provider: z.string().describe("openai 或 openai-compatible"),
      baseURL: z.string().describe("LLM API base URL，例如 https://api.openai.com/v1"),
      apiKey: z.string().describe("LLM API Key"),
      model: z.string().describe("模型名称，例如 gpt-4o-mini"),
      apiBaseURL: z.string().optional().describe("原系统业务 API base URL，Tool 执行时使用"),
      apiToken: z.string().optional().describe("原系统 API Token，避免绕过原系统权限"),
      allowedPermissions: z.array(z.string()).optional().describe("允许执行的权限白名单"),
      maxIterations: z.number().optional().describe("单轮最大 Tool 调用轮次"),
      timeoutMs: z.number().optional().describe("LLM/API 超时时间"),
      temperature: z.number().optional().describe("LLM temperature"),
      retryCount: z.number().optional().describe("API 重试次数"),
    },
    async ({ provider, baseURL, apiKey, model, apiBaseURL, apiToken, allowedPermissions, maxIterations, timeoutMs, temperature, retryCount }) => {
      saveAgentConfig({
        provider,
        baseURL,
        apiKey,
        model,
        apiBaseURL,
        apiToken,
        allowedPermissions,
        maxIterations,
        timeoutMs,
        temperature,
        retryCount,
      });
      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✅ LLM Provider 已配置`,
              `Provider: ${provider}`,
              `Base URL: ${baseURL}`,
              `Model: ${model}`,
              `API Key: ***`,
              apiBaseURL ? `原系统 API Base URL: ${apiBaseURL}` : "原系统 API Base URL: 未配置",
            ].join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "get_llm_config",
    "获取当前 LLM Provider 配置，API Key 会脱敏。",
    {},
    async () => {
      const config = loadAgentConfig();
      if (!config) {
        return {
          content: [{ type: "text" as const, text: "❌ 尚未配置 LLM Provider" }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(maskAgentConfig(config), null, 2),
          },
        ],
      };
    }
  );

  server.tool(
    "agent_chat",
    "向 Agent Runtime 发送用户消息。Agent 会结合 Project Knowledge、Tool Registry 和 Workflow Registry，由 LLM 判断意图、选择 Tool/Workflow、校验参数、执行并生成自然语言结果。",
    {
      projectName: z.string().describe("项目名称"),
      message: z.string().describe("用户消息"),
      sessionId: z.string().optional().describe("会话 ID；不传则创建新会话"),
    },
    async ({ projectName, message, sessionId }) => {
      try {
        const result = await runAgentTurn({ projectName, message, sessionId });
        const lines = [
          `💬 ${result.reply}`,
          `📇 会话: ${result.sessionId}`,
        ];
        if (result.executedTools.length > 0) {
          lines.push(`🧰 已调用 Tool: ${result.executedTools.join(", ")}`);
        }
        if (result.executedWorkflows.length > 0) {
          lines.push(`🔀 已执行 Workflow: ${result.executedWorkflows.join(", ")}`);
        }
        if (result.needsUserInput) {
          lines.push(`📥 还需要: ${(result.missingInputs || []).join(", ")}`);
        }
        if (result.confirmationRequest) {
          lines.push(`🔐 需要确认: ${result.confirmationRequest}`);
        }
        return {
          content: [{ type: "text" as const, text: lines.join("\n") }],
        };
      } catch (error) {
        const messageText = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `❌ Agent 执行失败\n\n${messageText}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "agent_list_sessions",
    "列出 Agent Runtime 已保存的会话。",
    {},
    async () => {
      const sessions = listSessions();
      if (sessions.length === 0) {
        return {
          content: [{ type: "text" as const, text: "📭 暂无 Agent 会话" }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: sessions.map(session =>
              `- ${session.id} | ${session.projectName} | ${session.updatedAt} | 消息 ${session.messages.length}`
            ).join("\n"),
          },
        ],
      };
    }
  );

  server.tool(
    "agent_get_session",
    "获取 Agent 会话完整消息上下文。",
    {
      sessionId: z.string().describe("会话 ID"),
    },
    async ({ sessionId }) => {
      const session = loadSession(sessionId);
      if (!session) {
        return {
          content: [{ type: "text" as const, text: `❌ 会话 ${sessionId} 不存在` }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(session, null, 2) }],
      };
    }
  );

  server.tool(
    "agent_list_execution_logs",
    "列出指定 Agent 会话的执行日志。",
    {
      sessionId: z.string().describe("会话 ID"),
    },
    async ({ sessionId }) => {
      const logs = listExecutionLogs(sessionId);
      if (logs.length === 0) {
        return {
          content: [{ type: "text" as const, text: "📭 暂无执行日志" }],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(logs, null, 2) }],
      };
    }
  );
}
