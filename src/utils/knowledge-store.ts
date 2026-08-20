import fs from "node:fs";
import path from "node:path";
import type { FileSnapshot } from "./scanner.js";
import type { ProjectAnalysis } from "../analyzer/types.js";

// 知识存储目录
const KNOWLEDGE_DIR = path.join(
  process.env.HOME || "/tmp",
  ".project-analysis-mcp",
  "knowledge"
);

// 当前 schema 版本
export const CURRENT_SCHEMA_VERSION = 3;

// ============ 类型定义 ============

// 知识状态（表示知识的生命周期，未来可拆分为 lifecycleStatus + freshness）
export type InsightStatus = "active" | "stale" | "invalidated";

// 简化的项目知识结构
export interface ProjectKnowledge {
  name: string;              // 项目名称（中文/英文，如"智能巡视"）
  projectPath: string;       // 项目路径
  businessSummary: string;   // 业务总结（由AI生成）
  createdAt: string;         // 首次创建时间
  lastUpdated: string;       // 最后更新时间
  insights: Insight[];       // 洞察记录列表
  schemaVersion?: number;    // 数据结构版本（v2 新增，缺失视为 v1）
  analysis?: ProjectAnalysis; // Project Analyzer 生成的 AI 可操作知识模型
}

// 洞察记录
export interface Insight {
  id: string;
  question: string;          // 问题
  answer: string;            // 答案/分析结果
  category: InsightCategory; // 分类
  tags: string[];            // 标签
  relatedFiles: string[];    // 相关文件路径（归一化后的绝对路径）
  recordedAt: string;        // 记录时间
  confidence: "high" | "medium" | "low";

  // ---- P0-1 新增字段（全部可选，确保旧数据兼容）----
  relatedSymbols?: string[];   // 关联的符号（函数名、类名、变量名等）
  relatedModules?: string[];   // 关联的模块名
  relatedApis?: string[];      // 关联的 API 路径
  fileSnapshots?: FileSnapshot[];  // 文件快照（mtime/size/hash）
  status?: InsightStatus;      // 知识状态
  lastVerifiedAt?: string;     // 最后验证时间（仅当实际验证时更新，unknown 不更新）
  version?: number;            // 知识版本号（每次更新 +1）
}

export type InsightCategory =
  | "architecture"    // 架构设计
  | "feature"         // 功能实现
  | "pattern"         // 设计模式
  | "api"             // API 接口
  | "data_flow"       // 数据流
  | "bug_fix"         // Bug 修复
  | "performance"     // 性能优化
  | "config"          // 配置相关
  | "dependency"      // 依赖相关
  | "other";          // 其他

// ============ 基础文件操作 ============

// 确保存储目录存在
function ensureDir(): void {
  if (!fs.existsSync(KNOWLEDGE_DIR)) {
    fs.mkdirSync(KNOWLEDGE_DIR, { recursive: true });
  }
}

// 生成安全的文件名
function getKnowledgePath(projectName: string): string {
  const safeName = projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
  return path.join(KNOWLEDGE_DIR, `${safeName}.json`);
}

// 检查项目是否有知识库（按名称）
export function hasKnowledge(projectName: string): boolean {
  return fs.existsSync(getKnowledgePath(projectName));
}

// 加载项目知识（按名称）
export function loadKnowledge(projectName: string): ProjectKnowledge | null {
  const filePath = getKnowledgePath(projectName);
  
  if (!fs.existsSync(filePath)) {
    return null;
  }
  
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const knowledge = JSON.parse(content) as ProjectKnowledge;

    // 自动迁移旧数据
    if (migrateKnowledge(knowledge)) {
      saveKnowledge(knowledge);
    }

    return knowledge;
  } catch {
    return null;
  }
}

/**
 * [M7] 原子保存项目知识
 * 先写入临时文件，再 rename 到目标路径，防止崩溃导致数据丢失
 */
export function saveKnowledge(knowledge: ProjectKnowledge): void {
  ensureDir();
  const filePath = getKnowledgePath(knowledge.name);
  const tmpPath = filePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(knowledge, null, 2), "utf-8");
  fs.renameSync(tmpPath, filePath);
}

// ============ 数据迁移 ============

/**
 * 将旧版本数据迁移到当前版本
 * @returns true 如果发生了迁移，false 如果无需迁移
 */
