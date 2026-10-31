import { describe, expect, it } from 'vitest';
import {
  assertHostCapabilities,
  hasHostCapability,
  inspectHostCapabilities,
  MemoryHostBridge,
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
});
