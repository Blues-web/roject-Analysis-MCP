import crypto from "node:crypto";
import type { ProjectAnalysis } from "../analyzer/types.js";
import type {
  RegisteredTool,
  ToolRegistry,
} from "../registry/types.js";
import { stableId, unique } from "../analyzer/utils.js";
import type {
  ConfirmationPolicy,
  WorkflowDefinition,
  WorkflowRegistry,
  WorkflowStep,
} from "./types.js";

export interface GenerateWorkflowOptions {
  moduleIds?: string[];
}

interface ToolCandidate {
  role: string;
  tool: RegisteredTool;
  entity: string;
}

interface WorkflowCandidate {
  name: string;
  moduleId: string;
  moduleName: string;
  entity: string;
  tools: ToolCandidate[];
  source: "state" | "pattern" | "page";
}

function now(): string {
  return new Date().toISOString();
}

function toolRole(name: string): string {
  if (/^(create|new|add|save|register)/.test(name)) return "create";
  if (/^(submit|publish|report|commit)/.test(name)) return "submit";
  if (/^(approve|audit|review|pass|agree)/.test(name)) return "approve";
  if (/^(reject|refuse|back)/.test(name)) return "reject";
  if (/^(update|edit|modify|change)/.test(name)) return "update";
  if (/^(delete|remove|cancel|revoke)/.test(name)) return "delete";
  if (/^(export|download)/.test(name)) return "export";
  if (/^(query|search|list|view|detail)/.test(name)) return "query";
  return "operate";
}

function entityFromToolName(name: string): string {
  const parts = name.split("_");
  return parts.slice(1).join("_") || "business";
}

function activeTools(registry: ToolRegistry): RegisteredTool[] {
  return registry.tools.filter(tool => tool.status === "active");
}

function groupTools(
  registry: ToolRegistry
): Map<string, Map<string, RegisteredTool>> {
  const byEntity = new Map<string, Map<string, RegisteredTool>>();
  for (const tool of activeTools(registry)) {
    const entity = entityFromToolName(tool.name);
    const roleMap = byEntity.get(entity) || new Map<string, RegisteredTool>();
    roleMap.set(toolRole(tool.name), tool);
    byEntity.set(entity, roleMap);
  }
  return byEntity;
}

function findToolByRole(
  entity: string,
  role: string,
  groups: Map<string, Map<string, RegisteredTool>>
): RegisteredTool | undefined {
  return groups.get(entity)?.get(role);
}

function workflowName(roles: string[], entity: string): string {
  const filtered = roles
    .filter(role => !["operate", "query"].includes(role))
    .map(role => role);
  const hasApprove = filtered.includes("approve");
  const hasReject = filtered.includes("reject");
  if (hasApprove && hasReject) {
    const withoutBranch = filtered.filter(role => role !== "approve" && role !== "reject");
    withoutBranch.push("approve_or_reject");
    const readable = withoutBranch.join("_and_");
    return `${readable}_${entity}`;
  }
  const readable = filtered.join("_and_");
  if (!readable) return `process_${entity}`;
  return `${readable}_${entity}`;
}

function candidateFromRoles(
  moduleId: string,
  moduleName: string,
  entity: string,
  roles: string[],
  groups: Map<string, Map<string, RegisteredTool>>,
  source: WorkflowCandidate["source"]
): WorkflowCandidate | null {
  const tools: ToolCandidate[] = [];
  for (const role of roles) {
    const tool = findToolByRole(entity, role, groups);
    if (!tool) return null;
    tools.push({ role, tool, entity });
  }
  return {
    name: workflowName(roles, entity),
    moduleId,
    moduleName,
    entity,
    tools,
    source,
  };
}