export function migrateKnowledge(knowledge: ProjectKnowledge): boolean {
  const currentVersion = knowledge.schemaVersion ?? 1;
  if (currentVersion >= CURRENT_SCHEMA_VERSION) {
    return false;
  }

  // v1 → v2：为每条 Insight 填充新增字段的默认值
  if (currentVersion < 2) {
    for (const insight of knowledge.insights) {
      if (insight.relatedSymbols === undefined) insight.relatedSymbols = [];
      if (insight.relatedModules === undefined) insight.relatedModules = [];
      if (insight.relatedApis === undefined) insight.relatedApis = [];
      if (insight.fileSnapshots === undefined) insight.fileSnapshots = [];
      if (insight.status === undefined) insight.status = "active";
      if (insight.lastVerifiedAt === undefined) insight.lastVerifiedAt = insight.recordedAt;
      if (insight.version === undefined) insight.version = 1;
    }
  }

  knowledge.schemaVersion = CURRENT_SCHEMA_VERSION;
  return true;
}

// ============ 路径归一化 ============

/** relatedFiles 上限 */
const MAX_RELATED_FILES = 8;

/**
 * [C1] 归一化文件路径列表
 * - 相对路径基于 projectPath 解析为绝对路径
 * - 去重
 * - 过滤不存在的文件
 * - 限制数量上限
 */
export function normalizeFilePaths(files: string[], projectPath: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const file of files) {
    if (!file || typeof file !== "string") continue;

    const normalized = path.isAbsolute(file)
      ? path.resolve(file)
      : path.resolve(projectPath, file);

    // 去重
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // 过滤不存在的文件（静默跳过）
    try {
      const stat = fs.statSync(normalized);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }

    result.push(normalized);
    if (result.length >= MAX_RELATED_FILES) break;
  }

  return result;
}

// ============ 创建与更新 ============

// 创建新项目知识
export function createKnowledge(
  projectName: string,
  projectPath: string,
  businessSummary: string
): ProjectKnowledge {
  const now = new Date().toISOString();
  
  const knowledge: ProjectKnowledge = {
    name: projectName,
    projectPath,
    businessSummary,
    createdAt: now,
    lastUpdated: now,
    insights: [],
    schemaVersion: CURRENT_SCHEMA_VERSION,
  };
  
  saveKnowledge(knowledge);
  return knowledge;
}

// 更新业务总结
export function updateBusinessSummary(
  projectName: string,
  businessSummary: string
): ProjectKnowledge | null {
  const knowledge = loadKnowledge(projectName);
  
  if (!knowledge) {
    return null;
  }
  
  knowledge.businessSummary = businessSummary;
  knowledge.lastUpdated = new Date().toISOString();
  saveKnowledge(knowledge);
  
  return knowledge;
}

// ============ Insight 增删改查 ============

/** addInsight 的输入参数（去掉自动生成的 id/recordedAt，加上新的可选字段） */
export interface InsightInput {
  question: string;
  answer: string;
  category: InsightCategory;
  tags: string[];
  relatedFiles: string[];
  confidence: "high" | "medium" | "low";
  // P0-1 新增
  relatedSymbols?: string[];
  relatedModules?: string[];
  relatedApis?: string[];
  fileSnapshots?: FileSnapshot[];
}

/**
 * [M6] 判断两个问题是否相似
 * 使用字符级 Jaccard 相似度 + 长度约束，避免误合并
 */
function isQuestionSimilar(q1: string, q2: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[？?。，,!！:：;；\s]/g, "").trim();
  const n1 = normalize(q1);
  const n2 = normalize(q2);
  
  // 完全相同
  if (n1 === n2) return true;

  // 长度差异过大时不做包含判断（防止"认证"匹配"JWT认证流程详细说明"）
  const lenRatio = Math.min(n1.length, n2.length) / Math.max(n1.length, n2.length);
  if (lenRatio < 0.5) return false;

  // 短字符串包含（长度比 > 0.5 时才允许）
  if (n1.includes(n2) || n2.includes(n1)) return true;

  // 字符级 Jaccard 相似度
  const chars1 = new Set(n1.split(""));
  const chars2 = new Set(n2.split(""));
  const intersection = new Set([...chars1].filter(c => chars2.has(c)));
  const union = new Set([...chars1, ...chars2]);
  const jaccard = intersection.size / union.size;

  return jaccard >= 0.75;
}

function mergeArray(existing: string[], newItems: string[]): string[] {
  const set = new Set([...existing, ...newItems]);
  return Array.from(set);
}

/**
 * 添加洞察记录
 * [C1] relatedFiles 归一化为绝对路径
 * [H3] 更新时 snapshot 始终与 relatedFiles 一致
 */
