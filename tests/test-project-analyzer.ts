import assert from "node:assert";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  analyzeWebProject,
  getProjectAnalysis,
} from "../src/analyzer/project-analyzer.js";
import { deleteKnowledge } from "../src/utils/knowledge-store.js";
import type { ProjectAnalysis } from "../src/analyzer/types.js";

const TEST_PREFIX = "_test_analyzer_";
const tempDir = path.join(os.tmpdir(), `pam-project-analyzer-${Date.now()}`);
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
    name: "sample-plan-app",
    version: "1.0.0",
    dependencies: {
      vue: "^2.7.0",
      "vue-router": "^3.6.5",
      vuex: "^3.6.2",
      "element-ui": "^2.15.14",
      axios: "^1.6.0",
    },
  }, null, 2));

  writeFile(root, "src/router/index.js", `
import Vue from 'vue';
import VueRouter from 'vue-router';

Vue.use(VueRouter);

const routes = [
  {
    path: '/plan',
    name: 'PlanList',
    component: () => import('@/views/plan/index.vue'),
    meta: { title: '计划管理', permission: 'plan:list' }
  }
];

export default new VueRouter({ routes });
`);

  writeFile(root, "src/views/plan/index.vue", `
<template>
  <!-- 计划管理页面：用于查询和维护巡检计划 -->
  <div class="search-bar">
    <el-input v-model="query.name" placeholder="计划名称"></el-input>
    <el-select v-model="query.status" placeholder="状态"></el-select>
    <el-button type="primary" @click="handleQuery" v-hasPermi="'plan:query'">查询</el-button>
    <el-button type="primary" @click="handleCreate" v-hasPermi="'plan:create'">新增计划</el-button>
    <el-button @click="handleDelete" v-hasPermi="'plan:delete'">删除</el-button>
  </div>
  <el-table :data="list">
    <el-table-column prop="name" label="计划名称"></el-table-column>
    <el-table-column prop="status" label="状态"></el-table-column>
  </el-table>
  <el-form :model="form">
    <el-form-item label="计划名称" prop="name">
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

  writeFile(root, "src/store/modules/plan.js", `
export const planStatusOptions = [
  { label: '草稿', value: 0 },
  { label: '已提交', value: 1 },
  { label: '审批中', value: 2 },
  { label: '已通过', value: 3 },
  { label: '已完成', value: 4 }
];
`);

  writeFile(root, "src/models/plan.ts", `
export interface Plan {
  id: string;
  name: string;
  status: string;
}
`);

  writeFile(root, "src/utils/request.js", `
import axios from 'axios';

const token = localStorage.getItem('token');
const instance = axios.create({
  baseURL: process.env.VUE_APP_BASE_API,
  headers: { Authorization: 'Bearer ' + token }
});

export default instance;
`);

  writeFile(root, "src/utils/token.js", `
export const sessionToken = localStorage.getItem('sessionToken');
export const currentUser = { id: '1', name: 'admin' };
`);
}

async function cleanup(): Promise<void> {
  for (const name of createdProjects) deleteKnowledge(name);
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("\n🧪 Project Analyzer 测试开始\n");

await test("分析 Web 项目并生成 AI 可操作 Project Knowledge", async () => {
  const projectDir = path.join(tempDir, "plan-app");
  createSampleProject(projectDir);
  const name = testProjectName("basic");

  const analysis = await analyzeWebProject(name, projectDir);

  assert.ok(analysis.project.frameworks.includes("Vue"), "应识别 Vue");
  assert.ok(analysis.project.frameworks.includes("Vue Router"), "应识别 Vue Router");
  assert.ok(analysis.project.frameworks.includes("Axios"), "应识别 Axios");
  assert.ok(analysis.project.type === "frontend", "应识别为 frontend");

  const planModule = analysis.modules.find(module => module.id === "plan");
  assert.ok(planModule, "应生成 plan 模块");

  const page = analysis.pages.find(item => item.filePath === "src/views/plan/index.vue");
  assert.ok(page, "应识别计划管理页面");
  assert.strictEqual(page!.route, "/plan");
  assert.ok(page!.queryFields.some(field => field.name === "name"), "应识别查询条件");
  assert.ok(page!.tableFields.some(field => field.name === "status"), "应识别表格字段");
  assert.ok(page!.formFields.some(field => field.name === "name"), "应识别表单字段");
  assert.ok(page!.actions.some(action => action.handler === "handleCreate"), "应识别按钮方法");
  assert.ok(page!.permissions.includes("plan:list"), "应识别页面权限");

  assert.ok(
    analysis.apis.some(api => api.method === "GET" && api.path === "/plan/list"),
    "应识别 GET /plan/list"
  );
  assert.ok(
    analysis.apis.some(api => api.method === "POST" && api.path === "/plan/create"),
    "应识别 POST /plan/create"
  );

  const createCapability = analysis.capabilities.find(cap => cap.name === "create_plan");
  assert.ok(createCapability, "应按业务语言生成 create_plan");
  assert.ok(
    createCapability!.apiIds.some(id => id === stableApiId("POST", "/plan/create")),
    "create_plan 应关联创建计划 API"
  );
  assert.ok(createCapability!.description.includes("创建"), "描述应使用业务语言");

  assert.ok(analysis.entities.some(entity => entity.name === "Plan"), "应识别数据模型");
  assert.ok(analysis.permissions.length > 0, "应识别权限");
  assert.ok(analysis.states.some(state => state.label === "草稿"), "应识别草稿状态");
  assert.ok(analysis.states.some(state => state.label === "已提交"), "应识别已提交状态");
  assert.ok(
    analysis.workflows.some(workflow => workflow.states.includes("草稿") && workflow.states.includes("已提交")),
    "应生成状态流转工作流"
  );

  const saved = getProjectAnalysis(name);
  assert.ok(saved, "Project Knowledge 应持久化");
  assert.strictEqual(saved!.pages.length, analysis.pages.length);
});

await test("再次分析时增量合并，不重复生成已有页面", async () => {
  const projectDir = path.join(tempDir, "plan-incremental");
  createSampleProject(projectDir);
  const name = testProjectName("incremental");

  const first = await analyzeWebProject(name, projectDir);
  const firstPage = first.pages.find(item => item.filePath === "src/views/plan/index.vue");
  assert.ok(firstPage, "首次分析应生成页面");
  const firstCreatedAt = firstPage!.createdAt;

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
      this.$http.post('/plan/create', { name: this.form.name });
    }
  }
};
</script>
`);

  writeFile(projectDir, "src/router/index.js", `
import Vue from 'vue';
import VueRouter from 'vue-router';

Vue.use(VueRouter);

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

export default new VueRouter({ routes });
`);

  const second = await analyzeWebProject(name, projectDir);
  const secondPage = second.pages.find(item => item.filePath === "src/views/plan/index.vue");
  assert.ok(secondPage, "增量分析应保留已有页面");
  assert.strictEqual(secondPage!.createdAt, firstCreatedAt, "已有页面 createdAt 应保留");
  assert.strictEqual(
    second.pages.filter(item => item.filePath === "src/views/plan/index.vue").length,
    1,
    "已有页面不应重复生成"
  );
  assert.ok(
    second.pages.some(item => item.filePath === "src/views/plan/create.vue"),
    "新增页面应被增量识别"
  );
  assert.ok(second.capabilities.some(cap => cap.name === "submit_plan"), "新增页面应生成业务能力");
});

console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
await cleanup();

if (failed > 0) process.exit(1);

function stableApiId(method: string, apiPath: string): string {
  return crypto.createHash("sha1").update(`api::${method}::${apiPath}`.trim().toLowerCase()).digest("hex").slice(0, 14);
}
