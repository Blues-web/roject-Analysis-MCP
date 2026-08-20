import { getProjectAnalysis } from "../analyzer/project-analyzer.js";
import { loadToolRegistry } from "../registry/tool-registry.js";
import { loadWorkflowRegistry } from "../workflow/workflow-store.js";
import { loadAgentConfig } from "../provider/config-store.js";
import { createLLMProvider } from "../provider/llm-provider.js";
import {
  appendExecutionLog,
} from "./log-store.js";
import {
  createSession,
  loadSession,
  saveSession,
} from "./session-store.js";
import { executeTool } from "./tool-executor.js";
import {
  executeWorkflow,
  type ToolExecutor,
} from "./workflow-executor.js";
import type {
  AgentMessage,
  AgentRuntimeConfig,
  AgentRunResult,
  AgentSession,
  AgentToolCall,
  AgentToolContext,
  AgentToolSpec,
  ExecutionResult,
  LLMMessage,
  LLMProvider,
  PendingAction,
} from "./types.js";
import type {
  JsonSchema,
  RegisteredTool,
  ToolRegistry,
} from "../registry/types.js";
import type { WorkflowDefinition, WorkflowRegistry } from "../workflow/types.js";
import type { ProjectAnalysis } from "../analyzer/types.js";

export interface AgentRuntimeDeps {
  config: AgentRuntimeConfig;
  provider: LLMProvider;
  analysis: ProjectAnalysis;
  toolRegistry: ToolRegistry;
  workflowRegistry: WorkflowRegistry;
  executor?: ToolExecutor;
}

function buildContext(
  toolRegistry: ToolRegistry,
  workflowRegistry: WorkflowRegistry
): AgentToolContext {
  return {
    tools: toolRegistry.tools
      .filter(tool => tool.status === "active")
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        permission: tool.permission,
        riskLevel: tool.riskLevel,
        requiresConfirmation: tool.requiresConfirmation,
      })),
    workflows: workflowRegistry.workflows
      .filter(workflow => workflow.status === "active")
      .map(workflow => ({
        name: workflow.name,
        description: workflow.description,
        requiredInputs: workflow.requiredInputs,
        confirmationPolicy: workflow.confirmationPolicy,
      })),
  };
}

function buildSystemPrompt(
  analysis: ProjectAnalysis,
  context: AgentToolContext
): string {
  const modules = analysis.modules
    .filter(module => module.status !== "deprecated")
    .map(module => `${module.id}(${module.pageIds.length} pages, ${module.apiIds.length} apis)`)
    .join(", ");
  const capabilities = analysis.capabilities
    .filter(capability => capability.status !== "deprecated")
    .slice(0, 20)
    .map(capability => capability.name)
    .join(", ");
  const workflows = context.workflows.map(workflow =>
    `${workflow.name} (${workflow.confirmationPolicy}, inputs: ${workflow.requiredInputs.join(", ") || "-"})`
  ).join("\n");

  return [
    `你是 ${analysis.project.name} 的 AI 业务操作助手。`,
    "你只能通过注册 Tool 调用原系统 API，不能直接操作页面、数据库，不能绕过原系统权限。",
    "",
    `项目模块: ${modules}`,
    `业务能力: ${capabilities}`,
    "",
    "可用 Workflow:",
    workflows || "（无）",
    "",
    "执行规则:",
    "1. 用户意图对应单个原子能力时，选择 Tool。",
    "2. 用户意图对应多个连续业务能力时，选择 Workflow。",
    "3. 参数不完整时，先向用户询问，不要猜测关键参数。",
    "4. 需要确认的 Tool/Workflow 必须等待用户确认。",
    "5. Tool 参数使用 snake_case。",
    "6. 工具返回后，根据返回结果继续下一步或生成自然语言回复。",
  ].join("\n");
}

function buildToolSpecs(context: AgentToolContext): AgentToolSpec[] {
  return [
    ...context.tools.map(tool => ({
      name: tool.name,
      description: `${tool.description} 权限: ${tool.permission || "无"} 风险: ${tool.riskLevel} 需要确认: ${tool.requiresConfirmation ? "是" : "否"}`,
      parameters: tool.inputSchema,
    })),
    ...context.workflows.map(workflow => {
      const properties: Record<string, JsonSchema> = {};
      for (const name of workflow.requiredInputs) {
        properties[name] = { type: "string", description: `工作流输入 ${name}` };
      }
      return {
        name: workflow.name,
        description: `${workflow.description} 请优先用 Workflow 完成组合业务。`,
        parameters: {
          type: "object" as const,
          properties,
          required: workflow.requiredInputs.length > 0 ? workflow.requiredInputs : undefined,
          additionalProperties: false,
        },
      };
    }),
  ];
}

