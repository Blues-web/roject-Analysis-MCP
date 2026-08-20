import type {
  AgentRuntimeConfig,
  AgentToolCall,
  AgentToolSpec,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "../agent/types.js";

function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTools(
  tools: AgentToolSpec[]
): Array<{
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: AgentToolSpec["parameters"];
  };
}> {
  return tools.map(tool => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

function chatCompletionsURL(baseURL: string): string {
  const normalized = baseURL.replace(/\/+$/, "");
  if (normalized.endsWith("/chat/completions")) return normalized;
  return `${normalized}/chat/completions`;
}

export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: AgentRuntimeConfig) {}

  async chat(
    messages: LLMMessage[],
    tools: AgentToolSpec[] = []
  ): Promise<LLMResponse> {
    const url = chatCompletionsURL(this.config.baseURL);
    const timeoutMs = this.config.timeoutMs || 60000;
    const maxRetries = Math.max(0, this.config.retryCount || 1);

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
            ...(this.config.extraHeaders || {}),
          },
          body: JSON.stringify({
            model: this.config.model,
            messages,
            tools: normalizeTools(tools),
            tool_choice: "auto",
            temperature: this.config.temperature ?? 0.2,
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(`LLM API ${response.status}: ${text.slice(0, 500)}`);
        }

        const data = (await response.json()) as {
          choices?: Array<{
            message?: {
              content?: string;
              tool_calls?: Array<{
                id?: string;
                function?: {
                  name?: string;
                  arguments?: string;
                };
              }>;
            };
          }>;
        };
        const message = data.choices?.[0]?.message;
        const toolCalls: AgentToolCall[] = (message?.tool_calls || []).flatMap(call => {
          const name = call.function?.name;
          if (!name) return [];
          return [{
            id: call.id || `call_${Date.now()}`,
            name,
            arguments: parseToolArguments(call.function?.arguments),
          }];
        });
        return {
          content: message?.content || undefined,
          toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        };
      } catch (error) {
        lastError = error;
        if (attempt < maxRetries && isRetryable(error)) {
          await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
          continue;
        }
        break;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error("LLM request failed");
  }
}

function isRetryable(error: unknown): boolean {
  return error instanceof Error && /fetch|network|timeout|abort|ECONN/i.test(error.message);
}

export function createLLMProvider(
  config: AgentRuntimeConfig
): LLMProvider {
  return new OpenAICompatibleProvider(config);
}
