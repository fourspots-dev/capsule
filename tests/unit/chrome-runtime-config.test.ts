import { describe, expect, it } from 'vitest';
import {
  parseKernelConfig,
  parseRemoteActionConfig,
  type ChromeKeyValueStorage,
} from '../../src/runtime/chrome-runtime';

class MemoryStorage implements ChromeKeyValueStorage {
  readonly values = new Map<string, unknown>();
  async get(keys: string | string[]): Promise<Record<string, unknown>> {
    return Object.fromEntries(
      (Array.isArray(keys) ? keys : [keys]).map((key) => [key, this.values.get(key)])
    );
  }
  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) this.values.set(key, value);
  }
}

describe('chrome kernel configuration', () => {
  it('normalizes the existing extension connection format', () => {
    expect(
      parseKernelConfig({
        approval: 'auto',
        connection: 'deepseek',
        model: 'deepseek-reasoner',
        connections: [
          {
            id: 'deepseek',
            'base-url': 'https://api.deepseek.com/v1/',
            'api-key': 'test-key',
            models: ['deepseek-chat'],
          },
        ],
      })
    ).toEqual({
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: 'test-key',
      model: 'deepseek-reasoner',
      approval: 'auto',
      connectionId: 'deepseek',
    });
  });

  it('rejects missing or incomplete connections with stable errors', () => {
    expect(() => parseKernelConfig({ connections: [] })).toThrowError(/Configure an OpenAI-compatible/);
    expect(() =>
      parseKernelConfig({ connections: [{ id: 'x', 'base-url': 'https://x' }] })
    ).toThrowError(/requires both base URL and API key/);
  });

  it('normalizes Remote Action endpoint and allowlist configuration', () => {
    expect(
      parseRemoteActionConfig({
        endpoint: 'https://actions.example/v1',
        token: 'token',
        allowedActionIds: ['app.test', 'app.build'],
        timeoutMs: 1000,
      })
    ).toEqual({
      endpoint: 'https://actions.example/v1',
      token: 'token',
      allowedActionIds: ['app.test', 'app.build'],
      timeoutMs: 1000,
    });
    expect(parseRemoteActionConfig({ endpoint: 'file:///tmp/action' })).toBeUndefined();
  });
});
