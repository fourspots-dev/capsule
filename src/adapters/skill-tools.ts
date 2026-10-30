import type { ExtensionRegistry, SkillDefinition } from '../core/extension-registry';
import { expandSkill } from '../core/extension-registry';
import type { JsonValue, ToolDefinition } from '../core/types';

export interface SkillStore {
  list(): Promise<SkillDefinition[]>;
  upsert(skill: SkillDefinition): Promise<void>;
  remove(name: string): Promise<void>;
}

export function createSkillTools(
  registry: ExtensionRegistry,
  store?: SkillStore
): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: 'skill',
      description: 'Load a declared skill body and expand its arguments.',
      parameters: {
        type: 'object',
        properties: {
          skill: { type: 'string' },
          args: { type: 'string' },
        },
        required: ['skill'],
      },
      risk: 'read',
      effect: 'read',
      capabilities: ['extension:skills'],
      executionMode: 'parallel',
      replay: 'safe',
      execute: async (raw) => {
        const input = raw as Record<string, JsonValue>;
        const name = String(input.skill ?? '');
        const skill = registry.skill(name);
        if (!skill) return `Skill "${name}" was not found in the extension registry.`;
        return {
          name: skill.name,
          instructions: expandSkill(skill, String(input.args ?? '')),
        };
      },
    },
  ];
  if (store) {
    tools.push(
      {
        name: 'save_skill',
        description: 'Create or replace a reusable instruction skill.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            description: { type: 'string' },
            when_to_use: { type: 'string' },
            body: { type: 'string' },
          },
          required: ['name', 'description', 'body'],
        },
        risk: 'write',
        effect: 'write',
        capabilities: ['extension:skills'],
        executionMode: 'sequential',
        replay: 'never',
        execute: async (raw) => {
          const input = raw as Record<string, JsonValue>;
          const name = String(input.name ?? '').trim();
          if (!name) throw new Error('Skill name cannot be empty');
          const skill: SkillDefinition = {
            name,
            description: String(input.description ?? ''),
            whenToUse: String(input.when_to_use ?? ''),
            body: String(input.body ?? ''),
          };
          await store.upsert(skill);
          registry.register({
            id: 'tinyai.skills',
            name: 'tinyai skills',
            version: String(Date.now()),
            source: 'builtin',
            skills: await store.list(),
          });
          return { saved: name };
        },
      },
      {
        name: 'delete_skill',
        description: 'Delete a reusable instruction skill.',
        parameters: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
        risk: 'write',
        effect: 'write',
        capabilities: ['extension:skills'],
        executionMode: 'sequential',
        replay: 'never',
        execute: async (raw) => {
          const name = String((raw as Record<string, JsonValue>).name ?? '');
          await store.remove(name);
          registry.register({
            id: 'tinyai.skills',
            name: 'tinyai skills',
            version: String(Date.now()),
            source: 'builtin',
            skills: await store.list(),
          });
          return { deleted: true, name };
        },
      }
    );
  }
  return tools;
}
