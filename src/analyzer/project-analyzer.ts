import fs from "node:fs";
import path from "node:path";
import {
  createKnowledge,
  loadKnowledge,
  saveKnowledge,
} from "../utils/knowledge-store.js";
import {
  applyStateOperations,
  inferCapabilities,
  inferWorkflows,
  mergeAnalysis,
} from "./infer.js";
import {
  buildModules,
  detectProjectMeta,
  parseApis,
  parseEntities,
  parsePages,
  parsePermissions,
  parseRoutes,
  parseStates,
  parseStoreModules,
  scanProjectFiles,
} from "./parsers.js";
import type { ProjectAnalysis } from "./types.js";
import { unique } from "./utils.js";

export interface AnalyzeWebProjectOptions {
  force?: boolean;
}

export async function analyzeWebProject(
  projectName: string,
  projectPath: string,
  options: AnalyzeWebProjectOptions = {}
): Promise<ProjectAnalysis> {
  const root = path.resolve(projectPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error(`项目目录不存在: ${root}`);
  }

  const startedAt = Date.now();
  const files = scanProjectFiles(root);
  const routes = parseRoutes(root, files);
  const pages = parsePages(files, routes, root);
  const stores = parseStoreModules(files);
  const apis = parseApis(files, root, pages);
  const entities = parseEntities(files);
  const permissions = parsePermissions(files, pages);
  let states = parseStates(files);
  const modules = buildModules(files, pages, apis, entities, states, stores);

  for (const page of pages) {
    page.states = unique(
      states
        .filter(state => state.moduleId === page.moduleId)
        .map(state => state.label)
    );
  }

  const capabilities = inferCapabilities(pages, apis, modules);
  states = applyStateOperations(states, capabilities);
  const workflows = inferWorkflows(modules, states, capabilities);

  const next: ProjectAnalysis = {
    schemaVersion: 3,
    status: "ready",
    analyzedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    project: detectProjectMeta(projectName, root, files),
    modules,
    pages,
    apis,
    entities,
    permissions,
    capabilities,
    workflows,
    states,
  };

  const knowledge = loadKnowledge(projectName) || createKnowledge(projectName, root, "");
  knowledge.projectPath = root;
  knowledge.analysis = options.force ? next : mergeAnalysis(knowledge.analysis || null, next);
  knowledge.lastUpdated = new Date().toISOString();
  saveKnowledge(knowledge);

  return knowledge.analysis;
}

export function getProjectAnalysis(projectName: string): ProjectAnalysis | null {
  return loadKnowledge(projectName)?.analysis || null;
}

export function formatAnalysisSummary(analysis: ProjectAnalysis): string {
  const project = analysis.project;
  const lines = [
    `✅ Project Knowledge 已生成: ${project.name}`,
    `📁 路径: ${project.path}`,
    `🧩 技术栈: ${project.frameworks.join(", ")}`,
    `🏷️ 类型: ${project.type}`,
    "",
    `📦 模块: ${analysis.modules.length}`,
    `📄 页面: ${analysis.pages.length}`,
    `🔌 API: ${analysis.apis.length}`,
    `🧬 实体: ${analysis.entities.length}`,
    `🔐 权限: ${analysis.permissions.length}`,
    `⚡ 业务能力: ${analysis.capabilities.length}`,
    `🔄 工作流: ${analysis.workflows.length}`,
    `🎚️ 状态: ${analysis.states.length}`,
    "",
    `⏱️ 耗时: ${analysis.durationMs ?? 0}ms`,
    `🕐 分析时间: ${analysis.analyzedAt}`,
  ];
  return lines.join("\n");
}
