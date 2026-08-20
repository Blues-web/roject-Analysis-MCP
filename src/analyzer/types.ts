/**
 * Project Analyzer 结构化输出模型。
 *
 * 这里的模型是“AI 可操作知识模型”，不是文件索引：
 * 它把页面、API、方法、参数、权限、状态和业务能力组合成 Agent 可消费的结构。
 */

export type AnalysisStatus = "pending" | "analyzing" | "ready" | "error";

export type Confidence = "high" | "medium" | "low";

export type ArtifactStatus = "active" | "deprecated";

export interface LifecycleFields {
  status?: ArtifactStatus;
  createdAt?: string;
  updatedAt?: string;
  lastSeenAt?: string;
  deprecatedAt?: string;
}

export interface ProjectAnalysis {
  schemaVersion: number;
  status: AnalysisStatus;
  analyzedAt: string;
  durationMs?: number;
  message?: string;
  project: AnalyzedProject;
  modules: AnalyzedModule[];
  pages: AnalyzedPage[];
  apis: ApiDefinition[];
  entities: EntityDefinition[];
  permissions: PermissionDefinition[];
  capabilities: BusinessCapability[];
  workflows: WorkflowDefinition[];
  states: StateDefinition[];
}

export type ProjectType = "frontend" | "backend" | "fullstack" | "unknown";

export interface ProjectStats {
  filesScanned: number;
  codeFiles: number;
  pageFiles: number;
  componentFiles: number;
  apiFiles: number;
  storeFiles: number;
  configFiles: number;
}

export interface AnalyzedProject {
  name: string;
  path: string;
  type: ProjectType;
  frameworks: string[];
  analyzedAt?: string;
  packageManager?: string;
  version?: string;
  sourceDir?: string;
  configFiles: string[];
  stats: ProjectStats;
}

export interface RouteDefinition {
  id: string;
  path: string;
  name?: string;
  title?: string;
  componentPath?: string;
  filePath?: string;
  permissions: string[];
  children: RouteDefinition[];
}

export interface AnalyzedModule extends LifecycleFields {
  id: string;
  name: string;
  path: string;
  pageIds: string[];
  apiIds: string[];
  entityIds: string[];
  stateIds: string[];
  storeFiles: string[];
  stateFields: string[];
  actions: string[];
  permissions: string[];
}

export type UiFieldSource = "query" | "form" | "table";

export interface UiField {
  name: string;
  label?: string;
  type?: string;
  source: UiFieldSource;
  required?: boolean;
}

export type ActionRisk = "read" | "write" | "destructive";

export interface PageAction extends LifecycleFields {
  id: string;
  label: string;
  handler?: string;
  method?: string;
  calledFunctions?: string[];
  apiIds: string[];
  capabilityId?: string;
  permission?: string;
  risk: ActionRisk;
}

export interface AnalyzedPage extends LifecycleFields {
  id: string;
  name: string;
  route?: string;
  filePath: string;
  moduleId: string;
  purpose?: string;
  queryFields: UiField[];
  tableFields: UiField[];
  formFields: UiField[];
  actions: PageAction[];
  states: string[];
  permissions: string[];
  apiIds: string[];
}

export type ApiParamSource = "query" | "body" | "path" | "header";

export interface ApiParam {
  name: string;
  source: ApiParamSource;
  type?: string;
  required?: boolean;
  sample?: string;
}

export interface ResponseShape {
  container?: string;
  listField?: string;
  objectField?: string;
  raw?: boolean;
}

export interface ApiDefinition extends LifecycleFields {
  id: string;
  method: string;
  path: string;
  moduleId: string;
  sourceFiles: string[];
  callerFunctions: string[];
  pageIds: string[];
  requestParams: ApiParam[];
  requestBodyKeys: string[];
  responseShape?: ResponseShape;
  description?: string;
  permission?: string;
  risk: ActionRisk;
}

export type EntitySource = "interface" | "form" | "store" | "api";

export interface EntityField {
  name: string;
  type?: string;
  required?: boolean;
  description?: string;
}

export interface EntityDefinition extends LifecycleFields {
  id: string;
  name: string;
  moduleId: string;
  sourceFiles: string[];
  fields: EntityField[];
  source: EntitySource;
  description?: string;
}

export type PermissionType =
  | "login"
  | "menu"
  | "button"
  | "role"
  | "data"
  | "token"
  | "session"
  | "user"
  | "other";

export interface PermissionDefinition extends LifecycleFields {
  id: string;
  name: string;
  type: PermissionType;
  confidence: Confidence;
  sourceFiles: string[];
  expressions: string[];
  pageIds: string[];
  apiIds: string[];
  description?: string;
}

export interface BusinessCapability extends LifecycleFields {
  id: string;
  name: string;
  description: string;
  confidence: Confidence;
  moduleId: string;
  pageId?: string;
  actionLabel: string;
  handler?: string;
  apiIds: string[];
  params: ApiParam[];
  states: string[];
  permission?: string;
  risk: ActionRisk;
}

export interface StateTransition {
  from: string;
  to: string;
  action?: string;
  label?: string;
}

export interface WorkflowDefinition extends LifecycleFields {
  id: string;
  name: string;
  description: string;
  moduleId: string;
  states: string[];
  transitions: StateTransition[];
}

export interface StateDefinition extends LifecycleFields {
  id: string;
  name: string;
  label: string;
  value: string;
  moduleId: string;
  sourceFiles: string[];
  allowedOperations: string[];
  description?: string;
}

export interface StoreModuleInfo {
  id: string;
  name: string;
  filePath: string;
  moduleId: string;
  stateFields: string[];
  actions: string[];
}
