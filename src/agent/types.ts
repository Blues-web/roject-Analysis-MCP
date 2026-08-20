import type { JsonSchema } from "../registry/types.js";

export type AgentProviderType = "openai" | "openai-compatible" | string;

export interface AgentRuntimeConfig {
  provider: AgentProviderType;
  baseURL: string;
  apiKey: string;
  model: string;
  apiBaseURL?: string;
  apiToken?: string;
  extraHeaders?: Record<string, string>;
  allowedPermissions?: string[];
  maxIterations?: number;
  timeoutMs?: number;
  temperature?: number;
  retryCount?: number;
}

export type AgentRole = "system" | "user" | "assistant" | "tool";

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface AgentMessage {
  role: AgentRole;
  content?: string;
  toolCalls?: AgentToolCall[];
  toolCallId?: string;
  name?: string;
}

export interface LLMMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface LLMResponse {
  content?: string;
  toolCalls?: AgentToolCall[];
}

export interface LLMProvider {
  chat(
    messages: LLMMessage[],
    tools?: AgentToolSpec[]
  ): Promise<LLMResponse>;
}

export interface AgentToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface PendingWorkflowState {
  stepIndex: number;
  variables: Record<string, unknown>;
  stepResults: Record<string, unknown>;
  confirmed?: boolean;
}

export interface PendingAction {
  kind: "tool" | "workflow";
  toolName?: string;
  workflowName?: string;
  callId?: string;
  arguments: Record<string, unknown>;
  confirm?: boolean;
  missingInputs?: string[];
  workflowState?: PendingWorkflowState;
  message?: string;
}

export interface AgentSession {
  id: string;
  projectName: string;
  createdAt: string;
  updatedAt: string;
  messages: AgentMessage[];
  pending?: PendingAction;
}

export interface ExecutionResult {
  success: boolean;
  toolName?: string;
  workflowName?: string;
  data?: unknown;
  error?: string;
  httpStatus?: number;
  durationMs?: number;
  needsInput?: boolean;
  missingInputs?: string[];
  confirmationRequired?: boolean;
  workflowState?: PendingWorkflowState;
  message?: string;
}

export interface AgentRunResult {
  sessionId: string;
  reply: string;
  executedTools: string[];
  executedWorkflows: string[];
  toolResults?: Array<{
    toolName: string;
    arguments?: Record<string, unknown>;
    result: ExecutionResult;
  }>;
  needsUserInput?: boolean;
  missingInputs?: string[];
  confirmationRequest?: string;
  pendingAction?: PendingAction;
}

export type ExecutionLogType =
  | "user"
  | "llm"
  | "tool_call"
  | "workflow"
  | "confirmation"
  | "error";

export interface ExecutionLogEntry {
  id: string;
  sessionId: string;
  projectName: string;
  timestamp: string;
  type: ExecutionLogType;
  message: string;
  details?: Record<string, unknown>;
}

export interface AgentToolContext {
  tools: Array<{
    name: string;
    description: string;
    inputSchema: JsonSchema;
    permission?: string;
    riskLevel: string;
    requiresConfirmation: boolean;
  }>;
  workflows: Array<{
    name: string;
    description: string;
    requiredInputs: string[];
    confirmationPolicy: string;
  }>;
}