export function addInsight(
  projectName: string,
  insight: InsightInput
): Insight | null {
  const knowledge = loadKnowledge(projectName);
  
  if (!knowledge) {
    return null;
  }

  const now = new Date().toISOString();
  const projectPath = knowledge.projectPath || "";

  // [C1] 归一化 relatedFiles 为绝对路径
  const normalizedFiles = projectPath
    ? normalizeFilePaths(insight.relatedFiles, projectPath)
    : insight.relatedFiles.slice(0, MAX_RELATED_FILES);

  // 检查是否已有类似问题
  const similarInsight = knowledge.insights.find(i => 
    isQuestionSimilar(i.question, insight.question)
  );

  if (similarInsight) {
    // 更新已有的洞察
    similarInsight.answer = insight.answer;
    similarInsight.tags = mergeArray(similarInsight.tags, insight.tags);
    // [C1] 用归一化后的路径替换（不合并旧路径，避免相对/绝对混杂）
    similarInsight.relatedFiles = normalizedFiles;
    similarInsight.confidence = insight.confidence;
    similarInsight.category = insight.category;

    // P0-1：更新新增字段
    similarInsight.relatedSymbols = mergeArray(
      similarInsight.relatedSymbols || [],
      insight.relatedSymbols || []
    );
    similarInsight.relatedModules = mergeArray(
      similarInsight.relatedModules || [],
      insight.relatedModules || []
    );
    similarInsight.relatedApis = mergeArray(
      similarInsight.relatedApis || [],
      insight.relatedApis || []
    );

    // [H3] snapshot 必须和 relatedFiles 一致：
    // 如果传入了新快照，使用新快照；否则根据新的 relatedFiles 过滤保留匹配的旧快照
    if (insight.fileSnapshots && insight.fileSnapshots.length > 0) {
      similarInsight.fileSnapshots = insight.fileSnapshots;
    } else {
      // 保留旧快照中路径仍在 relatedFiles 里的项
      const fileSet = new Set(normalizedFiles);
      similarInsight.fileSnapshots = (similarInsight.fileSnapshots || []).filter(
        s => fileSet.has(s.path)
      );
    }

    // 版本递增
    similarInsight.version = (similarInsight.version || 1) + 1;
    similarInsight.status = "active";
    similarInsight.lastVerifiedAt = now;
    
    knowledge.lastUpdated = now;
    saveKnowledge(knowledge);
    return similarInsight;
  }

  // 创建新洞察
  const newInsight: Insight = {
    id: generateInsightId(),
    question: insight.question,
    answer: insight.answer,
    category: insight.category,
    tags: insight.tags,
    relatedFiles: normalizedFiles,
    recordedAt: now,
    confidence: insight.confidence,
    // P0-1 新字段
    relatedSymbols: insight.relatedSymbols || [],
    relatedModules: insight.relatedModules || [],
    relatedApis: insight.relatedApis || [],
    fileSnapshots: insight.fileSnapshots || [],
    status: "active",
    lastVerifiedAt: now,
    version: 1,
  };

  knowledge.insights.push(newInsight);
  knowledge.lastUpdated = now;
  saveKnowledge(knowledge);

  return newInsight;
}

// 查询洞察
export function queryInsights(
  projectName: string,
  options: {
    category?: InsightCategory;
    keyword?: string;
    tags?: string[];
    limit?: number;
  } = {}
): Insight[] {
  const knowledge = loadKnowledge(projectName);
  
  if (!knowledge) {
    return [];
  }

  let results = [...knowledge.insights];

  // 按分类过滤
  if (options.category) {
    results = results.filter(i => i.category === options.category);
  }

  // 按关键词过滤
  if (options.keyword) {
    const kw = options.keyword.toLowerCase();
    results = results.filter(i =>
      i.question.toLowerCase().includes(kw) ||
      i.answer.toLowerCase().includes(kw)
    );
  }

  // 按标签过滤
  if (options.tags && options.tags.length > 0) {
    results = results.filter(i =>
      options.tags!.some(tag => i.tags.includes(tag))
    );
  }

  // 按时间倒序
  results.sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));

  // 限制数量
  if (options.limit) {
    results = results.slice(0, options.limit);
  }

  return results;
}

// 获取洞察统计
export function getInsightStats(projectName: string): {
  total: number;
  byCategory: Record<string, number>;
  recentCount: number;
  // P0-1 新增
  byStatus: Record<string, number>;
} | null {
  const knowledge = loadKnowledge(projectName);
  
  if (!knowledge) {
    return null;
  }

  const insights = knowledge.insights;
  const byCategory: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  
  for (const insight of insights) {
    byCategory[insight.category] = (byCategory[insight.category] || 0) + 1;
    const status = insight.status || "active";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  // 最近7天
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);
  const recentCount = insights.filter(i => 
    new Date(i.recordedAt) > sevenDaysAgo
  ).length;

  return {
    total: insights.length,
    byCategory,
    recentCount,
    byStatus,
  };
}

