import { AgentError, toStructuredError } from './errors';
import type { JsonValue, StructuredError, ToolExecutionResult } from './types';

export type HookEvent = 'PreToolUse' | 'PostToolUse';
export type HookSource = 'builtin' | 'user' | 'project' | 'plugin';

export interface HookContext {
  event: HookEvent;
  sessionId: string;
  taskId: string;
  callId: string;
  toolName: string;
  input: JsonValue;
  result?: ToolExecutionResult;
}

export type HookResult =
  | { decision: 'allow' }
  | { decision: 'ask'; reason?: string }
  | { decision: 'deny'; reason: string }
  | { decision: 'modifyInput'; input: JsonValue; reason?: string }
  | { decision: 'context'; content: string };

export interface HookDefinition {
  name: string;
  event: HookEvent;
  toolNames?: string[];
  run(context: HookContext, signal: AbortSignal): Promise<HookResult> | HookResult;
}

export interface HookRegistrationInput {
  source: HookSource;
  sourceId?: string;
  content: string;
  expectedDigest: string;
  trusted?: boolean;
  definition: HookDefinition;
}

interface HookRegistration extends Omit<HookRegistrationInput, 'expectedDigest'> {
  digest: string;
}

export interface PreToolDecision {
  decision: 'allow' | 'ask' | 'deny';
  input: JsonValue;
  reason?: string;
}

export interface PostToolRecord {
  hookName: string;
  hookDigest: string;
  contexts: string[];
  errors: StructuredError[];
}

export class HookRunner {
  private readonly hooks = new Map<string, HookRegistration>();

  async register(input: HookRegistrationInput): Promise<void> {
    const digest = await sha256(input.content);
    if (digest !== input.expectedDigest.toLowerCase()) {
      throw new AgentError(
        'HOOK_DIGEST_MISMATCH',
        `Hook content digest changed for ${input.definition.name}`
      );
    }
    if (input.source !== 'builtin' && input.trusted !== true) {
      throw new AgentError(
        'HOOK_UNTRUSTED',
        `Hook ${input.definition.name} must be explicitly trusted`
      );
    }
    this.hooks.set(hookKey(input.definition), {
      source: input.source,
      sourceId: input.sourceId,
      content: input.content,
      trusted: input.trusted,
      definition: input.definition,
      digest,
    });
  }

  async before(
    context: Omit<HookContext, 'event'>,
    signal: AbortSignal
  ): Promise<PreToolDecision> {
    let input = cloneJson(context.input);
    let requiresApproval = false;
    let reason: string | undefined;
    for (const registration of this.matching('PreToolUse', context.toolName)) {
      let result: HookResult;
      try {
        result = await registration.definition.run(
          { ...context, event: 'PreToolUse', input },
          signal
        );
      } catch (error) {
        return {
          decision: 'deny',
          input,
          reason: `PreToolUse hook ${registration.definition.name} failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (result.decision === 'deny') {
        return { decision: 'deny', input, reason: result.reason };
      }
      if (result.decision === 'ask') {
        requiresApproval = true;
        reason = result.reason ?? reason;
      }
      if (result.decision === 'modifyInput') {
        input = cloneJson(result.input);
        reason = result.reason ?? reason;
      }
    }
    return {
      decision: requiresApproval ? 'ask' : 'allow',
      input,
      ...(reason ? { reason } : {}),
    };
  }

  async after(
    context: Omit<HookContext, 'event' | 'result'>,
    result: ToolExecutionResult,
    signal: AbortSignal
  ): Promise<PostToolRecord[]> {
    const records: PostToolRecord[] = [];
    for (const registration of this.matching('PostToolUse', context.toolName)) {
      const record: PostToolRecord = {
        hookName: registration.definition.name,
        hookDigest: registration.digest,
        contexts: [],
        errors: [],
      };
      try {
        const outcome = await registration.definition.run(
          { ...context, event: 'PostToolUse', result },
          signal
        );
        if (outcome.decision === 'context') record.contexts.push(outcome.content);
      } catch (error) {
        record.errors.push(toStructuredError(error, 'HOOK_POST_FAILED'));
      }
      records.push(record);
    }
    return records;
  }

  diagnostics(): Array<{
    name: string;
    event: HookEvent;
    source: HookSource;
    sourceId?: string;
    digest: string;
    trusted: boolean;
  }> {
    return [...this.hooks.values()]
      .map((registration) => ({
        name: registration.definition.name,
        event: registration.definition.event,
        source: registration.source,
        ...(registration.sourceId ? { sourceId: registration.sourceId } : {}),
        digest: registration.digest,
        trusted: registration.source === 'builtin' || registration.trusted === true,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private matching(event: HookEvent, toolName: string): HookRegistration[] {
    return [...this.hooks.values()].filter(
      (registration) =>
        registration.definition.event === event &&
        (!registration.definition.toolNames?.length ||
          registration.definition.toolNames.includes(toolName))
    );
  }
}

export async function hookDigest(content: string): Promise<string> {
  return sha256(content);
}

async function sha256(value: string): Promise<string> {
  const data = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hookKey(definition: HookDefinition): string {
  return `${definition.event}:${definition.name}`;
}

function cloneJson(value: JsonValue): JsonValue {
  return structuredClone(value);
}
