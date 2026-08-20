import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeWebProject } from "../src/analyzer/project-analyzer.js";
import {
  deleteToolRegistry,
  generateProjectToolRegistry,
  loadToolRegistry,
} from "../src/registry/tool-registry.js";
import { deleteKnowledge } from "../src/utils/knowledge-store.js";

const TEST_PREFIX = "_test_tools_";
const tempDir = path.join(os.tmpdir(), `pam-tool-generator-${Date.now()}`);
const createdProjects: string[] = [];

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (error: any) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${error.message}`);
  }
}

function testProjectName(suffix: string): string {
  const name = `${TEST_PREFIX}${suffix}_${Date.now()}`;
  createdProjects.push(name);
  return name;
}

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf-8");
}

function createSampleProject(root: string): void {
  writeFile(root, "package.json", JSON.stringify({
    name: "tool-sample-app",
    version: "1.0.0",
    dependencies: {
      vue: "^2.7.0",
      "vue-router": "^3.6.5",
      axios: "^1.6.0",
    },
  }, null, 2));

  writeFile(root, "src/router/index.js", `
const routes = [
  {
    path: '/plan',
    name: 'PlanList',
    component: () => import('@/views/plan/index.vue'),
    meta: { title: '计划管理', permission: 'plan:list' }
  }
];
export default routes;
`);

  writeFile(root, "src/views/plan/index.vue", `
<template>
  <div class="search-bar">
    <el-input v-model="query.name" placeholder="计划名称"></el-input>
    <el-button type="primary" @click="handleQuery" v-hasPermi="'plan:query'">查询</el-button>
    <el-button type="primary" @click="handleCreate" v-hasPermi="'plan:create'">新增计划</el-button>
    <el-button @click="handleDelete" v-hasPermi="'plan:delete'">删除计划</el-button>
  </div>
  <el-table :data="list">
    <el-table-column prop="name" label="计划名称"></el-table-column>
    <el-table-column prop="status" label="状态"></el-table-column>
  </el-table>
  <el-form :model="form">
    <el-form-item label="计划名称" prop="name" required>
      <el-input v-model="form.name"></el-input>
    </el-form-item>
  </el-form>
</template>
<script>
import { createPlan } from '@/api/plan';
export default {
  data() {
    return {
      list: [],
      query: { name: '', status: '' },
      form: { name: '' }
    };
  },
  methods: {
    handleQuery() {
      this.$http.get('/plan/list', { params: { name: this.query.name, status: this.query.status } });
    },
    handleCreate() {
      createPlan({ name: this.form.name });
    },
    handleDelete() {
      this.$http.post('/plan/delete', { id: this.form.id });
    }
  }
};
</script>
`);

  writeFile(root, "src/api/plan.js", `
import request from '@/utils/request';

export function getPlanList(params) {
  return request({ url: '/plan/list', method: 'get', params });
}

export function createPlan(data) {
  return request({ url: '/plan/create', method: 'post', data });
}

