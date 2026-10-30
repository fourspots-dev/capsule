import type { HookDefinition, HookEvent, HookResult, HookRunner, HookSource } from '../core/hooks';
import { hookDigest } from '../core/hooks';
import type { JsonValue } from '../core/types';

interface DeclarativeHookRule {
  name: string;
  event: HookEvent;
  source?: HookSource;
  sourceId?: string;
  trusted?: boolean;
  toolNames?: string[];
  decision: 'allow' | 'ask' | 'deny' | 'modifyInput' | 'context';
  reason?: string;
  input?: JsonValue;
  content?: string;
}

export async function registerDeclarativeHooks(
  runner: HookRunner,
  raw: unknown
): Promise<number> {
  if (!Array.isArray(raw)) return 0;
  let registered = 0;
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const rule = value as DeclarativeHookRule;
    if (
      !rule.name ||
      !['PreToolUse', 'PostToolUse'].includes(rule.event) ||
      !['allow', 'ask', 'deny', 'modifyInput', 'context'].includes(rule.decision)
    ) {
      continue;
    }
    const source = rule.source ?? 'user';
    if (source !== 'builtin' && rule.trusted !== true) continue;
    const definition: HookDefinition = {
      name: rule.name,
      event: rule.event,
      ...(rule.toolNames?.length ? { toolNames: [...rule.toolNames] } : {}),
      run: () => hookResult(rule),
    };
    const content = JSON.stringify(rule);
    await runner.register({
      definition,
      source,
      sourceId: rule.sourceId ?? 'declarative',
      content,
      expectedDigest: await hookDigest(content),
      trusted: rule.trusted,
    });
    registered += 1;
  }
  return registered;
}

function hookResult(rule: DeclarativeHookRule): HookResult {
  if (rule.decision === 'deny') {
    return { decision: 'deny', reason: rule.reason ?? 'Denied by declarative hook' };
  }
  if (rule.decision === 'ask') return { decision: 'ask', ...(rule.reason ? { reason: rule.reason } : {}) };
  if (rule.decision === 'modifyInput' && rule.input !== undefined) {
    return {
      decision: 'modifyInput',
      input: structuredClone(rule.input),
      ...(rule.reason ? { reason: rule.reason } : {}),
    };
  }
  if (rule.decision === 'context' && rule.content) {
    return { decision: 'context', content: rule.content };
  }
  return { decision: 'allow' };
}
