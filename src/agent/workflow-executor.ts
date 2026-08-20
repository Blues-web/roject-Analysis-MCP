import type { RegisteredTool } from "../registry/types.js";
import type { WorkflowDefinition } from "../workflow/types.js";
import type {
  AgentRuntimeConfig,
  ExecutionResult,
  PendingWorkflowState,
} from "./types.js";

export type ToolExecutor = (
  tool: RegisteredTool,
  args: Record<string, unknown>,
  config: AgentRuntimeConfig
) => Promise<ExecutionResult>;

function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current && typeof current === "object" && key in (current as Record<string, unknown>)) {
      return (current as Record<string, unknown>)[key];
    }
    return undefined;
  }, value);
}

function resolveInput(
  input: Record<string, unknown> | undefined,
  variables: Record<string, unknown>,
  args: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input || {})) {
    if (typeof raw !== "string") {
      result[key] = raw;
      continue;
    }
    if (raw.startsWith("$input.")) {
      const name = raw.slice(7);
      result[key] = args[name] ?? variables[name];
      continue;
    }
    if (raw.startsWith("$")) {
      const path = raw.slice(1);
      result[key] = getPath(variables, path);
      continue;
    }
    result[key] = raw;
  }
  return result;
}

function findStepIndex(
  workflow: WorkflowDefinition,
  stepIdOrName: string
): number {
  const index = workflow.steps.findIndex(
    step => step.id === stepIdOrName || step.name === stepIdOrName
  );
  return index >= 0 ? index : 0;
}

export async function executeWorkflow(
  workflow: WorkflowDefinition,
  args: Record<string, unknown>,
  config: AgentRuntimeConfig,
  tools: RegisteredTool[],
  executor: ToolExecutor,
  state?: PendingWorkflowState
): Promise<ExecutionResult> {
  const variables: Record<string, unknown> = {
    ...(state?.variables || {}),
    ...args,
  };
  const stepResults: Record<string, unknown> = {
    ...(state?.stepResults || {}),
  };
  let confirmed = Boolean(state?.confirmed);
  let index = state?.stepIndex || 0;

  const currentState = (): PendingWorkflowState => ({
    stepIndex: index,
    variables,
    stepResults,
    confirmed,
  });

  while (index < workflow.steps.length) {
    const step = workflow.steps[index];
    const next = step.next;

    if (step.type === "wait_input") {
      const missing = (workflow.requiredInputs || []).filter(
        name => args[name] === undefined || args[name] === null || args[name] === ""
      );
      if (missing.length > 0) {
        return {
          success: false,
          workflowName: workflow.name,
          needsInput: true,
          missingInputs: missing,
          workflowState: currentState(),
          message: `Workflow ${workflow.name} 需要补充参数: ${missing.join(", ")}`,
        };
      }
    }

    if (step.type === "confirm") {
      if (!confirmed) {
        return {
          success: false,
          workflowName: workflow.name,
          confirmationRequired: true,
          workflowState: {
            ...currentState(),
            confirmed: true,
            stepIndex: index + 1,
          },
          message: step.confirmationMessage || `请确认执行 ${workflow.name}`,
        };
      }
    }

    if (step.type === "condition") {
      const decision = String(args.decision || args.choice || "").toLowerCase();
      if (/(approve|pass|yes|通过|同意)/.test(decision)) {
        const branch = step.conditions?.[0]?.then || step.conditions?.[0]?.else;
        if (branch) index = findStepIndex(workflow, branch);
        else index += 1;
        continue;
      }
      if (/(reject|refuse|no|驳回|拒绝)/.test(decision)) {
        const branch = step.conditions?.[0]?.else || step.conditions?.[0]?.then;
        if (branch) index = findStepIndex(workflow, branch);
        else index += 1;
        continue;
      }
      return {
        success: false,
        workflowName: workflow.name,
        needsInput: true,
        missingInputs: ["decision"],
        workflowState: currentState(),
        message: `Workflow ${workflow.name} 需要选择审批结果`,
      };
    }

    if (step.type === "tool") {
      const tool = tools.find(item => item.name === step.tool);
      if (!tool) {
        return {
          success: false,
          workflowName: workflow.name,
          error: `Workflow ${workflow.name} 引用了不存在的 Tool ${step.tool}`,
          workflowState: currentState(),
        };
      }
      const input = resolveInput(step.input, variables, args);
      const result = await executor(tool, input, config);
      stepResults[step.tool || step.id] = result;
      if (!result.success) {
        if (result.needsInput) {
          return {
            ...result,
            workflowName: workflow.name,
            workflowState: currentState(),
          };
        }
        if (result.confirmationRequired) {
          return {
            ...result,
            workflowName: workflow.name,
            workflowState: currentState(),
          };
        }
        return {
          success: false,
          workflowName: workflow.name,
          error: result.error || `Tool ${step.tool} 执行失败`,
          workflowState: currentState(),
        };
      }
      if (step.output) {
        variables[step.output] = result.data;
      }
    }

    if (typeof next === "string") {
      index = findStepIndex(workflow, next);
      continue;
    }
    if (Array.isArray(next)) {
      index += 1;
      continue;
    }
    index += 1;
  }

  return {
    success: true,
    workflowName: workflow.name,
    data: { variables, stepResults },
    message: `Workflow ${workflow.name} 执行完成`,
  };
}