function toLLMMessages(messages: AgentMessage[]): LLMMessage[] {
  return messages.map(message => {
    if (message.role === "assistant" && message.toolCalls?.length) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map(call => ({
          id: call.id,
          type: "function" as const,
          function: {
            name: call.name,
            arguments: JSON.stringify(call.arguments),
          },
        })),
      };
    }
    return {
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId,
      name: message.name,
    };
  });
}

function isConfirmationMessage(message: string): boolean {
  return /(确认|执行|继续|同意|yes|ok|confirm|approve)/i.test(message.trim());
}

function validateToolArgs(
  tool: RegisteredTool,
  args: Record<string, unknown>
): string[] {
  return (tool.inputSchema.required || []).filter(
    name => args[name] === undefined || args[name] === null || args[name] === ""
  );
}

export class AgentRuntime {
  private readonly executor: ToolExecutor;
  private readonly tools: RegisteredTool[];
  private readonly workflows: WorkflowDefinition[];
  private readonly context: AgentToolContext;

  constructor(private readonly deps: AgentRuntimeDeps) {
    this.executor = deps.executor || executeTool;
    this.tools = deps.toolRegistry.tools.filter(tool => tool.status === "active");
    this.workflows = deps.workflowRegistry.workflows.filter(
      workflow => workflow.status === "active"
    );
    this.context = buildContext(deps.toolRegistry, deps.workflowRegistry);
  }

  async chat(
    projectName: string,
    message: string,
    sessionId?: string
  ): Promise<AgentRunResult> {
    const session = sessionId
      ? loadSession(sessionId) || createSession(projectName)
      : createSession(projectName);
    const executedTools: string[] = [];
    const executedWorkflows: string[] = [];
    const toolResults: NonNullable<AgentRunResult["toolResults"]> = [];

    appendExecutionLog(session.id, projectName, "user", message, {
      sessionId: session.id,
    });

    if (session.pending) {
      if (session.pending.confirm) {
        if (isConfirmationMessage(message)) {
          session.messages.push({
            role: "user",
            content: `用户已确认: ${message}`,
          });
          appendExecutionLog(session.id, projectName, "confirmation", "用户确认执行", {
            pending: session.pending,
          });
          const result = await this.executePending(session, executedTools, executedWorkflows, toolResults);
          if (result) return result;
        } else {
          session.pending = undefined;
          session.messages.push({ role: "user", content: message });
          const result: AgentRunResult = {
            sessionId: session.id,
            reply: "已取消当前待确认操作。如需继续，请重新描述需求。",
            executedTools,
            executedWorkflows,
            toolResults,
          };
          saveSession(session);
          return result;
        }
      } else {
        session.pending = undefined;
        session.messages.push({ role: "user", content: message });
      }
    } else {
      session.messages.push({ role: "user", content: message });
    }

    const systemPrompt = buildSystemPrompt(this.deps.analysis, this.context);
    const specs = buildToolSpecs(this.context);
    const maxIterations = this.deps.config.maxIterations || 5;

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      const llmMessages: LLMMessage[] = [
        { role: "system", content: systemPrompt },
        ...toLLMMessages(session.messages),
      ];
      const response = await this.deps.provider.chat(llmMessages, specs);

      if (response.toolCalls && response.toolCalls.length > 0) {
        session.messages.push({
          role: "assistant",
          content: response.content,
          toolCalls: response.toolCalls,
        });
        appendExecutionLog(session.id, projectName, "llm", "LLM 选择调用", {
          toolCalls: response.toolCalls.map(call => call.name),
        });

        let shouldContinue = false;
        for (const call of response.toolCalls) {
          const handled = await this.handleToolCall(
            session,
            call,
            projectName,
            executedTools,
            executedWorkflows,
            toolResults
          );
          if (handled) return handled;
          shouldContinue = true;
        }
        if (shouldContinue) continue;
      }

      const reply = response.content || "已完成处理。";
      session.messages.push({ role: "assistant", content: reply });
      saveSession(session);
      return {
        sessionId: session.id,
        reply,
        executedTools,
        executedWorkflows,
        toolResults,
      };
    }

