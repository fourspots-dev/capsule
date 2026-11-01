import { describe, expect, it } from 'vitest';
import {
  assertHostBaseline,
  baselineProfiles,
  HOST_BASELINE_PROFILES,
  MemoryHostBridge,
  probeHostBaseline,
  type HostBridge,
  type HostFileSystemBridge,
} from '../../src/host';
import type { AvailableHostAction } from '../../src/platform/host-action';

describe('REQ-HOST-002 host baseline matrix', () => {
  it('keeps portable coding available without execution and probes without side effects', async () => {
    const host = new MemoryHostBridge();
    const before = performance.now();
    const report = probeHostBaseline(host, 'memory', {
      workspaceStorage: 'storage-backed',
      availableActions: [],
    });
    expect(performance.now() - before).toBeLessThan(500);
    expect(report.tierState).toEqual({
      core: 'available',
      workspace: 'available',
      'portable-coding': 'available',
      'real-execution': 'degraded',
    });
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'HOST_EXECUTION_DEGRADED',
        severity: 'warning',
      })
    );
    expect(report.healthy).toBe(true);
    expect((await host.storage!.list?.()) ?? []).toEqual([]);
  });

  it('fails core startup when a mandatory host port is missing', () => {
    const base = new MemoryHostBridge();
    const host: HostBridge = {
      descriptor: {
        id: 'missing-clock',
        capabilities: ['storage', 'scheduler', 'crypto'],
      },
      storage: base.storage,
      scheduler: base.scheduler,
      crypto: base.crypto,
    };
    expect(() =>
      assertHostBaseline(host, 'sandbox', {
        workspaceStorage: 'storage-backed',
      })
    ).toThrow(/core baseline/i);
  });

  it('requires a filesystem bridge when the workspace uses host-fs', () => {
    const memory = new MemoryHostBridge();
    expect(() =>
      assertHostBaseline(memory, 'tui-local', {
        workspaceStorage: 'host-fs',
      })
    ).toThrow(/workspace baseline/i);

    const filesystem = fakeFileSystem();
    const host = new MemoryHostBridge({
      filesystem,
      descriptor: {
        capabilities: [
          'storage',
          'filesystem',
          'clock',
          'scheduler',
          'crypto',
          'clone',
        ],
      },
    });
    expect(
      assertHostBaseline(host, 'tui-local', {
        workspaceStorage: 'host-fs',
      }).tierState.workspace
    ).toBe('available');
  });

  it('rejects Actions that attempt to replace host baseline ports', () => {
    const report = probeHostBaseline(new MemoryHostBridge(), 'ios', {
      workspaceStorage: 'storage-backed',
      availableActions: [
        action({
          id: 'host.filesystem.mobile',
          version: '1.0.0',
          title: 'Fake filesystem',
          description: 'Forbidden substitution.',
          inputSchema: { type: 'object', properties: {} },
          effects: ['read'],
          risk: 'read',
          probe: async () => ({ state: 'available' }),
        }),
      ],
    });
    expect(report.healthy).toBe(false);
    expect(report.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'HOST_ACTION_SUBSTITUTION_FORBIDDEN',
        severity: 'error',
      })
    );
  });

  it('uses one stable matrix across TUI, Chrome, iOS, sandbox and memory', () => {
    const profiles = baselineProfiles();
    expect(profiles.map((profile) => profile.id).sort()).toEqual([
      'chrome',
      'ios',
      'memory',
      'sandbox',
      'tui-local',
    ]);
    for (const profile of profiles) {
      expect(profile.requiredTiers).toEqual([
        'core',
        'workspace',
        'portable-coding',
      ]);
      expect(profile.forbiddenActionPrefixes).toContain('host.storage');
    }
    expect(HOST_BASELINE_PROFILES.chrome.requiredTiers).toEqual(
      HOST_BASELINE_PROFILES['tui-local'].requiredTiers
    );
  });

  it('rejects unknown profiles and can re-probe the same host deterministically', () => {
    const host = new MemoryHostBridge();
    expect(() =>
      probeHostBaseline(host, 'unknown', {
        workspaceStorage: 'storage-backed',
      })
    ).toThrow(/unknown host baseline profile/i);
    const first = probeHostBaseline(host, 'chrome', {
      workspaceStorage: 'storage-backed',
    });
    const second = probeHostBaseline(host, 'chrome', {
      workspaceStorage: 'storage-backed',
    });
    expect(second.tierState).toEqual(first.tierState);
    expect(second.hostCapabilities.available).toEqual(
      first.hostCapabilities.available
    );
  });
});

function action(
  descriptor: AvailableHostAction['descriptor']
): AvailableHostAction {
  return {
    descriptor,
    sourceId: 'test',
    probe: { state: 'available' },
  };
}

function fakeFileSystem(): HostFileSystemBridge {
  return {
    read: async () => new Uint8Array(),
    write: async () => undefined,
    list: async () => [],
    stat: async () => ({ kind: 'directory' }),
  };
}
