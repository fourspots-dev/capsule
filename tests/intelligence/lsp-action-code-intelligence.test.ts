import { describe, expect, it, vi } from 'vitest';
import { LspActionCodeIntelligence } from '../../src/adapters/lsp-action-code-intelligence';
import {
  HostActionRegistry,
  type HostActionProvider,
} from '../../src/platform/host-action';

describe('REQ-LSP-001 LSP Action adapter', () => {
  it('maps semantic operations to one named Action', async () => {
    const invoke = vi.fn(async (_id, input) => {
      const operation = (input as { operation: string }).operation;
      if (operation === 'diagnostics') {
        return {
          value: {
            diagnostics: [
              {
                path: 'src/a.ts',
                severity: 'warning',
                message: 'unused value',
              },
            ],
          },
        };
      }
      if (operation === 'symbols') {
        return {
          value: {
            symbols: [
              {
                name: 'run',
                kind: 'function',
                path: 'src/a.ts',
                range: {
                  startLine: 1,
                  startColumn: 1,
                  endLine: 1,
                  endColumn: 4,
                },
              },
            ],
          },
        };
      }
      return {
        value: {
          locations: [
            {
              path: 'src/a.ts',
              symbol: 'run',
              range: {
                startLine: 1,
                startColumn: 1,
                endLine: 1,
                endColumn: 4,
              },
            },
          ],
        },
      };
    });
    const registry = new HostActionRegistry();
    registry.register('lsp', {
      describe: async () => [
        {
          id: 'code.lsp.query',
          version: '1.0.0',
          title: 'LSP query',
          description: 'Query language intelligence.',
          inputSchema: { type: 'object', properties: {} },
          effects: ['read'],
          risk: 'read',
          probe: async () => ({ state: 'available' }),
        },
      ],
      invoke: invoke as unknown as HostActionProvider['invoke'],
    });
    const intelligence = new LspActionCodeIntelligence(registry);
    expect(await intelligence.capabilities()).toMatchObject({
      provider: 'lsp',
      diagnostics: true,
    });
    expect(await intelligence.diagnostics(['src/a.ts'])).toHaveLength(1);
    expect(await intelligence.symbols('run')).toHaveLength(1);
    expect(await intelligence.definition('run')).toHaveLength(1);
    expect(invoke.mock.calls[0][1]).toMatchObject({
      operation: 'diagnostics',
      paths: ['src/a.ts'],
    });
  });
});
