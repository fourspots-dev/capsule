import { AgentError } from './errors';
import type { JsonValue } from './types';

export function parseToolArguments(source: string): Record<string, JsonValue> {
  if (!source.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be valid JSON', {
      details: { cause: error instanceof Error ? error.message : String(error) },
    });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', 'Tool arguments must be a JSON object');
  }
  return parsed as Record<string, JsonValue>;
}

function validateNode(schema: unknown, value: unknown, path: string): void {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  const rule = schema as Record<string, unknown>;

  if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => Object.is(candidate, value))) {
    throw new AgentError('TOOL_SCHEMA_INVALID', `${path} must be one of the declared enum values`);
  }

  const type = typeof rule.type === 'string' ? rule.type : undefined;
  if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new AgentError('TOOL_SCHEMA_INVALID', `${path} must be an object`);
    }
    const object = value as Record<string, unknown>;
    const required = Array.isArray(rule.required) ? rule.required.map(String) : [];
    for (const key of required) {
      if (!(key in object)) {
        throw new AgentError('TOOL_SCHEMA_INVALID', `${path}.${key} is required`);
      }
    }
    const properties =
      rule.properties && typeof rule.properties === 'object' && !Array.isArray(rule.properties)
        ? (rule.properties as Record<string, unknown>)
        : {};
    for (const [key, child] of Object.entries(properties)) {
      if (key in object) validateNode(child, object[key], `${path}.${key}`);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      throw new AgentError('TOOL_SCHEMA_INVALID', `${path} must be an array`);
    }
    for (let index = 0; index < value.length; index += 1) {
      validateNode(rule.items, value[index], `${path}[${index}]`);
    }
    return;
  }

  if (type === 'string' && typeof value !== 'string') {
    throw new AgentError('TOOL_SCHEMA_INVALID', `${path} must be a string`);
  }
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw new AgentError('TOOL_SCHEMA_INVALID', `${path} must be a finite number`);
  }
  if (type === 'integer' && (!Number.isInteger(value) || typeof value !== 'number')) {
    throw new AgentError('TOOL_SCHEMA_INVALID', `${path} must be an integer`);
  }
  if (type === 'boolean' && typeof value !== 'boolean') {
    throw new AgentError('TOOL_SCHEMA_INVALID', `${path} must be a boolean`);
  }
}

export function validateToolInput(
  schema: Record<string, JsonValue>,
  input: Record<string, JsonValue>
): void {
  validateNode(schema, input, 'arguments');
}

export function validateJsonValue(
  schema: Record<string, JsonValue>,
  value: unknown,
  path = 'value'
): void {
  validateNode(schema, value, path);
}
