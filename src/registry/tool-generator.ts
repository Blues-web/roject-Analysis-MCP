import crypto from "node:crypto";
import type {
  AnalyzedModule,
  AnalyzedPage,
  ApiDefinition,
  ApiParam,
  BusinessCapability,
  ProjectAnalysis,
} from "../analyzer/types.js";
import { stableId, unique } from "../analyzer/utils.js";
import type {
  ApiMapping,
  JsonSchema,
  RegisteredTool,
  RequestMapping,
  ToolDefinition,
  ToolRegistry,
  ToolRiskLevel,
} from "./types.js";

export interface GenerateToolOptions {
  moduleIds?: string[];
  capabilityIds?: string[];
}

export interface GenerateToolResult {
  tools: ToolDefinition[];
  skipped: Array<{ name: string; reason: string }>;
}

function now(): string {
  return new Date().toISOString();
}

function sourceHash(tool: ToolDefinition, capabilityId: string): string {
  const raw = JSON.stringify({
    capabilityId,
    name: tool.name,
    confidence: tool.confidence,
    sources: {
      files: tool.sourceFiles,
      apis: tool.sourceApis,
      pages: tool.sourcePages,
      methods: tool.sourceMethods,
    },
    api: tool.apiMapping,
    input: tool.inputSchema,
    output: tool.outputSchema,
    permission: tool.permission,
    risk: tool.riskLevel,
    confirmation: tool.requiresConfirmation,
  });
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function selectPrimaryApi(
  capability: BusinessCapability,
  apis: ApiDefinition[]
): ApiDefinition | null {
  const candidates = apis.filter(api => capability.apiIds.includes(api.id));
  if (candidates.length === 0) return null;

  const label = capability.actionLabel || "";
  const name = capability.name;
  const scored = candidates.map(api => {
    let score = 0;
    const path = api.path.toLowerCase();
    const method = api.method.toUpperCase();

    if (/查询|搜索|筛选|检索|查看|导出/.test(label) && method === "GET") score += 100;
    if (/创建|新增|新建|添加|登记/.test(label) && /create|add|save|insert|new|build/.test(path)) score += 100;
    if (/修改|编辑|更新|变更/.test(label) && /update|edit|modify|change/.test(path)) score += 100;
    if (/删除|移除|撤销|作废/.test(label) && (method === "DELETE" || /delete|remove|cancel|destroy/.test(path))) score += 100;
    if (/提交|上报|发布/.test(label) && method === "POST" && /submit|publish|report|commit/.test(path)) score += 100;
    if (/审批|审核|通过|同意/.test(label) && method === "POST" && /approve|audit|review|pass/.test(path)) score += 100;
    if (/驳回|退回|拒绝/.test(label) && method === "POST" && /reject|refuse|back/.test(path)) score += 100;
    if (/启用|停用|禁用/.test(label) && /enable|disable|status/.test(path)) score += 80;

    if (capability.risk === "read" && api.risk === "read") score += 30;
    if (capability.risk === "destructive" && api.risk === "destructive") score += 30;
    if (name.includes("query") && api.risk === "read") score += 20;
    if (name.includes("create") && method === "POST") score += 20;
    if (name.includes("delete") && (method === "DELETE" || /delete/.test(path))) score += 20;
    return { api, score };
  });

  scored.sort((a, b) => b.score - a.score || a.api.path.localeCompare(b.api.path));
  return scored[0].api;
}

function riskForCapability(capability: BusinessCapability): ToolRiskLevel {
  const label = capability.actionLabel || "";
  const name = capability.name;
  const combined = `${label} ${name}`;

  if (/权限|permission/.test(combined)) return "critical";
  if (/批量|batch/.test(combined)) return "high";
  if (/删除|移除|撤销|作废|停用|禁用/.test(combined)) return "high";
  if (/审批|审核|通过|同意|驳回|拒绝/.test(combined)) return "high";
  if (/修改|更新|编辑|变更/.test(combined)) return "medium";
  if (/提交|上报|发布|保存|导入/.test(combined)) return "medium";
  if (/创建|新增|新建|添加|登记/.test(combined)) return "low";
  if (capability.risk === "read") return "read";
  if (capability.risk === "destructive") return "high";
  return "medium";
}

function requiresConfirmation(risk: ToolRiskLevel): boolean {
  return risk === "medium" || risk === "high" || risk === "critical";
}

const OPTIONAL_PARAM_NAMES = new Set([
  "remark",
  "remarks",
  "description",
  "file",
  "files",
  "attachment",
  "attachments",
  "sort",
  "order",
  "page",
  "pageNum",
  "pageSize",
  "keyword",
  "status",
  "type",
]);

function jsonTypeForParam(
  name: string,
  fieldType: string | undefined,
  apiParamType: string | undefined
): JsonSchema {
  const lower = name.toLowerCase();
  if (lower === "pagenum" || lower === "pagesize" || lower === "page" || lower === "size") {
    return { type: "integer", description: "分页参数" };
  }
  if (/date|time/.test(lower) || fieldType === "date") {
    return { type: "string", format: "date-time", description: "日期时间" };
  }
  if (/^(is|has|enabled?|disabled?|checked)/.test(lower) || fieldType === "boolean") {
    return { type: "boolean" };
  }
  if (apiParamType?.toLowerCase().includes("number")) {
    return { type: "number" };
  }
  if (apiParamType?.toLowerCase().includes("boolean")) {
    return { type: "boolean" };
  }
  return { type: "string" };
}

function buildInputSchema(
  capability: BusinessCapability,
  page: AnalyzedPage | undefined,
  primaryApi: ApiDefinition,
  isWrite: boolean
): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  const required: string[] = [];

  const fieldMap = new Map<string, { label?: string; type?: string; required?: boolean; source: "query" | "form" | "table" }>();
  for (const field of page?.queryFields || []) {
    fieldMap.set(field.name, { ...field, source: "query" });
  }
  for (const field of page?.formFields || []) {
    fieldMap.set(field.name, { ...field, source: "form" });
  }

  const paramMap = new Map<string, ApiParam>(
    primaryApi.requestParams.map(param => [param.name, param])
  );
  for (const field of page?.queryFields || []) {
    if (!paramMap.has(field.name)) {
      paramMap.set(field.name, {
        name: field.name,
        source: capability.risk === "read" ? "query" : "query",
        type: field.type,
        required: field.required,
      });
    }
  }
  const includesFormFields = /创建|新增|新建|编辑|修改|更新|保存|登记|导入/.test(
    `${capability.actionLabel} ${capability.name}`
  );
  if (includesFormFields) {
    for (const field of page?.formFields || []) {
      if (!paramMap.has(field.name)) {
        paramMap.set(field.name, {
          name: field.name,
          source: capability.risk === "read" ? "query" : "body",
          type: field.type,
          required: field.required,
        });
      }
    }
  }

  for (const param of paramMap.values()) {
    const field = fieldMap.get(param.name);
    const schema = jsonTypeForParam(param.name, field?.type, param.type);
    schema.description = field?.label || `原系统${param.source}参数 ${param.name}`;
    properties[param.name] = schema;

    const optional = OPTIONAL_PARAM_NAMES.has(param.name.toLowerCase());
    const requiredFlag = param.source === "path"
      || field?.required === true
      || (isWrite && param.source === "body" && !optional && !field);
    if (requiredFlag) required.push(param.name);
  }

  if (Object.keys(properties).length === 0) {
    properties._originalApi = {
      type: "object",
      description: `按原系统 ${primaryApi.method} ${primaryApi.path} 请求结构传入参数`,
      additionalProperties: true,
    };
  }

  return {
    type: "object",
    description: `${capability.actionLabel || capability.name}所需的业务参数`,
    properties,
    required: required.length > 0 ? required : undefined,
    additionalProperties: false,
  };
}

