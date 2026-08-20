import fs from "node:fs";
import path from "node:path";
import type { ProjectAnalysis } from "../analyzer/types.js";
import type { ToolRegistry } from "../registry/types.js";
import {
  buildWorkflowRegistry,
  type GenerateWorkflowOptions,
} from "./workflow-generator.js";
import type {
  WorkflowDefinition,
  WorkflowRegistry,
  WorkflowStatus,
} from "./types.js";

const WORKFLOW_DIR = path.join(
  process.env.HOME || "/tmp",
  ".project-analysis-mcp",
  "workflows"
);

const CURRENT_WORKFLOW_SCHEMA_VERSION = 1;

function ensureDir(): void {
  if (!fs.existsSync(WORKFLOW_DIR)) {
    fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
  }
}

function safeProjectName(projectName: string): string {
  return projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
}

function workflowPath(projectName: string): string {
  return path.join(WORKFLOW_DIR, `${safeProjectName(projectName)}.json`);
}

export function loadWorkflowRegistry(projectName: string): WorkflowRegistry | null {
  const filePath = workflowPath(projectName);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as WorkflowRegistry;
    if (parsed.schemaVersion !== CURRENT_WORKFLOW_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveWorkflowRegistry(registry: WorkflowRegistry): WorkflowRegistry {
  ensureDir();
  const filePath = workflowPath(registry.projectName);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(registry, null, 2),
    "utf-8"
  );
  fs.renameSync(tmpPath, filePath);
  return registry;
}

export function deleteWorkflowRegistry(projectName: string): boolean {
  const filePath = workflowPath(projectName);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function generateProjectWorkflows(
  analysis: ProjectAnalysis,
  toolRegistry: ToolRegistry,
  options: GenerateWorkflowOptions = {}
): {
  registry: WorkflowRegistry;
  generated: number;
} {
  const previous = loadWorkflowRegistry(analysis.project.name);
  const registry = buildWorkflowRegistry(
    analysis,
    toolRegistry,
    previous,
    options
  );
  saveWorkflowRegistry(registry);
  const before = previous?.workflows.filter(item => item.status === "active").length || 0;
  const active = registry.workflows.filter(item => item.status === "active").length;
  return {
    registry,
    generated: Math.max(0, active - before),
  };
}

export function listRegisteredWorkflows(
  projectName: string,
  status?: WorkflowStatus
): Array<{
  id: string;
  name: string;
  module: string;
  triggerExamples: string[];
  confirmationPolicy: string;
  status: WorkflowStatus;
  version: number;
}> {
  const registry = loadWorkflowRegistry(projectName);
  if (!registry) return [];
  return registry.workflows
    .filter(workflow => !status || workflow.status === status)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(workflow => ({
      id: workflow.id,
      name: workflow.name,
      module: workflow.module,
      triggerExamples: workflow.triggerExamples,
      confirmationPolicy: workflow.confirmationPolicy,
      status: workflow.status,
      version: workflow.version,
    }));
}

export function getRegisteredWorkflow(
  projectName: string,
  workflowName: string
): WorkflowDefinition | null {
  return loadWorkflowRegistry(projectName)?.workflows.find(
    workflow => workflow.name === workflowName
  ) || null;
}
