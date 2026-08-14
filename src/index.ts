import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  createKnowledge,
  updateBusinessSummary,
  loadKnowledge,
  hasKnowledge,
  addInsight,
  queryInsights,
  getInsightStats,
  listAllKnowledge,
  deleteInsight,
  getInsightById,
  updateInsightFreshness,
  batchUpdateFreshness,
} from "./utils/knowledge-store.js";
import type { InsightCategory, InsightStatus } from "./utils/knowledge-store.js";
import { createFileSnapshots, type FileSnapshot } from "./utils/scanner.js";
import {
  checkInsightFreshness,
  checkProjectFreshness,
  createFileStatCache,
  type InsightFreshnessResult,
} from "./utils/freshness.js";
import {
  analyzeImpact,
  formatImpactAnalysis,
} from "./utils/impact-analyzer.js";

const server = new McpServer({
  name: "project-analysis",
  version: "5.0.0",
});

// ============ 工具1: 分析项目 ============
server.tool(
  "analyze_project",
  "分析项目并记录业务总结。首次分析时创建项目知识，后续可更新业务总结。",
  {
    projectName: z.string().describe("项目名称，如'智能巡视'、'用户系统'"),
    projectPath: z.string().describe("项目的绝对路径"),
    businessSummary: z.string().describe("项目业务总结（由你分析后生成，只包含业务逻辑，不包含文件列表）"),
  },
  async ({ projectName, projectPath, businessSummary }) => {
    if (hasKnowledge(projectName)) {
      const updated = updateBusinessSummary(projectName, businessSummary);
      
      if (!updated) {
        return {
          content: [{ type: "text" as const, text: "❌ 更新失败" }],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: [
              `✅ 项目「${projectName}」业务总结已更新`,
              "",
              "📝 总结:",
              businessSummary,
              "",
              `💡 后续分析具体问题时，请使用 record_insight 记录业务洞察。`,
            ].join("\n"),
          },
        ],
      };
    }

    const knowledge = createKnowledge(projectName, projectPath, businessSummary);

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `✅ 项目「${projectName}」知识已创建`,
            "",
            "📝 业务总结:",
            businessSummary,
            "",
            `💡 后续分析具体问题时，请使用 record_insight 记录业务洞察。`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ============ 工具2: 记录洞察 ============
server.tool(
  "record_insight",
  "【重要】记录对项目代码的业务分析洞察。当你回答用户关于项目的具体问题时（如架构设计、功能实现、数据流、API接口等），必须调用此工具记录问题和答案。这样下次遇到类似问题可以直接复用，避免重复分析。注意：只记录业务逻辑相关的洞察，不要记录文件列表或目录结构。系统会自动为 relatedFiles 中的文件生成快照（mtime/size/hash）。",
  {
    projectName: z.string().describe("项目名称"),
    question: z.string().describe("用户提出的问题或分析主题"),
    answer: z.string().describe("分析结果或答案（业务逻辑总结，不要包含文件路径列表）"),
    category: z.enum([
      "architecture", "feature", "pattern", "api", "data_flow",
      "bug_fix", "performance", "config", "dependency", "other",
    ]).describe("洞察分类"),
    tags: z.array(z.string()).optional().describe("标签列表，用于后续检索"),
    relatedFiles: z.array(z.string()).optional().describe("相关的关键文件路径（最多5个核心文件，相对路径或绝对路径）"),
    confidence: z.enum(["high", "medium", "low"]).optional().describe("置信度"),
    relatedSymbols: z.array(z.string()).optional().describe("关联的符号名（函数名、类名、变量名、类型名等）"),
    relatedModules: z.array(z.string()).optional().describe("关联的模块名（如 auth、user、order 等业务模块）"),
    relatedApis: z.array(z.string()).optional().describe("关联的 API 路径（如 /api/users、POST /login 等）"),
  },
  async ({ projectName, question, answer, category, tags, relatedFiles, confidence, relatedSymbols, relatedModules, relatedApis }) => {
    if (!hasKnowledge(projectName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 项目「${projectName}」尚未分析，请先调用 analyze_project。`,
          },
        ],
      };
    }

    const knowledge = loadKnowledge(projectName);
    const projectPath = knowledge?.projectPath || "";

    let fileSnapshots: FileSnapshot[] = [];
    if (relatedFiles && relatedFiles.length > 0 && projectPath) {
      fileSnapshots = await createFileSnapshots(relatedFiles, projectPath);
    }

    const insight = addInsight(projectName, {
      question,
      answer,
      category: category as InsightCategory,
      tags: tags || [],
      relatedFiles: relatedFiles || [],
      confidence: confidence || "high",
      relatedSymbols: relatedSymbols || [],
      relatedModules: relatedModules || [],
      relatedApis: relatedApis || [],
      fileSnapshots,
    });

    if (!insight) {
      return {
        content: [{ type: "text" as const, text: "❌ 记录洞察失败" }],
        isError: true,
      };
    }

    const tagStr = tags && tags.length > 0 ? `\n  标签: ${tags.join(", ")}` : "";
    const snapshotCount = fileSnapshots.length;
    const snapshotStr = snapshotCount > 0 ? `\n  📸 文件快照: ${snapshotCount} 个文件` : "";
    const symbolStr = relatedSymbols && relatedSymbols.length > 0 ? `\n  🔣 符号: ${relatedSymbols.join(", ")}` : "";
    const moduleStr = relatedModules && relatedModules.length > 0 ? `\n  📦 模块: ${relatedModules.join(", ")}` : "";
    const apiStr = relatedApis && relatedApis.length > 0 ? `\n  🔌 API: ${relatedApis.join(", ")}` : "";

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `✅ 洞察已记录到「${projectName}」知识库 (v${insight.version || 1})`,
            "",
            `📝 问题: ${question}`,
            `📂 分类: ${category}`,
            `🎯 置信度: ${confidence || "high"}`,
            `${tagStr}${snapshotStr}${symbolStr}${moduleStr}${apiStr}`,
            "",
            `💡 后续可通过 search_insights 查询复用。`,
          ].join("\n"),
        },
      ],
    };
  }
);

// ============ 工具3: 搜索洞察（P0-2 升级：可选新鲜度检查） ============
server.tool(
  "search_insights",
  "【重要】在回答问题前，先调用此工具搜索是否已有类似问题的分析记录。如果有，可以直接复用已有知识，避免重复分析。支持按关键词、分类、标签搜索。建议设置 checkFreshness=true 以检查关联代码是否变化，确保复用的知识仍然有效。",
  {
    projectName: z.string().describe("项目名称"),
    category: z.enum([
      "architecture", "feature", "pattern", "api", "data_flow",
      "bug_fix", "performance", "config", "dependency", "other",
    ]).optional().describe("按分类筛选"),
    keyword: z.string().optional().describe("搜索关键词（搜索问题和答案）"),
    tags: z.array(z.string()).optional().describe("按标签筛选"),
    limit: z.number().optional().describe("返回数量限制"),
    checkFreshness: z.boolean().optional().describe("是否检查新鲜度（默认 false）。开启后会检查关联文件是否变化，增加少量耗时"),
  },
  async ({ projectName, category, keyword, tags, limit, checkFreshness }) => {
    if (!hasKnowledge(projectName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 项目「${projectName}」尚未分析。`,
          },
        ],
      };
    }

    const insights = queryInsights(projectName, {
      category: category as InsightCategory | undefined,
      keyword,
      tags,
      limit: limit || 20,
    });

    if (insights.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: `📭 未找到匹配的洞察记录\n\n💡 可以继续分析并用 record_insight 记录新的洞察。`,
          },
        ],
      };
    }

    // [M4 + H4] 可选新鲜度检查：并行检查 + 批量更新
    const freshnessMap = new Map<string, InsightFreshnessResult>();
    let freshnessFreshCount = 0;
    let freshnessStaleCount = 0;
    let freshnessUnknownCount = 0;
    if (checkFreshness) {
      // [M3] 使用共享缓存避免重复 stat/hash
      const cache = createFileStatCache();
      
      // [M4] 并行检查所有 Insight 的新鲜度
      const results = await Promise.all(
        insights.map(insight => checkInsightFreshness(insight, cache))
      );

      for (const result of results) {
        freshnessMap.set(result.insightId, result);

        if (result.status === "fresh") freshnessFreshCount++;
        else if (result.status === "stale") freshnessStaleCount++;
        else freshnessUnknownCount++;
      }

      // [H4] 批量更新，单次文件写入
      batchUpdateFreshness(
        projectName,
        results.map(r => ({
          insightId: r.insightId,
          freshnessStatus: r.status,
          checkedAt: r.checkedAt,
        }))
      );
    }

    const categoryLabels: Record<string, string> = {
      architecture: "架构设计", feature: "功能实现", pattern: "设计模式",
      api: "API接口", data_flow: "数据流", bug_fix: "Bug修复",
      performance: "性能优化", config: "配置相关", dependency: "依赖相关",
      other: "其他",
    };

    const statusLabels: Record<string, string> = {
      active: "🟢有效", stale: "🟡可能过期", invalidated: "🔴已失效",
    };

    const freshnessLabels: Record<string, string> = {
      fresh: "🟢代码未变", stale: "🔴代码已变", unknown: "⚪无快照",
    };

    const insightList = insights
      .map(i => {
        const date = new Date(i.recordedAt).toLocaleDateString("zh-CN");
        const tagStr = i.tags.length > 0 ? ` [${i.tags.join(", ")}]` : "";
        const version = i.version || 1;
        const status = i.status || "active";
        const statusStr = statusLabels[status] || status;
        const snapshotCount = (i.fileSnapshots || []).length;
        const snapshotStr = snapshotCount > 0 ? ` | 📸${snapshotCount}文件` : "";

        // P0-2: 新鲜度信息
        const freshness = freshnessMap.get(i.id);
        const freshnessStr = freshness
          ? ` | ${freshnessLabels[freshness.status] || freshness.status}`
          : "";

        const lines = [
          `### ${i.question}`,
          `- 分类: ${categoryLabels[i.category] || i.category} | v${version} | ${statusStr}${snapshotStr}${freshnessStr}`,
          `- 日期: ${date} | 置信度: ${i.confidence}${tagStr}`,
          "",
          i.answer.length > 300 ? i.answer.slice(0, 300) + "..." : i.answer,
        ];

        // P0-2: 如果有新鲜度检查且状态为 stale，展示变化详情
        if (freshness && freshness.status === "stale") {
          lines.push("");
          lines.push(`⚠️ **代码已变化，建议重新验证**`);
          for (const cf of freshness.changedFiles) {
            lines.push(`  - ❌ ${cf.path}: ${cf.reason}`);
          }
          for (const mf of freshness.missingFiles) {
            lines.push(`  - 🗑️ ${mf.path}: ${mf.reason}`);
          }
        }

        lines.push("");
        lines.push("---");

        return lines.join("\n");
      })
      .join("\n");

    // Integration: 新鲜度汇总
    let freshnessHint = "";
    if (checkFreshness) {
      const parts: string[] = [];
      if (freshnessFreshCount > 0) parts.push(`🟢 有效 ${freshnessFreshCount}`);
      if (freshnessStaleCount > 0) parts.push(`🔴 需验证 ${freshnessStaleCount}`);
      if (freshnessUnknownCount > 0) parts.push(`⚪ 无快照 ${freshnessUnknownCount}`);
      freshnessHint = parts.length > 0
        ? `\n🔍 新鲜度: ${parts.join(" | ")}`
        : "";
      if (freshnessStaleCount > 0) {
        freshnessHint += `\n⚠️ 有 ${freshnessStaleCount} 条知识关联的代码已变化，建议重新验证后再复用。`;
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: [
            `🔍 找到 ${insights.length} 条相关洞察记录${freshnessHint}`,
            "",
            `💡 这些是之前分析过的内容，可以直接复用，避免重复分析。`,
            "",
            insightList,
          ].join("\n"),
        },
      ],
    };
  }
);

