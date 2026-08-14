/**
 * 集成测试：P0-1 + P0-2 + P0-3 + 联动
 * 
 * 运行方式: npx tsx tests/test-integration.ts
 * 
 * 测试覆盖:
 * 1. 搜索 → 发现 stale → 更新 → 验证 fresh（完整闭环）
 * 2. 影响分析关联知识新鲜度
 * 3. record_insight 更新重置 freshness
 * 4. 旧数据（无快照）在集成流程中的兼容性
 * 5. 多工具串联：search → check → record → search
 * 6. analyze_impact 包含 freshness 信息
 * 7. refresh_project_knowledge 集成
 * 8. 并发安全：快速连续更新
 * 9. 风险评分 stale 加成
 * 10. 端到端流程模拟
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
  queryInsights,
  updateInsightFreshness,
} from "../src/utils/knowledge-store.js";

import {
  checkInsightFreshness,
  checkProjectFreshness,
} from "../src/utils/freshness.js";

import {
  analyzeImpact,
  formatImpactAnalysis,
} from "../src/utils/impact-analyzer.js";

import { createFileSnapshots } from "../src/utils/scanner.js";

// ============ 测试辅助 ============

const TEST_PREFIX = "_test_integration_";
const createdProjects: string[] = [];
const tempDir = path.join(os.tmpdir(), "pam-test-integration-" + Date.now());

function testProjectName(suffix: string): string {
  return `${TEST_PREFIX}${suffix}_${Date.now()}`;
}

function cleanup() {
  for (const name of createdProjects) {
    deleteKnowledge(name);
  }
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
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

console.log("\n🧪 集成测试开始\n");

// 创建临时测试目录
fs.mkdirSync(tempDir, { recursive: true });

// ---- 场景1: 搜索 → 发现 stale → 更新 → 验证 fresh ----
console.log("📁 场景1: 完整闭环（搜索 → stale → 更新 → fresh）");

await test("闭环: 创建知识 → 修改代码 → 检测 stale → 更新 → fresh", async () => {
  const projectDir = path.join(tempDir, "scenario1");
  fs.mkdirSync(projectDir, { recursive: true });

  // 创建目标文件
  const targetFile = path.join(projectDir, "auth.ts");
  fs.writeFileSync(targetFile, "export function login() { return true; }", "utf-8");

  const name = testProjectName("scenario1");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "认证模块项目");

  // Step 1: 记录知识（带快照）
  const insight = addInsight(name, {
    question: "登录逻辑是什么？",
    answer: "通过 login() 函数处理登录",
    category: "feature",
    tags: ["auth"],
    relatedFiles: [targetFile],
    confidence: "high",
    relatedSymbols: ["login"],
    relatedModules: ["auth"],
    relatedApis: ["/api/login"],
    fileSnapshots: await createFileSnapshots([targetFile], projectDir),
  });

  assert.ok(insight, "应成功创建知识");
  assert.strictEqual(insight!.version, 1);
  assert.strictEqual(insight!.status, "active");
  assert.ok(insight!.fileSnapshots!.length > 0, "应有快照");

  // Step 2: 检查新鲜度 → 应该是 fresh
  const freshness1 = await checkInsightFreshness(insight!);
  assert.strictEqual(freshness1.status, "fresh", "初始状态应为 fresh");

  // Step 3: 修改文件
  fs.writeFileSync(targetFile, "export function login() { return false; }", "utf-8");

  // Step 4: 重新加载知识并检查 → 应该是 stale
  const loaded = loadKnowledge(name);
  const loadedInsight = loaded!.insights[0];
  const freshness2 = await checkInsightFreshness(loadedInsight);
  assert.strictEqual(freshness2.status, "stale", "修改文件后应为 stale");
  assert.ok(freshness2.changedFiles.length > 0, "应有变化文件");

  // Step 5: 更新知识（模拟重新分析）
  const updated = addInsight(name, {
    question: "登录逻辑是什么？",
    answer: "通过 login() 函数处理登录（返回 false）",
    category: "feature",
    tags: ["auth"],
    relatedFiles: [targetFile],
    confidence: "high",
    relatedSymbols: ["login"],
    relatedModules: ["auth"],
    relatedApis: ["/api/login"],
    fileSnapshots: await createFileSnapshots([targetFile], projectDir),
  });

  assert.ok(updated, "应成功更新");
  assert.strictEqual(updated!.version, 2, "版本应递增为 2");
  assert.strictEqual(updated!.status, "active", "更新后应为 active");

  // Step 6: 再次检查 → 应该是 fresh
  const reloaded = loadKnowledge(name);
  const reloadedInsight = reloaded!.insights[0];
  const freshness3 = await checkInsightFreshness(reloadedInsight);
  assert.strictEqual(freshness3.status, "fresh", "更新快照后应为 fresh");
});

// ---- 场景2: analyze_impact 包含 freshness ----
console.log("\n📁 场景2: 影响分析包含知识新鲜度");

await test("analyze_impact: 关联知识带 freshness 信息", async () => {
  const projectDir = path.join(tempDir, "scenario2");
  fs.mkdirSync(projectDir, { recursive: true });

  // 创建被引用文件
  const storeFile = path.join(projectDir, "store.ts");
  fs.writeFileSync(storeFile, "export const state = { count: 0 };", "utf-8");

  // 创建引用文件
  const viewFile = path.join(projectDir, "view.ts");
  fs.writeFileSync(viewFile, "import { state } from './store';\nconsole.log(state);", "utf-8");

  const name = testProjectName("scenario2");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "状态管理项目");

  // 记录知识（关联 store 文件）
  addInsight(name, {
    question: "状态管理怎么实现的？",
    answer: "使用 store.ts 管理全局状态",
    category: "architecture",
    tags: ["store"],
    relatedFiles: [storeFile],
    confidence: "high",
    relatedModules: ["store"],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots([storeFile], projectDir),
  });

  // 分析 store.ts 的影响
  const result = await analyzeImpact(storeFile, name, projectDir);

  assert.ok(result.relatedInsights.length > 0, "应有相关知识");
  assert.strictEqual(result.relatedInsights[0].freshness, "fresh", "知识应为 fresh");
  assert.strictEqual(result.freshnessSummary.fresh, 1, "fresh 计数应为 1");
  assert.strictEqual(result.freshnessSummary.stale, 0, "stale 计数应为 0");

  // 修改 store.ts
  fs.writeFileSync(storeFile, "export const state = { count: 1, name: '' };", "utf-8");

  // 再次分析
  const result2 = await analyzeImpact(storeFile, name, projectDir);

  assert.ok(result2.relatedInsights.length > 0, "修改后仍应有相关知识");
  assert.strictEqual(result2.relatedInsights[0].freshness, "stale", "修改后知识应为 stale");
  assert.strictEqual(result2.freshnessSummary.stale, 1, "stale 计数应为 1");
  assert.ok(
    result2.risk.reasons.some(r => r.includes("过期")),
    "风险原因应包含 stale 知识提示"
  );
});

// ---- 场景3: record_insight 更新重置 freshness ----
console.log("\n📁 场景3: record_insight 更新重置 freshness");

await test("record_insight: 更新知识重置 freshness 和 version", async () => {
  const projectDir = path.join(tempDir, "scenario3");
  fs.mkdirSync(projectDir, { recursive: true });

  const file1 = path.join(projectDir, "api.ts");
  fs.writeFileSync(file1, "export function getUser() { return {}; }", "utf-8");

  const name = testProjectName("scenario3");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "API 项目");

  // 创建知识
  const insight1 = addInsight(name, {
    question: "getUser 做什么？",
    answer: "获取用户信息",
    category: "api",
    tags: ["user"],
    relatedFiles: [file1],
    confidence: "high",
    relatedSymbols: ["getUser"],
    relatedModules: ["user"],
    relatedApis: ["/api/user"],
    fileSnapshots: await createFileSnapshots([file1], projectDir),
  });

  assert.strictEqual(insight1!.version, 1);
  assert.strictEqual(insight1!.status, "active");

  // 修改文件
  fs.writeFileSync(file1, "export function getUser() { return { name: 'test' }; }", "utf-8");

  // 检查 → stale
  const loaded1 = loadKnowledge(name)!.insights[0];
  const f1 = await checkInsightFreshness(loaded1);
  assert.strictEqual(f1.status, "stale");

  // 更新知识
  const insight2 = addInsight(name, {
    question: "getUser 做什么？",
    answer: "获取用户信息，返回 name 字段",
    category: "api",
    tags: ["user"],
    relatedFiles: [file1],
    confidence: "high",
    relatedSymbols: ["getUser"],
    relatedModules: ["user"],
    relatedApis: ["/api/user"],
    fileSnapshots: await createFileSnapshots([file1], projectDir),
  });

  assert.strictEqual(insight2!.version, 2, "版本应递增");
  assert.strictEqual(insight2!.status, "active", "状态应重置为 active");

  // 再次检查 → fresh
  const loaded2 = loadKnowledge(name)!.insights[0];
  const f2 = await checkInsightFreshness(loaded2);
  assert.strictEqual(f2.status, "fresh", "更新快照后应为 fresh");
});

// ---- 场景4: 旧数据兼容性 ----
console.log("\n📁 场景4: 旧数据（无快照）兼容性");

await test("旧数据: 无快照知识在集成流程中不报错", async () => {
  const projectDir = path.join(tempDir, "scenario4");
  fs.mkdirSync(projectDir, { recursive: true });

  const name = testProjectName("scenario4");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "旧项目");

  // 创建知识（不带快照）
  const insight = addInsight(name, {
    question: "旧逻辑是什么？",
    answer: "旧的实现方式",
    category: "feature",
    tags: ["legacy"],
    relatedFiles: [],
    confidence: "medium",
    relatedSymbols: [],
    relatedModules: [],
    relatedApis: [],
    // 不传 fileSnapshots
  });

  assert.ok(insight, "应成功创建");
  assert.strictEqual(insight!.fileSnapshots!.length, 0, "快照应为空");

  // 检查新鲜度 → unknown
  const freshness = await checkInsightFreshness(insight!);
  assert.strictEqual(freshness.status, "unknown", "无快照应为 unknown");

  // analyze_impact 不应报错
  const file = path.join(projectDir, "legacy.ts");
  fs.writeFileSync(file, "export const legacy = true;", "utf-8");
  
  const result = await analyzeImpact(file, name, projectDir);
  assert.ok(result, "analyze_impact 不应报错");
  assert.strictEqual(result.freshnessSummary.unknown, 0, "文件不关联则不应计入");

  // search 不应报错
  const searchResults = queryInsights(name, { keyword: "旧逻辑" });
  assert.strictEqual(searchResults.length, 1, "应能搜索到");
});

// ---- 场景5: 多工具串联 ----
console.log("\n📁 场景5: 多工具串联");

await test("串联: search → check → record → search", async () => {
  const projectDir = path.join(tempDir, "scenario5");
  fs.mkdirSync(projectDir, { recursive: true });

  const file1 = path.join(projectDir, "router.ts");
  fs.writeFileSync(file1, "export const routes = [{ path: '/' }];", "utf-8");

  const name = testProjectName("scenario5");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "路由项目");

  // Step 1: 搜索（应该没有）
  const search1 = queryInsights(name, { keyword: "路由" });
  assert.strictEqual(search1.length, 0, "初始应为空");

  // Step 2: 记录知识
  addInsight(name, {
    question: "路由怎么配置的？",
    answer: "在 router.ts 中配置 routes 数组",
    category: "architecture",
    tags: ["router"],
    relatedFiles: [file1],
    confidence: "high",
    relatedSymbols: ["routes"],
    relatedModules: ["router"],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots([file1], projectDir),
  });

  // Step 3: 搜索（应该有）
  const search2 = queryInsights(name, { keyword: "路由" });
  assert.strictEqual(search2.length, 1, "应找到 1 条");

  // Step 4: 检查新鲜度
  const freshness1 = await checkInsightFreshness(search2[0]);
  assert.strictEqual(freshness1.status, "fresh", "应为 fresh");

  // Step 5: 修改文件
  fs.writeFileSync(file1, "export const routes = [{ path: '/' }, { path: '/about' }];", "utf-8");

  // Step 6: 重新搜索并检查
  const search3 = queryInsights(name, { keyword: "路由" });
  const freshness2 = await checkInsightFreshness(search3[0]);
  assert.strictEqual(freshness2.status, "stale", "修改后应为 stale");

  // Step 7: 更新知识
  addInsight(name, {
    question: "路由怎么配置的？",
    answer: "在 router.ts 中配置 routes 数组，包含 / 和 /about",
    category: "architecture",
    tags: ["router"],
    relatedFiles: [file1],
    confidence: "high",
    relatedSymbols: ["routes"],
    relatedModules: ["router"],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots([file1], projectDir),
  });

  // Step 8: 最终搜索
  const search4 = queryInsights(name, { keyword: "路由" });
  assert.strictEqual(search4.length, 1, "应仍为 1 条（合并）");
  assert.strictEqual(search4[0].version, 2, "版本应为 2");
  
  const freshness3 = await checkInsightFreshness(search4[0]);
  assert.strictEqual(freshness3.status, "fresh", "更新后应为 fresh");
});

// ---- 场景6: analyze_impact 格式化输出含 freshness ----
console.log("\n📁 场景6: analyze_impact 输出含新鲜度信息");

await test("formatImpactAnalysis: 输出包含 freshness 汇总", async () => {
  const projectDir = path.join(tempDir, "scenario6");
  fs.mkdirSync(projectDir, { recursive: true });

  const coreFile = path.join(projectDir, "core.ts");
  fs.writeFileSync(coreFile, "export const core = 'core';", "utf-8");

  // 创建引用文件
  const appFile = path.join(projectDir, "app.ts");
  fs.writeFileSync(appFile, "import { core } from './core';", "utf-8");

  const name = testProjectName("scenario6");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "核心模块项目");

  // 记录知识
  addInsight(name, {
    question: "核心模块是什么？",
    answer: "core.ts 提供核心常量",
    category: "architecture",
    tags: ["core"],
    relatedFiles: [coreFile],
    confidence: "high",
    relatedModules: ["core"],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots([coreFile], projectDir),
  });

  // 分析
  const result = await analyzeImpact(coreFile, name, projectDir);
  const formatted = formatImpactAnalysis(result);

  assert.ok(formatted.includes("有效:"), "应包含 fresh 统计");
  assert.ok(formatted.includes("需验证:"), "应包含 stale 统计");
  assert.ok(formatted.includes("无快照:"), "应包含 unknown 统计");
  assert.ok(formatted.includes("核心模块是什么"), "应包含知识问题");
  assert.ok(formatted.includes("🟢"), "fresh 知识应显示绿色标记");
});

// ---- 场景7: refresh_project_knowledge 集成 ----
console.log("\n📁 场景7: refresh_project_knowledge 集成");

await test("refresh: 混合 fresh/stale/unknown 项目刷新", async () => {
  const projectDir = path.join(tempDir, "scenario7");
  fs.mkdirSync(projectDir, { recursive: true });

  const file1 = path.join(projectDir, "a.ts");
  const file2 = path.join(projectDir, "b.ts");
  fs.writeFileSync(file1, "export const a = 1;", "utf-8");
  fs.writeFileSync(file2, "export const b = 2;", "utf-8");

  const name = testProjectName("scenario7");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "混合项目");

  // 知识1: 有快照，文件未变 → fresh
  addInsight(name, {
    question: "a 是什么？",
    answer: "a 是常量 1",
    category: "feature",
    tags: ["a"],
    relatedFiles: [file1],
    confidence: "high",
    relatedSymbols: [],
    relatedModules: [],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots([file1], projectDir),
  });

  // 知识2: 有快照，文件将变 → stale
  addInsight(name, {
    question: "b 是什么？",
    answer: "b 是常量 2",
    category: "feature",
    tags: ["b"],
    relatedFiles: [file2],
    confidence: "high",
    relatedSymbols: [],
    relatedModules: [],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots([file2], projectDir),
  });

  // 知识3: 无快照 → unknown
  addInsight(name, {
    question: "整体架构是什么？",
    answer: "简单的模块结构",
    category: "architecture",
    tags: ["arch"],
    relatedFiles: [],
    confidence: "medium",
    relatedSymbols: [],
    relatedModules: [],
    relatedApis: [],
    // 无快照
  });

  // 修改 file2（写入不同长度的内容确保 mtime/size 变化）
  fs.writeFileSync(file2, "export const b = 300; // changed", "utf-8");

  // 项目级刷新
  const knowledge = loadKnowledge(name)!;
  const refreshResult = await checkProjectFreshness(knowledge);

  assert.strictEqual(refreshResult.total, 3, "应有 3 条知识");
  assert.strictEqual(refreshResult.fresh, 1, "应有 1 条 fresh");
  assert.strictEqual(refreshResult.stale, 1, "应有 1 条 stale");
  assert.strictEqual(refreshResult.unknown, 1, "应有 1 条 unknown");
});

// ---- 场景8: 并发安全 ----
console.log("\n📁 场景8: 并发安全");

await test("并发: 快速连续更新知识不丢数据", async () => {
  const projectDir = path.join(tempDir, "scenario8");
  fs.mkdirSync(projectDir, { recursive: true });

  const file1 = path.join(projectDir, "concurrent.ts");
  fs.writeFileSync(file1, "export const x = 1;", "utf-8");

  const name = testProjectName("scenario8");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "并发测试");

  // 连续更新同一知识
  for (let i = 0; i < 5; i++) {
    addInsight(name, {
      question: "并发测试问题",
      answer: `答案版本 ${i + 1}`,
      category: "feature",
      tags: [`v${i}`],
      relatedFiles: [file1],
      confidence: "high",
      relatedSymbols: [],
      relatedModules: [],
      relatedApis: [],
      fileSnapshots: await createFileSnapshots([file1], projectDir),
    });
  }

  const knowledge = loadKnowledge(name)!;
  assert.strictEqual(knowledge.insights.length, 1, "应只有 1 条知识（合并）");
  assert.strictEqual(knowledge.insights[0].version, 5, "版本应为 5");
  assert.strictEqual(knowledge.insights[0].answer, "答案版本 5", "答案应为最后一次更新");
  assert.ok(knowledge.insights[0].tags.includes("v0"), "应包含早期 tag");
  assert.ok(knowledge.insights[0].tags.includes("v4"), "应包含最新 tag");
});

// ---- 场景9: analyze_impact 风险评分含 stale 加成 ----
console.log("\n📁 场景9: 风险评分 stale 加成");

await test("风险评分: stale 知识增加风险分", async () => {
  const projectDir = path.join(tempDir, "scenario9");
  fs.mkdirSync(projectDir, { recursive: true });

  const sharedFile = path.join(projectDir, "shared.ts");
  fs.writeFileSync(sharedFile, "export const shared = 1;", "utf-8");

  // 创建多个引用文件
  for (let i = 0; i < 5; i++) {
    const f = path.join(projectDir, `use${i}.ts`);
    fs.writeFileSync(f, `import { shared } from './shared';`, "utf-8");
  }

  const name = testProjectName("scenario9");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "风险项目");

  // 记录知识（带快照）
  addInsight(name, {
    question: "shared 模块做什么？",
    answer: "提供共享常量",
    category: "architecture",
    tags: ["shared"],
    relatedFiles: [sharedFile],
    confidence: "high",
    relatedModules: ["shared"],
    relatedApis: [],
    fileSnapshots: await createFileSnapshots([sharedFile], projectDir),
  });

  // 先分析（fresh）
  const result1 = await analyzeImpact(sharedFile, name, projectDir);
  const score1 = result1.risk.score;

  // 修改文件
  fs.writeFileSync(sharedFile, "export const shared = 2; export const extra = 3;", "utf-8");

  // 再分析（stale）
  const result2 = await analyzeImpact(sharedFile, name, projectDir);
  const score2 = result2.risk.score;

  assert.ok(score2 > score1, `stale 后分数应更高: ${score2} > ${score1}`);
  assert.ok(
    result2.risk.reasons.some(r => r.includes("过期")),
    "应包含过期知识原因"
  );
});

// ---- 场景10: 完整端到端流程模拟 ----
console.log("\n📁 场景10: 端到端流程模拟");

await test("端到端: 模拟 AI 回答问题的完整工作流", async () => {
  const projectDir = path.join(tempDir, "scenario-e2e");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });

  // 创建项目文件
  const unitFile = path.join(projectDir, "src", "unit.ts");
  fs.writeFileSync(unitFile, `
export interface Unit {
  id: string;
  name: string;
}

export function getUnits(): Unit[] {
  return [];
}

export function getUnitById(id: string): Unit | null {
  return null;
}
`, "utf-8");

  const pageFile = path.join(projectDir, "src", "unitPage.ts");
  fs.writeFileSync(pageFile, `
import { getUnits, Unit } from './unit';

export function renderUnitPage() {
  const units = getUnits();
  return units;
}
`, "utf-8");

  const name = testProjectName("e2e");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "单位管理项目");

  // === 第一步: AI 搜索知识（没有找到）===
  const search1 = queryInsights(name, { keyword: "单位权限" });
  assert.strictEqual(search1.length, 0, "初始无知识");

  // === 第二步: AI 分析代码并记录知识 ===
  const insight1 = addInsight(name, {
    question: "单位权限逻辑是什么？",
    answer: "通过 unit.ts 的 getUnits 和 getUnitById 管理单位数据，unitPage.ts 渲染单位页面",
    category: "feature",
    tags: ["unit", "permission"],
    relatedFiles: [unitFile, pageFile],
    confidence: "high",
    relatedSymbols: ["getUnits", "getUnitById", "Unit", "renderUnitPage"],
    relatedModules: ["unit"],
    relatedApis: ["/api/units"],
    fileSnapshots: await createFileSnapshots([unitFile, pageFile], projectDir),
  });

  assert.ok(insight1, "应成功记录");
  assert.strictEqual(insight1!.fileSnapshots!.length, 2, "应有 2 个文件快照");

  // === 第三步: 下次搜索 → 找到 + fresh ===
  const search2 = queryInsights(name, { keyword: "单位" });
  assert.strictEqual(search2.length, 1, "应找到 1 条");
  
  const f1 = await checkInsightFreshness(search2[0]);
  assert.strictEqual(f1.status, "fresh", "应为 fresh");

  // === 第四步: 代码变化 ===
  fs.writeFileSync(unitFile, `
export interface Unit {
  id: string;
  name: string;
  permission: string[];
}

export function getUnits(): Unit[] {
  return [];
}

export function getUnitById(id: string): Unit | null {
  return null;
}

export function checkPermission(unitId: string, action: string): boolean {
  return false;
}
`, "utf-8");

  // === 第五步: AI 搜索 → 找到但 stale ===
  const search3 = queryInsights(name, { keyword: "单位" });
  const f2 = await checkInsightFreshness(search3[0]);
  assert.strictEqual(f2.status, "stale", "代码变化后应为 stale");
  assert.ok(f2.changedFiles.length > 0, "应有变化文件");

  // === 第六步: AI 影响分析 ===
  const impact = await analyzeImpact(unitFile, name, projectDir);
  assert.ok(impact.directImpact.length > 0, "应有直接影响");
  assert.ok(impact.relatedInsights.length > 0, "应有关联知识");
  assert.strictEqual(impact.relatedInsights[0].freshness, "stale", "关联知识应为 stale");

  // === 第七步: AI 重新分析并更新知识 ===
  const insight2 = addInsight(name, {
    question: "单位权限逻辑是什么？",
    answer: "通过 unit.ts 的 getUnits/getUnitById 管理单位数据，新增 checkPermission 检查权限。unitPage.ts 渲染单位页面。",
    category: "feature",
    tags: ["unit", "permission"],
    relatedFiles: [unitFile, pageFile],
    confidence: "high",
    relatedSymbols: ["getUnits", "getUnitById", "Unit", "renderUnitPage", "checkPermission"],
    relatedModules: ["unit"],
    relatedApis: ["/api/units"],
    fileSnapshots: await createFileSnapshots([unitFile, pageFile], projectDir),
  });

  assert.strictEqual(insight2!.version, 2, "版本应为 2");
  assert.ok(insight2!.answer.includes("checkPermission"), "答案应包含新功能");

  // === 第八步: 最终验证 ===
  const search4 = queryInsights(name, { keyword: "单位" });
  assert.strictEqual(search4.length, 1, "仍为 1 条");
  
  const f3 = await checkInsightFreshness(search4[0]);
  assert.strictEqual(f3.status, "fresh", "更新后应为 fresh");

  // 项目刷新统计
  const knowledge = loadKnowledge(name)!;
  const refresh = await checkProjectFreshness(knowledge);
  assert.strictEqual(refresh.fresh, 1, "应有 1 条 fresh");
  assert.strictEqual(refresh.stale, 0, "不应有 stale");
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
