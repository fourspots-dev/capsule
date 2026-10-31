import { AgentError } from './errors';
import type { JsonValue } from './types';

export type AgentProfileSource = 'builtin' | 'user' | 'project' | 'plugin';
export type AgentContextMode = 'fresh' | 'fork' | 'artifacts';
export type AgentExecutionMode =
  | 'foreground'
  | 'background'
  | 'isolated-worktree'
  | 'sandbox';
export type AgentEffect = 'read' | 'write' | 'execute' | 'network';

export interface ToolPolicy {
  allow?: string[];
  deny?: string[];
}

export interface ModelPolicy {
  connection?: string;
  model?: string;
  temperature?: number;
}

export interface PermissionPolicy {
  capabilities: string[];
  effects: AgentEffect[];
  deniedCapabilities?: string[];
  deniedTools?: string[];
}

export interface ExecutionPolicy {
  defaultMode: AgentExecutionMode;
  allowedModes: AgentExecutionMode[];
}

export interface AgentProfile {
  name: string;
  displayName: string;
  description: string;
  instructions: string;
  source: AgentProfileSource;
  sourceId?: string;
  skills: string[];
  tools: ToolPolicy;
  mcpServers: string[];
  model?: ModelPolicy;
  permissions: PermissionPolicy;
  contextMode: AgentContextMode;
  execution: ExecutionPolicy;
  resultSchema?: Record<string, JsonValue>;
  maxDepth: number;
  maxConcurrency: number;
}

export interface TaskBudget {
  maxTurns?: number;
  maxToolCalls?: number;
  maxTokens?: number;
  deadlineMs?: number;
}

export interface ChildTaskSpec {
  parentTaskId: string;
  parentSessionId?: string;
  profile: string;
  brief: string;
  acceptance?: string[];
  contextRefs?: string[];
  budget: TaskBudget;
  contextMode: AgentContextMode;
  executionMode: AgentExecutionMode;
  resultSchema?: string;
}

export interface ResolvedAgentProfile extends AgentProfile {
  requestedName: string;
  registryRevision: number;
  effectivePermissions: {
    capabilities: string[];
    effects: AgentEffect[];
    deniedCapabilities: string[];
    deniedTools: string[];
  };
}

interface RegistryEntry {
  profile: AgentProfile;
  sourceId?: string;
}

const sourcePriority: Record<AgentProfileSource, number> = {
  builtin: 0,
  user: 1,
  project: 2,
  plugin: 3,
};

export class AgentProfileRegistry {
  private readonly entries = new Map<string, Map<AgentProfileSource, RegistryEntry>>();
  private revision = 0;

  register(profile: AgentProfile, sourceId?: string): void {
    validateProfile(profile);
    const profiles = this.entries.get(profile.name) ?? new Map<AgentProfileSource, RegistryEntry>();
    profiles.set(profile.source, {
      profile: cloneProfile(profile),
      ...(sourceId ? { sourceId } : {}),
    });
    this.entries.set(profile.name, profiles);
    this.revision += 1;
  }

  registerAll(profiles: Iterable<AgentProfile>): void {
    for (const profile of profiles) this.register(profile, profile.sourceId);
  }

  unregister(name: string, source?: AgentProfileSource): boolean {
    if (!source) {
      const removed = this.entries.delete(name);
      if (removed) this.revision += 1;
      return removed;
    }
    const profiles = this.entries.get(name);
    const removed = profiles?.delete(source) ?? false;
    if (profiles?.size === 0) this.entries.delete(name);
    if (removed) this.revision += 1;
    return removed;
  }

  get(name: string): AgentProfile | undefined {
    const entry = this.effective(name);
    return entry ? cloneProfile(entry.profile) : undefined;
  }

  resolve(
    name: string,
    parentPermissions: PermissionPolicy
  ): ResolvedAgentProfile {
    const entry = this.effective(name);
    if (!entry) {
      throw new AgentError('PROFILE_NOT_FOUND', `Agent profile not found: ${name}`);
    }
    const profile = cloneProfile(entry.profile);
    const deniedCapabilities = [
      ...new Set([
        ...(parentPermissions.deniedCapabilities ?? []),
        ...(profile.permissions.deniedCapabilities ?? []),
      ]),
    ];
    const deniedTools = [
      ...new Set([
        ...(parentPermissions.deniedTools ?? []),
        ...(profile.permissions.deniedTools ?? []),
      ]),
    ];
    const capabilities = intersection(
      parentPermissions.capabilities,
      profile.permissions.capabilities
    ).filter((capability) => !deniedCapabilities.includes(capability));
    const effects = intersection(parentPermissions.effects, profile.permissions.effects);
    return {
      ...profile,
      requestedName: name,
      registryRevision: this.revision,
      effectivePermissions: {
        capabilities,
        effects,
        deniedCapabilities,
        deniedTools,
      },
    };
  }

