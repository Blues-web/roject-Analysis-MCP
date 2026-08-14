/**
 * P0-2: 知识新鲜度检查模块
 * 
 * 判断 Insight 关联的代码文件是否发生变化。
 * 两层检查策略：
 *   第一层：比较 mtime + size（快速，无 IO）
 *   第二层：mtime/size 变化时才计算 hash（精确，有 IO）
 * 
 * [M3] 支持外部传入缓存，避免同一文件重复 stat/hash
 */

import fs from "node:fs";
import { generateFileHash, type FileSnapshot } from "./scanner.js";
import type { Insight, ProjectKnowledge } from "./knowledge-store.js";

// ============ 类型定义 ============

/** 单个文件的检查结果 */
export interface FileFreshnessResult {
  path: string;
  /** 文件状态 */
  status: "unchanged" | "content_changed" | "missing";
  /** 变化原因 */
  reason?: string;
  /** 当前快照（如果能读取到） */
  currentSnapshot?: FileSnapshot;
}

/** 单条 Insight 的新鲜度结果 */
export interface InsightFreshnessResult {
  insightId: string;
  question: string;
  /** 整体状态 */
  status: "fresh" | "stale" | "unknown";
  /** 检查时间 */
  checkedAt: string;
  /** 内容变化的文件 */
  changedFiles: FileFreshnessResult[];
  /** 未变化的文件 */
  unchangedFiles: FileFreshnessResult[];
  /** 已删除/不存在的文件 */
  missingFiles: FileFreshnessResult[];
  /** 状态原因说明 */
  reason: string;
}

/** 项目级别的新鲜度汇总 */
export interface ProjectFreshnessResult {
  projectName: string;
  checkedAt: string;
  total: number;
  fresh: number;
  stale: number;
  unknown: number;
  /** 所有变化的文件（去重） */
  changedFiles: FileFreshnessResult[];
  /** 每条 Insight 的检查结果 */
  insights: InsightFreshnessResult[];
}

/**
 * [M3] 文件统计缓存
 * 同一个操作中多个 Insight 可能引用相同文件，避免重复 stat 和 hash 计算
 */
export interface FileStatCache {
  /** 缓存 stat 结果 */
  stats: Map<string, fs.Stats | null>;
  /** 缓存 hash 结果 */
  hashes: Map<string, string | null>;
}

/** 创建一个新的缓存实例 */
export function createFileStatCache(): FileStatCache {
  return {
    stats: new Map(),
    hashes: new Map(),
  };
}

// ============ 核心检查逻辑 ============

/**
 * 带缓存的 stat
 */
async function cachedStat(filePath: string, cache?: FileStatCache): Promise<fs.Stats | null> {
  if (cache && cache.stats.has(filePath)) {
    return cache.stats.get(filePath)!;
  }
  try {
    const stat = await fs.promises.stat(filePath);
    if (cache) cache.stats.set(filePath, stat);
    return stat;
  } catch {
    if (cache) cache.stats.set(filePath, null);
    return null;
  }
}

/**
 * 带缓存的 hash
 */
async function cachedHash(filePath: string, cache?: FileStatCache): Promise<string | null> {
  if (cache && cache.hashes.has(filePath)) {
    return cache.hashes.get(filePath)!;
  }
  const hash = await generateFileHash(filePath);
  if (cache) cache.hashes.set(filePath, hash);
  return hash;
}

/**
 * 检查单个文件的新鲜度
 * [M3] 支持缓存
 */
