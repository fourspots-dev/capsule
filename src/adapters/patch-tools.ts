import { AgentError } from '../core/errors';
import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';
import {
  applyContextPatch,
  applyUnifiedPatch,
  type PatchFileSystem,
} from '../virtual';

type ObjectInput = Record<string, JsonValue>;

export function createPatchTools(workspace: PatchFileSystem): ToolDefinition[] {
  return [
    patchTool(
      'apply_patch',
      'Apply a contextual patch to one or more files. Use *** Begin Patch ... *** End Patch with Update File, Add File, Delete File and Move to directives. Every Update File hunk starts with @@ or @@ anchor text. Context lines use a leading space, removed lines use -, added lines use +. Do not provide unified-diff hunk counts or ---/+++ headers; use apply_unified_diff for those.',
      async (input, invocation) =>
        applyContextPatch(
          workspace,
          requiredString(input, 'patch'),
          patchOptions(input, invocation)
        ) as unknown as JsonValue
    ),
    patchTool(
      'apply_unified_diff',
      'Apply a strict Git-style unified diff with ---/+++ headers and exact @@ hunk counts. Use this only for standard unified diffs; prefer apply_patch for model-authored edits.',
      async (input, invocation) =>
        applyUnifiedPatch(
          workspace,
          requiredString(input, 'patch'),
          patchOptions(input, invocation)
        ) as unknown as JsonValue
    ),
  ];
}

function patchTool(
  name: string,
  description: string,
  execute: (input: ObjectInput, invocation: ToolInvocation) => Promise<JsonValue>
): ToolDefinition {
  return {
    name,
    description,
    parameters: {
      type: 'object',
      properties: {
        patch: {
          type: 'string',
          description:
            name === 'apply_patch'
              ? 'ContextPatch text beginning with *** Begin Patch and ending with *** End Patch. Do not use unified-diff headers or hunk line counts.'
              : 'Strict Git unified diff with ---/+++ headers and exact @@ hunk counts.',
        },
        expected_versions: { type: 'object' },
        expected_hashes: { type: 'object' },
      },
      required: ['patch'],
    },
    risk: 'write',
    effect: 'write',
    capabilities: ['workspace:write'],
    executionMode: 'sequential',
    replay: 'never',
    timeoutMs: 120_000,
    execute: async (input, invocation) =>
      execute(asObject(input), invocation),
  };
}

function patchOptions(
  input: ObjectInput,
  invocation: ToolInvocation
): {
  signal: AbortSignal;
  expectedVersions?: Record<string, number>;
  expectedHashes?: Record<string, string>;
} {
  return {
    signal: invocation.signal,
    ...(numberRecord(input.expected_versions)
      ? { expectedVersions: numberRecord(input.expected_versions)! }
      : {}),
    ...(stringRecord(input.expected_hashes)
      ? { expectedHashes: stringRecord(input.expected_hashes)! }
      : {}),
  };
}

function asObject(value: JsonValue): ObjectInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', 'Tool input must be an object');
  }
  return value;
}

function requiredString(input: ObjectInput, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', `${key} must be a non-empty string`);
  }
  return value;
}

function numberRecord(value: JsonValue | undefined): Record<string, number> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number'
    )
  );
}

function stringRecord(value: JsonValue | undefined): Record<string, string> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string'
    )
  );
}
