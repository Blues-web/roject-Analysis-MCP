import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getProjectAnalysis } from "../analyzer/project-analyzer.js";
import { loadToolRegistry } from "../registry/tool-registry.js";
import {
  generateProjectWorkflows,
  getRegisteredWorkflow,
  listRegisteredWorkflows,
  loadWorkflowRegistry,
} from "../workflow/workflow-store.js";

export function registerWorkflowGeneratorTools(server: McpServer): void {
  server.tool(
    "generate_project_workflows",
    "根据 Project Knowledge 和 Tool Registry 自动生成结构化业务 Workflow，识别连续 Tool 调用、状态流转、页面按钮顺序和参数依赖。Workflow 不写死执行代码，只生成步骤、参数传递、条件分支、确认、暂停和失败策略。",
    {
      projectName: z.string().describe("项目名称"),
      moduleIds: z.array(z.string()).optional().describe("只生成指定模块的 Workflow"),
    },
    async ({ projectName, moduleIds }) => {
      const analysis = getProjectAnalysis(projectName);
      if (!analysis) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」尚未执行 analyze_project_static。`,
            },
          ],
        };
      }
      const toolRegistry = loadToolRegistry(projectName);
      if (!toolRegistry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」尚未生成 Tool Registry，请先调用 generate_project_tools。`,
            },
          ],
        };
      }

      const result = generateProjectWorkflows(analysis, toolRegistry, { moduleIds });
      const active = result.registry.workflows.filter(item => item.status === "active");
      const deprecated = result.registry.workflows.filter(item => item.status === "deprecated");
      const lines = [
        `✅ Workflow Registry 已更新: ${result.registry.projectName}`,
        `📁 路径: ${result.registry.projectPath}`,
        `🔀 活跃 Workflow: ${active.length}`,
        `🗂️ 已废弃: ${deprecated.length}`,
        `🆕 本次新增/更新: ${result.generated}`,
        "",
        "📋 Workflow 列表:",
      ];
      if (active.length === 0) {
        lines.push("  （无）");
      } else {
        for (const workflow of active) {
          lines.push(
            `  - ${workflow.name} | ${workflow.module} | ${workflow.confirmationPolicy} | 示例: ${workflow.triggerExamples[0] || "-"}`
          );
        }
      }
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "list_registered_workflows",
    "列出指定项目已生成的业务 Workflow。",
    {
      projectName: z.string().describe("项目名称"),
      status: z.enum(["draft", "active", "disabled", "deprecated"]).optional().describe("按状态筛选"),
    },
    async ({ projectName, status }) => {
      const workflows = listRegisteredWorkflows(projectName, status);
      if (workflows.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: `📭 项目「${projectName}」暂无匹配的 Workflow。`,
            },
          ],
        };
      }
      const lines = [
        `🔀 Workflow Registry: ${projectName} (${workflows.length} 个)`,
        "",
        ...workflows.map(workflow =>
          `- ${workflow.name} | ${workflow.module} | ${workflow.confirmationPolicy} | ${workflow.status} v${workflow.version}`
        ),
      ];
      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
      };
    }
  );

  server.tool(
    "get_registered_workflow",
    "获取单个已注册 Workflow 的完整结构化定义。",
    {
      projectName: z.string().describe("项目名称"),
      workflowName: z.string().describe("Workflow 名称，如 create_and_submit_plan"),
    },
    async ({ projectName, workflowName }) => {
      const workflow = getRegisteredWorkflow(projectName, workflowName);
      if (!workflow) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」中未找到 Workflow「${workflowName}」。`,
            },
          ],
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(workflow, null, 2) }],
      };
    }
  );

  server.tool(
    "get_workflow_registry",
    "获取指定项目完整的 Workflow Registry JSON。",
    {
      projectName: z.string().describe("项目名称"),
    },
    async ({ projectName }) => {
      const registry = loadWorkflowRegistry(projectName);
      if (!registry) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 项目「${projectName}」尚未生成 Workflow Registry。`,
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
