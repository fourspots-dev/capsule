import type { JsonValue, StructuredError } from './types';

export class AgentError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: JsonValue;

  constructor(code: string, message: string, options: { retryable?: boolean; details?: JsonValue } = {}) {
    super(message);
    this.name = 'AgentError';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }

  toStructured(): StructuredError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function toStructuredError(error: unknown, fallbackCode = 'INTERNAL_ERROR'): StructuredError {
  if (error instanceof AgentError) return error.toStructured();
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    (error instanceof AgentError && error.code === 'TASK_CANCELLED')
  );
}
