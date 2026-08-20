import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  analyzeWebProject,
  formatAnalysisSummary,
  getProjectAnalysis,
} from "../analyzer/project-analyzer.js";

export function registerProjectAnalyzerTools(server: McpServer): void {
  server.tool(
    "analyze_project_static",
    "自动静态分析一个 Web 项目目录，生成或增量更新 AI 可操作 Project Knowledge，包括模块、页面、API、实体、权限、业务能力、状态流转和工作流。不会执行项目代码，也不会直接调用项目 API。",
    {
      projectName: z.string().describe("项目名称，如'计划管理'"),
      projectPath: z.string().describe("Web 项目绝对路径"),
      force: z.boolean().optional().describe("默认 false 执行增量合并；true 强制重新分析并覆盖"),
    },
    async ({ projectName, projectPath, force }) => {
      try {
        const analysis = await analyzeWebProject(projectName, projectPath, { force });
        return {
          content: [
            {
              type: "text" as const,
              text: formatAnalysisSummary(analysis),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [{ type: "text" as const, text: `❌ 项目分析失败\n\n${message}` }],
          isError: true,
        };
      }
    }
  );

  server.tool(
    "get_project_analysis",
    "获取指定项目已生成的 Project Knowledge 结构化 JSON。可用于让 AI Agent 理解页面能力、API、权限、状态和工作流。",
    {
      projectName: z.string().describe("项目名称"),
    },
    async ({ projectName }) => {
      const analysis = getProjectAnalysis(projectName);
      if (!analysis) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」尚未执行 analyze_project_static，请先分析。`,
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(analysis, null, 2),
          },
        ],
      };
    }
  );
}
