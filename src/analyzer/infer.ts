import type {
  AnalyzedModule,
  AnalyzedPage,
  ApiDefinition,
  ApiParam,
  BusinessCapability,
  ProjectAnalysis,
  StateDefinition,
  WorkflowDefinition,
} from "./types.js";
import { deepEqual, stableId, toSlug, unique } from "./utils.js";

const CHINESE_ENTITY: Record<string, string> = {
  计划: "plan",
  巡检: "inspection",
  巡视: "patrol",
  用户: "user",
  角色: "role",
  权限: "permission",
  工单: "work_order",
  设备: "device",
  单位: "unit",
  档案: "archive",
  任务: "task",
  台账: "ledger",
  缺陷: "defect",
  责任田: "responsibility",
  人员: "staff",
  队伍: "team",
  公告: "notice",
  白名单: "whitelist",
  拓扑: "topology",
};

function actionInfo(label: string): {
  verb: string;
  risk: BusinessCapability["risk"];
  description: string;
} {
  if (/查询|搜索|筛选|检索/.test(label)) return { verb: "query", risk: "read", description: "查询" };
  if (/详情|查看|预览/.test(label)) return { verb: "view", risk: "read", description: "查看" };
  if (/导出|下载/.test(label)) return { verb: "export", risk: "read", description: "导出" };
  if (/新增|创建|新建|添加|登记/.test(label)) return { verb: "create", risk: "write", description: "创建" };
  if (/编辑|修改|更新|变更/.test(label)) return { verb: "update", risk: "write", description: "更新" };
  if (/保存|暂存/.test(label)) return { verb: "save", risk: "write", description: "保存" };
  if (/提交|上报|发布/.test(label)) return { verb: "submit", risk: "write", description: "提交" };
  if (/审批|审核|通过|同意/.test(label)) return { verb: "approve", risk: "write", description: "审批" };
  if (/驳回|退回|拒绝/.test(label)) return { verb: "reject", risk: "write", description: "驳回" };
  if (/删除|移除|撤销|作废/.test(label)) return { verb: "delete", risk: "destructive", description: "删除" };
  if (/启用/.test(label)) return { verb: "enable", risk: "write", description: "启用" };
  if (/停用|禁用/.test(label)) return { verb: "disable", risk: "write", description: "停用" };
  if (/导入/.test(label)) return { verb: "import", risk: "write", description: "导入" };
  return { verb: "operate", risk: "write", description: label };
}

function entitySlug(
  page: AnalyzedPage,
  apis: ApiDefinition[],
  moduleId: string
): string {
  const segments = (page.route || "").split("/").filter(Boolean);
  let seg = segments[segments.length - 1] || "";
  if (!seg || ["index", "list", "detail", "edit", "create"].includes(seg)) {
    seg = segments[segments.length - 2] || "";
  }
  if (!seg) {
    const api = apis.find(api => api.pageIds.includes(page.id));
    seg = (api?.path || "").split("/").filter(Boolean)[0] || "";
  }

  for (const [chinese, english] of Object.entries(CHINESE_ENTITY)) {
    if (page.name.includes(chinese) || seg.includes(chinese)) return english;
  }

  const slug = toSlug(seg.replace(/^:+/g, ""));
  if (slug && slug !== "index") return slug;
  return toSlug(moduleId) || "business";
}

export function inferCapabilities(
  pages: AnalyzedPage[],
  apis: ApiDefinition[],
  modules: AnalyzedModule[]
): BusinessCapability[] {
  const capabilities: BusinessCapability[] = [];

  for (const page of pages) {
    const entity = entitySlug(page, apis, page.moduleId);
    for (const action of page.actions) {
      const info = actionInfo(action.label);
      const wrapperApiIds = unique(
        (action.calledFunctions || []).flatMap(name =>
          apis
            .filter(api => api.callerFunctions.includes(name))
            .map(api => api.id)
        )
      );
      const apiIds = unique([
        ...action.apiIds,
        ...wrapperApiIds,
        ...(action.apiIds.length === 0 && wrapperApiIds.length === 0 && action.risk !== "read" ? page.apiIds : []),
      ]);
      const linkedApis = apis.filter(api => apiIds.includes(api.id));
      const params: ApiParam[] = Array.from(
        new Map(
          linkedApis
            .flatMap(api => api.requestParams)
            .map(param => [`${param.source}:${param.name}`, param])
        ).values()
      );
      const name = `${info.verb}_${entity}`;
      const apiDescription = linkedApis
        .map(api => `${api.method} ${api.path}`)
        .join("; ");
      const confidence = action.handler && (action.apiIds.length > 0 || wrapperApiIds.length > 0)
        ? "high"
        : apiIds.length > 0
          ? "medium"
          : "low";
      const module = modules.find(mod => mod.id === page.moduleId);
      capabilities.push({
        id: stableId("capability", page.moduleId, name, page.id, action.handler || action.label),
        name,
        description: `${info.description}${entity}：在${page.name || "页面"}执行${action.label || info.description}${apiDescription ? `，调用 ${apiDescription}` : ""}`,
        confidence,
        moduleId: page.moduleId,
        pageId: page.id,
        actionLabel: action.label || info.description,
        handler: action.handler,
        apiIds,
        params,
        states: page.states,
        permission: action.permission || page.permissions[0],
        risk: action.risk,
        status: "active",
      });
      action.capabilityId = capabilities[capabilities.length - 1].id;
      void module;
    }
  }

  return capabilities;
}

