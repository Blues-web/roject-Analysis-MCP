import type { Confidence } from "../analyzer/types.js";

export type WorkflowStatus = "draft" | "active" | "disabled" | "deprecated";

export type ConfirmationPolicy = "auto" | "on_risk" | "always";

export type FailureAction = "stop" | "retry" | "continue";

export interface WorkflowFailureStrategy {
  onError: FailureAction;
  retryCount?: number;
  retryDelayMs?: number;
  fallbackWorkflow?: string;
  message?: string;
}

export type WorkflowStepType =
  | "tool"
  | "condition"
  | "confirm"
  | "wait_input"
  | "continue";

export interface WorkflowConditionBranch {
  when: string;
  then: string;
  else?: string;
}

export interface WorkflowStep {
  id: string;
  type: WorkflowStepType;
  name: string;
  description?: string;
  tool?: string;
  output?: string;
  input?: Record<string, unknown>;
  requiredInputs?: string[];
  conditions?: WorkflowConditionBranch[];
  confirmationMessage?: string;
  failure?: WorkflowFailureStrategy;
  next?: string | string[];
  waitFor?: string[];
  onContinue?: string;
}

export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  confidence: Confidence;
  sourceTools: string[];
  sourcePages: Array<{
    id?: string;
    name?: string;
    route?: string;
  }>;
  module: string;
  moduleId: string;
  triggerExamples: string[];
  steps: WorkflowStep[];
  requiredInputs: string[];
  confirmationPolicy: ConfirmationPolicy;
  failureStrategy: WorkflowFailureStrategy;
  status: WorkflowStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
  sourceHash: string;
}

export interface WorkflowRegistry {
  schemaVersion: number;
  projectName: string;
  projectPath: string;
  generatedAt: string;
  updatedAt: string;
  workflows: WorkflowDefinition[];
}