function buildOutputSchema(
  capability: BusinessCapability,
  page: AnalyzedPage | undefined,
  primaryApi: ApiDefinition,
  analysis: ProjectAnalysis
): JsonSchema {
  const dataProperties: Record<string, JsonSchema> = {};
  const entityFields = page?.tableFields || [];
  const module = analysis.modules.find(mod => mod.id === capability.moduleId);
  const entity = analysis.entities.find(entity =>
    module?.entityIds.includes(entity.id)
  );

  if (capability.risk === "read" && entityFields.length > 0) {
    const listItemProperties: Record<string, JsonSchema> = {};
    for (const field of entityFields) {
      listItemProperties[field.name] = {
        type: "string",
        description: field.label || field.name,
      };
    }
    dataProperties.list = {
      type: "array",
      description: "查询结果列表",
      items: {
        type: "object",
        properties: listItemProperties,
        additionalProperties: true,
      },
    };
    dataProperties.total = { type: "integer", description: "总记录数" };
  } else if (entity && primaryApi.responseShape?.objectField) {
    const objectProperties: Record<string, JsonSchema> = {};
    for (const field of entity.fields) {
      objectProperties[field.name] = {
        type: "string",
        description: field.description,
      };
    }
    dataProperties[primaryApi.responseShape.objectField] = {
      type: "object",
      properties: objectProperties,
      additionalProperties: true,
    };
  } else {
    // 保留顶层 data 为原系统通用响应对象。
  }

  return {
    type: "object",
    description: `${primaryApi.method} ${primaryApi.path} 的原系统响应结构`,
    properties: {
      code: { type: "string", description: "原系统返回码" },
      message: { type: "string", description: "原系统返回消息" },
      data: {
        type: "object",
        properties: dataProperties,
        additionalProperties: true,
      },
    },
    additionalProperties: true,
  };
}

