import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { analyzeWebProject } from "../src/analyzer/project-analyzer.js";
import { AgentRuntime } from "../src/agent/agent-runtime.js";
import { deleteExecutionLogs, listExecutionLogs } from "../src/agent/log-store.js";
import { deleteSession, loadSession } from "../src/agent/session-store.js";
import {
  deleteToolRegistry,
  generateProjectToolRegistry,
} from "../src/registry/tool-registry.js";
import {
  deleteWorkflowRegistry,
  generateProjectWorkflows,
} from "../src/workflow/workflow-store.js";
import { deleteKnowledge } from "../src/utils/knowledge-store.js";
import type {
  AgentRuntimeConfig,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../src/agent/types.js";
import type { RegisteredTool } from "../src/registry/types.js";

const TEST_PREFIX = "_test_agent_";
const tempDir = path.join(os.tmpdir(), `pam-agent-runtime-${Date.now()}`);
const createdProjects: string[] = [];
const createdSessions: string[] = [];

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
    name: "agent-sample-app",
    version: "1.0.0",
    dependencies: {
      vue: "^2.7.0",
      "vue-router": "^3.6.5",
      axios: "^1.6.0",
    },
  }, null, 2));

  writeFile(root, "src/router/index.js", `
const routes = [
  { path: '/plan', component: () => import('@/views/plan/index.vue'), meta: { title: '计划管理' } },
  { path: '/plan/create', component: () => import('@/views/plan/create.vue'), meta: { title: '创建计划' } },
  { path: '/plan/approve', component: () => import('@/views/plan/approve.vue'), meta: { title: '计划审批' } }
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
    <el-button @click="handleDelete">删除计划</el-button>
  </el-form>
</template>
<script>
import { createPlan, deletePlan } from '@/api/plan';
export default {
  data() { return { form: { name: '' } }; },
  methods: {
    handleCreate() { createPlan({ name: this.form.name }); },
    handleDelete() { deletePlan({ id: this.form.id }); }
  }
};
</script>
`);

  writeFile(root, "src/views/plan/create.vue", `
<template><el-button @click="handleSubmit">提交计划</el-button></template>
<script>
export default {
  data() { return { form: { id: '', name: '' } }; },
  methods: {
    handleSubmit() { this.$http.post('/plan/submit', { id: this.form.id, name: this.form.name }); }
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
    handleApprove() { this.$http.post('/plan/approve', { id: this.form.id }); },
    handleReject() { this.$http.post('/plan/reject', { id: this.form.id }); }
  }
};
</script>
`);

  writeFile(root, "src/api/plan.js", `
import request from '@/utils/request';
export function createPlan(data) { return request({ url: '/plan/create', method: 'post', data }); }
export function deletePlan(data) { return request({ url: '/plan/delete', method: 'post', data }); }
export function submitPlan(data) { return request({ url: '/plan/submit', method: 'post', data }); }
export function approvePlan(data) { return request({ url: '/plan/approve', method: 'post', data }); }
export function rejectPlan(data) { return request({ url: '/plan/reject', method: 'post', data }); }
`);

  writeFile(root, "src/store/modules/plan.js", `
export const planStatusOptions = [
  { label: '草稿', value: 0 },
  { label: '已提交', value: 1 },
  { label: '审批中', value: 2 },
  { label: '已通过', value: 3 }
];
`);
}

class FakeLLM implements LLMProvider {
  private queue: LLMResponse[];
  constructor(...responses: LLMResponse[]) {
    this.queue = responses;
  }
  async chat(_messages: LLMMessage[]): Promise<LLMResponse> {
    return this.queue.shift() || { content: "完成。" };
  }
}

function runtimeConfig(): AgentRuntimeConfig {
  return {
    provider: "fake",
    baseURL: "http://localhost/v1",
    apiKey: "test-key",
    model: "fake-model",
    apiBaseURL: "http://localhost:8080",
    apiToken: "test-token",
  };
}

async function buildRuntime(projectName: string) {
  const projectDir = path.join(tempDir, `${projectName}-dir`);
  createSampleProject(projectDir);
  const analysis = await analyzeWebProject(projectName, projectDir);
  const toolRegistry = generateProjectToolRegistry(analysis).registry;
  const workflowRegistry = generateProjectWorkflows(analysis, toolRegistry).registry;
  return { analysis, toolRegistry, workflowRegistry };
}

async function cleanup(): Promise<void> {
  for (const sessionId of createdSessions) {
    deleteSession(sessionId);
    deleteExecutionLogs(sessionId);
  }
  for (const name of createdProjects) {
    deleteKnowledge(name);
    deleteToolRegistry(name);
    deleteWorkflowRegistry(name);
  }
  if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
}

