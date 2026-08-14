/**
 * P0-3: 影响范围分析器
 * 
 * 基于依赖图分析文件变更的影响范围
 * 关联已有知识，计算风险评分
 * 
 * Integration: 关联知识的 freshness 信息
 * [H1] 路径穿越防护
 * [M3] freshness 缓存支持
 * [L4] 风险权重递减
 */

import path from "node:path";
import { loadKnowledge, type ProjectKnowledge, type Insight } from "./knowledge-store.js";
import { 
  quickAnalyzeImpact, 
  type TraversalResult,
  type TraversalOptions 
} from "./dependency-graph.js";
import {
  checkInsightFreshness,
  createFileStatCache,
  type InsightFreshnessResult,
  type FileStatCache,
} from "./freshness.js";

// ============ 类型定义 ============

/** 风险等级 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/** 风险评分详情 */
export interface RiskScore {
  level: RiskLevel;
  score: number;           // 0-100
  reasons: string[];       // 可解释的原因列表
}

/** 影响分析中关联的知识条目（含 freshness） */
export interface RelatedInsightInfo {
  id: string;
  question: string;
  category: string;
  /** 知识新鲜度：fresh / stale / unknown */
  freshness: "fresh" | "stale" | "unknown";
  /** 最后验证时间 */
  lastVerifiedAt?: string;
  /** 知识状态 */
  status?: string;
  /** 新鲜度原因说明 */
  freshnessReason?: string;
}

/** 影响分析结果 */
export interface ImpactAnalysisResult {
  target: string;
  projectName: string;
  
  // 代码影响
  directImpact: string[];      // 直接引用该文件的文件
  indirectImpact: string[];    // 间接影响的文件
  
  // 业务关联
  relatedModules: string[];    // 相关模块
  relatedApis: string[];       // 相关 API
  relatedInsights: RelatedInsightInfo[];
  
  // 风险评估
  risk: RiskScore;
  
  // 元信息
  analyzedAt: string;
  options: TraversalOptions;
  
  // Integration: 知识新鲜度汇总
  freshnessSummary: {
    fresh: number;
    stale: number;
    unknown: number;
  };
}

// ============ 风险评分规则 ============

const RISK_WEIGHTS = {
  directImpact: 3,      // 每个直接引用 +3 分
  indirectImpact: 1,    // 每个间接影响 +1 分
  relatedInsights: 5,   // 每条相关知识 +5 分
  relatedApis: 10,      // 每个相关 API +10 分
  relatedModules: 2,    // 每个相关模块 +2 分
  staleInsights: 8,     // 前 3 条 stale 知识每条 +8 分
  staleInsightsExtra: 3, // 超过 3 条的 stale 知识每条 +3 分（L4 递减）
  staleInsightsCap: 3,  // 高权重的 stale 数量上限
};

const RISK_THRESHOLDS = {
  low: 20,
  medium: 50,
  high: 80,
};

/**
 * [L4] 计算风险评分（stale 知识权重递减）
 */
function calculateRiskScore(
  directCount: number,
  indirectCount: number,
  insightCount: number,
  apiCount: number,
  moduleCount: number,
  staleInsightCount: number = 0
): RiskScore {
  // [L4] stale 知识权重递减：前 3 条 +8，后续 +3
  const staleBase = Math.min(staleInsightCount, RISK_WEIGHTS.staleInsightsCap);
  const staleExtra = Math.max(0, staleInsightCount - RISK_WEIGHTS.staleInsightsCap);
  const staleScore = staleBase * RISK_WEIGHTS.staleInsights + staleExtra * RISK_WEIGHTS.staleInsightsExtra;

  const score = 
    directCount * RISK_WEIGHTS.directImpact +
    indirectCount * RISK_WEIGHTS.indirectImpact +
    insightCount * RISK_WEIGHTS.relatedInsights +
    apiCount * RISK_WEIGHTS.relatedApis +
    moduleCount * RISK_WEIGHTS.relatedModules +
    staleScore;

  const normalizedScore = Math.min(100, Math.max(0, score));

  let level: RiskLevel;
  if (normalizedScore < RISK_THRESHOLDS.low) {
    level = "low";
  } else if (normalizedScore < RISK_THRESHOLDS.medium) {
    level = "medium";
  } else if (normalizedScore < RISK_THRESHOLDS.high) {
    level = "high";
  } else {
    level = "critical";
  }

  const reasons: string[] = [];
  
  if (directCount > 0) {
    reasons.push(`${directCount} 个文件直接引用`);
  }
  if (indirectCount > 0) {
    reasons.push(`${indirectCount} 个文件间接依赖`);
  }
  if (insightCount > 0) {
    reasons.push(`${insightCount} 条项目知识相关`);
  }
  if (staleInsightCount > 0) {
    reasons.push(`${staleInsightCount} 条知识可能过期（代码已变化）`);
  }
  if (apiCount > 0) {
    reasons.push(`${apiCount} 个 API 端点相关`);
  }
  if (moduleCount > 0) {
    reasons.push(`${moduleCount} 个业务模块相关`);
  }

  return {
    level,
    score: normalizedScore,
    reasons,
  };
}