// ============ 工具4: 项目概览 ============
server.tool(
  "get_project_overview",
  "获取项目的完整概览，包括业务总结和所有洞察记录。",
  {
    projectName: z.string().describe("项目名称"),
  },
  async ({ projectName }) => {
    const knowledge = loadKnowledge(projectName);
    
    if (!knowledge) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 项目「${projectName}」尚未分析。`,
          },
        ],
      };
    }

    const stats = getInsightStats(projectName);
    const categoryLabels: Record<string, string> = {
      architecture: "架构设计", feature: "功能实现", pattern: "设计模式",
      api: "API接口", data_flow: "数据流", bug_fix: "Bug修复",
      performance: "性能优化", config: "配置相关", dependency: "依赖相关",
      other: "其他",
    };

    const statusLabels: Record<string, string> = {
      active: "🟢 有效", stale: "🟡 可能过期", invalidated: "🔴 已失效",
    };

    const overview = [
      `═══════════════════════════════════════`,
      `  项目: ${knowledge.name}`,
      `═══════════════════════════════════════`,
      "",
      `📁 路径: ${knowledge.projectPath}`,
      `🕐 创建: ${knowledge.createdAt.slice(0, 10)}`,
      `🔄 更新: ${knowledge.lastUpdated.slice(0, 10)}`,
      `📐 Schema: v${knowledge.schemaVersion || 1}`,
      "",
      `📝 业务总结`,
      knowledge.businessSummary,
      "",
      `📊 洞察统计`,
      `  总数: ${stats?.total || 0}`,
      `  近7天: ${stats?.recentCount || 0}`,
    ];

    if (stats && stats.total > 0) {
      overview.push("");
      overview.push("按分类:");
      for (const [cat, count] of Object.entries(stats.byCategory)) {
        overview.push(`  ${categoryLabels[cat] || cat}: ${count}`);
      }

      overview.push("");
      overview.push("按状态:");
      for (const [status, count] of Object.entries(stats.byStatus)) {
        overview.push(`  ${statusLabels[status] || status}: ${count}`);
      }
    }

    if (knowledge.insights.length > 0) {
      overview.push("");
      overview.push(`📋 最近的洞察 (${Math.min(5, knowledge.insights.length)} 条)`);
      overview.push("");
      
      for (const insight of knowledge.insights.slice(0, 5)) {
        const version = insight.version || 1;
        const status = insight.status || "active";
        const snapshotCount = (insight.fileSnapshots || []).length;
        const extra = snapshotCount > 0 ? ` 📸${snapshotCount}` : "";
        overview.push(`• [v${version}|${status}] ${insight.question}${extra}`);
        overview.push(`  ${insight.answer.slice(0, 100)}${insight.answer.length > 100 ? "..." : ""}`);
      }
    }

    return {
      content: [
        {
          type: "text" as const,
          text: overview.join("\n"),
        },
      ],
    };
  }
);

// ============ 工具5: 列出所有项目 ============
server.tool(
  "list_projects",
  "列出所有已分析过的项目。",
  {},
  async () => {
    const allProjects = listAllKnowledge();

    if (allProjects.length === 0) {
      return {
        content: [
          {
            type: "text" as const,
            text: "📭 暂无已分析的项目。\n\n使用 analyze_project 分析你的第一个项目！",
          },
        ],
      };
    }

    const projectList = allProjects
      .sort((a, b) => b.lastUpdated.localeCompare(a.lastUpdated))
      .map(k => [
        `📁 ${k.name}`,
        `   洞察: ${k.insights.length} 条`,
        `   更新: ${k.lastUpdated.slice(0, 10)}`,
      ].join("\n"))
      .join("\n\n");

    return {
      content: [
        {
          type: "text" as const,
          text: `📋 已分析的项目 (${allProjects.length} 个):\n\n${projectList}`,
        },
      ],
    };
  }
);

// ============ 工具6: 删除洞察 ============
server.tool(
  "delete_insight",
  "删除指定的洞察记录。",
  {
    projectName: z.string().describe("项目名称"),
    insightId: z.string().describe("洞察 ID"),
  },
  async ({ projectName, insightId }) => {
    const success = deleteInsight(projectName, insightId);

    return {
      content: [
        {
          type: "text" as const,
          text: success
            ? `✅ 洞察 ${insightId} 已删除`
            : `❌ 未找到洞察 ${insightId}`,
        },
      ],
    };
  }
);

// ============ 工具7: 检查知识新鲜度（P0-2 新增） ============
server.tool(
  "check_knowledge_freshness",
  "检查指定知识关联的代码文件是否发生变化。可以检查单条 Insight 或整个项目。返回每个关联文件的变化状态（未变化/内容已变/文件缺失）。代码变化不代表知识一定错误，但建议重新验证。",
  {
    projectName: z.string().describe("项目名称"),
    insightId: z.string().optional().describe("洞察 ID。不填则检查项目所有 Insight"),
  },
  async ({ projectName, insightId }) => {
    if (!hasKnowledge(projectName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 项目「${projectName}」尚未分析。`,
          },
        ],
      };
    }

    // 单条 Insight 检查
    if (insightId) {
      const insight = getInsightById(projectName, insightId);
      if (!insight) {
        return {
          content: [
            {
              type: "text" as const,
              text: `❌ 未找到洞察 ${insightId}`,
            },
          ],
        };
      }

      const result = await checkInsightFreshness(insight);

      // 更新 Insight 状态
      updateInsightFreshness(projectName, insightId, result.status, result.checkedAt);

      const statusEmoji: Record<string, string> = {
        fresh: "🟢", stale: "🔴", unknown: "⚪",
      };

      const lines = [
        `🔍 知识新鲜度检查`,
        ``,
        `${statusEmoji[result.status]} 状态: ${result.status.toUpperCase()}`,
        `📝 问题: ${result.question}`,
        `🕐 检查时间: ${result.checkedAt.slice(0, 19).replace("T", " ")}`,
        `💡 原因: ${result.reason}`,
      ];

      if (result.changedFiles.length > 0) {
        lines.push("", `❌ 内容已变化的文件 (${result.changedFiles.length}):`);
        for (const f of result.changedFiles) {
          lines.push(`  - ${f.path}: ${f.reason}`);
        }
      }

      if (result.missingFiles.length > 0) {
        lines.push("", `🗑️ 已缺失的文件 (${result.missingFiles.length}):`);
        for (const f of result.missingFiles) {
          lines.push(`  - ${f.path}: ${f.reason}`);
        }
      }

      if (result.unchangedFiles.length > 0) {
        lines.push("", `✅ 未变化的文件 (${result.unchangedFiles.length}):`);
        for (const f of result.unchangedFiles) {
          lines.push(`  - ${f.path}${f.reason ? ` (${f.reason})` : ""}`);
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: lines.join("\n"),
          },
        ],
      };
    }

    // 整个项目检查
    const knowledge = loadKnowledge(projectName);
    if (!knowledge) {
      return {
        content: [{ type: "text" as const, text: "❌ 项目加载失败" }],
        isError: true,
      };
    }

    const result = await checkProjectFreshness(knowledge);

    // [H4] 批量更新所有 Insight 的新鲜度状态
    batchUpdateFreshness(
      projectName,
      result.insights.map(ir => ({
        insightId: ir.insightId,
        freshnessStatus: ir.status,
        checkedAt: ir.checkedAt,
      }))
    );

    const lines = [
      `🔍 项目「${result.projectName}」新鲜度检查报告`,
      ``,
      `🕐 检查时间: ${result.checkedAt.slice(0, 19).replace("T", " ")}`,
      ``,
      `📊 统计:`,
      `  总计: ${result.total} 条`,
      `  🟢 有效: ${result.fresh}`,
      `  🔴 需验证: ${result.stale}`,
      `  ⚪ 无快照: ${result.unknown}`,
    ];

    if (result.stale > 0) {
      lines.push("", `⚠️ 需要重新验证的洞察:`);
      for (const ir of result.insights) {
        if (ir.status === "stale") {
          lines.push(`  - ${ir.question}`);
          lines.push(`    ${ir.reason}`);
        }
      }
    }

    if (result.changedFiles.length > 0) {
      lines.push("", `📁 所有变化的文件 (${result.changedFiles.length}):`);
      for (const f of result.changedFiles) {
        lines.push(`  - ${f.path}: ${f.reason}`);
      }
    }

    if (result.unknown > 0) {
      lines.push("", `💡 ${result.unknown} 条知识没有文件快照，无法判断新鲜度。建议重新 record_insight 补充文件关联。`);
    }

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  }
);