function collectCandidates(
  analysis: ProjectAnalysis,
  registry: ToolRegistry
): WorkflowCandidate[] {
  const candidates: WorkflowCandidate[] = [];
  const seen = new Set<string>();
  const groups = groupTools(registry);

  function addCandidate(candidate: WorkflowCandidate | null): void {
    if (!candidate) return;
    const key = candidate.tools.map(item => item.tool.name).join("->");
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push(candidate);
  }

  for (const entity of groups.keys()) {
    const roleMap = groups.get(entity)!;
    const create = roleMap.get("create");
    const submit = roleMap.get("submit");
    const approve = roleMap.get("approve");
    const reject = roleMap.get("reject");
    const update = roleMap.get("update");
    const deleteTool = roleMap.get("delete");
    const query = roleMap.get("query");
    const firstTool = create || submit || approve || reject || update || deleteTool || query;
    const module = analysis.modules.find(item => item.id === entity)
      || (firstTool ? analysis.modules.find(item => item.id === firstTool.moduleId) : undefined);
    const moduleId = module?.id || firstTool?.moduleId || entity;
    const moduleName = module?.name || firstTool?.module || entity;

    if (create && submit) {
      addCandidate(candidateFromRoles(moduleId, moduleName, entity, ["create", "submit"], groups, "pattern"));
    }
    if (submit && approve && reject) {
      addCandidate(candidateFromRoles(moduleId, moduleName, entity, ["submit", "approve", "reject"], groups, "pattern"));
    }
    if (create && submit && approve) {
      addCandidate(candidateFromRoles(moduleId, moduleName, entity, ["create", "submit", "approve"], groups, "pattern"));
    }
    if (query && exportTool(entity, groups)) {
      addCandidate(candidateFromRoles(moduleId, moduleName, entity, ["query", "export"], groups, "pattern"));
    }
    if (query && deleteTool) {
      addCandidate(candidateFromRoles(moduleId, moduleName, entity, ["query", "delete"], groups, "pattern"));
    }
    if (create && update && submit) {
      addCandidate(candidateFromRoles(moduleId, moduleName, entity, ["create", "update", "submit"], groups, "pattern"));
    }
  }

  // 状态流转：把 create/submit/approve 映射到已有 Tool 序列
  for (const stateWorkflow of analysis.workflows) {
    const entity = firstEntity(groups);
    if (!entity) continue;
    const module = analysis.modules.find(item => item.id === entity)
      || analysis.modules.find(item => item.id === stateWorkflow.moduleId);
    const moduleId = module?.id || entity;
    const moduleName = module?.name || entity;
    const tools: ToolCandidate[] = [];
    if (/草稿|新建|待提交/.test(stateWorkflow.states[0] || "")) {
      const create = findToolByRole(entity, "create", groups);
      if (create) tools.push({ role: "create", tool: create, entity });
    }
    for (const transition of stateWorkflow.transitions) {
      const role = transition.action === "submit"
        ? "submit"
        : transition.action === "approve"
          ? "approve"
          : transition.action === "reject"
            ? "reject"
            : undefined;
      if (!role) continue;
      const tool = findToolByRole(entity, role, groups);
      if (!tool) continue;
      if (tools.some(item => item.tool.id === tool.id)) continue;
      tools.push({ role, tool, entity });
    }
    if (tools.length >= 2) {
      addCandidate({
        name: workflowName(tools.map(item => item.role), entity),
        moduleId,
        moduleName,
        entity,
        tools,
        source: "state",
      });
    }
  }

  // 页面按钮顺序
  for (const page of analysis.pages) {
    const tools: ToolCandidate[] = [];
    for (const action of page.actions) {
      const capability = analysis.capabilities.find(item => item.id === action.capabilityId);
      if (!capability) continue;
      const registered = activeTools(registry).find(tool =>
        tool.sourceCapabilityId === capability.id
      );
      if (!registered) continue;
      const role = toolRole(registered.name);
      if (["operate", "query"].includes(role)) continue;
      if (!tools.some(item => item.tool.id === registered.id)) {
        tools.push({ role, tool: registered, entity: entityFromToolName(registered.name) });
      }
    }
    if (tools.length >= 2) {
      const entity = tools[0].entity;
      const module = analysis.modules.find(item => item.id === entity)
        || analysis.modules.find(item => item.id === page.moduleId);
      const moduleId = module?.id || entity;
      const moduleName = module?.name || page.moduleId;
      addCandidate({
        name: workflowName(tools.map(item => item.role), entity),
        moduleId,
        moduleName,
        entity,
        tools,
        source: "page",
      });
    }
  }

  return candidates.sort((a, b) => a.name.localeCompare(b.name));
}

function exportTool(
  entity: string,
  groups: Map<string, Map<string, RegisteredTool>>
): RegisteredTool | undefined {
  return groups.get(entity)?.get("export");
}

