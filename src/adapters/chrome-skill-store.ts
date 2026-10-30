import type { SkillStore } from './skill-tools';
import type { SkillDefinition } from '../core/extension-registry';
import type { ChromeKeyValueStorage } from '../runtime/chrome-runtime';

const PRIMARY_KEY = 'tinyai:v1:skills';

export class ChromeSkillStore implements SkillStore {
  constructor(private readonly storage: ChromeKeyValueStorage) {}

  async list(): Promise<SkillDefinition[]> {
    const stored = await this.storage.get(PRIMARY_KEY);
    const merged = new Map<string, SkillDefinition>();
    for (const key of [PRIMARY_KEY]) {
      const values = stored[key];
      if (!Array.isArray(values)) continue;
      for (const value of values) {
        if (!value || typeof value !== 'object') continue;
        const item = value as Record<string, unknown>;
        const name = string(item.name);
        if (!name) continue;
        merged.set(name, {
          name,
          description: string(item.description),
          whenToUse: string(item.whenToUse) || string(item.when_to_use),
          body: string(item.body),
        });
      }
    }
    return [...merged.values()];
  }

  async upsert(skill: SkillDefinition): Promise<void> {
    const skills = await this.list();
    const next = [...skills.filter((item) => item.name !== skill.name), { ...skill }];
    await this.save(next);
  }

  async remove(name: string): Promise<void> {
    await this.save((await this.list()).filter((item) => item.name !== name));
  }

  private async save(skills: SkillDefinition[]): Promise<void> {
    await this.storage.set({
      [PRIMARY_KEY]: skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        when_to_use: skill.whenToUse ?? '',
        body: skill.body,
      })),
    });
  }
}

function string(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