export function deletePlan(data) {
  return request({ url: '/plan/delete', method: 'post', data });
}
`);
}

async function cleanup(): Promise<void> {
  for (const name of createdProjects) {
    deleteKnowledge(name);
    deleteToolRegistry(name);
  }
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("\n🧪 Tool Generator / Registry 测试开始\n");

await test("从业务能力生成 Tool 并写入 Registry", async () => {
  const projectDir = path.join(tempDir, "tool-app");
  createSampleProject(projectDir);
  const name = testProjectName("basic");
  const analysis = await analyzeWebProject(name, projectDir);

  const result = generateProjectToolRegistry(analysis);
  const registry = result.registry;

  const names = registry.tools.map(tool => tool.name);
  assert.ok(names.includes("query_plan"), "应生成 query_plan");
  assert.ok(names.includes("create_plan"), "应生成 create_plan");
  assert.ok(names.includes("delete_plan"), "应生成 delete_plan");

  const createTool = registry.tools.find(tool => tool.name === "create_plan")!;
  assert.ok(createTool, "应存在 create_plan");
  assert.strictEqual(createTool.apiMapping.method, "POST");
  assert.strictEqual(createTool.apiMapping.path, "/plan/create");
  assert.strictEqual(createTool.riskLevel, "low");
  assert.strictEqual(createTool.requiresConfirmation, false);
  assert.ok(["high", "medium"].includes(createTool.confidence), "Tool 应包含来源置信度");
  assert.ok(createTool.inputSchema.properties?.name, "inputSchema 应包含页面表单字段 name");
  assert.strictEqual(createTool.permission, "plan:create");
  assert.ok(createTool.relatedPages.some(page => page.route === "/plan"), "应关联页面");
  assert.ok(createTool.sourceFiles.length > 0, "应保留 sourceFiles");
  assert.ok(createTool.sourceApis.some(api => api.path === "/plan/create"), "应保留 sourceApis");
  assert.ok(createTool.sourcePages.some(page => page.route === "/plan"), "应保留 sourcePages");
  assert.ok(createTool.sourceMethods.length > 0, "应保留 sourceMethods");
  assert.ok(createTool.businessPurpose.includes("创建"), "应包含业务目的");

  const deleteTool = registry.tools.find(tool => tool.name === "delete_plan")!;
  assert.strictEqual(deleteTool.riskLevel, "high");
  assert.strictEqual(deleteTool.requiresConfirmation, true);

  const queryTool = registry.tools.find(tool => tool.name === "query_plan")!;
  assert.strictEqual(queryTool.riskLevel, "read");
  assert.strictEqual(queryTool.requiresConfirmation, false);
  assert.strictEqual(queryTool.apiMapping.method, "GET");

  const loaded = loadToolRegistry(name);
  assert.ok(loaded, "Tool Registry 应持久化");
  assert.strictEqual(loaded!.tools.length, registry.tools.length);
});

await test("重复生成保留版本，新增能力增量注册", async () => {
  const projectDir = path.join(tempDir, "tool-incremental");
  createSampleProject(projectDir);
  const name = testProjectName("incremental");

  const firstAnalysis = await analyzeWebProject(name, projectDir);
  generateProjectToolRegistry(firstAnalysis);
  const firstCreate = loadToolRegistry(name)!.tools.find(tool => tool.name === "create_plan")!;
  assert.strictEqual(firstCreate.version, 1);

  generateProjectToolRegistry(firstAnalysis);
  const secondCreate = loadToolRegistry(name)!.tools.find(tool => tool.name === "create_plan")!;
  assert.strictEqual(secondCreate.version, 1, "无变更时不应递增版本");

  writeFile(projectDir, "src/views/plan/create.vue", `
<template>
  <el-form :model="form">
    <el-form-item label="计划名称" prop="name">
      <el-input v-model="form.name"></el-input>
    </el-form-item>
    <el-button @click="handleSubmit">提交计划</el-button>
  </el-form>
</template>
<script>
export default {
  data() { return { form: { name: '' } }; },
  methods: {
    handleSubmit() {
      this.$http.post('/plan/submit', { id: this.form.id, name: this.form.name });
    }
  }
};
</script>
`);

  writeFile(projectDir, "src/router/index.js", `
const routes = [
  {
    path: '/plan',
    name: 'PlanList',
    component: () => import('@/views/plan/index.vue'),
    meta: { title: '计划管理', permission: 'plan:list' }
  },
  {
    path: '/plan/create',
    name: 'PlanCreate',
    component: () => import('@/views/plan/create.vue'),
    meta: { title: '创建计划' }
  }
];
export default routes;
`);

  const secondAnalysis = await analyzeWebProject(name, projectDir);
  generateProjectToolRegistry(secondAnalysis);
  const registry = loadToolRegistry(name)!;
  assert.ok(registry.tools.some(tool => tool.name === "submit_plan"), "新增能力应增量注册");
  const createAfter = registry.tools.find(tool => tool.name === "create_plan")!;
  assert.strictEqual(createAfter.version, 1, "未变更的 Tool 应保持版本");
});

console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
await cleanup();

if (failed > 0) process.exit(1);
