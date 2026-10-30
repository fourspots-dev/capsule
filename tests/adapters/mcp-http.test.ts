import { describe, expect, it, vi } from 'vitest';
import {
  HttpMcpClient,
  HttpMcpTransport,
  type McpTransport,
} from '../../src/adapters/mcp-http';

describe('HTTP MCP adapter', () => {
  it('initializes, discovers tools and exposes namespaced ToolDefinitions', async () => {
    const calls: Array<{ method: string; params: any }> = [];
    const transport: McpTransport = {
      request: vi.fn(async (method, params) => {
        calls.push({ method, params });
        if (method === 'initialize') return { protocolVersion: '2025-03-26' } as any;
        if (method === 'tools/list') {
          return {
            tools: [
              {
                name: 'lookup/docs',
                description: 'Look up docs',
                inputSchema: {
                  type: 'object',
                  properties: { query: { type: 'string' } },
                  required: ['query'],
                },
              },
            ],
          } as any;
        }
        if (method === 'tools/call') return { content: [{ type: 'text', text: 'found' }] } as any;
        return null;
      }) as McpTransport['request'],
      close: vi.fn(async () => undefined),
    };
    const client = new HttpMcpClient(transport, 'docs');
    await client.initialize();
    const tools = await client.definitions();
    expect(tools[0]).toMatchObject({
      name: 'docs__lookup_docs',
      risk: 'write',
      effect: 'network',
      capabilities: ['mcp:call'],
    });
    const output = await tools[0].execute(
      { query: 'agent' },
      {
        sessionId: 's',
        taskId: 't',
        call: { id: 'c', name: tools[0].name, arguments: '{}' },
        signal: new AbortController().signal,
      }
    );
    expect(output).toMatchObject({ content: [{ text: 'found' }] });
    expect(calls.at(-1)).toEqual({
      method: 'tools/call',
      params: { name: 'lookup/docs', arguments: { query: 'agent' } },
    });
  });

  it('carries MCP sessions and converts JSON-RPC errors', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response('{"jsonrpc":"2.0","id":1,"result":{"ok":true}}', {
          status: 200,
          headers: { 'mcp-session-id': 'session_1', 'content-type': 'application/json' },
        })
      )
      .mockResolvedValueOnce(
        new Response('{"jsonrpc":"2.0","id":2,"error":{"code":-32601,"message":"missing"}}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      );
    const transport = new HttpMcpTransport({
      url: 'https://mcp.example/rpc',
      fetch: fetchMock as typeof fetch,
    });
    await expect(transport.request('initialize', {})).resolves.toEqual({ ok: true });
    await expect(transport.request('tools/list', {})).rejects.toMatchObject({
      code: 'MCP_-32601',
    });
    const headers = fetchMock.mock.calls[1][1].headers as Record<string, string>;
    expect(headers['Mcp-Session-Id']).toBe('session_1');
  });
});