function buildRequestMapping(
  inputSchema: JsonSchema,
  capability: BusinessCapability
): RequestMapping[] {
  const paramMap = new Map(
    capability.params.map(param => [param.name, param])
  );
  const mappings: RequestMapping[] = [];
  for (const toolParam of Object.keys(inputSchema.properties || {})) {
    if (toolParam.startsWith("_")) continue;
    const param = paramMap.get(toolParam);
    const location = param?.source || (/query|search|filter/.test(capability.actionLabel) ? "query" : "body");
    mappings.push({
      toolParam,
      apiParam: toolParam,
      location,
      required: Boolean(inputSchema.required?.includes(toolParam)),
      description: param ? `原系统${param.source}参数` : undefined,
    });
  }
  return mappings;
}

function buildApiMapping(
  capability: BusinessCapability,
  primaryApi: ApiDefinition,
  alternativeApis: ApiDefinition[],
  inputSchema: JsonSchema
): ApiMapping {
  return {
    capabilityId: capability.id,
    apiId: primaryApi.id,
    method: primaryApi.method,
    path: primaryApi.path,
    baseUrlMode: "original_system",
    requestMapping: buildRequestMapping(inputSchema, capability),
    responseMapping: {
      container: primaryApi.responseShape?.container,
      listField: primaryApi.responseShape?.listField,
      objectField: primaryApi.responseShape?.objectField,
      raw: primaryApi.responseShape?.raw,
    },
    sourceFiles: primaryApi.sourceFiles,
    callerFunctions: primaryApi.callerFunctions,
    alternativeApis: alternativeApis.map(api => ({
      apiId: api.id,
      method: api.method,
      path: api.path,
    })),
  };
}

function entityName(capability: BusinessCapability): string {
  const parts = capability.name.split("_");
  return parts.slice(1).join("_") || capability.moduleId;
}

function buildPreconditions(
  capability: BusinessCapability,
  permission: string | undefined,
  analysis: ProjectAnalysis
): string[] {
  const conditions: string[] = [];
  const hasAuth = analysis.permissions.some(p =>
    ["login", "token", "session", "user"].includes(p.type)
  );
  if (hasAuth || permission) conditions.push("用户必须已通过原系统认证");
  if (permission) conditions.push(`当前用户必须拥有原系统权限 ${permission}`);
  if (capability.states.length > 0) {
    conditions.push(`操作前需确认业务状态处于可操作范围：${capability.states.join("、")}`);
  }
  return conditions;
}

function buildPostconditions(capability: BusinessCapability): string[] {
  const entity = entityName(capability);
  const label = capability.actionLabel || "";
  if (/查询|搜索|查看|导出/.test(label)) return [`原系统返回${entity}查询结果`];
  if (/删除|移除|撤销/.test(label)) return [`原系统将删除${entity}业务记录`];
  if (/审批|审核|通过|同意/.test(label)) return [`原系统将推进${entity}审批状态`];
  if (/提交|上报|发布/.test(label)) return [`原系统将推进${entity}业务状态`];
  if (/修改|编辑|更新/.test(label)) return [`原系统将更新${entity}业务记录`];
  if (/创建|新增|新建/.test(label)) return [`原系统将创建${entity}业务记录`];
  if (capability.states.length > 0) {
    return [`原系统执行业务操作，状态可能流转到：${capability.states.join("、")}`];
  }
  return [`原系统执行${label || capability.name}业务操作`];
}

