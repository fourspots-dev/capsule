import type { JsonValue } from '../core/types';

export type CapabilityState = 'available' | 'degraded' | 'unavailable';

export interface CapabilityDescriptor {
  id: string;
  version: string;
  state: CapabilityState;
  limitations: string[];
  details?: JsonValue;
}

export interface CapabilityReport {
  environmentFingerprint?: string;
  capabilities: CapabilityDescriptor[];
  diagnostics: Array<{
    capabilityId: string;
    code: 'CAPABILITY_UNAVAILABLE' | 'CAPABILITY_DUPLICATE';
    message: string;
  }>;
}

export class CapabilityGraph {
  private readonly capabilities = new Map<string, CapabilityDescriptor>();
  private environmentFingerprint?: string;

  register(descriptor: CapabilityDescriptor): void {
    if (this.capabilities.has(descriptor.id)) {
      throw new Error(`Capability is already registered: ${descriptor.id}`);
    }
    this.capabilities.set(descriptor.id, {
      ...descriptor,
      limitations: [...descriptor.limitations],
    });
  }

  setEnvironmentFingerprint(value: string): void {
    this.environmentFingerprint = value;
  }

  get(id: string): CapabilityDescriptor | undefined {
    return this.capabilities.get(id);
  }

  isAvailable(id: string): boolean {
    return this.capabilities.get(id)?.state === 'available';
  }

  canUse(id: string): boolean {
    const state = this.capabilities.get(id)?.state;
    return state === 'available' || state === 'degraded';
  }

  report(): CapabilityReport {
    return {
      ...(this.environmentFingerprint
        ? { environmentFingerprint: this.environmentFingerprint }
        : {}),
      capabilities: [...this.capabilities.values()]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((descriptor) => ({
          ...descriptor,
          limitations: [...descriptor.limitations],
        })),
      diagnostics: [...this.capabilities.values()]
        .filter((descriptor) => descriptor.state === 'unavailable')
        .map((descriptor) => ({
          capabilityId: descriptor.id,
          code: 'CAPABILITY_UNAVAILABLE' as const,
          message: descriptor.limitations.join('; ') || 'Capability is unavailable',
        })),
    };
  }
}
