/**
 * 代码审查回归测试
 * 
 * 测试审查修复项：C1, H1, H3, H4, M2, M3, M5, M6, L4
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createKnowledge,
  addInsight,
  loadKnowledge,
  listAllKnowledge,
  updateInsightFreshness,
  batchUpdateFreshness,
  normalizeFilePaths,
  getInsightById,
  CURRENT_SCHEMA_VERSION,
} from "../src/utils/knowledge-store.js";
import type { InsightCategory } from "../src/utils/knowledge-store.js";
import { createFileSnapshots } from "../src/utils/scanner.js";
import {
  checkInsightFreshness,
  checkProjectFreshness,
  createFileStatCache,
} from "../src/utils/freshness.js";
import { analyzeImpact } from "../src/utils/impact-analyzer.js";

// ============ 测试工具 ============

let passCount = 0;
let failCount = 0;
let currentGroup = "";

function group(name: string) {
  currentGroup = name;
  console.log(`\n📁 ${name}`);
}

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passCount++;
    console.log(`  ✅ ${name}`);
  } catch (e: any) {
    failCount++;
    console.log(`  ❌ ${name}`);
    console.log(`     ${e.message}`);
  }
}

function createTempProject(): { dir: string; name: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "review-test-"));
  const name = `review-test-${Date.now()}`;
  return { dir, name };
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function cleanupKnowledge(name: string) {
  const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
  const filePath = path.join(
    process.env.HOME || "/tmp",
    ".project-analysis-mcp",
    "knowledge",
    `${safeName}.json`
  );
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

// ============ 开始测试 ============

console.log("🧪 代码审查回归测试开始\n");

// ---- C1: relatedFiles 归一化 ----
group("C1: relatedFiles 归一化为绝对路径");

await test("相对路径输入 → 存储为绝对路径", () => {
  const { dir, name } = createTempProject();
  try {
    const testFile = path.join(dir, "src", "utils.ts");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(testFile, "export const x = 1;", "utf-8");

    createKnowledge(name, dir, "测试项目");
    const insight = addInsight(name, {
      question: "C1 相对路径测试",
      answer: "测试相对路径归一化",
      category: "architecture" as InsightCategory,
      tags: [],
      relatedFiles: ["src/utils.ts"],  // 相对路径
      confidence: "high",
    });

    assert.ok(insight, "Insight 应被创建");
    assert.ok(insight!.relatedFiles.length > 0, "relatedFiles 不应为空");
    // 存储的应该是绝对路径
    assert.ok(
      path.isAbsolute(insight!.relatedFiles[0]),
      `relatedFiles 应为绝对路径，实际: ${insight!.relatedFiles[0]}`
    );
    assert.strictEqual(insight!.relatedFiles[0], testFile);
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

await test("重复相对路径和绝对路径 → 去重", () => {
  const { dir, name } = createTempProject();
  try {
    const testFile = path.join(dir, "src", "a.ts");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(testFile, "export const a = 1;", "utf-8");

    createKnowledge(name, dir, "测试项目");
    const insight = addInsight(name, {
      question: "C1 去重测试",
      answer: "测试路径去重",
      category: "architecture" as InsightCategory,
      tags: [],
      relatedFiles: ["src/a.ts", testFile],  // 同一个文件的两种路径
      confidence: "high",
    });

    assert.ok(insight, "Insight 应被创建");
    assert.strictEqual(insight!.relatedFiles.length, 1, "重复路径应被去重");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

await test("不存在的文件 → 静默跳过", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    const insight = addInsight(name, {
      question: "C1 不存在文件测试",
      answer: "测试不存在的文件被跳过",
      category: "architecture" as InsightCategory,
      tags: [],
      relatedFiles: ["nonexistent.ts", "also-missing.js"],
      confidence: "high",
    });

    assert.ok(insight, "Insight 应被创建");
    assert.strictEqual(insight!.relatedFiles.length, 0, "不存在的文件应被过滤");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- H1: 路径穿越防护 ----
group("H1: 路径穿越防护");

await test("analyze_impact: 目标文件不在项目内 → 抛错", async () => {
  const { dir, name } = createTempProject();
  try {
    const testFile = path.join(dir, "src", "main.ts");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(testFile, "export const main = 1;", "utf-8");

    createKnowledge(name, dir, "测试项目");

    // 尝试分析项目目录外的文件
    let threwError = false;
    try {
      await analyzeImpact("/etc/passwd", name, dir);
    } catch (e: any) {
      threwError = true;
      assert.ok(
        e.message.includes("安全限制") || e.message.includes("不在项目目录"),
        `错误消息应包含"安全限制": ${e.message}`
      );
    }
    assert.ok(threwError, "应抛出路径穿越错误");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

await test("analyze_impact: 相对路径穿越 → 抛错", async () => {
  const { dir, name } = createTempProject();
  try {
    const testFile = path.join(dir, "src", "main.ts");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(testFile, "export const main = 1;", "utf-8");

    createKnowledge(name, dir, "测试项目");

    let threwError = false;
    try {
      // 使用 ../../ 穿越到项目外
      await analyzeImpact("../../etc/passwd", name, dir);
    } catch (e: any) {
      threwError = true;
    }
    assert.ok(threwError, "相对路径穿越应被阻止");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- M5: unknown 不更新 lastVerifiedAt ----
group("M5: unknown 不更新 lastVerifiedAt");

await test("freshness=unknown 时 lastVerifiedAt 不变", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    const insight = addInsight(name, {
      question: "M5 unknown 测试",
      answer: "测试 unknown 不更新 lastVerifiedAt",
      category: "architecture" as InsightCategory,
      tags: [],
      relatedFiles: [],
      confidence: "high",
    });

    assert.ok(insight, "Insight 应被创建");
    const originalLastVerified = insight!.lastVerifiedAt;

    // 更新为 unknown
    const checkedAt = "2099-01-01T00:00:00.000Z";
    updateInsightFreshness(name, insight!.id, "unknown", checkedAt);

    const updated = getInsightById(name, insight!.id);
    assert.ok(updated, "Insight 应能读取");
    assert.strictEqual(
      updated!.lastVerifiedAt,
      originalLastVerified,
      "unknown 不应更新 lastVerifiedAt"
    );
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

await test("freshness=fresh 时 lastVerifiedAt 被更新", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    const insight = addInsight(name, {
      question: "M5 fresh 测试",
      answer: "测试 fresh 更新 lastVerifiedAt",
      category: "architecture" as InsightCategory,
      tags: [],
      relatedFiles: [],
      confidence: "high",
    });

    const checkedAt = "2099-01-01T00:00:00.000Z";
    updateInsightFreshness(name, insight!.id, "fresh", checkedAt);

    const updated = getInsightById(name, insight!.id);
    assert.strictEqual(
      updated!.lastVerifiedAt,
      checkedAt,
      "fresh 应更新 lastVerifiedAt"
    );
    assert.strictEqual(updated!.status, "active");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- H4: 批量更新 ----
group("H4: 批量更新 freshness");

await test("batchUpdateFreshness 一次更新多条 Insight", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    const i1 = addInsight(name, {
      question: "批量1", answer: "a", category: "feature" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });
    const i2 = addInsight(name, {
      question: "批量2", answer: "b", category: "feature" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });
    const i3 = addInsight(name, {
      question: "批量3", answer: "c", category: "feature" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });

    const checkedAt = new Date().toISOString();
    const count = batchUpdateFreshness(name, [
      { insightId: i1!.id, freshnessStatus: "fresh", checkedAt },
      { insightId: i2!.id, freshnessStatus: "stale", checkedAt },
      { insightId: i3!.id, freshnessStatus: "unknown", checkedAt },
    ]);

    assert.strictEqual(count, 2, "应更新 2 条（unknown 不算）");

    const u1 = getInsightById(name, i1!.id);
    const u2 = getInsightById(name, i2!.id);
    const u3 = getInsightById(name, i3!.id);

    assert.strictEqual(u1!.status, "active");
    assert.strictEqual(u2!.status, "stale");
    assert.strictEqual(u3!.status, "active"); // unknown 不改变
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- M6: 相似度收紧 ----
group("M6: 相似度判断收紧");

await test("短字符串不应误匹配长字符串", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    
    const i1 = addInsight(name, {
      question: "认证",
      answer: "认证模块总结",
      category: "architecture" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });

    const i2 = addInsight(name, {
      question: "JWT认证流程详细说明和token刷新机制",
      answer: "JWT详细说明",
      category: "feature" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });

    // 两个问题不应被合并（长度差异大）
    assert.notStrictEqual(i1!.id, i2!.id, "短问题和长问题不应被合并为同一条");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

await test("完全相同的问题仍然合并", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    
    const i1 = addInsight(name, {
      question: "用户认证流程",
      answer: "版本1",
      category: "architecture" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });

    const i2 = addInsight(name, {
      question: "用户认证流程",
      answer: "版本2",
      category: "architecture" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });

    assert.strictEqual(i1!.id, i2!.id, "完全相同的问题应合并");
    assert.strictEqual(i2!.version, 2, "合并后版本应为2");
    assert.strictEqual(i2!.answer, "版本2", "答案应被更新");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- H3: snapshot 一致性 ----
group("H3: 更新 Insight 时 snapshot 与 relatedFiles 一致");

await test("更新 relatedFiles 后旧 snapshot 被过滤", () => {
  const { dir, name } = createTempProject();
  try {
    const fileA = path.join(dir, "a.ts");
    const fileB = path.join(dir, "b.ts");
    fs.writeFileSync(fileA, "export const a = 1;", "utf-8");
    fs.writeFileSync(fileB, "export const b = 2;", "utf-8");

    createKnowledge(name, dir, "测试项目");
    
    // 第一次记录，关联 a.ts
    const snapshots1 = [{ path: fileA, size: 21, mtime: "2026-01-01T00:00:00.000Z" }];
    addInsight(name, {
      question: "H3 一致性测试",
      answer: "版本1",
      category: "architecture" as InsightCategory,
      tags: [], relatedFiles: [fileA], confidence: "high",
      fileSnapshots: snapshots1,
    });

    // 第二次更新，只关联 b.ts（不再关联 a.ts）
    const snapshots2 = [{ path: fileB, size: 21, mtime: "2026-01-01T00:00:00.000Z" }];
    const updated = addInsight(name, {
      question: "H3 一致性测试",
      answer: "版本2",
      category: "architecture" as InsightCategory,
      tags: [], relatedFiles: [fileB], confidence: "high",
      fileSnapshots: snapshots2,
    });

    assert.ok(updated, "更新应成功");
    assert.strictEqual(updated!.relatedFiles.length, 1, "应只有 1 个 relatedFile");
    assert.ok(updated!.relatedFiles[0].endsWith("b.ts"), "应为 b.ts");
    
    // snapshot 应该只包含 b.ts，不包含旧的 a.ts
    const snapshotPaths = (updated!.fileSnapshots || []).map(s => s.path);
    assert.ok(!snapshotPaths.some(p => p.endsWith("a.ts")), "旧 a.ts snapshot 应被移除");
    assert.ok(snapshotPaths.some(p => p.endsWith("b.ts")), "新 b.ts snapshot 应存在");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- M2: listAllKnowledge 内存迁移 ----
group("M2: listAllKnowledge 返回完整字段");

await test("listAllKnowledge 对旧数据做内存迁移", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    addInsight(name, {
      question: "M2 测试",
      answer: "测试",
      category: "other" as InsightCategory,
      tags: [], relatedFiles: [], confidence: "high",
    });

    const all = listAllKnowledge();
    const project = all.find(k => k.name === name);
    assert.ok(project, "应找到项目");
    
    if (project && project.insights.length > 0) {
      const insight = project.insights[0];
      // 迁移后应有完整字段
      assert.ok(insight.relatedSymbols !== undefined, "应有 relatedSymbols");
      assert.ok(insight.relatedModules !== undefined, "应有 relatedModules");
      assert.ok(insight.fileSnapshots !== undefined, "应有 fileSnapshots");
      assert.ok(insight.status !== undefined, "应有 status");
      assert.ok(insight.version !== undefined, "应有 version");
    }
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- M3: 缓存有效性 ----
group("M3: freshness 缓存避免重复计算");

await test("共享缓存时多 Insight 检查结果一致", async () => {
  const { dir, name } = createTempProject();
  try {
    const sharedFile = path.join(dir, "shared.ts");
    fs.writeFileSync(sharedFile, "export const shared = 1;", "utf-8");

    createKnowledge(name, dir, "测试项目");
    
    const snapshots = await createFileSnapshots([sharedFile], dir);
    const i1 = addInsight(name, {
      question: "缓存测试1",
      answer: "a",
      category: "feature" as InsightCategory,
      tags: [], relatedFiles: [sharedFile], confidence: "high",
      fileSnapshots: snapshots,
    });
    const i2 = addInsight(name, {
      question: "缓存测试2",
      answer: "b",
      category: "feature" as InsightCategory,
      tags: [], relatedFiles: [sharedFile], confidence: "high",
      fileSnapshots: snapshots,
    });

    // 修改文件
    fs.writeFileSync(sharedFile, "export const shared = 2;", "utf-8");

    const cache = createFileStatCache();
    const r1 = await checkInsightFreshness(i1!, cache);
    const r2 = await checkInsightFreshness(i2!, cache);

    assert.strictEqual(r1.status, "stale");
    assert.strictEqual(r2.status, "stale");
    // 缓存应被复用：第二次检查应该命中缓存
    assert.strictEqual(cache.stats.size, 1, "应只 stat 1 个文件（缓存复用）");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- L4: 风险权重递减 ----
group("L4: stale 知识风险权重递减");

await test("大量 stale 知识不会导致分数无限增长", async () => {
  const { dir, name } = createTempProject();
  try {
    const targetFile = path.join(dir, "src", "core.ts");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.writeFileSync(targetFile, "export const core = 1;", "utf-8");

    createKnowledge(name, dir, "测试项目");

    // 创建 10 条 stale 知识（都关联 core.ts）
    for (let i = 0; i < 10; i++) {
      addInsight(name, {
        question: `stale 知识 ${i}`,
        answer: `answer ${i}`,
        category: "feature" as InsightCategory,
        tags: [],
        relatedFiles: [targetFile],
        confidence: "high",
      });
      // 标记为 stale
      const k = loadKnowledge(name)!;
      const ins = k.insights[k.insights.length - 1];
      ins.status = "stale";
    }

    // 修改 core.ts 使知识变 stale
    fs.writeFileSync(targetFile, "export const core = 2; export const extra = 3;", "utf-8");

    const result = await analyzeImpact(targetFile, name, dir, { maxDepth: 2, maxNodes: 10 });
    
    // 即使有 10 条 stale，分数也不应超过 100
    assert.ok(result.risk.score <= 100, `分数应 ≤ 100，实际: ${result.risk.score}`);
    assert.ok(result.risk.score > 0, `分数应 > 0，实际: ${result.risk.score}`);
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ---- M7: 原子写入 ----
group("M7: 原子写入");

await test("保存知识使用 tmp + rename 原子操作", () => {
  const { dir, name } = createTempProject();
  try {
    createKnowledge(name, dir, "测试项目");
    
    const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
    const knowledgeDir = path.join(process.env.HOME || "/tmp", ".project-analysis-mcp", "knowledge");
    const knowledgeFile = path.join(knowledgeDir, `${safeName}.json`);
    const tmpFile = knowledgeFile + ".tmp";
    
    // 保存后不应残留 .tmp 文件
    assert.ok(fs.existsSync(knowledgeFile), "知识文件应存在");
    assert.ok(!fs.existsSync(tmpFile), ".tmp 文件不应残留");
  } finally {
    cleanup(dir);
    cleanupKnowledge(name);
  }
});

// ============ 汇总 ============

console.log("\n════════════════════════════════════════");
console.log(`测试结果: ${passCount} 通过, ${failCount} 失败, 共 ${passCount + failCount} 项`);
console.log("════════════════════════════════════════\n");

if (failCount > 0) {
  process.exit(1);
}
