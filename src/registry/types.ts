import type { ApiParamSource, Confidence } from "../analyzer/types.js";

export type ToolRiskLevel = "read" | "low" | "medium" | "high" | "critical";

export type ToolStatus = "draft" | "active" | "disabled" | "deprecated";

export interface JsonSchema {
  type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  format?: string;
  enum?: string[];
  additionalProperties?: boolean;
}

export interface RequestMapping {
  toolParam: string;
  apiParam: string;
  location: ApiParamSource;
  required: boolean;
  description?: string;
}

export interface ApiMapping {
  capabilityId: string;
  apiId: string;
  method: string;
  path: string;
  baseUrlMode: "original_system";
  requestMapping: RequestMapping[];
  responseMapping: {
    container?: string;
    listField?: string;
    objectField?: string;
    raw?: boolean;
  };
  sourceFiles: string[];
  callerFunctions: string[];
  alternativeApis: Array<{
    apiId: string;
    method: string;
    path: string;
  }>;
}

export interface RelatedPageRef {
  id?: string;
  name?: string;
  route?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  confidence: Confidence;
  module: string;
  moduleId: string;
  businessPurpose: string;
  sourceFiles: string[];
  sourceApis: Array<{
    apiId: string;
    method: string;
    path: string;
  }>;
  sourcePages: RelatedPageRef[];
  sourceMethods: string[];
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  apiMapping: ApiMapping;
  permission?: string;
  riskLevel: ToolRiskLevel;
  requiresConfirmation: boolean;
  preconditions: string[];
  postconditions: string[];
  relatedTools: string[];
  relatedPages: RelatedPageRef[];
}

export interface RegisteredTool extends ToolDefinition {
  id: string;
  sourceCapabilityId: string;
  sourceHash: string;
  status: ToolStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolRegistry {
  schemaVersion: number;
  projectName: string;
  projectPath: string;
  generatedAt: string;
  updatedAt: string;
  tools: RegisteredTool[];
}
