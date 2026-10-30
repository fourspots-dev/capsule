import { AgentError } from './errors';
import type { ToolDefinition } from './types';

export type ToolSource = 'builtin' | 'user' | 'project' | 'plugin' | 'mcp';

export interface ToolRegistration {
  definition: ToolDefinition;
  source: ToolSource;
  sourceId?: string;
  enabled?: boolean;
}

export interface ToolSelection {
  allow?: readonly string[];
  deny?: readonly string[];
  capabilities?: readonly string[];
}

const sourcePriority: Record<ToolSource, number> = {
  builtin: 0,
  user: 1,
  project: 2,
  plugin: 3,
  mcp: 4,
};

export class ToolRegistry {
  private readonly registrations = new Map<string, Map<ToolSource, ToolRegistration>>();

  register(registration: ToolRegistration): void {
    const name = registration.definition.name.trim();
    if (!name) throw new AgentError('TOOL_NAME_INVALID', 'Tool name cannot be empty');
    const sources = this.registrations.get(name) ?? new Map<ToolSource, ToolRegistration>();
    sources.set(registration.source, {
      ...registration,
      definition: { ...registration.definition, name },
    });
    this.registrations.set(name, sources);
  }

  registerAll(registrations: Iterable<ToolRegistration>): void {
    for (const registration of registrations) this.register(registration);
  }

  remove(name: string): boolean {
    return this.registrations.delete(name);
  }

  clearSource(source: ToolSource, sourceId?: string): void {
    for (const [name, sources] of this.registrations) {
      const registration = sources.get(source);
      if (registration && (sourceId === undefined || registration.sourceId === sourceId)) {
        sources.delete(source);
        if (sources.size === 0) this.registrations.delete(name);
      }
    }
  }

  get(name: string): ToolDefinition | undefined {
    const registration = this.effective(name);
    return registration?.enabled === false ? undefined : registration?.definition;
  }

  resolve(selection: ToolSelection = {}): ToolDefinition[] {
    const allow = selection.allow ? new Set(selection.allow) : undefined;
    const deny = new Set(selection.deny ?? []);
    const required = selection.capabilities ?? [];
    return [...this.registrations.keys()]
      .map((name) => this.effective(name))
      .filter((registration): registration is ToolRegistration => Boolean(registration))
      .filter((registration) => registration.enabled !== false)
      .filter(({ definition }) => !allow || allow.has(definition.name))
      .filter(({ definition }) => !deny.has(definition.name))
      .filter(({ definition }) => {
        const provided = new Set(definition.capabilities ?? []);
        return required.every((capability) => provided.has(capability));
      })
      .sort((a, b) => a.definition.name.localeCompare(b.definition.name))
      .map(({ definition }) => definition);
  }

  diagnostics(): Array<{
    name: string;
    source: ToolSource;
    sourceId?: string;
    enabled: boolean;
  }> {
    return [...this.registrations.keys()]
      .sort()
      .flatMap((name) => {
        const registration = this.effective(name);
        return registration
          ? [
              {
                name,
                source: registration.source,
                ...(registration.sourceId ? { sourceId: registration.sourceId } : {}),
                enabled: registration.enabled !== false,
              },
            ]
          : [];
      });
  }

  private effective(name: string): ToolRegistration | undefined {
    const sources = this.registrations.get(name);
    if (!sources) return undefined;
    return [...sources.values()].sort(
      (a, b) => sourcePriority[b.source] - sourcePriority[a.source]
    )[0];
  }
}
