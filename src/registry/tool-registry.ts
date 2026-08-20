import fs from "node:fs";
import path from "node:path";
import type { ProjectAnalysis } from "../analyzer/types.js";
import {
  buildToolRegistry,
  generateToolDefinitions,
  type GenerateToolOptions,
} from "./tool-generator.js";
import type {
  RegisteredTool,
  ToolRegistry,
  ToolStatus,
} from "./types.js";

const REGISTRY_DIR = path.join(
  process.env.HOME || "/tmp",
  ".project-analysis-mcp",
  "registry"
);

const CURRENT_REGISTRY_SCHEMA_VERSION = 1;

function ensureDir(): void {
  if (!fs.existsSync(REGISTRY_DIR)) {
    fs.mkdirSync(REGISTRY_DIR, { recursive: true });
  }
}

function safeProjectName(projectName: string): string {
  return projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, "_");
}

function registryPath(projectName: string): string {
  return path.join(REGISTRY_DIR, `${safeProjectName(projectName)}.json`);
}

export function loadToolRegistry(projectName: string): ToolRegistry | null {
  const filePath = registryPath(projectName);
  if (!fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as ToolRegistry;
    if (parsed.schemaVersion !== CURRENT_REGISTRY_SCHEMA_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveToolRegistry(registry: ToolRegistry): ToolRegistry {
  ensureDir();
  const filePath = registryPath(registry.projectName);
  const tmpPath = `${filePath}.tmp`;
  fs.writeFileSync(
    tmpPath,
    JSON.stringify(registry, null, 2),
    "utf-8"
  );
  fs.renameSync(tmpPath, filePath);
  return registry;
}

export function deleteToolRegistry(projectName: string): boolean {
  const filePath = registryPath(projectName);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
    return true;
  }
  return false;
}

export function generateProjectToolRegistry(
  analysis: ProjectAnalysis,
  options: GenerateToolOptions = {}
): {
  registry: ToolRegistry;
  generated: number;
  skipped: Array<{ name: string; reason: string }>;
} {
  const previous = loadToolRegistry(analysis.project.name);
  const registry = buildToolRegistry(analysis, previous, options);
  saveToolRegistry(registry);

  const before = previous?.tools.filter(tool => tool.status === "active").length || 0;
  const generated = registry.tools.filter(tool => tool.status === "active").length - before;
  return {
    registry,
    generated: Math.max(0, generated),
    skipped: generateToolDefinitions(analysis, options).skipped,
  };
}

export function listRegisteredTools(
  projectName: string,
  status?: ToolStatus
): Array<{
  id: string;
  name: string;
  module: string;
  riskLevel: string;
  requiresConfirmation: boolean;
  permission?: string;
  api: string;
  status: ToolStatus;
  version: number;
}> {
  const registry = loadToolRegistry(projectName);
  if (!registry) return [];
  return registry.tools
    .filter(tool => !status || tool.status === status)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(tool => ({
      id: tool.id,
      name: tool.name,
      module: tool.module,
      riskLevel: tool.riskLevel,
      requiresConfirmation: tool.requiresConfirmation,
      permission: tool.permission,
      api: `${tool.apiMapping.method} ${tool.apiMapping.path}`,
      status: tool.status,
      version: tool.version,
    }));
}

export function getRegisteredTool(
  projectName: string,
  toolName: string
): RegisteredTool | null {
  return loadToolRegistry(projectName)?.tools.find(tool => tool.name === toolName) || null;
}