function buildToolDefinition(
  capability: BusinessCapability,
  analysis: ProjectAnalysis,
  primaryApi: ApiDefinition,
  alternatives: ApiDefinition[],
  relatedCapabilities: BusinessCapability[]
): ToolDefinition {
  const page = analysis.pages.find(item => item.id === capability.pageId);
  const module = analysis.modules.find(item => item.id === capability.moduleId);
  const isWrite = capability.risk !== "read";
  const inputSchema = buildInputSchema(capability, page, primaryApi, isWrite);
  const riskLevel = riskForCapability(capability);
  const permission = capability.permission
    || primaryApi.permission
    || page?.permissions[0]
    || module?.permissions[0];

  const relatedPages = unique([
    ...(capability.pageId ? [capability.pageId] : []),
    ...primaryApi.pageIds,
  ])
    .map(pageId => analysis.pages.find(item => item.id === pageId))
    .filter((item): item is AnalyzedPage => Boolean(item))
    .map(item => ({
      id: item.id,
      name: item.name,
      route: item.route,
    }));

  const relatedTools = unique(
    relatedCapabilities
      .filter(item => item.id !== capability.id)
      .map(item => item.name)
  ).slice(0, 8);

  const entity = entityName(capability);
  const verb = capability.name.split("_")[0];
  const verbChinese: Record<string, string> = {
    create: "创建",
    update: "更新",
    delete: "删除",
    query: "查询",
    submit: "提交",
    approve: "审批",
    reject: "驳回",
    export: "导出",
    import: "导入",
    save: "保存",
    view: "查看",
    enable: "启用",
    disable: "停用",
  };
  const actionText = verbChinese[verb] || capability.actionLabel || capability.name;
  const businessPurpose = `${actionText}${entity}：在${page?.name || module?.name || capability.moduleId}页面执行原系统业务能力`;
  const confidence = capability.confidence || (primaryApi.sourceFiles.length > 0 ? "medium" : "low");
  const sourceFiles = unique([
    ...primaryApi.sourceFiles,
    ...(page ? [page.filePath] : []),
  ]);
  const sourceApis = [primaryApi, ...alternatives].map(api => ({
    apiId: api.id,
    method: api.method,
    path: api.path,
  }));
  const sourceMethods = unique([
    ...(capability.handler ? [capability.handler] : []),
    ...(page?.actions.find(action => action.handler === capability.handler)?.method
      ? [page.actions.find(action => action.handler === capability.handler)!.method!]
      : []),
    ...primaryApi.callerFunctions,
  ]);

  return {
    name: capability.name,
    description: [
      businessPurpose,
      `当用户需要${actionText}${entity}或表达“${actionText}${entity}”意图时调用。`,
      `执行方式：调用原系统 ${primaryApi.method} ${primaryApi.path}，不复制原系统业务逻辑。`,
      `需要确认：${riskLevel !== "read" ? "是" : "否"}。来源置信度：${confidence}。`,
    ].join(" "),
    confidence,
    module: module?.name || capability.moduleId,
    moduleId: capability.moduleId,
    businessPurpose,
    sourceFiles,
    sourceApis,
    sourcePages: relatedPages,
    sourceMethods,
    inputSchema,
    outputSchema: buildOutputSchema(capability, page, primaryApi, analysis),
    apiMapping: buildApiMapping(capability, primaryApi, alternatives, inputSchema),
    permission,
    riskLevel,
    requiresConfirmation: requiresConfirmation(riskLevel),
    preconditions: buildPreconditions(capability, permission, analysis),
    postconditions: buildPostconditions(capability),
    relatedTools,
    relatedPages,
  };
}

