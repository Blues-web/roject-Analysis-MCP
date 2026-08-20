import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeWebProject } from "../src/analyzer/project-analyzer.js";
import {
  generateProjectToolRegistry,
  deleteToolRegistry,
} from "../src/registry/tool-registry.js";
import {
  deleteWorkflowRegistry,
  generateProjectWorkflows,
  loadWorkflowRegistry,
} from "../src/workflow/workflow-store.js";
import { deleteKnowledge } from "../src/utils/knowledge-store.js";

const TEST_PREFIX = "_test_workflow_";
const tempDir = path.join(os.tmpdir(), `pam-workflow-generator-${Date.now()}`);
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
    name: "workflow-sample-app",
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
    meta: { title: '计划管理' }
  },
  {
    path: '/plan/create',
    name: 'PlanCreate',
    component: () => import('@/views/plan/create.vue'),
    meta: { title: '创建计划' }
  },
  {
    path: '/plan/approve',
    name: 'PlanApprove',
    component: () => import('@/views/plan/approve.vue'),
    meta: { title: '计划审批' }
  }
];
export default routes;
`);

  writeFile(root, "src/views/plan/index.vue", `
<template>
  <el-form>
    <el-form-item label="计划名称" prop="name" required>
      <el-input v-model="form.name"></el-input>
    </el-form-item>
    <el-button @click="handleCreate">创建计划</el-button>
  </el-form>
</template>
<script>
import { createPlan } from '@/api/plan';
export default {
  data() { return { form: { name: '' } }; },
  methods: {
    handleCreate() {
      createPlan({ name: this.form.name });
    }
  }
};
</script>
`);

  writeFile(root, "src/views/plan/create.vue", `
<template>
  <el-button @click="handleSubmit">提交计划</el-button>
</template>
<script>
export default {
  data() { return { form: { id: '', name: '' } }; },
  methods: {
    handleSubmit() {
      this.$http.post('/plan/submit', { id: this.form.id, name: this.form.name });
    }
  }
};
</script>
`);

  writeFile(root, "src/views/plan/approve.vue", `
<template>
  <el-button @click="handleApprove">通过</el-button>
  <el-button @click="handleReject">驳回</el-button>
</template>
<script>
export default {
  methods: {
    handleApprove() {
      this.$http.post('/plan/approve', { id: this.form.id });
    },
    handleReject() {
      this.$http.post('/plan/reject', { id: this.form.id });
    }
  }
};
</script>
`);

  writeFile(root, "src/api/plan.js", `
import request from '@/utils/request';

export function createPlan(data) {
  return request({ url: '/plan/create', method: 'post', data });
}

export function submitPlan(data) {
  return request({ url: '/plan/submit', method: 'post', data });
}

export function approvePlan(data) {
  return request({ url: '/plan/approve', method: 'post', data });
}

export function rejectPlan(data) {
  return request({ url: '/plan/reject', method: 'post', data });
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
}

async function cleanup(): Promise<void> {
  for (const name of createdProjects) {
    deleteKnowledge(name);
    deleteToolRegistry(name);
    deleteWorkflowRegistry(name);
  }
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("\n🧪 Workflow Generator 测试开始\n");

await test("根据 Tool 组合生成 create_and_submit_plan", async () => {
  const projectDir = path.join(tempDir, "workflow-app");
  createSampleProject(projectDir);
  const name = testProjectName("basic");

  const analysis = await analyzeWebProject(name, projectDir);
  const toolResult = generateProjectToolRegistry(analysis);
  const toolNames = toolResult.registry.tools.map(tool => tool.name);
  assert.ok(toolNames.includes("create_plan"), "应生成 create_plan Tool");
  assert.ok(toolNames.includes("submit_plan"), "应生成 submit_plan Tool");

  const result = generateProjectWorkflows(analysis, toolResult.registry);
  const workflow = result.registry.workflows.find(item => item.name === "create_and_submit_plan");
  assert.ok(workflow, "应生成 create_and_submit_plan");
  assert.ok(
    workflow!.steps.some(step => step.tool === "create_plan"),
    "Workflow 应包含 create_plan 步骤"
  );
  assert.ok(
    workflow!.steps.some(step => step.tool === "submit_plan"),
    "Workflow 应包含 submit_plan 步骤"
  );

  const submitStep = workflow!.steps.find(step => step.tool === "submit_plan")!;
  assert.ok(
    Object.values(submitStep.input || {}).some(value => value === "$plan.id"),
    "submit_plan 应接收 create_plan 输出的 plan.id"
  );
  assert.ok(workflow!.requiredInputs.includes("name"), "requiredInputs 应包含创建计划名称");
  assert.ok(workflow!.triggerExamples.some(example => example.includes("创建")), "应有业务触发示例");
  assert.strictEqual(workflow!.confirmationPolicy, "on_risk");
  assert.ok(workflow!.steps.some(step => step.type === "wait_input"), "应支持暂停等待输入");
  assert.ok(workflow!.steps.some(step => step.type === "continue"), "应支持继续执行");
  assert.ok(workflow!.confidence === "high" || workflow!.confidence === "medium", "Workflow 应包含置信度");
  assert.ok(workflow!.sourceTools.includes("create_plan"), "Workflow 应保留 sourceTools");
  assert.ok(workflow!.sourceTools.includes("submit_plan"), "Workflow 应保留 submit_plan 来源");
  assert.ok(workflow!.sourcePages.length > 0, "Workflow 应保留 sourcePages");

  const loaded = loadWorkflowRegistry(name);
  assert.ok(loaded, "Workflow Registry 应持久化");
  assert.ok(loaded!.workflows.some(item => item.name === "create_and_submit_plan"));
});

await test("审批流程生成条件分支，重复生成保留版本", async () => {
  const projectDir = path.join(tempDir, "workflow-branch");
  createSampleProject(projectDir);
  const name = testProjectName("branch");

  const analysis = await analyzeWebProject(name, projectDir);
  const toolRegistry = generateProjectToolRegistry(analysis).registry;
  const first = generateProjectWorkflows(analysis, toolRegistry);
  const branch = first.registry.workflows.find(item => item.name === "submit_and_approve_or_reject_plan");
  assert.ok(branch, "应生成 submit_and_approve_or_reject_plan 条件流程");
  assert.ok(
    branch!.steps.some(step => step.type === "condition" && step.conditions?.length),
    "Workflow 应包含条件分支"
  );

  const version = branch!.version;
  const second = generateProjectWorkflows(analysis, toolRegistry);
  const secondBranch = second.registry.workflows.find(item => item.name === "submit_and_approve_or_reject_plan")!;
  assert.strictEqual(secondBranch.version, version, "无变更时不应递增版本");
  assert.strictEqual(
    second.registry.workflows.filter(item => item.name === "submit_and_approve_or_reject_plan").length,
    1,
    "重复生成不应产生重复 Workflow"
  );
});

console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
await cleanup();

if (failed > 0) process.exit(1);