// ============ 核心分析函数 ============

/**
 * 从 Insight 中提取关联的模块和 API
 */
function extractModulesAndApis(insights: Insight[]): {
  modules: string[];
  apis: string[];
} {
  const moduleSet = new Set<string>();
  const apiSet = new Set<string>();

  for (const insight of insights) {
    if (insight.relatedModules && Array.isArray(insight.relatedModules)) {
      for (const mod of insight.relatedModules) {
        if (typeof mod === 'string') moduleSet.add(mod);
      }
    }
    if (insight.relatedApis && Array.isArray(insight.relatedApis)) {
      for (const api of insight.relatedApis) {
        if (typeof api === 'string') apiSet.add(api);
      }
    }
  }

  return {
    modules: Array.from(moduleSet),
    apis: Array.from(apiSet),
  };
}

/**
 * [C1 联动] 查找与文件相关的 Insight
 * 比较时对两侧路径都做归一化，确保相对路径和绝对路径能正确匹配
 */
function findRelatedInsights(
  knowledge: ProjectKnowledge,
  affectedFiles: string[]
): Insight[] {
  const relatedInsights: Insight[] = [];
  
  // 归一化受影响文件列表（确保都是绝对路径）
  const affectedFileSet = new Set(
    affectedFiles.map(f => path.resolve(f))
  );

  for (const insight of knowledge.insights) {
    if (!insight.relatedFiles || !Array.isArray(insight.relatedFiles)) {
      continue;
    }

    // 归一化 Insight 的 relatedFiles（兼容旧的相对路径）
    const hasIntersection = insight.relatedFiles.some((file: string) => {
      const normalized = path.isAbsolute(file)
        ? path.resolve(file)
        : path.resolve(knowledge.projectPath || "", file);
      return affectedFileSet.has(normalized);
    });

    if (hasIntersection) {
      relatedInsights.push(insight);
    }
  }

  return relatedInsights;
}

/**
 * [H1] 校验目标文件是否在项目目录内，防止路径穿越
 */
function validateTargetPath(targetFile: string, projectPath: string): void {
  const resolvedTarget = path.resolve(targetFile);
  const resolvedProject = path.resolve(projectPath);
  
  if (!resolvedTarget.startsWith(resolvedProject + path.sep) && resolvedTarget !== resolvedProject) {
    throw new Error(
      `安全限制：目标文件 "${targetFile}" 不在项目目录 "${projectPath}" 内`
    );
  }
}

/**
 * 分析文件变更的影响范围
 * 
 * [H1] 增加路径穿越校验
 * [M3] 使用 freshness 缓存
 * Integration: 检查关联知识的 freshness
 */
export async function analyzeImpact(
  targetFile: string,
  projectName: string,
  projectPath: string,
  options: TraversalOptions = {}
): Promise<ImpactAnalysisResult> {
  const {
    maxDepth = 5,
    maxNodes = 100,
  } = options;

  // [H1] 路径穿越防护
  validateTargetPath(targetFile, projectPath);

  // 1. 构建依赖图并遍历
  const traversalResult = quickAnalyzeImpact(targetFile, projectPath, {
    maxDepth,
    maxNodes,
    direction: "reverse",
  });

  // 2. 加载项目知识
  const knowledge = loadKnowledge(projectName);
  
  let relatedInsights: Insight[] = [];
  let relatedModules: string[] = [];
  let relatedApis: string[] = [];

  if (knowledge) {
    // 3. 查找相关 Insight
    const affectedFiles = [
      targetFile,
      ...traversalResult.direct,
      ...traversalResult.indirect,
    ];
    
    relatedInsights = findRelatedInsights(knowledge, affectedFiles);

    // 4. 提取模块和 API
    const extracted = extractModulesAndApis(relatedInsights);
    relatedModules = extracted.modules;
    relatedApis = extracted.apis;
  }

  // 5. Integration: 检查每条关联 Insight 的 freshness
  // [M3] 使用共享缓存
  const cache = createFileStatCache();
  const relatedInsightInfos: RelatedInsightInfo[] = [];
  let freshCount = 0;
  let staleCount = 0;
  let unknownCount = 0;

  for (const insight of relatedInsights) {
    const freshnessResult = await checkInsightFreshness(insight, cache);

    const info: RelatedInsightInfo = {
      id: insight.id,
      question: insight.question,
      category: insight.category,
      freshness: freshnessResult.status,
      lastVerifiedAt: insight.lastVerifiedAt,
      status: insight.status,
      freshnessReason: freshnessResult.reason,
    };
    relatedInsightInfos.push(info);

    switch (freshnessResult.status) {
      case "fresh": freshCount++; break;
      case "stale": staleCount++; break;
      case "unknown": unknownCount++; break;
    }
  }

  // 6. 计算风险评分
  const risk = calculateRiskScore(
    traversalResult.direct.length,
    traversalResult.indirect.length,
    relatedInsights.length,
    relatedApis.length,
    relatedModules.length,
    staleCount
  );

  // 7. 组装结果
  return {
    target: targetFile,
    projectName,
    directImpact: traversalResult.direct,
    indirectImpact: traversalResult.indirect,
    relatedModules,
    relatedApis,
    relatedInsights: relatedInsightInfos,
    risk,
    analyzedAt: new Date().toISOString(),
    options: { maxDepth, maxNodes },
    freshnessSummary: {
      fresh: freshCount,
      stale: staleCount,
      unknown: unknownCount,
    },
  };
}

