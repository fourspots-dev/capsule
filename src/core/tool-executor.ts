import { AgentError, toStructuredError } from './errors';
import type { ArtifactStore } from './artifact-store';
import type { HookRunner, PostToolRecord } from './hooks';
import type { PolicyEngine } from './policy';
import type { ApprovalPort } from './ports';
import { parseToolArguments, validateToolInput } from './tool-schema';
import type {
  JsonValue,
  ToolCall,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionResult,
  ToolInvocation,
} from './types';

export class ToolExecutor {
  private readonly tools: Map<string, ToolDefinition>;

  constructor(
    tools: Iterable<ToolDefinition>,
    private readonly approval: ApprovalPort,
    private readonly options: {
      defaultTimeoutMs?: number;
      hooks?: HookRunner;
      onPostToolUse?: (records: PostToolRecord[]) => void;
      policy?: PolicyEngine;
      artifacts?: {
        store: ArtifactStore;
        thresholdBytes?: number;
      };
    } = {}
  ) {
    this.tools = new Map([...tools].map((tool) => [tool.name, tool]));
  }

  descriptors(): ToolDescriptor[] {
    return [...this.tools.values()].map(({ name, description, parameters }) => ({
      name,
      description,
      parameters,
    }));
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  executionMode(name: string): NonNullable<ToolDefinition['executionMode']> {
    return this.tools.get(name)?.executionMode ?? 'sequential';
  }

  async execute(invocation: ToolInvocation): Promise<ToolExecutionResult> {
    const base = { callId: invocation.call.id, name: invocation.call.name };
    const tool = this.tools.get(invocation.call.name);
    if (!tool) {
      return {
        ...base,
        status: 'failed',
        error: new AgentError('TOOL_NOT_FOUND', `Unknown tool: ${invocation.call.name}`).toStructured(),
      };
    }

    let input: Record<string, JsonValue>;
    try {
      input = parseToolArguments(invocation.call.arguments);
      validateToolInput(tool.parameters, input);
      this.assertActive(invocation.signal);
    } catch (error) {
      return { ...base, status: 'failed', error: toStructuredError(error, 'TOOL_VALIDATION_FAILED') };
    }

    let hookRequiresApproval = false;
    if (this.options.hooks) {
      const hook = await this.options.hooks.before(
        {
          sessionId: invocation.sessionId,
          taskId: invocation.taskId,
          callId: invocation.call.id,
          toolName: tool.name,
          input,
        },
        invocation.signal
      );
      if (hook.decision === 'deny') {
        return {
          ...base,
          status: 'denied',
          error: new AgentError(
            'TOOL_HOOK_DENIED',
            hook.reason ?? `A pre-tool hook denied ${tool.name}`
          ).toStructured(),
        };
      }
      hookRequiresApproval = hook.decision === 'ask';
      input = hook.input as Record<string, JsonValue>;
      try {
        validateToolInput(tool.parameters, input);
      } catch (error) {
        return {
          ...base,
          status: 'failed',
          error: toStructuredError(error, 'TOOL_HOOK_INPUT_INVALID'),
        };
      }
    }

    let policyRequiresApproval = false;
    let actionDigest: string | undefined;
    if (this.options.policy) {
      const decision = await this.options.policy.evaluate(
        {
          sessionId: invocation.sessionId,
          taskId: invocation.taskId,
          callId: invocation.call.id,
          toolName: tool.name,
          capabilities: [...(tool.capabilities ?? [])],
          effect: tool.effect ?? (tool.risk === 'read' ? 'read' : 'write'),
          risk: tool.risk,
          input,
        },
        invocation.signal
      );
      actionDigest = decision.actionDigest;
      if (decision.decision === 'deny') {
        return {
          ...base,
          status: 'denied',
          error: new AgentError(
            'TOOL_POLICY_DENIED',
            decision.reason ?? `${tool.name} is denied by policy`
          ).toStructured(),
        };
      }
      policyRequiresApproval = decision.decision === 'ask';
    }

    if (
      (tool.risk !== 'read' && !this.options.policy) ||
      hookRequiresApproval ||
      policyRequiresApproval
    ) {
      let approved = false;
      try {
        approved = await this.approval.requestApproval(
          {
            sessionId: invocation.sessionId,
            taskId: invocation.taskId,
            callId: invocation.call.id,
            toolName: tool.name,
            risk: tool.risk === 'read' ? 'write' : tool.risk,
            input,
            ...(actionDigest ? { actionDigest } : {}),
          },
          invocation.signal
        );
      } catch (error) {
        return { ...base, status: 'failed', error: toStructuredError(error, 'TOOL_APPROVAL_FAILED') };
      }
      if (!approved) {
        return {
          ...base,
          status: 'denied',
          error: new AgentError('TOOL_DENIED', `User denied ${tool.name}`).toStructured(),
        };
      }
    }

    try {
      const rawOutput = await this.executeWithTimeout(tool, input, invocation);
      if (tool.outputSchema) validateToolInput(tool.outputSchema, rawOutput as JsonValue as Record<string, JsonValue>);
      this.assertActive(invocation.signal);
      const output = await this.artifactize(rawOutput, invocation);
      const result: ToolExecutionResult = { ...base, status: 'succeeded', output };
      await this.runPostHooks(invocation, input, result);
      return result;
    } catch (error) {
      const result: ToolExecutionResult = {
        ...base,
        status: 'failed',
        error: toStructuredError(error, 'TOOL_EXECUTION_FAILED'),
      };
      await this.runPostHooks(invocation, input, result);
      return result;
    }
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentError('TASK_CANCELLED', 'Task was cancelled');
  }

  private async executeWithTimeout(
    tool: ToolDefinition,
    input: JsonValue,
    invocation: ToolInvocation
  ): Promise<JsonValue> {
    const timeoutMs = tool.timeoutMs ?? this.options.defaultTimeoutMs ?? 120_000;
    const controller = new AbortController();
    const abort = () => controller.abort();
    invocation.signal.addEventListener('abort', abort, { once: true });
    if (invocation.signal.aborted) controller.abort();

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new AgentError('TOOL_TIMEOUT', `Tool timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        tool.execute(input, { ...invocation, signal: controller.signal }),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      invocation.signal.removeEventListener('abort', abort);
    }
  }

  private async runPostHooks(
    invocation: ToolInvocation,
    input: Record<string, JsonValue>,
    result: ToolExecutionResult
  ): Promise<void> {
    if (!this.options.hooks) return;
    const records = await this.options.hooks.after(
      {
        sessionId: invocation.sessionId,
        taskId: invocation.taskId,
        callId: invocation.call.id,
        toolName: invocation.call.name,
        input,
      },
      result,
      invocation.signal
    );
    this.options.onPostToolUse?.(records);
  }

  private async artifactize(
    output: JsonValue,
    invocation: ToolInvocation
  ): Promise<JsonValue> {
    if (!this.options.artifacts) return output;
    const serialized = typeof output === 'string' ? output : JSON.stringify(output);
    const threshold = this.options.artifacts.thresholdBytes ?? 64_000;
    if (new TextEncoder().encode(serialized).byteLength <= threshold) return output;
    const ref = await this.options.artifacts.store.put({
      name: `${invocation.call.name}-${invocation.call.id}.txt`,
      mimeType: 'text/plain; charset=utf-8',
      kind: 'text',
      data: new TextEncoder().encode(serialized),
      sessionId: invocation.sessionId,
      taskId: invocation.taskId,
    });
    return {
      artifact: {
        artifactId: ref.artifactId,
        name: ref.name,
        mimeType: ref.mimeType,
        bytes: ref.bytes,
        kind: ref.kind,
      },
      preview: serialized.slice(0, Math.min(2_000, threshold)),
      truncated: true,
    };
  }
}

export function toolResultText(result: ToolExecutionResult): string {
  if (result.status === 'succeeded') {
    if (result.output === undefined) return '(no output)';
    return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  }
  return JSON.stringify(result.error ?? new AgentError('TOOL_FAILED', 'Tool failed').toStructured());
}

export function createToolCall(call: ToolCall): ToolCall {
  return {
    id: call.id,
    name: call.name,
    arguments: call.arguments.trim() || '{}',
  };
}