export function generateToolDefinitions(
  analysis: ProjectAnalysis,
  options: GenerateToolOptions = {}
): GenerateToolResult {
  let capabilities = analysis.capabilities.filter(cap => cap.status !== "deprecated");
  if (options.moduleIds?.length) {
    capabilities = capabilities.filter(cap => options.moduleIds!.includes(cap.moduleId));
  }
  if (options.capabilityIds?.length) {
    capabilities = capabilities.filter(cap => options.capabilityIds!.includes(cap.id));
  }

  const tools: ToolDefinition[] = [];
  const skipped: GenerateToolResult["skipped"] = [];

  for (const capability of capabilities) {
    const apis = analysis.apis.filter(api => capability.apiIds.includes(api.id));
    const primaryApi = selectPrimaryApi(capability, analysis.apis);
    if (!primaryApi) {
      skipped.push({
        name: capability.name,
        reason: "没有可映射的原系统 API",
      });
      continue;
    }
    const alternatives = apis.filter(api => api.id !== primaryApi.id);
    const relatedCapabilities = analysis.capabilities.filter(item =>
      item.status !== "deprecated" &&
      (item.moduleId === capability.moduleId || item.pageId === capability.pageId)
    );
    tools.push(
      buildToolDefinition(
        capability,
        analysis,
        primaryApi,
        alternatives,
        relatedCapabilities
      )
    );
  }

  return { tools, skipped };
}

export function buildToolRegistry(
  analysis: ProjectAnalysis,
  previous: ToolRegistry | null,
  options: GenerateToolOptions = {}
): ToolRegistry {
  const timestamp = now();
  const generated = generateToolDefinitions(analysis, options);
  const previousByCapability = new Map(
    (previous?.tools || []).map(tool => [tool.sourceCapabilityId, tool])
  );
  const tools: RegisteredTool[] = [];
  const isFiltered = Boolean(options.moduleIds?.length || options.capabilityIds?.length);

  for (const tool of generated.tools) {
    const prev = previousByCapability.get(tool.apiMapping.capabilityId);
    const hash = sourceHash(tool, tool.apiMapping.capabilityId);
    const id = stableId("registered-tool", analysis.project.name, tool.name);
    if (prev && prev.sourceHash === hash) {
      tools.push(prev);
      continue;
    }
    if (prev) {
      tools.push({
        ...tool,
        id,
        sourceCapabilityId: tool.apiMapping.capabilityId,
        sourceHash: hash,
        status: "active",
        version: (prev.version || 1) + 1,
        createdAt: prev.createdAt,
        updatedAt: timestamp,
      });
      continue;
    }
    tools.push({
      ...tool,
      id,
      sourceCapabilityId: tool.apiMapping.capabilityId,
      sourceHash: hash,
      status: "active",
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  const nextCapabilityIds = new Set(
    generated.tools.map(tool => tool.apiMapping.capabilityId)
  );
  for (const tool of previousByCapability.values()) {
    const stillExists = nextCapabilityIds.has(tool.sourceCapabilityId);
    if (stillExists || isFiltered || tool.status === "deprecated") {
      if (stillExists && !tools.some(item => item.id === tool.id)) {
        const generatedTool = generated.tools.find(item =>
          item.apiMapping.capabilityId === tool.sourceCapabilityId
        );
        if (generatedTool) {
          const hash = sourceHash(generatedTool, tool.sourceCapabilityId);
          tools.push({
            ...generatedTool,
            id: tool.id,
            sourceCapabilityId: tool.sourceCapabilityId,
            sourceHash: hash,
            status: tool.status === "deprecated" ? "deprecated" : "active",
            version: hash === tool.sourceHash ? tool.version : tool.version + 1,
            createdAt: tool.createdAt,
            updatedAt: hash === tool.sourceHash ? tool.updatedAt : timestamp,
          });
        }
        continue;
      }
      if (!tools.some(item => item.id === tool.id)) tools.push(tool);
      continue;
    }
    tools.push({
      ...tool,
      status: "deprecated",
      updatedAt: timestamp,
    });
  }

  tools.sort((a, b) => a.name.localeCompare(b.name));
  return {
    schemaVersion: 1,
    projectName: analysis.project.name,
    projectPath: analysis.project.path,
    generatedAt: previous?.generatedAt || timestamp,
    updatedAt: timestamp,
    tools,
  };
}
