import { AgentError } from '../core/errors';
import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';
import type {
  CodeIntelligencePort,
  CodeRange,
} from '../platform/code-intelligence';
import { workspacePath } from '../platform/workspace-resource';

export function createCodeIntelligenceTools(
  intelligence: CodeIntelligencePort
): ToolDefinition[] {
  return [
    tool(
      'code_capabilities',
      'Report available semantic code intelligence capabilities and limitations.',
      schema({}, []),
      async () =>
        (await intelligence.capabilities()) as unknown as JsonValue
    ),
    tool(
      'code_diagnostics',
      'Return diagnostics for workspace-relative source paths.',
      schema({ paths: { type: 'array', items: { type: 'string' } } }, ['paths']),
      async (input, invocation) =>
        (await intelligence.diagnostics(
          stringArray(objectInput(input), 'paths').map((path) =>
            workspacePath(path)
          ),
          invocation.signal
        )) as unknown as JsonValue
    ),
    tool(
      'code_symbols',
      'Find symbols by name or substring using LSP or portable text fallback.',
      schema({ query: { type: 'string' } }, ['query']),
      async (input, invocation) =>
        (await intelligence.symbols(
          requiredString(objectInput(input), 'query'),
          invocation.signal
        )) as unknown as JsonValue
    ),
    tool(
      'code_definition',
      'Find definitions of a symbol using LSP or portable lexical fallback.',
      schema({ symbol: { type: 'string' } }, ['symbol']),
      async (input, invocation) =>
        (await intelligence.definition(
          requiredString(objectInput(input), 'symbol'),
          invocation.signal
        )) as unknown as JsonValue
    ),
    tool(
      'code_references',
      'Find references of a symbol using LSP or portable lexical fallback.',
      schema({ symbol: { type: 'string' } }, ['symbol']),
      async (input, invocation) =>
        (await intelligence.references(
          requiredString(objectInput(input), 'symbol'),
          invocation.signal
        )) as unknown as JsonValue
    ),
    tool(
      'code_actions',
      'Return provider code actions as WorkspaceEdit proposals without applying them.',
      schema(
        {
          path: { type: 'string' },
          range: { type: 'object' },
        },
        ['path', 'range']
      ),
      async (input, invocation) => {
        const object = objectInput(input);
        const range = object.range;
        if (!range || typeof range !== 'object' || Array.isArray(range)) {
          throw new AgentError(
            'CODE_RANGE_INVALID',
            'code_actions requires a code range'
          );
        }
        return (await intelligence.codeActions(
          workspacePath(requiredString(object, 'path')),
          range as unknown as CodeRange,
          invocation.signal
        )) as unknown as JsonValue;
      }
    ),
  ];
}

function objectInput(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError(
      'TOOL_ARGUMENTS_INVALID',
      'Tool input must be an object'
    );
  }
  return value;
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, JsonValue>,
  execute: ToolDefinition['execute']
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    risk: 'read',
    effect: 'read',
    capabilities: ['code-intelligence:read'],
    executionMode: 'parallel',
    replay: 'safe',
    execute,
  };
}

function schema(
  properties: Record<string, JsonValue>,
  required: string[]
): Record<string, JsonValue> {
  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

function requiredString(
  input: Record<string, JsonValue>,
  key: string
): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError(
      'TOOL_ARGUMENTS_INVALID',
      `${key} must be a non-empty string`
    );
  }
  return value.trim();
}

function stringArray(
  input: Record<string, JsonValue>,
  key: string
): string[] {
  const value = input[key];
  if (!Array.isArray(value)) {
    throw new AgentError(
      'TOOL_ARGUMENTS_INVALID',
      `${key} must be an array of strings`
    );
  }
  return value.map(String);
}
