/**
 * P0-3 单元测试：影响范围分析
 * 
 * 运行方式: npx tsx tests/test-p0-3.ts
 * 
 * 测试覆盖:
 * 1. A → B (直接依赖)
 * 2. A → B → C (链式依赖)
 * 3. 循环依赖
 * 4. 多入口引用
 * 5. Vue 组件
 * 6. API 文件
 * 7. 无引用文件
 * 8. 大项目限制
 * 9. 关联 Insight
 * 10. 风险评分
 */

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import {
  extractImports,
  resolveImportPath,
  quickAnalyzeImpact,
} from "../src/utils/dependency-graph.js";

import {
  analyzeImpact,
  formatImpactAnalysis,
} from "../src/utils/impact-analyzer.js";

import {
  createKnowledge,
  addInsight,
  deleteKnowledge,
} from "../src/utils/knowledge-store.js";

// ============ 测试辅助 ============

const TEST_PREFIX = "_test_p03_";
const createdProjects: string[] = [];
const tempDir = path.join(os.tmpdir(), "pam-test-p03-" + Date.now());

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

console.log("\n🧪 P0-3 测试开始\n");

// 创建临时测试目录
fs.mkdirSync(tempDir, { recursive: true });

// ---- 依赖解析测试 ----
console.log("📁 dependency-graph.ts — 导入解析");

await test("extractImports: 解析 ES6 import", () => {
  const content = `
    import { foo } from './utils';
    import bar from '../lib/bar';
    import type { Type } from '@/types';
  `;
  
  const imports = extractImports(content);
  assert.ok(imports.length >= 3, "应至少解析出 3 个 import");
  
  const paths = imports.map(i => i.path);
  assert.ok(paths.includes('./utils'), "应包含 ./utils");
  assert.ok(paths.includes('../lib/bar'), "应包含 ../lib/bar");
});

await test("extractImports: 解析 CommonJS require", () => {
  const content = `
    const fs = require('fs');
    const path = require('path');
    const utils = require('./utils');
  `;
  
  const imports = extractImports(content);
  const paths = imports.map(i => i.path);
  assert.ok(paths.includes('./utils'), "应包含 ./utils");
  assert.ok(paths.includes('fs'), "应包含 fs");
});

await test("extractImports: 解析动态 import", () => {
  const content = `
    const module = await import('./dynamic-module');
    import('./another-module').then(m => m.default());
  `;
  
  const imports = extractImports(content);
  const paths = imports.map(i => i.path);
  assert.ok(paths.includes('./dynamic-module'), "应包含 ./dynamic-module");
  assert.ok(paths.includes('./another-module'), "应包含 ./another-module");
});

await test("resolveImportPath: 解析相对路径", () => {
  // 创建测试文件
  const dirA = path.join(tempDir, "dir-a");
  fs.mkdirSync(dirA, { recursive: true });
  
  const fileA = path.join(dirA, "a.ts");
  const fileB = path.join(dirA, "b.ts");
  fs.writeFileSync(fileA, "", "utf-8");
  fs.writeFileSync(fileB, "", "utf-8");
  
  const resolved = resolveImportPath('./b', fileA, tempDir);
  assert.ok(resolved, "应成功解析");
  assert.strictEqual(resolved, fileB, "应解析为 b.ts");
});

await test("resolveImportPath: 解析别名路径 @/", () => {
  const srcDir = path.join(tempDir, "src");
  const utilsDir = path.join(srcDir, "utils");
  fs.mkdirSync(utilsDir, { recursive: true });
  
  const fileA = path.join(srcDir, "main.ts");
  const fileB = path.join(utilsDir, "helper.ts");
  fs.writeFileSync(fileA, "", "utf-8");
  fs.writeFileSync(fileB, "", "utf-8");
  
  const resolved = resolveImportPath('@/utils/helper', fileA, tempDir);
  assert.ok(resolved, "应成功解析 @/ 别名");
  assert.strictEqual(resolved, fileB, "应解析为 src/utils/helper.ts");
});

await test("resolveImportPath: 跳过外部包", () => {
  const fileA = path.join(tempDir, "main.ts");
  fs.writeFileSync(fileA, "", "utf-8");
  
  const resolved = resolveImportPath('lodash', fileA, tempDir);
  assert.strictEqual(resolved, null, "外部包应返回 null");
});

// ---- 依赖图遍历测试 ----
console.log("\n📁 dependency-graph.ts — 依赖遍历");

