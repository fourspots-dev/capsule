import { AgentError } from '../core/errors';
import type { ModelTransport } from '../core/ports';
import type {
  JsonValue,
  ModelEvent,
  ModelMessage,
  ModelRequest,
  ToolCall,
} from '../core/types';

export interface OpenAIModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

export interface OpenAIModelOptions extends OpenAIModelConfig {
  fetch?: typeof fetch;
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

interface ToolCallFragment {
  id: string;
  name: string;
  arguments: string;
}

export class OpenAIModelTransport implements ModelTransport {
  private readonly fetchImpl: FetchLike;

  constructor(private readonly options: OpenAIModelOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.completionsUrl(), {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          model: this.options.model,
          messages: request.messages.map(toOpenAIMessage),
          stream: true,
          ...(request.tools.length ? { tools: request.tools.map(toOpenAITool) } : {}),
        }),
        signal: request.signal,
      });
    } catch (error) {
      yield {
        type: 'error',
        error: {
          code: request.signal.aborted ? 'MODEL_ABORTED' : 'MODEL_TRANSPORT_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: !request.signal.aborted,
        },
      };
      return;
    }

    if (!response.ok) {
      const body = (await response.text().catch(() => '')).slice(0, 800);
      yield {
        type: 'error',
        error: {
          code: `MODEL_HTTP_${response.status}`,
          message: `Model API HTTP ${response.status}: ${body}`,
          retryable: response.status === 408 || response.status === 429 || response.status >= 500,
          details: { status: response.status },
        },
      };
      return;
    }
    if (!response.body) {
      yield {
        type: 'error',
        error: {
          code: 'MODEL_STREAM_MISSING',
          message: 'Model API returned no stream',
          retryable: true,
        },
      };
      return;
    }

    const calls = new Map<number, ToolCallFragment>();
    let emittedCalls = false;
    let emittedFinish = false;
    let buffer = '';
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        if (request.signal.aborted) {
          await reader.cancel().catch(() => undefined);
          throw new AgentError('MODEL_ABORTED', 'Model request was aborted');
        }
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const parsed = parseDataLine(line);
          if (parsed === 'done') {
            if (!emittedCalls) {
              emittedCalls = true;
              yield* emitToolCalls(calls, request.taskId);
            }
            return;
          }
          if (!parsed) continue;
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;
          if (typeof delta?.content === 'string' && delta.content) {
            yield { type: 'text_delta', text: delta.content };
          }
          for (const fragment of delta?.tool_calls ?? []) {
            const index = Number(fragment.index ?? 0);
            const current = calls.get(index) ?? {
              id: String(fragment.id ?? ''),
              name: '',
              arguments: '',
            };
            if (fragment.id) current.id = String(fragment.id);
            if (fragment.function?.name) current.name += String(fragment.function.name);
            if (fragment.function?.arguments) {
              current.arguments += String(fragment.function.arguments);
            }
            calls.set(index, current);
          }
          if (choice?.finish_reason) {
            if (!emittedCalls) {
              emittedCalls = true;
              yield* emitToolCalls(calls, request.taskId);
            }
            if (!emittedFinish) {
              emittedFinish = true;
              yield { type: 'finish', reason: String(choice.finish_reason) };
            }
          }
          if (parsed.usage) {
            yield {
              type: 'usage',
              inputTokens: Number(parsed.usage.prompt_tokens ?? 0),
              outputTokens: Number(parsed.usage.completion_tokens ?? 0),
            };
          }
        }
      }

      const tail = parseDataLine(buffer);
      if (tail && tail !== 'done') {
        const delta = tail.choices?.[0]?.delta;
        if (typeof delta?.content === 'string' && delta.content) {
          yield { type: 'text_delta', text: delta.content };
        }
      }
      if (!emittedCalls) yield* emitToolCalls(calls, request.taskId);
      if (!emittedFinish) yield { type: 'finish', reason: 'stop' };
    } catch (error) {
      if (request.signal.aborted || (error instanceof AgentError && error.code === 'MODEL_ABORTED')) {
        throw error;
      }
      yield {
        type: 'error',
        error: {
          code: 'MODEL_STREAM_FAILED',
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
        },
      };
    } finally {
      reader.releaseLock();
    }
  }

  private completionsUrl(): string {
    return `${this.options.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.options.headers,
    };
    if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
    return headers;
  }
}

function toOpenAIMessage(message: ModelMessage): Record<string, unknown> {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      content: message.content,
      ...(message.toolCalls?.length
        ? {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: call.arguments },
            })),
          }
        : {}),
    };
  }
  if (message.role === 'tool') {
    return {
      role: 'tool',
      tool_call_id: message.callId,
      name: message.name,
      content: message.content,
    };
  }
  return { role: message.role, content: message.content };
}

function toOpenAITool(tool: ModelRequest['tools'][number]): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

interface ParsedSse {
  choices?: Array<{
    delta?: {
      content?: unknown;
      tool_calls?: Array<{
        index?: unknown;
        id?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
  };
}

function parseDataLine(line: string): ParsedSse | 'done' | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith('data:')) return undefined;
  const data = trimmed.slice(5).trim();
  if (!data) return undefined;
  if (data === '[DONE]') return 'done';
  try {
    return JSON.parse(data) as ParsedSse;
  } catch {
    return undefined;
  }
}

function* emitToolCalls(
  fragments: Map<number, ToolCallFragment>,
  taskId: string
): Iterable<ModelEvent> {
  for (const [index, fragment] of [...fragments.entries()].sort(([a], [b]) => a - b)) {
    const call: ToolCall = {
      id: fragment.id || `${taskId}_tool_${index + 1}`,
      name: fragment.name,
      arguments: fragment.arguments || '{}',
    };
    yield { type: 'tool_call', call };
  }
}

export function openAIJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}