function firstEntity(groups: Map<string, Map<string, RegisteredTool>>): string | undefined {
  const entities = Array.from(groups.keys());
  return entities.find(item => item !== "business") || entities[0];
}

function outputFields(tool: RegisteredTool): string[] {
  const fields: string[] = [];
  const output = tool.outputSchema;
  const data = output.properties?.data;
  if (!data) return fields;
  const list = data.properties?.list?.items?.properties;
  if (list) fields.push(...Object.keys(list));
  const object = data.properties?.data?.properties;
  if (object) fields.push(...Object.keys(object));
  for (const property of Object.values(data.properties || {})) {
    if (property.type === "object" && property.properties) {
      fields.push(...Object.keys(property.properties));
    }
  }
  if (fields.length === 0 && data.properties) fields.push(...Object.keys(data.properties));
  return unique(fields);
}

function previousOutputVar(candidate: WorkflowCandidate, index: number): string {
  return candidate.tools[index]?.entity || "entity";
}

function mapInput(
  tool: RegisteredTool,
  previousSteps: Array<{ entity: string; tool: RegisteredTool }>,
  entity: string
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const required = tool.inputSchema.required || [];
  const properties = Object.keys(tool.inputSchema.properties || {});
  for (const param of properties) {
    if (param.startsWith("_")) continue;
    let expression: string | undefined;
    const paramLower = param.toLowerCase();
    for (const previous of previousSteps) {
      const fields = outputFields(previous.tool);
      if (
        paramLower === "id" ||
        paramLower === `${previous.entity}id` ||
        paramLower === `${previous.entity}_id` ||
        fields.includes(param)
      ) {
        expression = `$${previous.entity}.${paramLower === "id" || paramLower === `${previous.entity}id` || paramLower === `${previous.entity}_id` ? "id" : param}`;
        break;
      }
    }
    if (expression) {
      input[param] = expression;
    } else {
      input[param] = required.includes(param) ? `$input.${param}` : `$input.${param}`;
    }
  }
  return input;
}

function triggerExamples(name: string, entity: string): string[] {
  if (name.includes("create_and_submit")) {
    return [
      `创建一个${entity}并提交审批`,
      `创建${entity}后直接提交`,
    ];
  }
  if (name.includes("approve_or_reject")) {
    return [
      `提交${entity}并审批`,
      `处理${entity}审批`,
    ];
  }
  if (name.includes("query_and_export")) {
    return [
      `查询${entity}并导出`,
      `导出${entity}列表`,
    ];
  }
  if (name.includes("query_and_delete")) {
    return [
      `查询并删除${entity}`,
      `处理${entity}删除`,
    ];
  }
  return [
    `执行${name}`,
    `完成${name}流程`,
  ];
}

