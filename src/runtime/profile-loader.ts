import {
  AgentProfileRegistry,
  type AgentProfile,
  type AgentProfileSource,
} from '../core/agent-profile';

const sources: AgentProfileSource[] = ['builtin', 'user', 'project', 'plugin'];

export function loadAgentProfiles(raw: unknown): AgentProfile[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
    const item = value as Record<string, unknown>;
    if (typeof item.name !== 'string' || !item.name.trim()) return [];
    const source = sources.includes(item.source as AgentProfileSource)
      ? (item.source as AgentProfileSource)
      : 'user';
    return [
      {
        name: item.name.trim(),
        displayName: stringValue(item.displayName) || item.name,
        description: stringValue(item.description),
        instructions: stringValue(item.instructions),
        source,
        ...(stringValue(item.sourceId) ? { sourceId: stringValue(item.sourceId) } : {}),
        skills: stringArray(item.skills),
        tools: {
          ...(Array.isArray(item.allowTools) ? { allow: stringArray(item.allowTools) } : {}),
          ...(Array.isArray(item.denyTools) ? { deny: stringArray(item.denyTools) } : {}),
        },
        mcpServers: stringArray(item.mcpServers),
        permissions: {
          capabilities: stringArray(item.capabilities),
          effects: ['read', 'write', 'execute', 'network'].filter((effect) =>
            stringArray(item.effects).includes(effect)
          ) as AgentProfile['permissions']['effects'],
          deniedCapabilities: stringArray(item.deniedCapabilities),
          deniedTools: stringArray(item.deniedTools),
        },
        contextMode:
          item.contextMode === 'fork' || item.contextMode === 'artifacts'
            ? item.contextMode
            : 'fresh',
        execution: {
          defaultMode:
            item.executionMode === 'background' ||
            item.executionMode === 'isolated-worktree' ||
            item.executionMode === 'sandbox'
              ? item.executionMode
              : 'foreground',
          allowedModes:
            stringArray(item.allowedModes).length > 0
              ? (stringArray(item.allowedModes).filter((mode) =>
                  ['foreground', 'background', 'isolated-worktree', 'sandbox'].includes(mode)
                ) as AgentProfile['execution']['allowedModes'])
              : ['foreground', 'background'],
        },
        ...(item.resultSchema &&
        typeof item.resultSchema === 'object' &&
        !Array.isArray(item.resultSchema)
          ? { resultSchema: structuredClone(item.resultSchema) as Record<string, import('../core/types').JsonValue> }
          : {}),
        maxDepth: positiveInteger(item.maxDepth, 1),
        maxConcurrency: positiveInteger(item.maxConcurrency, 1),
      },
    ];
  });
}

export function createDefaultProfileRegistry(extra: AgentProfile[] = []): AgentProfileRegistry {
  const registry = new AgentProfileRegistry();
  registry.register(
    {
      name: 'general',
      displayName: 'General browser worker',
      description: 'A generic browser task worker with no role-specific assumptions.',
      instructions:
        'Work only from the delegated brief. Use browser tools to observe before acting. Return concise evidence and unresolved items.',
      source: 'builtin',
      skills: [],
      tools: {},
      mcpServers: [],
      permissions: {
        capabilities: [
          'browser:read',
          'browser:navigate',
          'browser:interact',
          'browser:script',
          'browser:network',
          'extension:skills',
          'mcp:call',
        ],
        effects: ['read', 'write', 'execute', 'network'],
      },
      contextMode: 'fresh',
      execution: {
        defaultMode: 'foreground',
        allowedModes: ['foreground', 'background'],
      },
      maxDepth: 2,
      maxConcurrency: 2,
    },
    'tinyai'
  );
  for (const profile of extra) registry.register(profile, profile.sourceId);
  return registry;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
}