    const reply = "已达到最大执行轮次，请补充信息或分步继续。";
    session.messages.push({ role: "assistant", content: reply });
    saveSession(session);
    return {
      sessionId: session.id,
      reply,
      executedTools,
      executedWorkflows,
      toolResults,
    };
  }

  private async handleToolCall(
    session: AgentSession,
    call: AgentToolCall,
    projectName: string,
    executedTools: string[],
    executedWorkflows: string[],
    toolResults: NonNullable<AgentRunResult["toolResults"]>
  ): Promise<AgentRunResult | null> {
    const tool = this.tools.find(item => item.name === call.name);
    if (tool) {
      const missing = validateToolArgs(tool, call.arguments);
      if (missing.length > 0) {
        session.pending = {
          kind: "tool",
          toolName: tool.name,
          callId: call.id,
          arguments: call.arguments,
          missingInputs: missing,
          message: `缺少参数: ${missing.join(", ")}`,
        };
        saveSession(session);
        appendExecutionLog(session.id, projectName, "error", "Tool 参数不完整", {
          tool: tool.name,
          missing,
        });
        return {
          sessionId: session.id,
          reply: `执行 ${tool.name} 还需要以下信息：${missing.join("、")}。请补充后继续。`,
          executedTools,
          executedWorkflows,
          toolResults,
          needsUserInput: true,
          missingInputs: missing,
          pendingAction: session.pending,
        };
      }

      if (this.isPermissionDenied(tool)) {
        const toolResult: ExecutionResult = {
          success: false,
          toolName: tool.name,
          error: `当前配置不允许调用权限 ${tool.permission}`,
        };
        toolResults.push({ toolName: tool.name, arguments: call.arguments, result: toolResult });
        session.messages.push({
          role: "tool",
          toolCallId: call.id,
          name: tool.name,
          content: JSON.stringify(toolResult),
        });
        appendExecutionLog(session.id, projectName, "error", "权限拒绝", {
          tool: tool.name,
          permission: tool.permission,
        });
        return null;
      }

      if (tool.requiresConfirmation) {
        session.pending = {
          kind: "tool",
          toolName: tool.name,
          callId: call.id,
          arguments: call.arguments,
          confirm: true,
          message: `即将调用 ${tool.name}`,
        };
        saveSession(session);
        appendExecutionLog(session.id, projectName, "confirmation", "需要用户确认", {
          tool: tool.name,
        });
        return {
          sessionId: session.id,
          reply: `需要确认：即将执行 ${tool.name}。确认后我会继续，回复“确认”即可。`,
          executedTools,
          executedWorkflows,
          toolResults,
          confirmationRequest: tool.name,
          pendingAction: session.pending,
        };
      }

      const result = await this.executor(tool, call.arguments, this.deps.config);
      executedTools.push(tool.name);
      toolResults.push({ toolName: tool.name, arguments: call.arguments, result });
      session.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: tool.name,
        content: JSON.stringify(result),
      });
      appendExecutionLog(session.id, projectName, "tool_call", `调用 ${tool.name}`, {
        result,
      });
      return null;
    }

    const workflow = this.workflows.find(item => item.name === call.name);
    if (workflow) {
      const missing = workflow.requiredInputs.filter(
        name => call.arguments[name] === undefined || call.arguments[name] === null || call.arguments[name] === ""
      );
      if (missing.length > 0) {
        session.pending = {
          kind: "workflow",
          workflowName: workflow.name,
          callId: call.id,
          arguments: call.arguments,
          missingInputs: missing,
          message: `Workflow 缺少参数: ${missing.join(", ")}`,
        };
        saveSession(session);
        appendExecutionLog(session.id, projectName, "error", "Workflow 参数不完整", {
          workflow: workflow.name,
          missing,
        });
        return {
          sessionId: session.id,
          reply: `执行 ${workflow.name} 还需要：${missing.join("、")}。请补充后继续。`,
          executedTools,
          executedWorkflows,
          toolResults,
          needsUserInput: true,
          missingInputs: missing,
          pendingAction: session.pending,
        };
      }

      if (workflow.confirmationPolicy !== "auto") {
        session.pending = {
          kind: "workflow",
          workflowName: workflow.name,
          callId: call.id,
          arguments: call.arguments,
          confirm: true,
          message: `即将执行 Workflow ${workflow.name}`,
          workflowState: {
            stepIndex: 0,
            variables: {},
            stepResults: {},
            confirmed: true,
          },
        };
        saveSession(session);
        appendExecutionLog(session.id, projectName, "confirmation", "Workflow 需要确认", {
          workflow: workflow.name,
        });
        return {
          sessionId: session.id,
          reply: `需要确认：即将执行 ${workflow.name}。确认后我会继续，回复“确认”即可。`,
          executedTools,
          executedWorkflows,
          toolResults,
          confirmationRequest: workflow.name,
          pendingAction: session.pending,
        };
      }

      const result = await executeWorkflow(
        workflow,
        call.arguments,
        this.deps.config,
        this.tools,
        this.executor
      );
      if (result.needsInput || result.confirmationRequired) {
        session.pending = {
          kind: "workflow",
          workflowName: workflow.name,
          callId: call.id,
          arguments: call.arguments,
          workflowState: result.workflowState,
          message: result.message,
          missingInputs: result.missingInputs,
          confirm: result.confirmationRequired,
        };
        saveSession(session);
        return {
          sessionId: session.id,
          reply: result.message || "Workflow 需要继续输入或确认。",
          executedTools,
          executedWorkflows,
          toolResults,
          needsUserInput: Boolean(result.needsInput),
          missingInputs: result.missingInputs,
          confirmationRequest: result.confirmationRequired ? workflow.name : undefined,
          pendingAction: session.pending,
        };
      }
      executedWorkflows.push(workflow.name);
      toolResults.push({ toolName: workflow.name, arguments: call.arguments, result });
      session.messages.push({
        role: "tool",
        toolCallId: call.id,
        name: workflow.name,
        content: JSON.stringify(result),
      });
      appendExecutionLog(session.id, projectName, "workflow", `执行 ${workflow.name}`, {
        result,
      });
      return null;
    }

    const unknownResult: ExecutionResult = {
      success: false,
      error: `未找到 Tool 或 Workflow: ${call.name}`,
    };
    session.messages.push({
      role: "tool",
      toolCallId: call.id,
      name: call.name,
      content: JSON.stringify(unknownResult),
    });
    appendExecutionLog(session.id, projectName, "error", "未知 Tool/Workflow", {
      name: call.name,
    });
    return null;
  }

  private isPermissionDenied(tool: RegisteredTool): boolean {
    const allowed = this.deps.config.allowedPermissions;
    if (!allowed || allowed.length === 0) return false;
    if (!tool.permission) return false;
    return !allowed.includes(tool.permission);
  }

  private async executePending(
    session: AgentSession,
    executedTools: string[],
    executedWorkflows: string[],
    toolResults: NonNullable<AgentRunResult["toolResults"]>
  ): Promise<AgentRunResult | null> {
    const pending = session.pending;
    if (!pending) return null;
    session.pending = undefined;

    if (pending.kind === "tool" && pending.toolName) {
      const tool = this.tools.find(item => item.name === pending.toolName);
      if (!tool) return null;
      const result = await this.executor(tool, pending.arguments, this.deps.config);
      executedTools.push(tool.name);
      toolResults.push({ toolName: tool.name, arguments: pending.arguments, result });
      session.messages.push({
        role: "tool",
        toolCallId: pending.callId,
        name: tool.name,
        content: JSON.stringify(result),
      });
      return null;
    }

    if (pending.kind === "workflow" && pending.workflowName) {
      const workflow = this.workflows.find(item => item.name === pending.workflowName);
      if (!workflow) return null;
      const result = await executeWorkflow(
        workflow,
        pending.arguments,
        this.deps.config,
        this.tools,
        this.executor,
        pending.workflowState
      );
      if (result.needsInput || result.confirmationRequired) {
        session.pending = {
          ...pending,
          workflowState: result.workflowState,
          message: result.message,
          missingInputs: result.missingInputs,
          confirm: result.confirmationRequired,
        };
        saveSession(session);
        return {
          sessionId: session.id,
          reply: result.message || "Workflow 需要继续输入或确认。",
          executedTools,
          executedWorkflows,
          toolResults,
          needsUserInput: Boolean(result.needsInput),
          missingInputs: result.missingInputs,
          confirmationRequest: result.confirmationRequired ? workflow.name : undefined,
          pendingAction: session.pending,
        };
      }
      executedWorkflows.push(workflow.name);
      toolResults.push({ toolName: workflow.name, arguments: pending.arguments, result });
      session.messages.push({
        role: "tool",
        toolCallId: pending.callId,
        name: workflow.name,
        content: JSON.stringify(result),
      });
      return null;
    }

    return null;
  }
}

export async function runAgentTurn(input: {
  projectName: string;
  message: string;
  sessionId?: string;
}): Promise<AgentRunResult> {
  const config = loadAgentConfig();
  if (!config) {
    throw new Error("未配置 LLM Provider，请先调用 configure_llm_provider");
  }
  const analysis = getProjectAnalysis(input.projectName);
  if (!analysis) {
    throw new Error(`项目 ${input.projectName} 尚未生成 Project Knowledge`);
  }
  const toolRegistry = loadToolRegistry(input.projectName);
  if (!toolRegistry || toolRegistry.tools.length === 0) {
    throw new Error(`项目 ${input.projectName} 尚未生成 Tool Registry`);
  }
  const workflowRegistry = loadWorkflowRegistry(input.projectName) || {
    schemaVersion: 1,
    projectName: input.projectName,
    projectPath: analysis.project.path,
    generatedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workflows: [],
  };
  const provider = createLLMProvider(config);
  const runtime = new AgentRuntime({
    config,
    provider,
    analysis,
    toolRegistry,
    workflowRegistry,
  });
  return runtime.chat(input.projectName, input.message, input.sessionId);
}
