import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProjectAnalysis } from "../analyzer/project-analyzer.js";
import {
  generateProjectToolRegistry,
  getRegisteredTool,
  listRegisteredTools,
  loadToolRegistry,
} from "../registry/tool-registry.js";

export function registerToolGeneratorTools(server: McpServer): void {
  server.tool(
    "generate_project_tools",
    "根据已生成的 Project Knowledge 中的业务能力，生成 AI Tool 并写入 Tool Registry。Tool 代表完整业务能力，保留原系统 API 的真实调用方式，不复制或重新实现业务规则。",
    {
      projectName: z.string().describe("项目名称"),
      moduleIds: z.array(z.string()).optional().describe("只生成指定模块的 Tool"),
      capabilityIds: z.array(z.string()).optional().describe("只生成指定业务能力的 Tool"),
    },
    async ({ projectName, moduleIds, capabilityIds }) => {
      const analysis = getProjectAnalysis(projectName);
      if (!analysis) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」尚未执行 analyze_project_static，无法生成 Tool。`,
            },
          ],
        };
      }

      const result = generateProjectToolRegistry(analysis, {
        moduleIds,
        capabilityIds,
      });
      const active = result.registry.tools.filter(tool => tool.status === "active");
      const deprecated = result.registry.tools.filter(tool => tool.status === "deprecated");
      const lines = [
        `✅ Tool Registry 已更新: ${result.registry.projectName}`,
        `📁 路径: ${result.registry.projectPath}`,
        `🧰 活跃 Tool: ${active.length}`,
        `🗂️ 已废弃: ${deprecated.length}`,
        `🆕 本次新增/更新: ${result.generated}`,
      ];
      if (result.skipped.length > 0) {
        lines.push("", `⏭️ 跳过 ${result.skipped.length} 个能力:`);
        for (const item of result.skipped) {
          lines.push(`  - ${item.name}: ${item.reason}`);
        }
      }
      lines.push("", "📋 活跃 Tool:");
      if (active.length === 0) {
        lines.push("  （无）");
      } else {
        for (const tool of active) {
          lines.push(
            `  - ${tool.name} | ${tool.riskLevel} | 确认=${tool.requiresConfirmation ? "是" : "否"} | ${tool.apiMapping.method} ${tool.apiMapping.path}`
          );
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "list_registered_tools",
    "列出指定项目已注册的 AI Tool。",
    {
      projectName: z.string().describe("项目名称"),
      status: z.enum(["draft", "active", "disabled", "deprecated"]).optional().describe("按状态筛选"),
    },
    async ({ projectName, status }) => {
      const tools = listRegisteredTools(projectName, status);
      if (tools.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `📭 项目「${projectName}」暂无匹配的已注册 Tool。`,
            },
          ],
        };
      }
      const lines = [
        `📋 Tool Registry: ${projectName} (${tools.length} 个)`,
        "",
        ...tools.map(tool =>
          `- ${tool.name} | ${tool.module} | ${tool.riskLevel} | 确认=${tool.requiresConfirmation ? "是" : "否"} | ${tool.api} | ${tool.status} v${tool.version}`
        ),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "get_registered_tool",
    "获取指定项目中单个已注册 Tool 的完整定义，包括 inputSchema、outputSchema、apiMapping、权限和确认策略。",
    {
      projectName: z.string().describe("项目名称"),
      toolName: z.string().describe("Tool 名称，如 create_plan"),
    },
    async ({ projectName, toolName }) => {
      const tool = getRegisteredTool(projectName, toolName);
      if (!tool) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」中未找到 Tool「${toolName}」。`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(tool, null, 2) }],
      };
    }
  );

  server.tool(
    "get_tool_registry",
    "获取指定项目完整的 Tool Registry JSON。",
    {
      projectName: z.string().describe("项目名称"),
    },
    async ({ projectName }) => {
      const registry = loadToolRegistry(projectName);
      if (!registry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」尚未生成 Tool Registry。`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(registry, null, 2) }],
      };
    }
  );
}