function buildSteps(
  candidate: WorkflowCandidate
): {
  steps: WorkflowStep[];
  requiredInputs: string[];
} {
  const requiredInputs: string[] = [];
  const previousSteps: Array<{ entity: string; tool: RegisteredTool }> = [];
  const hasBranch = candidate.tools.some(item => item.role === "approve") &&
    candidate.tools.some(item => item.role === "reject");
  const branchStart = hasBranch
    ? candidate.tools.findIndex(item => ["approve", "reject"].includes(item.role))
    : -1;

  const waitStep: WorkflowStep = {
    id: "wait_input",
    type: "wait_input",
    name: `补充${candidate.entity}信息`,
    description: "等待用户补齐执行工作流所需的业务参数",
    waitFor: [],
    onContinue: "continue_execution",
    next: "continue_execution",
  };
  const continueStep: WorkflowStep = {
    id: "continue_execution",
    type: "continue",
    name: "继续执行",
    description: "用户确认参数后继续执行后续步骤",
    onContinue: undefined,
  };
  const steps: WorkflowStep[] = [waitStep, continueStep];
  let previousStepId = continueStep.id;

  const toolStepById = new Map<string, WorkflowStep>();
  for (let index = 0; index < candidate.tools.length; index++) {
    const item = candidate.tools[index];
    const tool = item.tool;
    const input = mapInput(tool, previousSteps, candidate.entity);
    for (const required of tool.inputSchema.required || []) {
      if (!Object.values(input).some(value => String(value).startsWith(`$${candidate.entity}.`)) && !requiredInputs.includes(required)) {
        requiredInputs.push(required);
      }
    }

    const toolStep: WorkflowStep = {
      id: `step_${index + 1}_${tool.name}`,
      type: "tool",
      name: tool.name,
      description: tool.description,
      tool: tool.name,
      output: item.entity,
      input,
      requiredInputs: tool.inputSchema.required,
      failure: {
        onError: tool.riskLevel === "read" ? "continue" : "stop",
        retryCount: tool.riskLevel === "read" ? 0 : 1,
      },
    };
    toolStepById.set(toolStep.id, toolStep);
    previousSteps.push({ entity: item.entity, tool });
  }

  function appendToolStep(index: number, wirePrevious: boolean): string {
    const item = candidate.tools[index];
    const tool = item.tool;
    const toolStep = toolStepById.get(`step_${index + 1}_${tool.name}`)!;
    if (tool.requiresConfirmation) {
      const confirmStep: WorkflowStep = {
        id: `confirm_${tool.name}`,
        type: "confirm",
        name: `确认${tool.name}`,
        description: `执行 ${tool.name} 前需要用户确认`,
        confirmationMessage: `即将调用 ${tool.name}，请确认执行。`,
        next: toolStep.id,
      };
      steps.push(confirmStep);
      steps.push(toolStep);
      if (wirePrevious) {
        const previous = steps.find(step => step.id === previousStepId);
        if (previous) previous.next = confirmStep.id;
      }
    } else {
      steps.push(toolStep);
      if (wirePrevious) {
        const previous = steps.find(step => step.id === previousStepId);
        if (previous) previous.next = toolStep.id;
      }
    }
    return toolStep.id;
  }

  if (!hasBranch) {
    for (let index = 0; index < candidate.tools.length; index++) {
      previousStepId = appendToolStep(index, true);
    }
  } else {
    for (let index = 0; index < branchStart; index++) {
      previousStepId = appendToolStep(index, true);
    }
    const approve = candidate.tools.find(item => item.role === "approve");
    const reject = candidate.tools.find(item => item.role === "reject");
    if (approve && reject && approve.tool.id !== reject.tool.id) {
      const approveIndex = candidate.tools.findIndex(item => item.role === "approve");
      const rejectIndex = candidate.tools.findIndex(item => item.role === "reject");
      const approveStepId = `step_${approveIndex + 1}_${approve.tool.name}`;
      const rejectStepId = `step_${rejectIndex + 1}_${reject.tool.name}`;
      const approveEntryId = approve.tool.requiresConfirmation
        ? `confirm_${approve.tool.name}`
        : approveStepId;
      const rejectEntryId = reject.tool.requiresConfirmation
        ? `confirm_${reject.tool.name}`
        : rejectStepId;
      const conditionStep: WorkflowStep = {
        id: `condition_${approve.tool.name}_or_${reject.tool.name}`,
        type: "condition",
        name: "审批分支",
        description: "根据用户审批结果进入通过或驳回分支",
        conditions: [
          { when: "用户选择审批通过", then: approve.tool.name, else: reject.tool.name },
        ],
        next: [approveEntryId, rejectEntryId],
      };
      const previous = steps.find(step => step.id === previousStepId);
      if (previous) previous.next = conditionStep.id;
      steps.push(conditionStep);
      appendToolStep(approveIndex, false);
      appendToolStep(rejectIndex, false);
      const approveStep = toolStepById.get(approveStepId)!;
      const rejectStep = toolStepById.get(rejectStepId)!;
      approveStep.next = undefined;
      rejectStep.next = undefined;
    }
  }

  if (waitStep.waitFor && requiredInputs.length > 0) {
    waitStep.waitFor = requiredInputs;
  }

  return { steps, requiredInputs: unique(requiredInputs) };
}

function confirmationPolicyFor(candidate: WorkflowCandidate): ConfirmationPolicy {
  if (candidate.tools.some(item => ["high", "critical"].includes(item.tool.riskLevel))) {
    return "always";
  }
  if (candidate.tools.some(item => item.tool.requiresConfirmation)) {
    return "on_risk";
  }
  return "auto";
}

