import { AgentError } from '../core/errors';
import type {
  AvailableHostAction,
  HostActionDiagnostic,
} from '../platform/host-action';
import {
  hostBaselineProfile,
  HOST_BASELINE_PROFILES,
  type BaselineProfileId,
  type BaselineTier,
  type HostBaselineProfile,
} from './profile-matrix';
import { inspectHostCapabilities } from './capabilities';
import type {
  HostBridge,
  HostCapability,
  HostCapabilityReport,
} from './types';

export type HostWorkspaceStorageMode =
  | 'host-fs'
  | 'storage-backed'
  | 'package-memory';

export interface HostBaselineProbeOptions {
  workspaceStorage: HostWorkspaceStorageMode;
  portableRuntime?: boolean;
  availableActions?: readonly AvailableHostAction[];
  actionDiagnostics?: readonly HostActionDiagnostic[];
}

export interface HostBaselineDiagnostic {
  code:
    | 'HOST_BASELINE_MISSING'
    | 'HOST_PROFILE_UNKNOWN'
    | 'HOST_PROFILE_INCOMPATIBLE'
    | 'HOST_ACTION_SUBSTITUTION_FORBIDDEN'
    | 'HOST_EXECUTION_DEGRADED';
  severity: 'error' | 'warning';
  tier?: BaselineTier;
  capability?: string;
  message: string;
}

export interface HostBaselineReport {
  profile: HostBaselineProfile;
  tierState: Record<BaselineTier, 'available' | 'degraded' | 'unavailable'>;
  hostCapabilities: HostCapabilityReport;
  availableActionIds: string[];
  diagnostics: HostBaselineDiagnostic[];
  healthy: boolean;
}

export function probeHostBaseline(
  host: HostBridge,
  profileId: BaselineProfileId | string,
  options: HostBaselineProbeOptions
): HostBaselineReport {
  let profile: HostBaselineProfile;
  try {
    profile = hostBaselineProfile(profileId);
  } catch {
    throw new AgentError(
      'HOST_PROFILE_UNKNOWN',
      `Unknown host baseline profile: ${profileId}`
    );
  }

  const hostCapabilities = inspectHostCapabilities(host);
  const available = new Set(hostCapabilities.available);
  const declared = new Set(hostCapabilities.declared);
  const diagnostics: HostBaselineDiagnostic[] = [];
  const coreCapabilities: HostCapability[] = [
    'storage',
    'clock',
    'scheduler',
    'crypto',
  ];
  const missingCore = coreCapabilities.filter(
    (capability) => !available.has(capability) || !declared.has(capability)
  );
  if (missingCore.length) {
    diagnostics.push({
      code: 'HOST_BASELINE_MISSING',
      severity: 'error',
      tier: 'core',
      capability: missingCore[0],
      message: `Core baseline is missing: ${missingCore.join(', ')}`,
    });
  }

  const missingRequired = profile.requiredHostCapabilities.filter(
    (capability) => !available.has(capability) || !declared.has(capability)
  );
  if (missingRequired.length) {
    diagnostics.push({
      code: 'HOST_BASELINE_MISSING',
      severity: 'error',
      capability: missingRequired[0],
      message: `Profile ${profile.id} requires: ${missingRequired.join(', ')}`,
    });
  }

  const workspaceAvailable = workspaceBaselineAvailable(
    options.workspaceStorage,
    available,
    declared
  );
  if (!workspaceAvailable) {
    diagnostics.push({
      code: 'HOST_BASELINE_MISSING',
      severity: 'error',
      tier: 'workspace',
      capability:
        options.workspaceStorage === 'host-fs' ? 'filesystem' : 'storage',
      message: `Workspace baseline is unavailable in ${options.workspaceStorage} mode`,
    });
  }

  const portableAvailable =
    workspaceAvailable && (options.portableRuntime ?? true);
  if (!portableAvailable) {
    diagnostics.push({
      code: 'HOST_BASELINE_MISSING',
      severity: 'error',
      tier: 'portable-coding',
      message: 'Portable coding runtime is unavailable',
    });
  }

  const actions = options.availableActions ?? [];
  const actionIds = actions.map((action) => action.descriptor.id).sort();
  for (const actionId of actionIds) {
    const prefix = profile.forbiddenActionPrefixes.find(
      (candidate) => actionId === candidate || actionId.startsWith(`${candidate}.`)
    );
    if (prefix) {
      diagnostics.push({
        code: 'HOST_ACTION_SUBSTITUTION_FORBIDDEN',
        severity: 'error',
        capability: actionId,
        message: `Action ${actionId} cannot substitute host baseline capability ${prefix}`,
      });
    }
  }
  if (hostCapabilities.diagnostics.some((item) => item.severity === 'error')) {
    diagnostics.push({
      code: 'HOST_PROFILE_INCOMPATIBLE',
      severity: 'error',
      message: 'Host capability declarations are inconsistent with their implementations',
    });
  }

  const executionAvailable = actions.some((action) =>
    action.descriptor.effects.includes('execute')
  );
  if (!executionAvailable) {
    diagnostics.push({
      code: 'HOST_EXECUTION_DEGRADED',
      severity: 'warning',
      tier: 'real-execution',
      message:
        'No executable application Action is available; portable coding remains enabled',
    });
  }

  const tierState: HostBaselineReport['tierState'] = {
    core: missingCore.length ? 'unavailable' : 'available',
    workspace: workspaceAvailable ? 'available' : 'unavailable',
    'portable-coding': portableAvailable ? 'available' : 'unavailable',
    'real-execution': executionAvailable ? 'available' : 'degraded',
  };
  if (
    options.actionDiagnostics?.some(
      (diagnostic) => diagnostic.code === 'ACTION_PROBE_FAILED'
    ) &&
    tierState['real-execution'] === 'available'
  ) {
    tierState['real-execution'] = 'degraded';
  }

  return {
    profile,
    tierState,
    hostCapabilities,
    availableActionIds: actionIds,
    diagnostics,
    healthy: diagnostics.every((diagnostic) => diagnostic.severity !== 'error'),
  };
}

export function assertHostBaseline(
  host: HostBridge,
  profileId: BaselineProfileId | string,
  options: HostBaselineProbeOptions
): HostBaselineReport {
  const report = probeHostBaseline(host, profileId, options);
  for (const tier of report.profile.requiredTiers) {
    if (report.tierState[tier] === 'unavailable') {
      throw new AgentError(
        'HOST_BASELINE_MISSING',
        `Host ${host.descriptor.id} cannot satisfy ${profileId} ${tier} baseline`,
        { details: { profile: profileId, tier } }
      );
    }
  }
  const error = report.diagnostics.find(
    (diagnostic) => diagnostic.severity === 'error'
  );
  if (error) {
    throw new AgentError(error.code, error.message, {
      details: {
        profile: profileId,
        ...(error.capability ? { capability: error.capability } : {}),
        ...(error.tier ? { tier: error.tier } : {}),
      },
    });
  }
  return report;
}

export function baselineProfiles(): readonly HostBaselineProfile[] {
  return Object.values(HOST_BASELINE_PROFILES);
}

function workspaceBaselineAvailable(
  mode: HostWorkspaceStorageMode,
  available: ReadonlySet<HostCapability>,
  declared: ReadonlySet<HostCapability>
): boolean {
  switch (mode) {
    case 'host-fs':
      return available.has('filesystem') && declared.has('filesystem');
    case 'storage-backed':
      return available.has('storage') && declared.has('storage');
    case 'package-memory':
      return true;
  }
}
