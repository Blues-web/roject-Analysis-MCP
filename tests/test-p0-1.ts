/**
 * P0-1 单元测试
 * 
 * 运行方式: npx tsx tests/test-p0-1.ts
 * 
 * 测试覆盖:
 * 1. scanner.ts: generateFileHash, createFileSnapshots
 * 2. knowledge-store.ts: 旧数据迁移, 新字段支持, 版本递增, 状态统计
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  generateFileHash,
  createFileSnapshots,
} from "../src/utils/scanner.js";

import {
  createKnowledge,
  addInsight,
  loadKnowledge,
  hasKnowledge,
  deleteKnowledge,
  getInsightStats,
  CURRENT_SCHEMA_VERSION,
} from "../src/utils/knowledge-store.js";

import type { ProjectKnowledge, Insight } from "../src/utils/knowledge-store.js";

// ============ 测试辅助 ============

const PROJECT_ROOT = path.resolve(process.cwd());
const TEST_PREFIX = "_test_p01_";
const createdProjects: string[] = [];

function testProjectName(suffix: string): string {
  return `${TEST_PREFIX}${suffix}_${Date.now()}`;
}

function cleanup() {
  for (const name of createdProjects) {
    deleteKnowledge(name);
  }
  // 也清理手动创建的文件
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
  }
}

// ============ 测试套件 ============

console.log("\n🧪 P0-1 测试开始\n");

// ---- scanner.ts 测试 ----
console.log("📁 scanner.ts");

await test("generateFileHash: 对普通文本文件生成 hash", async () => {
  const hash = await generateFileHash(path.join(PROJECT_ROOT, "package.json"));
  assert.ok(hash !== null, "hash 不应为 null");
  assert.ok(hash!.length === 64, "SHA-256 hash 长度应为 64");
});

await test("generateFileHash: 对不存在的文件返回 null", async () => {
  const hash = await generateFileHash("/nonexistent/file.ts");
  assert.strictEqual(hash, null);
});

await test("generateFileHash: 对目录返回 null", async () => {
  const hash = await generateFileHash(PROJECT_ROOT);
  assert.strictEqual(hash, null);
});

await test("createFileSnapshots: 对有效文件生成快照", async () => {
  const snapshots = await createFileSnapshots(
    ["package.json", "tsconfig.json"],
    PROJECT_ROOT
  );
  assert.strictEqual(snapshots.length, 2, "应生成 2 个快照");
  
  const pkg = snapshots.find(s => s.path.endsWith("package.json"));
  assert.ok(pkg, "应包含 package.json");
  assert.ok(pkg!.size > 0, "size 应 > 0");
  assert.ok(pkg!.mtime, "应有 mtime");
  assert.ok(pkg!.hash, "小文件应有 hash");
});

await test("createFileSnapshots: 跳过不存在的文件", async () => {
  const snapshots = await createFileSnapshots(
    ["package.json", "nonexistent_file.ts"],
    PROJECT_ROOT
  );
  assert.strictEqual(snapshots.length, 1, "应只生成 1 个快照");
});

await test("createFileSnapshots: 去重相同路径", async () => {
  const absPath = path.join(PROJECT_ROOT, "package.json");
  const snapshots = await createFileSnapshots(
    ["package.json", absPath, "package.json"],
    PROJECT_ROOT
  );
  assert.strictEqual(snapshots.length, 1, "重复路径应去重为 1 个");
});

await test("createFileSnapshots: 相对路径正确解析", async () => {
  const snapshots = await createFileSnapshots(
    ["src/index.ts"],
    PROJECT_ROOT
  );
  assert.strictEqual(snapshots.length, 1);
  assert.ok(snapshots[0].path.startsWith("/"), "应为绝对路径");
  assert.ok(snapshots[0].path.endsWith("src/index.ts"), "路径应以 src/index.ts 结尾");
});

await test("createFileSnapshots: 空数组返回空结果", async () => {
  const snapshots = await createFileSnapshots([], PROJECT_ROOT);
  assert.strictEqual(snapshots.length, 0);
});

// ---- knowledge-store.ts 测试 ----
console.log("\n📁 knowledge-store.ts");

await test("createKnowledge: 新项目 schemaVersion 为当前版本", () => {
  const name = testProjectName("create");
  createdProjects.push(name);

  const knowledge = createKnowledge(name, "/test/path", "测试业务总结");
  assert.strictEqual(knowledge.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.strictEqual(knowledge.insights.length, 0);
  assert.strictEqual(knowledge.businessSummary, "测试业务总结");
});

await test("addInsight: 新洞察包含所有 P0-1 新字段", () => {
  const name = testProjectName("insight_new");
  createdProjects.push(name);
  createKnowledge(name, PROJECT_ROOT, "测试项目");

  const insight = addInsight(name, {
    question: "测试问题",
    answer: "测试答案",
    category: "feature",
    tags: ["tag1"],
    relatedFiles: ["package.json"],
    confidence: "high",
    relatedSymbols: ["TestClass", "testMethod"],
    relatedModules: ["test-module"],
    relatedApis: ["/api/test"],
    fileSnapshots: [{ path: "/test/package.json", size: 100, mtime: "2026-01-01T00:00:00.000Z" }],
  });

  assert.ok(insight, "insight 不应为 null");
  assert.strictEqual(insight!.version, 1);
  assert.strictEqual(insight!.status, "active");
  assert.ok(insight!.lastVerifiedAt, "应有 lastVerifiedAt");
  assert.deepStrictEqual(insight!.relatedSymbols, ["TestClass", "testMethod"]);
  assert.deepStrictEqual(insight!.relatedModules, ["test-module"]);
  assert.deepStrictEqual(insight!.relatedApis, ["/api/test"]);
  assert.strictEqual(insight!.fileSnapshots!.length, 1);
});

await test("addInsight: 不提供新字段时使用默认值", () => {
  const name = testProjectName("insight_defaults");
  createdProjects.push(name);
  createKnowledge(name, "/test", "测试");

  const insight = addInsight(name, {
    question: "简单问题",
    answer: "简单答案",
    category: "other",
    tags: [],
    relatedFiles: [],
    confidence: "medium",
  });

  assert.ok(insight);
  assert.strictEqual(insight!.version, 1);
  assert.strictEqual(insight!.status, "active");
  assert.deepStrictEqual(insight!.relatedSymbols, []);
  assert.deepStrictEqual(insight!.relatedModules, []);
  assert.deepStrictEqual(insight!.relatedApis, []);
  assert.deepStrictEqual(insight!.fileSnapshots, []);
});

await test("addInsight: 更新已有洞察时 version 递增", () => {
  const name = testProjectName("insight_version");
  createdProjects.push(name);
  createKnowledge(name, PROJECT_ROOT, "测试");

  const first = addInsight(name, {
    question: "认证流程是怎样的",
    answer: "使用 JWT",
    category: "feature",
    tags: [],
    relatedFiles: [],
    confidence: "high",
    relatedSymbols: ["AuthService"],
  });
  assert.strictEqual(first!.version, 1);

  const second = addInsight(name, {
    question: "认证流程是怎样的",  // 相同问题，触发更新
    answer: "使用 JWT + Refresh Token",
    category: "feature",
    tags: ["auth"],
    relatedFiles: [],
    confidence: "high",
    relatedSymbols: ["AuthService", "TokenRefresher"],
  });
  assert.strictEqual(second!.version, 2, "version 应递增为 2");
  assert.ok(second!.answer.includes("Refresh Token"), "答案应已更新");

  // 确认知识库中只有一条洞察（去重了）
  const knowledge = loadKnowledge(name);
  assert.strictEqual(knowledge!.insights.length, 1, "相似问题应合并为 1 条");
});

await test("旧数据迁移: v1 JSON 加载后自动填充新字段", () => {
  const name = testProjectName("migration_v1");
  createdProjects.push(name);

  // 手动写入一条 v1 格式的数据（没有 schemaVersion，insight 没有新字段）
  const knowledgeDir = path.join(
    process.env.HOME || "/tmp",
    ".project-analysis-mcp",
    "knowledge"
  );
  fs.mkdirSync(knowledgeDir, { recursive: true });

  const safeName = name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
  const filePath = path.join(knowledgeDir, `${safeName}.json`);

  const oldData: any = {
    name: name,
    projectPath: "/old/project",
    businessSummary: "旧的业务总结",
    createdAt: "2025-01-01T00:00:00.000Z",
    lastUpdated: "2025-01-01T00:00:00.000Z",
    insights: [
      {
        id: "old-insight-1",
        question: "旧问题",
        answer: "旧答案",
        category: "architecture",
        tags: ["old"],
        relatedFiles: ["src/old.ts"],
        recordedAt: "2025-01-01T00:00:00.000Z",
        confidence: "high",
        // 故意没有: relatedSymbols, relatedModules, relatedApis, fileSnapshots, status, lastVerifiedAt, version
      },
    ],
    // 故意没有 schemaVersion
  };

  fs.writeFileSync(filePath, JSON.stringify(oldData, null, 2), "utf-8");

  // 加载旧数据
  const loaded = loadKnowledge(name);
  assert.ok(loaded, "旧数据应能正常加载");
  assert.strictEqual(loaded!.schemaVersion, CURRENT_SCHEMA_VERSION, "schemaVersion 应迁移为当前版本");

  const insight = loaded!.insights[0];
  assert.deepStrictEqual(insight.relatedSymbols, [], "relatedSymbols 应默认为 []");
  assert.deepStrictEqual(insight.relatedModules, [], "relatedModules 应默认为 []");
  assert.deepStrictEqual(insight.relatedApis, [], "relatedApis 应默认为 []");
  assert.deepStrictEqual(insight.fileSnapshots, [], "fileSnapshots 应默认为 []");
  assert.strictEqual(insight.status, "active", "status 应默认为 active");
  assert.strictEqual(insight.lastVerifiedAt, insight.recordedAt, "lastVerifiedAt 应默认为 recordedAt");
  assert.strictEqual(insight.version, 1, "version 应默认为 1");

  // 验证原有字段保持不变
  assert.strictEqual(insight.question, "旧问题");
  assert.strictEqual(insight.answer, "旧答案");
  assert.deepStrictEqual(insight.relatedFiles, ["src/old.ts"]);
});

await test("getInsightStats: 包含 byStatus 统计", () => {
  const name = testProjectName("stats");
  createdProjects.push(name);
  createKnowledge(name, PROJECT_ROOT, "测试");

  addInsight(name, {
    question: "问题1", answer: "答案1", category: "feature",
    tags: [], relatedFiles: [], confidence: "high",
  });
  addInsight(name, {
    question: "问题2", answer: "答案2", category: "api",
    tags: [], relatedFiles: [], confidence: "medium",
  });

  const stats = getInsightStats(name);
  assert.ok(stats, "stats 不应为 null");
  assert.strictEqual(stats!.total, 2);
  assert.ok(stats!.byStatus, "应有 byStatus");
  assert.strictEqual(stats!.byStatus["active"], 2, "两条洞察都应是 active");
});

await test("addInsight: 相关字段去重合并", () => {
  const name = testProjectName("merge");
  createdProjects.push(name);
  createKnowledge(name, PROJECT_ROOT, "测试");

  addInsight(name, {
    question: "数据流怎么走",
    answer: "通过消息队列",
    category: "data_flow",
    tags: ["mq"],
    relatedFiles: ["src/mq.ts"],
    confidence: "high",
    relatedSymbols: ["Producer"],
    relatedModules: ["messaging"],
    relatedApis: ["/api/send"],
  });

  // 更新同一条，带重复的 symbols/modules
  addInsight(name, {
    question: "数据流怎么走",
    answer: "通过消息队列 + Kafka",
    category: "data_flow",
    tags: ["kafka"],
    relatedFiles: ["src/kafka.ts"],
    confidence: "high",
    relatedSymbols: ["Producer", "Consumer"],  // Producer 重复
    relatedModules: ["messaging", "kafka"],    // messaging 重复
    relatedApis: ["/api/send", "/api/receive"],  // /api/send 重复
  });

  const knowledge = loadKnowledge(name);
  const insight = knowledge!.insights[0];

  // 验证去重
  assert.ok(insight.relatedSymbols!.includes("Producer"));
  assert.ok(insight.relatedSymbols!.includes("Consumer"));
  assert.strictEqual(insight.relatedSymbols!.length, 2, "符号应去重");

  assert.ok(insight.relatedModules!.includes("messaging"));
  assert.ok(insight.relatedModules!.includes("kafka"));
  assert.strictEqual(insight.relatedModules!.length, 2, "模块应去重");

  assert.strictEqual(insight.relatedApis!.length, 2, "API 应去重");

  // tags 也应合并
  assert.ok(insight.tags.includes("mq"));
  assert.ok(insight.tags.includes("kafka"));
});

// ---- 模拟真实 Insight 数据测试 ----
console.log("\n📁 真实数据模拟");

await test("真实场景: 完整 Insight 生命周期", async () => {
  const name = testProjectName("real_scenario");
  createdProjects.push(name);

  // 1. 创建项目
  const knowledge = createKnowledge(name, PROJECT_ROOT, "这是一个项目分析 MCP 服务器，提供知识管理能力");
  assert.ok(knowledge);

  // 2. 记录一条带完整信息的 Insight
  const insight = addInsight(name, {
    question: "知识库是如何持久化的",
    answer: "使用 JSON 文件存储在 ~/.project-analysis-mcp/knowledge/ 目录，每个项目一个独立 JSON 文件",
    category: "architecture",
    tags: ["持久化", "JSON", "存储"],
    relatedFiles: ["src/utils/knowledge-store.ts"],
    confidence: "high",
    relatedSymbols: ["saveKnowledge", "loadKnowledge", "KNOWLEDGE_DIR"],
    relatedModules: ["knowledge-store"],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots(["src/utils/knowledge-store.ts"], PROJECT_ROOT),
  });

  assert.ok(insight);
  assert.strictEqual(insight!.version, 1);
  assert.strictEqual(insight!.status, "active");
  assert.ok(insight!.fileSnapshots!.length > 0, "应有文件快照");
  assert.ok(insight!.fileSnapshots![0].hash, "小文件应有 hash");
  assert.ok(insight!.fileSnapshots![0].size > 0, "应有文件大小");
  assert.ok(insight!.fileSnapshots![0].mtime, "应有修改时间");

  // 3. 验证数据可以被完整加载
  const loaded = loadKnowledge(name);
  assert.ok(loaded);
  assert.strictEqual(loaded!.insights.length, 1);
  
  const loadedInsight = loaded!.insights[0];
  assert.strictEqual(loadedInsight.question, "知识库是如何持久化的");
  assert.deepStrictEqual(loadedInsight.relatedSymbols, ["saveKnowledge", "loadKnowledge", "KNOWLEDGE_DIR"]);
  assert.ok(loadedInsight.fileSnapshots![0].path.endsWith("knowledge-store.ts"));

  // 4. 更新 Insight（模拟代码修改后重新分析）
  const updated = addInsight(name, {
    question: "知识库是如何持久化的",
    answer: "使用 JSON 文件存储，支持 schema 版本迁移，新增 fileSnapshots 字段",
    category: "architecture",
    tags: ["持久化", "迁移"],
    relatedFiles: ["src/utils/knowledge-store.ts", "src/utils/scanner.ts"],
    confidence: "high",
    relatedSymbols: ["saveKnowledge", "loadKnowledge", "migrateKnowledge"],
    relatedModules: ["knowledge-store"],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots(
      ["src/utils/knowledge-store.ts", "src/utils/scanner.ts"],
      PROJECT_ROOT
    ),
  });

  assert.strictEqual(updated!.version, 2, "更新后 version 应为 2");
  assert.ok(updated!.answer.includes("schema 版本迁移"), "答案应已更新");

  // 5. 确认只有一条记录
  const final = loadKnowledge(name);
  assert.strictEqual(final!.insights.length, 1, "应仍为 1 条（合并）");
  assert.strictEqual(final!.insights[0].version, 2);
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