/**
 * 格式化影响分析结果为可读文本
 * [L9] 输出路径做相对化处理
 */
export function formatImpactAnalysis(result: ImpactAnalysisResult): string {
  const lines: string[] = [];
  const targetDir = path.dirname(result.target);

  lines.push(`🎯 影响分析: ${path.basename(result.target)}`);
  lines.push(`📁 文件: ${result.target}`);
  lines.push('');

  const riskEmoji = {
    low: '🟢',
    medium: '🟡',
    high: '🟠',
    critical: '🔴',
  };
  
  lines.push(`${riskEmoji[result.risk.level]} 风险等级: ${result.risk.level.toUpperCase()} (${result.risk.score}/100)`);
  
  if (result.risk.reasons.length > 0) {
    lines.push('   原因:');
    for (const reason of result.risk.reasons) {
      lines.push(`   - ${reason}`);
    }
  }
  lines.push('');

  // 直接影响
  if (result.directImpact.length > 0) {
    lines.push(`📍 直接影响 (${result.directImpact.length} 个文件):`);
    for (const file of result.directImpact.slice(0, 10)) {
      // [L9] 相对化路径
      lines.push(`   - ${path.relative(targetDir, file)}`);
    }
    if (result.directImpact.length > 10) {
      lines.push(`   ... 还有 ${result.directImpact.length - 10} 个文件`);
    }
    lines.push('');
  }

  // 间接影响
  if (result.indirectImpact.length > 0) {
    lines.push(`🔗 间接影响 (${result.indirectImpact.length} 个文件):`);
    for (const file of result.indirectImpact.slice(0, 10)) {
      lines.push(`   - ${path.relative(targetDir, file)}`);
    }
    if (result.indirectImpact.length > 10) {
      lines.push(`   ... 还有 ${result.indirectImpact.length - 10} 个文件`);
    }
    lines.push('');
  }

  // 相关模块
  if (result.relatedModules.length > 0) {
    lines.push(`📦 相关模块 (${result.relatedModules.length}):`);
    for (const mod of result.relatedModules) {
      lines.push(`   - ${mod}`);
    }
    lines.push('');
  }

  // 相关 API
  if (result.relatedApis.length > 0) {
    lines.push(`🔌 相关 API (${result.relatedApis.length}):`);
    for (const api of result.relatedApis) {
      lines.push(`   - ${api}`);
    }
    lines.push('');
  }

  // 相关知识（含 freshness）
  if (result.relatedInsights.length > 0) {
    const fs = result.freshnessSummary;
    lines.push(`💡 相关知识 (${result.relatedInsights.length} 条):`);
    lines.push(`   🟢 有效: ${fs.fresh} | 🔴 需验证: ${fs.stale} | ⚪ 无快照: ${fs.unknown}`);
    lines.push('');

    for (const insight of result.relatedInsights.slice(0, 8)) {
      const freshnessEmoji = {
        fresh: '🟢',
        stale: '🔴',
        unknown: '⚪',
      };
      const emoji = freshnessEmoji[insight.freshness] || '⚪';
      lines.push(`   ${emoji} [${insight.category}] ${insight.question}`);
      
      if (insight.freshness === 'stale') {
        lines.push(`      ⚠️ 代码已变化，建议重新验证: ${insight.freshnessReason || ''}`);
      }
    }
    if (result.relatedInsights.length > 8) {
      lines.push(`   ... 还有 ${result.relatedInsights.length - 8} 条知识`);
    }
    lines.push('');
  }

  lines.push(`⚙️  分析参数: 最大深度 ${result.options.maxDepth}, 最大节点 ${result.options.maxNodes}`);
  lines.push(`🕐 分析时间: ${result.analyzedAt}`);

  return lines.join('\n');
}