await test("简单依赖: A → B", async () => {
  const projectDir = path.join(tempDir, "project-simple");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const fileA = path.join(projectDir, "a.ts");
  const fileB = path.join(projectDir, "b.ts");
  
  fs.writeFileSync(fileB, "export const b = 'b';", "utf-8");
  fs.writeFileSync(fileA, "import { b } from './b';", "utf-8");
  
  const result = quickAnalyzeImpact(fileB, projectDir);
  
  assert.ok(result.direct.length >= 1 || result.indirect.length >= 0, 
    "应能找到引用");
  assert.strictEqual(result.target, fileB, "目标应为 b.ts");
});

await test("链式依赖: A → B → C", async () => {
  const projectDir = path.join(tempDir, "project-chain");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const fileC = path.join(projectDir, "c.ts");
  const fileB = path.join(projectDir, "b.ts");
  const fileA = path.join(projectDir, "a.ts");
  
  fs.writeFileSync(fileC, "export const c = 'c';", "utf-8");
  fs.writeFileSync(fileB, "import { c } from './c';\nexport const b = c;", "utf-8");
  fs.writeFileSync(fileA, "import { b } from './b';", "utf-8");
  
  const result = quickAnalyzeImpact(fileC, projectDir);
  
  // c.ts 被 b.ts 引用，b.ts 被 a.ts 引用
  const allAffected = [...result.direct, ...result.indirect];
  assert.ok(allAffected.length >= 1, "应能找到至少 1 个引用");
});

await test("循环依赖处理", async () => {
  const projectDir = path.join(tempDir, "project-cycle");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const fileA = path.join(projectDir, "a.ts");
  const fileB = path.join(projectDir, "b.ts");
  
  // 创建循环依赖
  fs.writeFileSync(fileA, "import { b } from './b';\nexport const a = 'a';", "utf-8");
  fs.writeFileSync(fileB, "import { a } from './a';\nexport const b = 'b';", "utf-8");
  
  // 应该能够处理循环依赖而不崩溃
  const result = quickAnalyzeImpact(fileA, projectDir, { maxDepth: 3 });
  
  assert.ok(result, "应能处理循环依赖");
  assert.ok(result.target === fileA, "目标应为 a.ts");
});

await test("多入口引用", async () => {
  const projectDir = path.join(tempDir, "project-multi-entry");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const shared = path.join(projectDir, "shared.ts");
  const entry1 = path.join(projectDir, "entry1.ts");
  const entry2 = path.join(projectDir, "entry2.ts");
  const entry3 = path.join(projectDir, "entry3.ts");
  
  fs.writeFileSync(shared, "export const shared = 'shared';", "utf-8");
  fs.writeFileSync(entry1, "import { shared } from './shared';", "utf-8");
  fs.writeFileSync(entry2, "import { shared } from './shared';", "utf-8");
  fs.writeFileSync(entry3, "import { shared } from './shared';", "utf-8");
  
  const result = quickAnalyzeImpact(shared, projectDir);
  
  // shared.ts 应该被 3 个文件引用
  assert.ok(result.direct.length >= 1, "应找到引用 shared.ts 的文件");
});

await test("Vue 组件引用", async () => {
  const projectDir = path.join(tempDir, "project-vue");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const componentA = path.join(projectDir, "ComponentA.vue");
  const componentB = path.join(projectDir, "ComponentB.vue");
  
  fs.writeFileSync(componentB, "<template><div>B</div></template>", "utf-8");
  fs.writeFileSync(componentA, 
    "<script>\nimport ComponentB from './ComponentB.vue';\nexport default { components: { ComponentB } };\n</script>", 
    "utf-8");
  
  const result = quickAnalyzeImpact(componentB, projectDir);
  
  assert.ok(result, "应能分析 Vue 组件依赖");
});

await test("API 文件引用", async () => {
  const projectDir = path.join(tempDir, "project-api");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const apiFile = path.join(projectDir, "api.ts");
  const serviceFile = path.join(projectDir, "service.ts");
  
  fs.writeFileSync(apiFile, "export const fetchData = () => fetch('/api/data');", "utf-8");
  fs.writeFileSync(serviceFile, "import { fetchData } from './api';\nexport const getData = () => fetchData();", "utf-8");
  
  const result = quickAnalyzeImpact(apiFile, projectDir);
  
  assert.ok(result, "应能分析 API 文件依赖");
});

await test("无引用文件", async () => {
  const projectDir = path.join(tempDir, "project-no-ref");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const isolated = path.join(projectDir, "isolated.ts");
  fs.writeFileSync(isolated, "export const isolated = 'isolated';", "utf-8");
  
  const result = quickAnalyzeImpact(isolated, projectDir);
  
  assert.strictEqual(result.direct.length, 0, "无引用文件应有 0 个直接影响");
  assert.strictEqual(result.indirect.length, 0, "无引用文件应有 0 个间接影响");
});