function buildWorkflowDefinition(
  candidate: WorkflowCandidate,
  analysis: ProjectAnalysis
): WorkflowDefinition {
  const { steps, requiredInputs } = buildSteps(candidate);
  const confidence = candidate.source === "page" ? "high" : "medium";
  const sourceTools = candidate.tools.map(item => item.tool.name);
  const sourcePageIds = unique(
    candidate.tools.flatMap(item =>
      (item.tool.relatedPages || []).map(page => page.id).filter((id): id is string => Boolean(id))
    )
  );
  const sourcePages = sourcePageIds
    .map(pageId => analysis.pages.find(page => page.id === pageId))
    .filter((page): page is NonNullable<typeof page> => Boolean(page))
    .map(page => ({
      id: page.id,
      name: page.name,
      route: page.route,
    }));
  const definition: WorkflowDefinition = {
    id: stableId("workflow", analysis.project.name, candidate.name),
    name: candidate.name,
    description: `${candidate.moduleName}业务组合流程：${candidate.tools.map(item => item.tool.name).join(" → ")}。来源置信度：${confidence}。`,
    confidence,
    sourceTools,
    sourcePages,
    module: candidate.moduleName,
    moduleId: candidate.moduleId,
    triggerExamples: triggerExamples(candidate.name, candidate.entity),
    steps,
    requiredInputs,
    confirmationPolicy: confirmationPolicyFor(candidate),
    failureStrategy: {
      onError: candidate.tools.some(item => item.tool.riskLevel !== "read") ? "stop" : "continue",
      retryCount: candidate.tools.some(item => item.tool.riskLevel === "read") ? 0 : 1,
      retryDelayMs: 1000,
      message: "工作流执行失败，已停止并保留已执行步骤结果",
    },
    status: "active",
    version: 1,
    createdAt: now(),
    updatedAt: now(),
    sourceHash: "",
  };
  definition.sourceHash = sourceHashFor(definition);
  return definition;
}

function sourceHashFor(definition: WorkflowDefinition): string {
  return crypto.createHash("sha1")
    .update(JSON.stringify({
      name: definition.name,
      description: definition.description,
      confidence: definition.confidence,
      sourceTools: definition.sourceTools,
      sourcePages: definition.sourcePages,
      steps: definition.steps,
      requiredInputs: definition.requiredInputs,
      confirmationPolicy: definition.confirmationPolicy,
      failureStrategy: definition.failureStrategy,
    }))
    .digest("hex");
}

export function generateWorkflowDefinitions(
  analysis: ProjectAnalysis,
  registry: ToolRegistry,
  options: GenerateWorkflowOptions = {}
): WorkflowDefinition[] {
  let candidates = collectCandidates(analysis, registry);
  if (options.moduleIds?.length) {
    candidates = candidates.filter(candidate =>
      options.moduleIds!.includes(candidate.moduleId)
    );
  }
  return candidates.map(candidate => buildWorkflowDefinition(candidate, analysis));
}

export function buildWorkflowRegistry(
  analysis: ProjectAnalysis,
  registry: ToolRegistry,
  previous: WorkflowRegistry | null,
  options: GenerateWorkflowOptions = {}
): WorkflowRegistry {
  const timestamp = now();
  const generated = generateWorkflowDefinitions(analysis, registry, options);
  const previousById = new Map(
    (previous?.workflows || []).map(workflow => [workflow.id, workflow])
  );
  const workflows: WorkflowDefinition[] = [];

  for (const definition of generated) {
    const prev = previousById.get(definition.id);
    if (prev && prev.sourceHash === definition.sourceHash) {
      workflows.push(prev);
      continue;
    }
    if (prev) {
      workflows.push({
        ...definition,
        version: (prev.version || 1) + 1,
        createdAt: prev.createdAt,
        updatedAt: timestamp,
      });
      continue;
    }
    workflows.push(definition);
  }

  const nextIds = new Set(generated.map(workflow => workflow.id));
  for (const workflow of previousById.values()) {
    if (nextIds.has(workflow.id) || workflow.status === "deprecated") continue;
    workflows.push({
      ...workflow,
      status: "deprecated",
      updatedAt: timestamp,
    });
  }

  workflows.sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: 1,
    projectName: analysis.project.name,
    projectPath: analysis.project.path,
    generatedAt: previous?.generatedAt || timestamp,
    updatedAt: timestamp,
    workflows,
  };
}
