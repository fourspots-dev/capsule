import { AgentError } from '../core/errors';
import type {
  HostBridge,
  HostCapability,
  HostCapabilityDiagnostic,
  HostCapabilityReport,
} from './types';

const capabilityOrder: readonly HostCapability[] = [
  'storage',
  'actions',
  'interactiveActions',
  'workspace.import',
  'workspace.export',
  'workspace.picker',
  'terminal',
  'process',
  'pty',
  'network',
  'clock',
  'scheduler',
  'crypto',
  'clone',
];

export function inspectHostCapabilities(host: HostBridge): HostCapabilityReport {
  const rawDeclared: unknown = host.descriptor?.capabilities;
  const declarations = Array.isArray(rawDeclared) ? rawDeclared : [];
  const declared = [
    ...new Set(declarations.filter(isKnownCapability)),
  ];
  const available = capabilityOrder.filter((capability) =>
    isCapabilityImplemented(host, capability)
  );
  const diagnostics: HostCapabilityDiagnostic[] = [];

  if (!host.descriptor?.id?.trim()) {
    diagnostics.push({
      capability: 'storage',
      severity: 'error',
      code: 'HOST_DESCRIPTOR_INVALID',
      message: 'Host descriptor must include a non-empty id',
    });
  }
  if (!Array.isArray(rawDeclared)) {
    diagnostics.push({
      capability: 'storage',
      severity: 'error',
      code: 'HOST_DESCRIPTOR_INVALID',
      message: 'Host capabilities must be an array',
    });
  }
  const seen = new Set<string>();
  for (const capability of declarations) {
    if (!isKnownCapability(capability)) {
      diagnostics.push({
        capability: String(capability),
        severity: 'error',
        code: 'HOST_CAPABILITY_UNKNOWN',
        message: `Host declared an unknown capability: ${String(capability)}`,
      });
      continue;
    }
    if (seen.has(capability)) {
      diagnostics.push({
        capability,
        severity: 'error',
        code: 'HOST_CAPABILITY_DUPLICATE',
        message: `Host declared capability more than once: ${capability}`,
      });
    }
    seen.add(capability);
  }

  for (const capability of declared) {
    if (!available.includes(capability)) {
      diagnostics.push({
        capability,
        severity: 'error',
        code: 'HOST_CAPABILITY_MISSING',
        message: `Host declared ${capability} but did not provide its bridge`,
      });
    }
  }
  for (const capability of available) {
    if (!declared.includes(capability)) {
      diagnostics.push({
        capability,
        severity: 'warning',
        code: 'HOST_CAPABILITY_UNDECLARED',
        message: `Host provides ${capability} but did not declare it`,
      });
    }
  }

  return {
    declared,
    available,
    diagnostics,
    healthy: diagnostics.every((item) => item.severity !== 'error'),
  };
}

export function assertHostCapabilities(
  host: HostBridge,
  required: readonly HostCapability[]
): HostCapabilityReport {
  const report = inspectHostCapabilities(host);
  const invalid = report.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error'
  );
  if (invalid) {
    throw new AgentError(invalid.code, invalid.message, {
      details: { capability: invalid.capability },
    });
  }
  const missing = required.filter(
    (capability) => !report.declared.includes(capability)
  );
  if (missing.length) {
    throw new AgentError(
      'HOST_CAPABILITY_MISSING',
      `Host ${host.descriptor.id} is missing required capabilities: ${missing.join(', ')}`,
      { details: { missing } }
    );
  }
  return report;
}

export function hasHostCapability(
  host: HostBridge,
  capability: HostCapability
): boolean {
  return (
    host.descriptor.capabilities.includes(capability) &&
    isCapabilityImplemented(host, capability)
  );
}

function isCapabilityImplemented(
  host: HostBridge,
  capability: HostCapability
): boolean {
  switch (capability) {
    case 'storage':
      return Boolean(host.storage);
    case 'actions':
      return (
        typeof host.actions?.describe === 'function' &&
        typeof host.actions?.invoke === 'function'
      );
    case 'interactiveActions':
      return typeof host.interactiveActions?.open === 'function';
    case 'workspace.import':
      return typeof host.workspace?.importWorkspace === 'function';
    case 'workspace.export':
      return typeof host.workspace?.exportWorkspace === 'function';
    case 'workspace.picker':
      return typeof host.workspace?.pickWorkspace === 'function';
    case 'terminal':
      return Boolean(
        host.terminal &&
          typeof host.terminal.write === 'function' &&
          typeof host.terminal.onInput === 'function'
      );
    case 'process':
      return typeof host.process?.execute === 'function';
    case 'pty':
      return typeof host.pty?.execute === 'function';
    case 'network':
      return typeof host.network?.request === 'function';
    case 'clock':
      return Boolean(
        host.clock &&
          typeof host.clock.now === 'function' &&
          typeof host.clock.setTimeout === 'function' &&
          typeof host.clock.clearTimeout === 'function'
      );
    case 'scheduler':
      return Boolean(
        host.scheduler &&
          typeof host.scheduler.setTimeout === 'function' &&
          typeof host.scheduler.clearTimeout === 'function' &&
          typeof host.scheduler.queueMicrotask === 'function'
      );
    case 'crypto':
      return typeof host.crypto?.digest === 'function';
    case 'clone':
      return typeof host.clone?.clone === 'function';
  }
}

function isKnownCapability(value: unknown): value is HostCapability {
  return (
    typeof value === 'string' &&
    (capabilityOrder as readonly string[]).includes(value)
  );
}