async function checkFileFreshness(
  snapshot: FileSnapshot,
  cache?: FileStatCache
): Promise<FileFreshnessResult> {
  const result: FileFreshnessResult = {
    path: snapshot.path,
    status: "unchanged",
  };

  // 第一层：检查文件是否存在
  const currentStat = await cachedStat(snapshot.path, cache);
  if (!currentStat || !currentStat.isFile()) {
    result.status = "missing";
    result.reason = currentStat ? "路径不再是文件" : "文件不存在或无法访问";
    return result;
  }

  // 构造当前快照
  const currentSnapshot: FileSnapshot = {
    path: snapshot.path,
    size: currentStat.size,
    mtime: currentStat.mtime.toISOString(),
  };

  // 第一层快速判断：mtime + size
  const mtimeSame = snapshot.mtime === currentSnapshot.mtime;
  const sizeSame = snapshot.size === currentSnapshot.size;

  if (mtimeSame && sizeSame) {
    result.status = "unchanged";
    result.currentSnapshot = currentSnapshot;
    return result;
  }

  // 第二层：mtime 或 size 变了，需要对比 hash
  if (!snapshot.hash) {
    result.status = "content_changed";
    result.reason = "size 或 mtime 变化，旧快照无 hash 无法精确对比";
    result.currentSnapshot = currentSnapshot;
    return result;
  }

  // 计算当前文件的 hash（带缓存）
  const currentHash = await cachedHash(snapshot.path, cache);

  if (!currentHash) {
    result.status = "content_changed";
    result.reason = `size 或 mtime 变化，当前文件无法计算 hash（size=${currentSnapshot.size}）`;
    result.currentSnapshot = currentSnapshot;
    return result;
  }

  currentSnapshot.hash = currentHash;

  if (snapshot.hash === currentHash) {
    result.status = "unchanged";
    result.reason = "mtime/size 变化但内容未变";
    result.currentSnapshot = currentSnapshot;
    return result;
  }

  result.status = "content_changed";
  result.reason = "文件内容已变化";
  result.currentSnapshot = currentSnapshot;
  return result;
}

/**
 * 检查单条 Insight 的新鲜度
 * [M3] 支持传入缓存以避免重复计算
 */
export async function checkInsightFreshness(
  insight: Insight,
  cache?: FileStatCache
): Promise<InsightFreshnessResult> {
  const result: InsightFreshnessResult = {
    insightId: insight.id,
    question: insight.question,
    status: "unknown",
    checkedAt: new Date().toISOString(),
    changedFiles: [],
    unchangedFiles: [],
    missingFiles: [],
    reason: "",
  };

  const snapshots = insight.fileSnapshots || [];

  // 没有快照 → unknown（旧知识，无法判断）
  if (snapshots.length === 0) {
    result.status = "unknown";
    result.reason = "该知识没有文件快照，无法判断新鲜度";
    return result;
  }

  // 逐个检查文件
  for (const snapshot of snapshots) {
    const fileResult = await checkFileFreshness(snapshot, cache);

    switch (fileResult.status) {
      case "unchanged":
        result.unchangedFiles.push(fileResult);
        break;
      case "content_changed":
        result.changedFiles.push(fileResult);
        break;
      case "missing":
        result.missingFiles.push(fileResult);
        break;
    }
  }

  // 综合判断状态
  if (result.missingFiles.length > 0) {
    result.status = "stale";
    result.reason = `${result.missingFiles.length} 个关联文件已被删除`;
  } else if (result.changedFiles.length > 0) {
    result.status = "stale";
    result.reason = `${result.changedFiles.length} 个关联文件内容已变化`;
  } else {
    result.status = "fresh";
    result.reason = `所有 ${result.unchangedFiles.length} 个关联文件未变化`;
  }

  return result;
}

/**
 * 检查整个项目所有 Insight 的新鲜度
 * [M3] 自动创建缓存并在所有 Insight 间共享
 */
export async function checkProjectFreshness(
  knowledge: ProjectKnowledge
): Promise<ProjectFreshnessResult> {
  const result: ProjectFreshnessResult = {
    projectName: knowledge.name,
    checkedAt: new Date().toISOString(),
    total: knowledge.insights.length,
    fresh: 0,
    stale: 0,
    unknown: 0,
    changedFiles: [],
    insights: [],
  };

  const changedPathsSeen = new Set<string>();
  // [M3] 使用共享缓存
  const cache = createFileStatCache();

  for (const insight of knowledge.insights) {
    const insightResult = await checkInsightFreshness(insight, cache);
    result.insights.push(insightResult);

    switch (insightResult.status) {
      case "fresh":
        result.fresh++;
        break;
      case "stale":
        result.stale++;
        break;
      case "unknown":
        result.unknown++;
        break;
    }

    // 收集变化的文件（去重）
    for (const cf of insightResult.changedFiles) {
      if (!changedPathsSeen.has(cf.path)) {
        changedPathsSeen.add(cf.path);
        result.changedFiles.push(cf);
      }
    }
    for (const mf of insightResult.missingFiles) {
      if (!changedPathsSeen.has(mf.path)) {
        changedPathsSeen.add(mf.path);
        result.changedFiles.push(mf);
      }
    }
  }

  return result;
}
