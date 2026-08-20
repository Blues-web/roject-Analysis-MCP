import fs from "node:fs";
import path from "node:path";
import type { AgentRuntimeConfig } from "../agent/types.js";

const CONFIG_PATH = path.join(
  process.env.HOME || "/tmp",
  ".project-analysis-mcp",
  "config.json"
);

function ensureDir(): void {
  const dir = path.dirname(CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function loadAgentConfig(): AgentRuntimeConfig | null {
  if (!fs.existsSync(CONFIG_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as AgentRuntimeConfig;
  } catch {
    return null;
  }
}

export function saveAgentConfig(config: AgentRuntimeConfig): AgentRuntimeConfig {
  ensureDir();
  const tmpPath = `${CONFIG_PATH}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tmpPath, CONFIG_PATH);
  return config;
}

export function maskAgentConfig(
  config: AgentRuntimeConfig
): Omit<AgentRuntimeConfig, "apiKey"> & { apiKey: string } {
  return {
    ...config,
    apiKey: config.apiKey ? "***" : "",
  };
}
