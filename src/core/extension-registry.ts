import { AgentError } from './errors';
import type { HookDefinition } from './hooks';
import type { JsonValue } from './types';

export type ExtensionSource = 'builtin' | 'user' | 'project' | 'plugin';

export interface SkillDefinition {
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
  arguments?: Array<{ name: string; required?: boolean; description?: string }>;
}

export interface PromptCommandDefinition {
  name: string;
  description: string;
  prompt: string;
  arguments?: string[];
}

export interface McpServerDefinition {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  url?: string;
  env?: Record<string, string>;
  capabilities?: string[];
}

export interface ThemeDefinition {
  name: string;
  variables: Record<string, string>;
}

export interface ExtensionManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  source: ExtensionSource;
  sourceId?: string;
  contentDigest?: string;
  trusted?: boolean;
  skills?: SkillDefinition[];
  commands?: PromptCommandDefinition[];
  mcpServers?: McpServerDefinition[];
  hooks?: HookDefinition[];
  themes?: ThemeDefinition[];
}

type ResourceKind = 'skill' | 'command' | 'mcp' | 'hook' | 'theme';

const sourcePriority: Record<ExtensionSource, number> = {
  builtin: 0,
  user: 1,
  project: 2,
  plugin: 3,
};

export class ExtensionRegistry {
  private readonly manifests = new Map<string, ExtensionManifest>();

  register(manifest: ExtensionManifest): void {
    if (!manifest.id.trim()) throw new AgentError('EXTENSION_ID_INVALID', 'Extension id is required');
    if (manifest.source !== 'builtin' && manifest.trusted !== true) {
      throw new AgentError(
        'EXTENSION_UNTRUSTED',
        `Extension ${manifest.id} must be explicitly trusted`
      );
    }
    this.manifests.set(manifest.id, cloneManifest(manifest));
  }

  unregister(id: string): boolean {
    return this.manifests.delete(id);
  }

  skill(name: string): SkillDefinition | undefined {
    return this.resolve('skill', name)?.resource;
  }

  command(name: string): PromptCommandDefinition | undefined {
    return this.resolve('command', name)?.resource;
  }

  mcpServer(name: string): McpServerDefinition | undefined {
    return this.resolve('mcp', name)?.resource;
  }

  theme(name: string): ThemeDefinition | undefined {
    return this.resolve('theme', name)?.resource;
  }

  hooks(): Array<{ extensionId: string; source: ExtensionSource; hook: HookDefinition }> {
    return this.sorted()
      .flatMap((manifest) =>
        (manifest.hooks ?? []).map((hook) => ({
          extensionId: manifest.id,
          source: manifest.source,
          hook,
        }))
      );
  }

  diagnostics(): Array<{
    id: string;
    name: string;
    version: string;
    source: ExtensionSource;
    contributions: Record<ResourceKind, number>;
  }> {
    return this.sorted().map((manifest) => ({
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      source: manifest.source,
      contributions: {
        skill: manifest.skills?.length ?? 0,
        command: manifest.commands?.length ?? 0,
        mcp: manifest.mcpServers?.length ?? 0,
        hook: manifest.hooks?.length ?? 0,
        theme: manifest.themes?.length ?? 0,
      },
    }));
  }

  private resolve<K extends ResourceKind>(
    kind: K,
    name: string
  ): {
    extensionId: string;
    source: ExtensionSource;
    resource: K extends 'skill'
      ? SkillDefinition
      : K extends 'command'
        ? PromptCommandDefinition
        : K extends 'mcp'
          ? McpServerDefinition
          : K extends 'hook'
            ? HookDefinition
            : ThemeDefinition;
  } | undefined {
    for (const manifest of this.sorted()) {
      const resources = resourcesOf(manifest, kind);
      const resource = (resources as Array<{ name: string }>).find((item) => item.name === name);
      if (resource) {
        return {
          extensionId: manifest.id,
          source: manifest.source,
          resource: structuredClone(resource),
        } as never;
      }
    }
    return undefined;
  }

  private sorted(): ExtensionManifest[] {
    return [...this.manifests.values()].sort(
      (a, b) => sourcePriority[b.source] - sourcePriority[a.source]
    );
  }
}

export function expandSkill(skill: SkillDefinition, rawArgs = ''): string {
  const args = rawArgs.split(/\s+/).filter(Boolean);
  return skill.body
    .replace(/\$ARGUMENTS/g, rawArgs)
    .replace(/\$(\d+)/g, (_match, index: string) => args[Number(index) - 1] ?? '');
}

export function skillCatalog(registry: ExtensionRegistry): JsonValue {
  return registry.diagnostics().flatMap(() => []);
}

function resourcesOf(manifest: ExtensionManifest, kind: ResourceKind): unknown[] {
  if (kind === 'skill') return manifest.skills ?? [];
  if (kind === 'command') return manifest.commands ?? [];
  if (kind === 'mcp') return manifest.mcpServers ?? [];
  if (kind === 'hook') return manifest.hooks ?? [];
  return manifest.themes ?? [];
}

function cloneManifest(manifest: ExtensionManifest): ExtensionManifest {
  return {
    ...manifest,
    skills: manifest.skills?.map((item) => structuredClone(item)),
    commands: manifest.commands?.map((item) => structuredClone(item)),
    mcpServers: manifest.mcpServers?.map((item) => structuredClone(item)),
    hooks: manifest.hooks?.map((hook) => ({ ...hook, ...(hook.toolNames ? { toolNames: [...hook.toolNames] } : {}) })),
    themes: manifest.themes?.map((item) => structuredClone(item)),
  };
}