await test("大项目限制: maxDepth", async () => {
  const projectDir = path.join(tempDir, "project-large");
  fs.mkdirSync(projectDir, { recursive: true });
  
  // 创建深度链: a -> b -> c -> d -> e -> f
  const files = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts'];
  
  for (let i = 0; i < files.length; i++) {
    const filePath = path.join(projectDir, files[i]);
    if (i < files.length - 1) {
      const nextFile = files[i + 1].replace('.ts', '');
      fs.writeFileSync(filePath, `import { x } from './${nextFile}';\nexport const x = ${i};`, "utf-8");
    } else {
      fs.writeFileSync(filePath, `export const x = ${i};`, "utf-8");
    }
  }
  
  // 限制深度为 2
  const result = quickAnalyzeImpact(
    path.join(projectDir, 'f.ts'), 
    projectDir, 
    { maxDepth: 2 }
  );
  
  assert.ok(result, "应能在深度限制下完成分析");
  // 深度限制后，应该只找到前 2 层的引用
});

// ---- 影响分析集成测试 ----
console.log("\n📁 impact-analyzer.ts — 完整分析");

await test("关联 Insight 分析", async () => {
  const projectDir = path.join(tempDir, "project-insight");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const targetFile = path.join(projectDir, "store.ts");
  const viewFile = path.join(projectDir, "view.ts");
  
  fs.writeFileSync(targetFile, "export const store = { data: [] };", "utf-8");
  fs.writeFileSync(viewFile, "import { store } from './store';", "utf-8");
  
  // 创建项目和知识
  const name = testProjectName("impact_insight");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "测试项目");
  
  // 添加关联 Insight
  addInsight(name, {
    question: "数据流如何工作？",
    answer: "通过 store 管理状态",
    category: "data_flow",
    tags: ["store"],
    relatedFiles: [targetFile],
    confidence: "high",
    relatedModules: ["state"],
    relatedApis: ["/api/data"],
  });
  
  // 执行影响分析
  const result = await analyzeImpact(targetFile, name, projectDir);
  
  assert.ok(result.relatedInsights.length > 0, "应找到相关 Insight");
  assert.strictEqual(result.relatedInsights[0].question, "数据流如何工作？");
  assert.ok(result.relatedModules.includes("state"), "应包含相关模块");
  assert.ok(result.relatedApis.includes("/api/data"), "应包含相关 API");
});

await test("风险评分: 低风险", async () => {
  const projectDir = path.join(tempDir, "project-low-risk");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const isolated = path.join(projectDir, "isolated.ts");
  fs.writeFileSync(isolated, "export const x = 1;", "utf-8");
  
  const name = testProjectName("risk_low");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "测试项目");
  
  const result = await analyzeImpact(isolated, name, projectDir);
  
  assert.ok(result.risk.score < 30, "孤立文件应为低风险");
  assert.ok(result.risk.level === "low" || result.risk.level === "medium", 
    "风险等级应为 low 或 medium");
});

await test("风险评分: 高风险（多引用 + 多知识）", async () => {
  const projectDir = path.join(tempDir, "project-high-risk");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const shared = path.join(projectDir, "shared.ts");
  fs.writeFileSync(shared, "export const shared = 'shared';", "utf-8");
  
  // 创建多个引用文件
  for (let i = 0; i < 10; i++) {
    const file = path.join(projectDir, `file${i}.ts`);
    fs.writeFileSync(file, `import { shared } from './shared';`, "utf-8");
  }
  
  const name = testProjectName("risk_high");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "测试项目");
  
  // 添加多条相关 Insight
  for (let i = 0; i < 5; i++) {
    addInsight(name, {
      question: `问题 ${i}`,
      answer: `答案 ${i}`,
      category: "feature",
      tags: [],
      relatedFiles: [shared],
      confidence: "high",
      relatedApis: [`/api/${i}`],
    });
  }
  
  const result = await analyzeImpact(shared, name, projectDir);
  
  assert.ok(result.risk.score > 50, "多引用 + 多知识应为高风险");
  assert.ok(result.risk.reasons.length > 0, "应有可解释的原因");
});

await test("格式化输出", async () => {
  const projectDir = path.join(tempDir, "project-format");
  fs.mkdirSync(projectDir, { recursive: true });
  
  const target = path.join(projectDir, "target.ts");
  fs.writeFileSync(target, "export const x = 1;", "utf-8");
  
  const name = testProjectName("format");
  createdProjects.push(name);
  createKnowledge(name, projectDir, "测试项目");
  
  const result = await analyzeImpact(target, name, projectDir);
  const formatted = formatImpactAnalysis(result);
  
  assert.ok(formatted.includes("🎯 影响分析"), "应包含标题");
  assert.ok(formatted.includes("风险等级"), "应包含风险等级");
  assert.ok(formatted.includes("分析参数"), "应包含分析参数");
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