function actionForTransition(
  from: StateDefinition,
  to: StateDefinition,
  capabilities: BusinessCapability[]
): string {
  const moduleActions = capabilities
    .filter(cap => cap.moduleId === from.moduleId)
    .map(cap => cap.actionLabel)
    .join(" ");

  if (/草稿|新建|待提交/.test(from.label) && /提交|待审批/.test(to.label)) return "submit";
  if (/提交|待审批|审批中/.test(from.label) && /通过|完成|归档/.test(to.label)) return "approve";
  if (/驳回|退回|拒绝/.test(to.label)) return "reject";
  if (/提交|上报|发布/.test(moduleActions)) return "submit";
  if (/审批|审核|通过/.test(moduleActions)) return "approve";
  return "next";
}

export function inferWorkflows(
  modules: AnalyzedModule[],
  states: StateDefinition[],
  capabilities: BusinessCapability[]
): WorkflowDefinition[] {
  const workflows: WorkflowDefinition[] = [];

  for (const module of modules) {
    const moduleStates = states.filter(state => state.moduleId === module.id);
    if (moduleStates.length < 2) continue;
    const ordered = Array.from(
      new Map(moduleStates.map(state => [state.id, state])).values()
    );
    const transitions = ordered.slice(0, -1).map((state, index) => ({
      from: state.label,
      to: ordered[index + 1].label,
      action: actionForTransition(state, ordered[index + 1], capabilities),
      label: `从${state.label}流转到${ordered[index + 1].label}`,
    }));
    workflows.push({
      id: stableId("workflow", module.id, ordered.map(state => state.label).join("->")),
      name: `${module.name}状态流转`,
      description: `${module.name}业务状态流转：${ordered.map(state => state.label).join(" → ")}`,
      moduleId: module.id,
      states: ordered.map(state => state.label),
      transitions,
      status: "active",
    });
  }

  return workflows;
}

export function applyStateOperations(
  states: StateDefinition[],
  capabilities: BusinessCapability[]
): StateDefinition[] {
  return states.map(state => {
    const allowed = unique(
      capabilities
        .filter(cap => cap.moduleId === state.moduleId && cap.risk !== "read")
        .map(cap => cap.actionLabel)
    );
    return { ...state, allowedOperations: allowed };
  });
}

function now(): string {
  return new Date().toISOString();
}

function mergeList<T extends { id: string; status?: "active" | "deprecated"; createdAt?: string; updatedAt?: string; lastSeenAt?: string; deprecatedAt?: string }>(
  previous: T[] | undefined,
  next: T[]
): T[] {
  const timestamp = now();
  const prevById = new Map((previous || []).map(item => [item.id, item]));
  const result: T[] = [];

  for (const item of next) {
    const prev = prevById.get(item.id);
    if (prev && deepEqual(prev, item)) {
      result.push({
        ...prev,
        status: "active",
        lastSeenAt: timestamp,
        deprecatedAt: undefined,
      });
      continue;
    }
    if (prev) {
      result.push({
        ...item,
        status: "active",
        createdAt: prev.createdAt,
        updatedAt: timestamp,
        lastSeenAt: timestamp,
        deprecatedAt: undefined,
      });
      continue;
    }
    result.push({
      ...item,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      lastSeenAt: timestamp,
    });
  }

  for (const item of prevById.values()) {
    if (item.status === "deprecated") {
      result.push(item);
      continue;
    }
    const stillExists = next.some(nextItem => nextItem.id === item.id);
    if (!stillExists) {
      result.push({
        ...item,
        status: "deprecated",
        deprecatedAt: timestamp,
        lastSeenAt: item.lastSeenAt || timestamp,
      });
    }
  }

  return result;
}

export function mergeAnalysis(
  previous: ProjectAnalysis | null,
  next: ProjectAnalysis
): ProjectAnalysis {
  const timestamp = now();
  return {
    ...next,
    status: "ready",
    analyzedAt: next.analyzedAt,
    durationMs: next.durationMs,
    message: next.message,
    project: {
      ...next.project,
      analyzedAt: timestamp,
    },
    modules: mergeList(previous?.modules, next.modules),
    pages: mergeList(previous?.pages, next.pages),
    apis: mergeList(previous?.apis, next.apis),
    entities: mergeList(previous?.entities, next.entities),
    permissions: mergeList(previous?.permissions, next.permissions),
    capabilities: mergeList(previous?.capabilities, next.capabilities),
    workflows: mergeList(previous?.workflows, next.workflows),
    states: mergeList(previous?.states, next.states),
  };
}