// 删除洞察
export function deleteInsight(projectName: string, insightId: string): boolean {
  const knowledge = loadKnowledge(projectName);
  
  if (!knowledge) {
    return false;
  }

  const initialLength = knowledge.insights.length;
  knowledge.insights = knowledge.insights.filter(i => i.id !== insightId);

  if (knowledge.insights.length < initialLength) {
    knowledge.lastUpdated = new Date().toISOString();
    saveKnowledge(knowledge);
    return true;
  }

  return false;
}

/**
 * [M2] 列出所有项目（加载时做内存迁移，确保字段完整）
 */
export function listAllKnowledge(): ProjectKnowledge[] {
  ensureDir();
  
  const files = fs.readdirSync(KNOWLEDGE_DIR);
  const results: ProjectKnowledge[] = [];
  
  for (const file of files) {
    if (file.endsWith(".json")) {
      try {
        const content = fs.readFileSync(
          path.join(KNOWLEDGE_DIR, file),
          "utf-8"
        );
        const knowledge = JSON.parse(content) as ProjectKnowledge;
        // [M2] 在内存中做迁移，确保返回对象字段完整（不写磁盘）
        migrateKnowledge(knowledge);
        results.push(knowledge);
      } catch {
        // 忽略损坏的文件
      }
    }
  }
  
  return results;
}

// 删除项目知识
export function deleteKnowledge(projectName: string): boolean {
  const filePath = getKnowledgePath(projectName);
  
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  
  return false;
}

// ============ 辅助函数 ============

function generateInsightId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ============ P0-2: 新鲜度相关 ============

/**
 * 根据 ID 获取单条 Insight
 */
export function getInsightById(
  projectName: string,
  insightId: string
): Insight | null {
  const knowledge = loadKnowledge(projectName);
  if (!knowledge) return null;
  
  return knowledge.insights.find(i => i.id === insightId) || null;
}

/**
 * [M5] 更新 Insight 的新鲜度状态和验证时间
 * - fresh → status=active, 更新 lastVerifiedAt
 * - stale → status=stale, 更新 lastVerifiedAt
 * - unknown → 不改变 status, 不更新 lastVerifiedAt（语义：未实际验证）
 */
export function updateInsightFreshness(
  projectName: string,
  insightId: string,
  freshnessStatus: "fresh" | "stale" | "unknown",
  checkedAt: string
): boolean {
  const knowledge = loadKnowledge(projectName);
  if (!knowledge) return false;
  
  const insight = knowledge.insights.find(i => i.id === insightId);
  if (!insight) return false;
  
  // 映射新鲜度状态到 Insight 状态
  if (freshnessStatus === "fresh") {
    insight.status = "active";
    insight.lastVerifiedAt = checkedAt;
    knowledge.lastUpdated = checkedAt;
  } else if (freshnessStatus === "stale") {
    insight.status = "stale";
    insight.lastVerifiedAt = checkedAt;
    knowledge.lastUpdated = checkedAt;
  }
  // [M5] unknown: 不改变状态，不更新 lastVerifiedAt
  
  // 只有实际改变了状态时才保存
  if (freshnessStatus !== "unknown") {
    saveKnowledge(knowledge);
  }
  return true;
}

/**
 * [H4] 批量更新多条 Insight 的新鲜度（单次加载 + 单次保存）
 */
export function batchUpdateFreshness(
  projectName: string,
  updates: Array<{
    insightId: string;
    freshnessStatus: "fresh" | "stale" | "unknown";
    checkedAt: string;
  }>
): number {
  const knowledge = loadKnowledge(projectName);
  if (!knowledge) return 0;

  let updatedCount = 0;

  for (const update of updates) {
    const insight = knowledge.insights.find(i => i.id === update.insightId);
    if (!insight) continue;

    if (update.freshnessStatus === "fresh") {
      insight.status = "active";
      insight.lastVerifiedAt = update.checkedAt;
      updatedCount++;
    } else if (update.freshnessStatus === "stale") {
      insight.status = "stale";
      insight.lastVerifiedAt = update.checkedAt;
      updatedCount++;
    }
    // unknown 不改变
  }

  if (updatedCount > 0) {
    knowledge.lastUpdated = new Date().toISOString();
    saveKnowledge(knowledge);
  }

  return updatedCount;
}