console.log("\n🧪 Agent Runtime 测试开始\n");

await test("LLM 选择 Tool 并执行、生成自然语言结果", async () => {
  const projectName = testProjectName("tool");
  const { analysis, toolRegistry, workflowRegistry } = await buildRuntime(projectName);
  const provider = new FakeLLM(
    {
      toolCalls: [{
        id: "call_create",
        name: "create_plan",
        arguments: { name: "明日巡检" },
      }],
    },
    { content: "已创建计划，计划 ID 为 plan-1。" }
  );
  const executor = async (tool: RegisteredTool, args: Record<string, unknown>) => ({
    success: true,
    toolName: tool.name,
    data: { id: "plan-1", ...args },
  });
  const runtime = new AgentRuntime({
    config: runtimeConfig(),
    provider,
    analysis,
    toolRegistry,
    workflowRegistry,
    executor,
  });

  const result = await runtime.chat(projectName, "帮我创建一个明天的巡检计划");
  assert.ok(result.executedTools.includes("create_plan"), "应执行 create_plan");
  assert.ok(result.reply.includes("plan-1"), "最终回复应包含执行结果");

  const session = loadSession(result.sessionId)!;
  assert.ok(session.messages.some(message => message.role === "tool"), "会话应包含 Tool 结果");
  createdSessions.push(result.sessionId);
});

await test("高风险 Tool 需要用户确认，确认后继续执行", async () => {
  const projectName = testProjectName("confirm");
  const { analysis, toolRegistry, workflowRegistry } = await buildRuntime(projectName);
  const provider = new FakeLLM(
    {
      toolCalls: [{
        id: "call_delete",
        name: "delete_plan",
        arguments: { id: "plan-1" },
      }],
    },
    { content: "计划已删除。" }
  );
  const executor = async (tool: RegisteredTool) => ({
    success: true,
    toolName: tool.name,
    data: { deleted: true },
  });
  const runtime = new AgentRuntime({
    config: runtimeConfig(),
    provider,
    analysis,
    toolRegistry,
    workflowRegistry,
    executor,
  });

  const first = await runtime.chat(projectName, "删除计划 plan-1");
  assert.ok(first.confirmationRequest === "delete_plan", "高风险 Tool 应要求确认");
  assert.ok(first.pendingAction?.confirm, "应保存待确认动作");

  const second = await runtime.chat(projectName, "确认", first.sessionId);
  assert.ok(second.executedTools.includes("delete_plan"), "确认后应执行 delete_plan");
  assert.ok(second.reply.includes("已删除"), "确认后应生成最终回复");
  createdSessions.push(first.sessionId);
});

await test("LLM 选择 Workflow 并连续执行多个 Tool", async () => {
  const projectName = testProjectName("workflow");
  const { analysis, toolRegistry, workflowRegistry } = await buildRuntime(projectName);
  const provider = new FakeLLM(
    {
      toolCalls: [{
        id: "call_workflow",
        name: "create_and_submit_plan",
        arguments: { name: "明日巡检" },
      }],
    },
    { content: "计划已创建并提交审批。" }
  );
  const calls: string[] = [];
  const executor = async (tool: RegisteredTool, args: Record<string, unknown>) => {
    calls.push(tool.name);
    return {
      success: true,
      toolName: tool.name,
      data: { id: args.id || "plan-1", ...args },
    };
  };
  const runtime = new AgentRuntime({
    config: runtimeConfig(),
    provider,
    analysis,
    toolRegistry,
    workflowRegistry,
    executor,
  });

  const first = await runtime.chat(projectName, "创建一个明天的巡检计划并提交审批");
  assert.ok(first.confirmationRequest === "create_and_submit_plan", "Workflow 应要求确认");

  const second = await runtime.chat(projectName, "确认", first.sessionId);
  assert.ok(second.executedWorkflows.includes("create_and_submit_plan"), "应执行 Workflow");
  assert.ok(calls.includes("create_plan") && calls.includes("submit_plan"), "应连续调用多个 Tool");
  assert.ok(second.reply.includes("提交审批"), "最终回复应包含业务结果");
  assert.ok(listExecutionLogs(second.sessionId).length > 0, "应记录执行日志");
  createdSessions.push(first.sessionId);
});

console.log(`\n测试结果: ${passed} 通过, ${failed} 失败, 共 ${passed + failed} 项\n`);
await cleanup();

if (failed > 0) process.exit(1);
