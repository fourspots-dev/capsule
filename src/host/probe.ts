import { HostActionRegistry } from '../platform/host-action';
import type {
  HostBridge,
  HostCapability,
} from './types';

export interface ProbedHostCapability {
  id: HostCapability;
  version: string;
  state: 'available' | 'degraded' | 'unavailable';
  limitations: string[];
  latencyMs: number;
  details?: Record<string, unknown>;
}

export interface ProbedHostReport {
  hostId: string;
  environmentFingerprint: string;
  capabilities: ProbedHostCapability[];
  diagnosticErrors: Array<{ capability: string; message: string }>;
}

export async function probeHostCapabilities(
  host: HostBridge
): Promise<ProbedHostReport> {
  const capabilities: ProbedHostCapability[] = [];
  const diagnosticErrors: Array<{ capability: string; message: string }> = [];
  const declared = [...new Set(host.descriptor.capabilities)].sort();

  for (const capability of declared) {
    const started = performanceNow();
    if (capability === 'actions') {
      const registry = new HostActionRegistry();
      if (!host.actions) {
        capabilities.push({
          id: capability,
          version: '1',
          state: 'unavailable',
          limitations: ['Action provider is missing'],
          latencyMs: performanceNow() - started,
        });
        continue;
      }
      registry.register(host.descriptor.id, host.actions);
      const report = await registry.discover();
      const unavailable = report.diagnostics.filter(
        (item) => item.code === 'ACTION_PROBE_FAILED'
      );
      capabilities.push({
        id: capability,
        version: '1',
        state:
          report.available.length > 0
            ? unavailable.length > 0
              ? 'degraded'
              : 'available'
            : 'unavailable',
        limitations: unavailable.map((item) => item.message),
        latencyMs: performanceNow() - started,
        details: {
          actionIds: report.available.map((item) => item.descriptor.id),
        },
      });
      continue;
    }

    const result = await probeStructure(host, capability);
    capabilities.push({
      ...result,
      latencyMs: performanceNow() - started,
    });
    if (result.state === 'unavailable') {
      diagnosticErrors.push({
        capability,
        message: result.limitations.join('; '),
      });
    }
  }

  const fingerprintSource = JSON.stringify(
    capabilities.map((capability) => ({
      id: capability.id,
      version: capability.version,
      state: capability.state,
      limitations: capability.limitations,
      details: capability.details,
    }))
  );
  const environmentFingerprint = await digestText(
    host,
    new TextEncoder().encode(fingerprintSource)
  );
  return {
    hostId: host.descriptor.id,
    environmentFingerprint,
    capabilities,
    diagnosticErrors,
  };
}

async function probeStructure(
  host: HostBridge,
  capability: HostCapability
): Promise<Omit<ProbedHostCapability, 'latencyMs'>> {
  switch (capability) {
    case 'storage':
      if (!host.storage) return unavailable(capability, 'Storage bridge is missing');
      await host.storage.get('__tinyai_probe__');
      return available(capability);
    case 'filesystem':
      if (!host.filesystem) {
        return unavailable(capability, 'Filesystem bridge is missing');
      }
      await host.filesystem.stat('');
      return available(capability);
    case 'clock':
      if (!host.clock || !Number.isFinite(host.clock.now())) {
        return unavailable(capability, 'Clock bridge is missing');
      }
      return available(capability);
    case 'scheduler':
      if (
        !host.scheduler ||
        typeof host.scheduler.queueMicrotask !== 'function'
      ) {
        return unavailable(capability, 'Scheduler bridge is missing');
      }
      return available(capability);
    case 'crypto':
      if (!host.crypto) return unavailable(capability, 'Crypto bridge is missing');
      await host.crypto.digest('SHA-256', new Uint8Array());
      return available(capability);
    case 'clone':
      if (!host.clone) return unavailable(capability, 'Clone bridge is missing');
      return available(capability);
    case 'terminal':
      return host.terminal
        ? available(capability)
        : unavailable(capability, 'Terminal bridge is missing');
    case 'process':
      return host.process
        ? available(capability, ['app-opt-in-required'])
        : unavailable(capability, 'Process bridge is missing');
    case 'pty':
      return host.pty
        ? available(capability, ['app-opt-in-required'])
        : unavailable(capability, 'PTY bridge is missing');
    case 'network':
      return host.network
        ? available(capability)
        : unavailable(capability, 'Network bridge is missing');
    case 'workspace.import':
      return typeof host.workspace?.importWorkspace === 'function'
        ? available(capability)
        : unavailable(capability, 'Workspace import bridge is missing');
    case 'workspace.export':
      return typeof host.workspace?.exportWorkspace === 'function'
        ? available(capability)
        : unavailable(capability, 'Workspace export bridge is missing');
    case 'workspace.picker':
      return typeof host.workspace?.pickWorkspace === 'function'
        ? available(capability)
        : unavailable(capability, 'Workspace picker bridge is missing');
    case 'actions':
      return unavailable(
        capability,
        'Actions must be discovered through HostActionRegistry'
      );
    case 'interactiveActions':
      return host.interactiveActions
        ? available(capability, ['app-opt-in-required'])
        : unavailable(capability, 'Interactive action provider is missing');
  }
}

function available(
  id: HostCapability,
  limitations: string[] = []
): Omit<ProbedHostCapability, 'latencyMs'> {
  return { id, version: '1', state: 'available', limitations };
}

function unavailable(
  id: HostCapability,
  limitation: string
): Omit<ProbedHostCapability, 'latencyMs'> {
  return { id, version: '1', state: 'unavailable', limitations: [limitation] };
}

async function digestText(host: HostBridge, value: Uint8Array): Promise<string> {
  const digest = host.crypto
    ? await host.crypto.digest('SHA-256', value)
    : globalThis.crypto?.subtle
      ? new Uint8Array(
          await globalThis.crypto.subtle.digest(
            'SHA-256',
            value.buffer.slice(
              value.byteOffset,
              value.byteOffset + value.byteLength
            ) as ArrayBuffer
          )
        )
      : value;
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function performanceNow(): number {
  return globalThis.performance?.now?.() ?? Date.now();
}
