import { describe, expect, it } from 'vitest';
import {
  assertHostCapabilities,
  hasHostCapability,
  inspectHostCapabilities,
  MemoryHostBridge,
  probeHostCapabilities,
  type HostBridge,
} from '../../src/host';

describe('host capability discovery', () => {
  it('reports a minimal in-memory host without a filesystem bridge', () => {
    const host = new MemoryHostBridge();
    const report = inspectHostCapabilities(host);

    expect(report).toMatchObject({
      healthy: true,
      diagnostics: [],
    });
    expect(report.available).toEqual([
      'storage',
      'clock',
      'scheduler',
      'crypto',
      'clone',
    ]);
    expect(hasHostCapability(host, 'process')).toBe(false);
  });

  it('rejects a capability that is declared but not implemented', () => {
    const host = new MemoryHostBridge({
      descriptor: { id: 'broken', capabilities: ['storage', 'process'] },
    });

    expect(() => assertHostCapabilities(host, ['storage'])).toThrow(
      /declared process/
    );
    expect(inspectHostCapabilities(host).diagnostics).toContainEqual(
      expect.objectContaining({
        capability: 'process',
        severity: 'error',
        code: 'HOST_CAPABILITY_MISSING',
      })
    );
  });

  it('reports undeclared implementations and refuses required capabilities', () => {
    const host: HostBridge = {
      descriptor: { id: 'minimal', capabilities: [] },
      storage: new MemoryHostBridge().storage,
    };
    const report = inspectHostCapabilities(host);

    expect(report.healthy).toBe(true);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        capability: 'storage',
        severity: 'warning',
        code: 'HOST_CAPABILITY_UNDECLARED',
      })
    );
    expect(hasHostCapability(host, 'storage')).toBe(false);
    expect(() => assertHostCapabilities(host, ['storage'])).toThrow(
      /missing required capabilities: storage/
    );
  });

  it('rejects malformed, duplicate and unknown declarations', () => {
    const duplicate = new MemoryHostBridge({
      descriptor: {
        id: 'duplicate',
        capabilities: ['storage', 'storage'] as never,
      },
    });
    expect(inspectHostCapabilities(duplicate).diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'HOST_CAPABILITY_DUPLICATE',
        severity: 'error',
      })
    );

    const unknown = new MemoryHostBridge({
      descriptor: {
        id: 'unknown',
        capabilities: ['teleport'] as never,
      },
    });
    expect(() => assertHostCapabilities(unknown, [])).toThrow(
      /unknown capability/
    );

    const malformed = {
      descriptor: { id: 'malformed', capabilities: 'storage' },
      storage: new MemoryHostBridge().storage,
    } as unknown as HostBridge;
    expect(() => assertHostCapabilities(malformed, [])).toThrow(
      /capabilities must be an array/
    );
  });

  it('probes named application actions and produces an environment fingerprint', async () => {
    const base = new MemoryHostBridge({
      descriptor: {
        id: 'action-host',
        capabilities: [
          'storage',
          'clock',
          'scheduler',
          'crypto',
          'clone',
          'actions',
        ],
      },
    });
    const host: HostBridge = {
      ...base,
      actions: {
        describe: async () => [
          {
            id: 'app.game.check',
            version: '1.0.0',
            title: 'Check game',
            description: 'Run game validation.',
            inputSchema: { type: 'object', properties: {} },
            effects: ['execute'],
            risk: 'dangerous',
            probe: async () => ({ state: 'available' }),
          },
        ],
        invoke: async () => ({ value: { passed: true } }),
      },
    };
    const report = await probeHostCapabilities(host);
    expect(report.environmentFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(report.capabilities.find((item) => item.id === 'actions')).toMatchObject({
      state: 'available',
      details: { actionIds: ['app.game.check'] },
    });
  });
});
