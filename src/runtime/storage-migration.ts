import { importLegacySessions } from '../adapters/legacy-session-importer';
import type { SessionStore } from '../core/session-store';
import type { ChromeKeyValueStorage } from './chrome-runtime';

export const CONFIG_KEY = 'tinyai:v2:config';
export const SKILLS_KEY = 'tinyai:v1:skills';
export const MIGRATION_KEY = 'tinyai:migration:v2';

const legacyKeys = [
  'clj-agent-config',
  'clj-agent-sessions',
  'clj-agent-skills',
  'agent_skills',
];

export async function migrateLegacyStorage(
  storage: ChromeKeyValueStorage,
  sessions: SessionStore,
  now = Date.now()
): Promise<{ migrated: boolean; importedSessions: number }> {
  const stored = await storage.get([MIGRATION_KEY, CONFIG_KEY, SKILLS_KEY, ...legacyKeys]);
  if (stored[MIGRATION_KEY] === true) {
    return { migrated: false, importedSessions: 0 };
  }

  const oldConfig = objectValue(stored['clj-agent-config']);
  if (oldConfig && !stored[CONFIG_KEY]) {
    await storage.set({ [CONFIG_KEY]: oldConfig });
  }

  if (!stored[SKILLS_KEY]) {
    const skills = mergeSkills(
      arrayValue(stored.agent_skills),
      arrayValue(stored['clj-agent-skills'])
    );
    await storage.set({ [SKILLS_KEY]: skills });
  }

  const importedSessions = await importLegacySessions(
    stored['clj-agent-sessions'],
    sessions,
    now
  );
  if (storage.remove) await storage.remove(legacyKeys);
  await storage.set({
    [MIGRATION_KEY]: true,
    'tinyai:migration:legacy-sessions': importedSessions,
  });
  return { migrated: true, importedSessions };
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function mergeSkills(original: unknown[], current: unknown[]): unknown[] {
  const skills = new Map<string, Record<string, unknown>>();
  for (const value of [...original, ...current]) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const skill = value as Record<string, unknown>;
    const name = typeof skill.name === 'string' ? skill.name.trim() : '';
    if (!name) continue;
    skills.set(name, {
      name,
      description: String(skill.description ?? ''),
      when_to_use: String(skill.when_to_use ?? skill.whenToUse ?? ''),
      body: String(skill.body ?? ''),
    });
  }
  return [...skills.values()];
}
