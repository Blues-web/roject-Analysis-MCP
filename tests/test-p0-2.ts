/**
 * P0-2 单元测试：知识新鲜度检查
 * 
 * 运行方式: npx tsx tests/test-p0-2.ts
 * 
 * 测试覆盖:
 * 1. 文件未变化 → fresh
 * 2. mtime 变化但内容没变化 → fresh（hash 相同）
 * 3. 内容变化 → stale
 * 4. 文件删除 → stale
 * 5. 文件不存在 → stale (missing)
 * 6. 旧 Insight 没有 snapshot → unknown
 * 7. 多文件 Insight
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  createKnowledge,
  addInsight,
  loadKnowledge,
  deleteKnowledge,
  getInsightById,
  updateInsightFreshness,
} from "../src/utils/knowledge-store.js";

import {
  checkInsightFreshness,
  checkProjectFreshness,
} from "../src/utils/freshness.js";

import { createFileSnapshots } from "../src/utils/scanner.js";

// ============ 测试辅助 ============

const TEST_PREFIX = "_test_p02_";
const createdProjects: string[] = [];
const tempDir = path.join(os.tmpdir(), "pam-test-p02-" + Date.now());
const createdTempFiles: string[] = [];

function testProjectName(suffix: string): string {
  return `${TEST_PREFIX}${suffix}_${Date.now()}`;
}

function cleanup() {
  for (const name of createdProjects) {
    deleteKnowledge(name);
  }
  // 清理临时目录
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  // 清理知识库中的测试数据
  const knowledgeDir = path.join(
    process.env.HOME || "/tmp",
    ".project-analysis-mcp",
    "knowledge"
  );
  if (fs.existsSync(knowledgeDir)) {
    const files = fs.readdirSync(knowledgeDir);
    for (const file of files) {
      if (file.startsWith(TEST_PREFIX)) {
        fs.unlinkSync(path.join(knowledgeDir, file));
      }
    }
  }
}

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${err.message}`);
    if (err.stack) {
      console.error(`     ${err.stack.split('\n').slice(1, 3).join('\n     ')}`);
    }
  }
}

// ============ 测试套件 ============

console.log("\n🧪 P0-2 测试开始\n");

// 创建临时测试目录
fs.mkdirSync(tempDir, { recursive: true });

console.log("📁 freshness.ts — 单文件检查");

await test("文件未变化 → fresh", async () => {
  // 创建测试文件
  const testFile = path.join(tempDir, "unchanged.txt");
  fs.writeFileSync(testFile, "hello world", "utf-8");

  // 创建项目并记录 Insight
  const name = testProjectName("fresh_unchanged");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  const snapshots = await createFileSnapshots(["unchanged.txt"], tempDir);
  assert.strictEqual(snapshots.length, 1);

  const insight = addInsight(name, {
    question: "测试问题",
    answer: "测试答案",
    category: "feature",
    tags: [],
    relatedFiles: ["unchanged.txt"],
    confidence: "high",
    fileSnapshots: snapshots,
  });

  assert.ok(insight);

  // 立即检查新鲜度（文件未变化）
  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "fresh", "状态应为 fresh");
  assert.strictEqual(result.unchangedFiles.length, 1, "应有 1 个未变化文件");
  assert.strictEqual(result.changedFiles.length, 0, "不应有变化文件");
  assert.strictEqual(result.missingFiles.length, 0, "不应有缺失文件");
});

await test("mtime 变化但内容没变化 → fresh（hash 相同）", async () => {
  const testFile = path.join(tempDir, "touch_same.txt");
  const content = "content stays the same";
  fs.writeFileSync(testFile, content, "utf-8");

  const name = testProjectName("fresh_touch");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  const snapshots = await createFileSnapshots(["touch_same.txt"], tempDir);

  const insight = addInsight(name, {
    question: "touch 测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: ["touch_same.txt"],
    confidence: "high",
    fileSnapshots: snapshots,
  });

  // 等待 100ms 确保 mtime 变化
  await new Promise(r => setTimeout(r, 100));

  // 重新写入相同内容（会更新 mtime）
  fs.writeFileSync(testFile, content, "utf-8");

  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "fresh", "内容未变，状态应为 fresh");
  assert.strictEqual(result.unchangedFiles.length, 1);
  assert.strictEqual(result.changedFiles.length, 0);
});

await test("内容变化 → stale", async () => {
  const testFile = path.join(tempDir, "changed.txt");
  fs.writeFileSync(testFile, "original content", "utf-8");

  const name = testProjectName("stale_changed");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  const snapshots = await createFileSnapshots(["changed.txt"], tempDir);

  const insight = addInsight(name, {
    question: "变化测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: ["changed.txt"],
    confidence: "high",
    fileSnapshots: snapshots,
  });

  // 等待确保 mtime 变化
  await new Promise(r => setTimeout(r, 100));

  // 写入不同内容
  fs.writeFileSync(testFile, "modified content!!!", "utf-8");

  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "stale", "内容变化，状态应为 stale");
  assert.strictEqual(result.changedFiles.length, 1, "应有 1 个变化文件");
  assert.ok(result.changedFiles[0].reason!.includes("内容已变化") || 
            result.changedFiles[0].reason!.includes("content_changed"),
    "原因应说明内容变化");
});

await test("文件删除 → stale (missing)", async () => {
  const testFile = path.join(tempDir, "to_delete.txt");
  fs.writeFileSync(testFile, "will be deleted", "utf-8");

  const name = testProjectName("stale_deleted");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  const snapshots = await createFileSnapshots(["to_delete.txt"], tempDir);

  const insight = addInsight(name, {
    question: "删除测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: ["to_delete.txt"],
    confidence: "high",
    fileSnapshots: snapshots,
  });

  // 删除文件
  fs.unlinkSync(testFile);

  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "stale", "文件删除，状态应为 stale");
  assert.strictEqual(result.missingFiles.length, 1, "应有 1 个缺失文件");
});

await test("文件不存在（快照路径无效）→ stale (missing)", async () => {
  const name = testProjectName("stale_nonexist");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  // 手动构造一个指向不存在文件的快照
  const insight = addInsight(name, {
    question: "不存在文件测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: ["nonexistent_file.ts"],
    confidence: "high",
    fileSnapshots: [{
      path: path.join(tempDir, "nonexistent_file.ts"),
      size: 100,
      mtime: new Date().toISOString(),
      hash: "abc123",
    }],
  });

  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "stale", "文件不存在，状态应为 stale");
  assert.strictEqual(result.missingFiles.length, 1);
});

await test("旧 Insight 没有 snapshot → unknown", async () => {
  const name = testProjectName("unknown_nosnap");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  // 创建 Insight 但不提供文件快照
  const insight = addInsight(name, {
    question: "旧知识测试",
    answer: "答案",
    category: "architecture",
    tags: [],
    relatedFiles: [],  // 无文件关联
    confidence: "medium",
  });

  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "unknown", "无快照应为 unknown");
  assert.ok(result.reason.includes("快照") || result.reason.includes("snapshot"), 
    "原因应说明缺少快照");
});

await test("多文件 Insight：部分变化 → stale", async () => {
  const file1 = path.join(tempDir, "multi_1.txt");
  const file2 = path.join(tempDir, "multi_2.txt");
  const file3 = path.join(tempDir, "multi_3.txt");
  fs.writeFileSync(file1, "file 1", "utf-8");
  fs.writeFileSync(file2, "file 2", "utf-8");
  fs.writeFileSync(file3, "file 3", "utf-8");

  const name = testProjectName("stale_multi");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  const snapshots = await createFileSnapshots(
    ["multi_1.txt", "multi_2.txt", "multi_3.txt"],
    tempDir
  );
  assert.strictEqual(snapshots.length, 3);

  const insight = addInsight(name, {
    question: "多文件测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: ["multi_1.txt", "multi_2.txt", "multi_3.txt"],
    confidence: "high",
    fileSnapshots: snapshots,
  });

  // 等待确保 mtime 变化
  await new Promise(r => setTimeout(r, 100));

  // 只修改第 2 个文件
  fs.writeFileSync(file2, "file 2 MODIFIED!!!", "utf-8");

  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "stale", "部分文件变化应为 stale");
  assert.strictEqual(result.changedFiles.length, 1, "应有 1 个变化文件");
  assert.strictEqual(result.unchangedFiles.length, 2, "应有 2 个未变化文件");
});

await test("多文件 Insight：部分删除 + 部分变化 → stale", async () => {
  const file1 = path.join(tempDir, "mixed_1.txt");
  const file2 = path.join(tempDir, "mixed_2.txt");
  fs.writeFileSync(file1, "mixed 1", "utf-8");
  fs.writeFileSync(file2, "mixed 2", "utf-8");

  const name = testProjectName("stale_mixed");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  const snapshots = await createFileSnapshots(
    ["mixed_1.txt", "mixed_2.txt"],
    tempDir
  );

  const insight = addInsight(name, {
    question: "混合测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: ["mixed_1.txt", "mixed_2.txt"],
    confidence: "high",
    fileSnapshots: snapshots,
  });

  // 删除 file1，修改 file2
  fs.unlinkSync(file1);
  await new Promise(r => setTimeout(r, 100));
  fs.writeFileSync(file2, "mixed 2 CHANGED", "utf-8");

  const result = await checkInsightFreshness(insight!);

  assert.strictEqual(result.status, "stale");
  assert.strictEqual(result.missingFiles.length, 1, "应有 1 个缺失文件");
  assert.strictEqual(result.changedFiles.length, 1, "应有 1 个变化文件");
});

// ---- checkProjectFreshness 测试 ----
console.log("\n📁 freshness.ts — 项目级别检查");

await test("checkProjectFreshness: 统计正确", async () => {
  const testFile = path.join(tempDir, "proj_test.txt");
  fs.writeFileSync(testFile, "project test", "utf-8");

  const name = testProjectName("proj_freshness");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试项目");

  // Insight 1: 有快照，文件未变 → fresh
  const snapshots1 = await createFileSnapshots(["proj_test.txt"], tempDir);
  addInsight(name, {
    question: "新鲜的知识",
    answer: "答案1",
    category: "feature",
    tags: [],
    relatedFiles: ["proj_test.txt"],
    confidence: "high",
    fileSnapshots: snapshots1,
  });

  // Insight 2: 无快照 → unknown
  addInsight(name, {
    question: "旧知识",
    answer: "答案2",
    category: "architecture",
    tags: [],
    relatedFiles: [],
    confidence: "medium",
  });

  // Insight 3: 有快照但文件会变 → stale
  const changeFile = path.join(tempDir, "proj_change.txt");
  fs.writeFileSync(changeFile, "will change", "utf-8");
  const snapshots3 = await createFileSnapshots(["proj_change.txt"], tempDir);
  addInsight(name, {
    question: "会变的知识",
    answer: "答案3",
    category: "feature",
    tags: [],
    relatedFiles: ["proj_change.txt"],
    confidence: "high",
    fileSnapshots: snapshots3,
  });

  // 修改文件
  await new Promise(r => setTimeout(r, 100));
  fs.writeFileSync(changeFile, "will change MODIFIED", "utf-8");

  const knowledge = loadKnowledge(name);
  assert.ok(knowledge);

  const result = await checkProjectFreshness(knowledge!);

  assert.strictEqual(result.total, 3, "总计应为 3");
  assert.strictEqual(result.fresh, 1, "fresh 应为 1");
  assert.strictEqual(result.stale, 1, "stale 应为 1");
  assert.strictEqual(result.unknown, 1, "unknown 应为 1");
  assert.ok(result.changedFiles.length > 0, "应有变化文件");
});

// ---- knowledge-store P0-2 函数测试 ----
console.log("\n📁 knowledge-store.ts — P0-2 函数");

await test("getInsightById: 正确获取 Insight", async () => {
  const name = testProjectName("get_by_id");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试");

  const insight = addInsight(name, {
    question: "查找测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: [],
    confidence: "high",
  });

  const found = getInsightById(name, insight!.id);
  assert.ok(found, "应能找到 Insight");
  assert.strictEqual(found!.question, "查找测试");
});

await test("getInsightById: 不存在的 ID 返回 null", () => {
  const name = testProjectName("get_null");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试");

  const found = getInsightById(name, "nonexistent-id");
  assert.strictEqual(found, null);
});

await test("updateInsightFreshness: 更新状态和验证时间", async () => {
  const name = testProjectName("update_fresh");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试");

  const insight = addInsight(name, {
    question: "更新测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: [],
    confidence: "high",
  });

  const checkedAt = new Date().toISOString();

  // 更新为 stale
  const success = updateInsightFreshness(name, insight!.id, "stale", checkedAt);
  assert.ok(success, "更新应成功");

  const updated = getInsightById(name, insight!.id);
  assert.strictEqual(updated!.status, "stale", "状态应为 stale");
  assert.strictEqual(updated!.lastVerifiedAt, checkedAt, "验证时间应更新");

  // 更新为 fresh
  const checkedAt2 = new Date().toISOString();
  updateInsightFreshness(name, insight!.id, "fresh", checkedAt2);
  const fresh = getInsightById(name, insight!.id);
  assert.strictEqual(fresh!.status, "active", "fresh 应映射为 active");
});

await test("updateInsightFreshness: unknown 不改变状态", async () => {
  const name = testProjectName("update_unknown");
  createdProjects.push(name);
  createKnowledge(name, tempDir, "测试");

  const insight = addInsight(name, {
    question: "unknown 测试",
    answer: "答案",
    category: "feature",
    tags: [],
    relatedFiles: [],
    confidence: "high",
  });

  // 先设为 stale
  updateInsightFreshness(name, insight!.id, "stale", new Date().toISOString());
  
  // 再用 unknown 更新，不应改变状态
  updateInsightFreshness(name, insight!.id, "unknown", new Date().toISOString());
  
  const result = getInsightById(name, insight!.id);
  assert.strictEqual(result!.status, "stale", "unknown 不应改变已有状态");
});

// ============ 测试报告 ============

console.log(`\n${"═".repeat(40)}`);
console.log(`测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项`);
console.log(`${"═".repeat(40)}\n`);

// 清理
cleanup();

if (failed > 0) {
  process.exit(1);
}