  validateChild(
    spec: ChildTaskSpec,
    parent: { depth: number; maxDepth: number; concurrency: number }
  ): ResolvedAgentProfile {
    const entry = this.effective(spec.profile);
    if (!entry) {
      throw new AgentError('PROFILE_NOT_FOUND', `Agent profile not found: ${spec.profile}`);
    }
    const profile = entry.profile;
    if (!spec.brief.trim()) {
      throw new AgentError('CHILD_BRIEF_EMPTY', 'Child task brief cannot be empty');
    }
    if (parent.depth >= parent.maxDepth || parent.depth >= profile.maxDepth) {
      throw new AgentError(
        'CHILD_DEPTH_EXCEEDED',
        `Child depth exceeds the allowed maximum at depth ${parent.depth}`
      );
    }
    if (parent.concurrency >= profile.maxConcurrency) {
      throw new AgentError(
        'CHILD_CONCURRENCY_EXCEEDED',
        `Profile ${profile.name} allows at most ${profile.maxConcurrency} concurrent children`
      );
    }
    if (!profile.execution.allowedModes.includes(spec.executionMode)) {
      throw new AgentError(
        'CHILD_EXECUTION_MODE_DENIED',
        `Profile ${profile.name} does not allow execution mode ${spec.executionMode}`
      );
    }
    for (const [name, value] of Object.entries(spec.budget)) {
      if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
        throw new AgentError('CHILD_BUDGET_INVALID', `Budget ${name} must be positive`);
      }
    }
    return {
      ...cloneProfile(profile),
      requestedName: spec.profile,
      registryRevision: this.revision,
      effectivePermissions: {
        capabilities: [...profile.permissions.capabilities],
        effects: [...profile.permissions.effects],
        deniedCapabilities: [...(profile.permissions.deniedCapabilities ?? [])],
        deniedTools: [...(profile.permissions.deniedTools ?? [])],
      },
    };
  }

  diagnostics(): Array<{
    name: string;
    source: AgentProfileSource;
    sourceId?: string;
    effective: boolean;
  }> {
    return [...this.entries.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([name, profiles]) => {
        const effective = this.effective(name);
        return [...profiles.values()].map((entry) => ({
          name,
          source: entry.profile.source,
          ...(entry.sourceId ? { sourceId: entry.sourceId } : {}),
          effective: entry === effective,
        }));
      });
  }

  private effective(name: string): RegistryEntry | undefined {
    const profiles = this.entries.get(name);
    if (!profiles) return undefined;
    return [...profiles.values()].sort(
      (a, b) => sourcePriority[b.profile.source] - sourcePriority[a.profile.source]
    )[0];
  }
}

function validateProfile(profile: AgentProfile): void {
  if (!profile.name.trim()) {
    throw new AgentError('PROFILE_NAME_INVALID', 'Profile name cannot be empty');
  }
  if (!Number.isInteger(profile.maxDepth) || profile.maxDepth < 0) {
    throw new AgentError('PROFILE_DEPTH_INVALID', 'Profile maxDepth must be a non-negative integer');
  }
  if (!Number.isInteger(profile.maxConcurrency) || profile.maxConcurrency < 0) {
    throw new AgentError(
      'PROFILE_CONCURRENCY_INVALID',
      'Profile maxConcurrency must be a non-negative integer'
    );
  }
  if (!profile.execution.allowedModes.includes(profile.execution.defaultMode)) {
    throw new AgentError(
      'PROFILE_EXECUTION_INVALID',
      'Profile default execution mode must be allowed'
    );
  }
}

function cloneProfile(profile: AgentProfile): AgentProfile {
  return {
    ...profile,
    skills: [...profile.skills],
    tools: {
      ...(profile.tools.allow ? { allow: [...profile.tools.allow] } : {}),
      ...(profile.tools.deny ? { deny: [...profile.tools.deny] } : {}),
    },
    mcpServers: [...profile.mcpServers],
    ...(profile.model ? { model: { ...profile.model } } : {}),
    permissions: {
      capabilities: [...profile.permissions.capabilities],
      effects: [...profile.permissions.effects],
      ...(profile.permissions.deniedCapabilities
        ? { deniedCapabilities: [...profile.permissions.deniedCapabilities] }
        : {}),
      ...(profile.permissions.deniedTools
        ? { deniedTools: [...profile.permissions.deniedTools] }
        : {}),
    },
    execution: {
      defaultMode: profile.execution.defaultMode,
      allowedModes: [...profile.execution.allowedModes],
    },
    ...(profile.resultSchema ? { resultSchema: { ...profile.resultSchema } } : {}),
  };
}

function intersection<T extends string>(left: readonly T[], right: readonly T[]): T[] {
  const allowed = new Set(right);
  return [...new Set(left)].filter((value) => allowed.has(value));
}