// ============ 工具8: 刷新项目知识（P0-2 新增） ============
server.tool(
  "refresh_project_knowledge",
  "扫描项目所有知识，检查每条 Insight 关联代码的新鲜度，统计有效/过期/无快照的数量。不自动重新分析，只输出报告。",
  {
    projectName: z.string().describe("项目名称"),
  },
  async ({ projectName }) => {
    if (!hasKnowledge(projectName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 项目「${projectName}」尚未分析。`,
          },
        ],
      };
    }

    const knowledge = loadKnowledge(projectName);
    if (!knowledge) {
      return {
        content: [{ type: "text" as const, text: "❌ 项目加载失败" }],
        isError: true,
      };
    }

    const result = await checkProjectFreshness(knowledge);

    // [H4] 批量更新所有 Insight 的新鲜度状态
    batchUpdateFreshness(
      projectName,
      result.insights.map(ir => ({
        insightId: ir.insightId,
        freshnessStatus: ir.status,
        checkedAt: ir.checkedAt,
      }))
    );

    const lines = [
      `═══════════════════════════════════════`,
      `  📋 项目知识刷新报告: ${result.projectName}`,
      `═══════════════════════════════════════`,
      ``,
      `🕐 检查时间: ${result.checkedAt.slice(0, 19).replace("T", " ")}`,
      ``,
      `📊 总览:`,
      `  总计: ${result.total} 条知识`,
      `  🟢 有效 (fresh): ${result.fresh} 条`,
      `  🔴 需验证 (stale): ${result.stale} 条`,
      `  ⚪ 无快照 (unknown): ${result.unknown} 条`,
    ];

    if (result.stale > 0) {
      lines.push("", `🔴 需重新验证的知识:`);
      lines.push("");
      for (const ir of result.insights) {
        if (ir.status === "stale") {
          lines.push(`  • ${ir.question}`);
          lines.push(`    ${ir.reason}`);
          for (const cf of ir.changedFiles) {
            lines.push(`    ❌ ${cf.path}: ${cf.reason}`);
          }
          for (const mf of ir.missingFiles) {
            lines.push(`    🗑️ ${mf.path}: ${mf.reason}`);
          }
          lines.push("");
        }
      }
    }

    if (result.changedFiles.length > 0) {
      lines.push(`📁 变化的文件汇总 (${result.changedFiles.length}):`);
      for (const f of result.changedFiles) {
        lines.push(`  - ${f.path}: ${f.reason}`);
      }
    }

    if (result.unknown > 0) {
      lines.push("", `💡 ${result.unknown} 条知识没有文件快照，无法判断新鲜度。`);
      lines.push(`   建议对重要知识重新 record_insight 补充文件关联。`);
    }

    lines.push("", `💡 提示: stale 状态的知识关联的代码已发生变化，建议重新分析后更新知识。`);

    return {
      content: [
        {
          type: "text" as const,
          text: lines.join("\n"),
        },
      ],
    };
  }
);

// ============ 工具9: 影响范围分析（P0-3 新增） ============
server.tool(
  "analyze_impact",
  "分析修改某个文件会影响哪些其他文件、模块、API 和已有知识。支持代码依赖追踪和知识关联分析，并给出可解释的风险评分。",
  {
    projectName: z.string().describe("项目名称"),
    target: z.string().describe("目标文件的绝对路径或相对于项目根目录的路径"),
    maxDepth: z.number().optional().describe("依赖追踪最大深度（默认 5）"),
    maxNodes: z.number().optional().describe("最大分析节点数（默认 100，防止大项目扫描失控）"),
  },
  async ({ projectName, target, maxDepth, maxNodes }) => {
    if (!hasKnowledge(projectName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 项目「${projectName}」尚未分析，请先调用 analyze_project。`,
          },
        ],
      };
    }

    const knowledge = loadKnowledge(projectName);
    if (!knowledge) {
      return {
        content: [{ type: "text" as const, text: "❌ 项目加载失败" }],
        isError: true,
      };
    }

    // 解析目标文件路径
    let targetPath = target;
    if (!target.startsWith("/")) {
      // 相对路径，基于 projectPath 解析
      const path = await import("node:path");
      targetPath = path.resolve(knowledge.projectPath, target);
    }

    // 检查文件是否存在
    const fs = await import("node:fs");
    if (!fs.existsSync(targetPath)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 目标文件不存在: ${targetPath}`,
          },
        ],
      };
    }

    // 执行影响分析
    const result = await analyzeImpact(
      targetPath,
      projectName,
      knowledge.projectPath,
      {
        maxDepth: maxDepth || 5,
        maxNodes: maxNodes || 100,
      }
    );

    // 格式化输出
    const formattedText = formatImpactAnalysis(result);

    return {
      content: [
        {
          type: "text" as const,
          text: formattedText,
        },
      ],
    };
  }
);


// ============ 工具10: 完整上下文查询（Integration 新增） ============
server.tool(
  "get_full_context",
  "【整合工具】一次性获取某个问题的完整上下文：搜索已有知识 + 检查新鲜度 + 影响范围分析。适合在回答复杂问题时调用，可以同时获得历史知识、代码变化状态和影响范围，避免多次调用。",
  {
    projectName: z.string().describe("项目名称"),
    question: z.string().describe("要查询的问题或主题"),
    targetFile: z.string().optional().describe("如果要分析某个文件的影响范围，填入文件路径（可选）"),
    category: z.enum([
      "architecture", "feature", "pattern", "api", "data_flow",
      "bug_fix", "performance", "config", "dependency", "other",
    ]).optional().describe("按分类筛选知识"),
    limit: z.number().optional().describe("返回知识数量限制（默认 10）"),
  },
  async ({ projectName, question, targetFile, category, limit }) => {
    if (!hasKnowledge(projectName)) {
      return {
        content: [
          {
            type: "text" as const,
            text: `❌ 项目「${projectName}」尚未分析，请先调用 analyze_project。`,
          },
        ],
      };
    }

    const knowledge = loadKnowledge(projectName);
    if (!knowledge) {
      return {
        content: [{ type: "text" as const, text: "❌ 项目加载失败" }],
        isError: true,
      };
    }

    const outputLines: string[] = [];
    const maxInsights = limit || 10;

    // === Part 1: 搜索知识 + 新鲜度检查 ===
    const insights = queryInsights(projectName, {
      category: category as InsightCategory | undefined,
      keyword: question,
      limit: maxInsights,
    });

    const categoryLabels: Record<string, string> = {
      architecture: "架构设计", feature: "功能实现", pattern: "设计模式",
      api: "API接口", data_flow: "数据流", bug_fix: "Bug修复",
      performance: "性能优化", config: "配置相关", dependency: "依赖相关",
      other: "其他",
    };

    outputLines.push("═══════════════════════════════════════");
    outputLines.push("  📋 完整上下文查询");
    outputLines.push("═══════════════════════════════════════");
    outputLines.push("");
    outputLines.push(`🔍 问题: ${question}`);
    outputLines.push(`📁 项目: ${projectName}`);
    outputLines.push("");

    // Part 1a: 知识搜索结果
    outputLines.push("━━━ 📚 知识搜索 ━━━");
    if (insights.length === 0) {
      outputLines.push("📭 未找到相关历史知识");
      outputLines.push("");
    } else {
      outputLines.push(`📚 找到 ${insights.length} 条相关知识:`);
      outputLines.push("");

      // [M4 + H4] 并行检查每条知识的 freshness + 批量更新
      let freshCount = 0;
      let staleCount = 0;
      let unknownCount = 0;
      const staleInsightIds: string[] = [];
      const cache = createFileStatCache();

      const freshnessResults = await Promise.all(
        insights.map(insight => checkInsightFreshness(insight, cache))
      );

      // 批量更新知识库状态
      batchUpdateFreshness(
        projectName,
        freshnessResults.map(r => ({
          insightId: r.insightId,
          freshnessStatus: r.status,
          checkedAt: r.checkedAt,
        }))
      );

      for (const [idx, insight] of insights.entries()) {
        const freshnessResult = freshnessResults[idx];
        
        // 更新统计
        if (freshnessResult.status === "fresh") freshCount++;
        else if (freshnessResult.status === "stale") {
          staleCount++;
          staleInsightIds.push(insight.id);
        }
        else unknownCount++;

        const version = insight.version || 1;
        const freshnessEmoji = {
          fresh: "🟢",
          stale: "🔴",
          unknown: "⚪",
        };
        const emoji = freshnessEmoji[freshnessResult.status];

        outputLines.push(`${emoji} [${categoryLabels[insight.category] || insight.category}] ${insight.question}`);
        outputLines.push(`   v${version} | ${insight.confidence} | ${freshnessResult.status}`);
        
        if (freshnessResult.status === "stale") {
          outputLines.push(`   ⚠️ ${freshnessResult.reason}`);
          for (const cf of freshnessResult.changedFiles) {
            outputLines.push(`     ❌ ${cf.path}: ${cf.reason}`);
          }
        }
        
        outputLines.push(`   ${insight.answer.length > 200 ? insight.answer.slice(0, 200) + "..." : insight.answer}`);
        outputLines.push("");
      }

      // 知识新鲜度汇总
      outputLines.push(`📊 知识新鲜度: 🟢 有效 ${freshCount} | 🔴 需验证 ${staleCount} | ⚪ 无快照 ${unknownCount}`);
      if (staleCount > 0) {
        outputLines.push(`⚠️ 有 ${staleCount} 条知识关联的代码已变化，建议重新验证。`);
        outputLines.push("💡 建议: 对 stale 知识重新分析代码后用 record_insight 更新。");
      }
      outputLines.push("");
    }

    // === Part 2: 影响范围分析（可选） ===
    if (targetFile) {
      outputLines.push("━━━ 🎯 影响范围分析 ━━━");
      
      let targetPath = targetFile;
      if (!targetFile.startsWith("/")) {
        const pathMod = await import("node:path");
        targetPath = pathMod.resolve(knowledge.projectPath, targetFile);
      }

      const fsMod = await import("node:fs");
      if (!fsMod.existsSync(targetPath)) {
        outputLines.push(`❌ 目标文件不存在: ${targetPath}`);
      } else {
        const impactResult = await analyzeImpact(
          targetPath,
          projectName,
          knowledge.projectPath,
          { maxDepth: 3, maxNodes: 50 }
        );
        
        // 简化的影响分析输出
        outputLines.push(formatImpactAnalysis(impactResult));
      }
      outputLines.push("");
    }

    // === Part 3: 建议的后续操作 ===
    outputLines.push("━━━ 💡 建议操作 ━━━");
    if (insights.length === 0) {
      outputLines.push("1. 分析代码并回答用户问题");
      outputLines.push("2. 用 record_insight 记录新发现的知识");
    } else {
      const staleInsights = insights.filter(i => (i.status === "stale"));
      if (staleInsights.length > 0) {
        outputLines.push(`1. 🔄 有 ${staleInsights.length} 条 stale 知识需要重新验证`);
        outputLines.push("2. 分析相关代码确认知识是否仍然正确");
        outputLines.push("3. 用 record_insight 更新知识（相同问题会自动覆盖并递增版本）");
      } else {
        outputLines.push("✅ 所有知识代码未变化，可以直接复用历史结论");
        outputLines.push("💡 如有新问题，继续分析后用 record_insight 记录");
      }
    }
    if (targetFile) {
      outputLines.push(`3. 🎯 修改 ${targetFile} 前请参考影响范围`);
    }

    outputLines.push("");
    outputLines.push(`🕐 查询时间: ${new Date().toISOString().slice(0, 19).replace("T", " ")}`);

    return {
      content: [
        {
          type: "text" as const,
          text: outputLines.join("\n"),
        },
      ],
    };
  }
);

// 启动服务
const transport = new StdioServerTransport();
await server.connect(transport);
