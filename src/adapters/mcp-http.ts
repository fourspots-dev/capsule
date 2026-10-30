import { AgentError } from '../core/errors';
import type { JsonValue, ToolDefinition } from '../core/types';

export interface McpTransport {
  request(method: string, params: JsonValue, signal?: AbortSignal): Promise<JsonValue>;
  close(): Promise<void>;
}

export interface HttpMcpTransportOptions {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
}

export class HttpMcpTransport implements McpTransport {
  private sequence = 0;
  private sessionId?: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: HttpMcpTransportOptions) {
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async request(method: string, params: JsonValue, signal?: AbortSignal): Promise<JsonValue> {
    const response = await this.fetchImpl(this.options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
        ...this.options.headers,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: ++this.sequence,
        method,
        params,
      }),
      signal,
    });
    if (!response.ok) {
      throw new AgentError(
        `MCP_HTTP_${response.status}`,
        `MCP HTTP ${response.status}: ${(await response.text().catch(() => '')).slice(0, 500)}`
      );
    }
    this.sessionId = response.headers.get('mcp-session-id') ?? this.sessionId;
    const payload = (await response.json()) as {
      result?: JsonValue;
      error?: { code?: number; message?: string };
    };
    if (payload.error) {
      throw new AgentError(
        `MCP_${payload.error.code ?? 'ERROR'}`,
        payload.error.message ?? 'MCP request failed'
      );
    }
    return payload.result ?? null;
  }

  async close(): Promise<void> {
    this.sessionId = undefined;
  }
}

export class HttpMcpClient {
  constructor(
    private readonly transport: McpTransport,
    readonly prefix = 'mcp'
  ) {}

  async initialize(signal?: AbortSignal): Promise<void> {
    await this.transport.request(
      'initialize',
      {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'tinyai', version: '0.1.0' },
      },
      signal
    );
  }

  async tools(signal?: AbortSignal): Promise<McpToolDescriptor[]> {
    const result = await this.transport.request('tools/list', {}, signal);
    const tools = (result as { tools?: unknown })?.tools;
    if (!Array.isArray(tools)) return [];
    return tools.flatMap((tool) => {
      if (!tool || typeof tool !== 'object') return [];
      const value = tool as Record<string, unknown>;
      if (typeof value.name !== 'string') return [];
      return [
        {
          name: value.name,
          description: typeof value.description === 'string' ? value.description : '',
          inputSchema:
            value.inputSchema && typeof value.inputSchema === 'object'
              ? (value.inputSchema as Record<string, JsonValue>)
              : { type: 'object', properties: {} },
        },
      ];
    });
  }

  async call(
    name: string,
    input: JsonValue,
    signal?: AbortSignal
  ): Promise<JsonValue> {
    return this.transport.request('tools/call', { name, arguments: input }, signal);
  }

  async definitions(): Promise<ToolDefinition[]> {
    return (await this.tools()).map((tool) => ({
      name: `${this.prefix}__${sanitize(tool.name)}`,
      description: tool.description,
      parameters: tool.inputSchema,
      risk: 'write',
      effect: 'network',
      capabilities: ['mcp:call'],
      executionMode: 'sequential',
      replay: 'never',
      timeoutMs: 120_000,
      execute: async (input, invocation) =>
        this.call(tool.name, input, invocation.signal),
    }));
  }

  close(): Promise<void> {
    return this.transport.close();
  }
}

export interface McpToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
}

function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}
