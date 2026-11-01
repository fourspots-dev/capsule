import type { HostCapability } from './types';

export type BaselineTier =
  | 'core'
  | 'workspace'
  | 'portable-coding'
  | 'real-execution';

export type BaselineProfileId =
  | 'tui-local'
  | 'chrome'
  | 'ios'
  | 'sandbox'
  | 'memory';

export interface HostBaselineProfile {
  id: BaselineProfileId;
  label: string;
  requiredTiers: readonly BaselineTier[];
  requiredHostCapabilities: readonly HostCapability[];
  optionalHostCapabilities: readonly HostCapability[];
  forbiddenActionPrefixes: readonly string[];
}

const portableProfile = (
  id: BaselineProfileId,
  label: string,
  options: {
    requiredHostCapabilities?: readonly HostCapability[];
    optionalHostCapabilities?: readonly HostCapability[];
  } = {}
): HostBaselineProfile => ({
  id,
  label,
  requiredTiers: ['core', 'workspace', 'portable-coding'],
  requiredHostCapabilities: options.requiredHostCapabilities ?? [],
  optionalHostCapabilities: options.optionalHostCapabilities ?? [
    'actions',
    'interactiveActions',
    'network',
    'terminal',
    'process',
    'pty',
  ],
  forbiddenActionPrefixes: [
    'host.storage',
    'host.filesystem',
    'host.clock',
    'host.scheduler',
    'host.crypto',
    'host.session',
  ],
});

export const HOST_BASELINE_PROFILES: Readonly<
  Record<BaselineProfileId, HostBaselineProfile>
> = Object.freeze({
  'tui-local': portableProfile('tui-local', 'Local TUI'),
  chrome: portableProfile('chrome', 'Chrome extension'),
  ios: portableProfile('ios', 'iOS native host'),
  sandbox: portableProfile('sandbox', 'Restricted sandbox'),
  memory: portableProfile('memory', 'Memory/test host'),
});

export function hostBaselineProfile(id: string): HostBaselineProfile {
  const profile = HOST_BASELINE_PROFILES[id as BaselineProfileId];
  if (!profile) {
    throw new Error(`Unknown host baseline profile: ${id}`);
  }
  return profile;
}
