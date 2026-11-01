import { AgentError, toStructuredError } from './errors';
import type { ArtifactStore } from './artifact-store';
import type { HookRunner, PostToolRecord } from './hooks';
import type { PolicyEngine } from './policy';
import type {
  ApprovalDecision,
  ApprovalPort,
  ApprovalReceiptStore,
} from './ports';
import { parseToolArguments, validateToolInput } from './tool-schema';
import type {
  JsonValue,
  ToolCall,
  ToolArtifactRef,
  ToolDefinition,
  ToolDescriptor,
  ToolExecutionResult,
  ToolExecutionMetadata,
  ToolExecutionOutput,
  ToolInvocation,
} from './types';

export class ToolExecutor {
  private readonly tools: Map<string, ToolDefinition>;
  private readonly repeatedFailures = new Map<
    string,
    { count: number; lastCode: string }
  >();

  constructor(
    tools: Iterable<ToolDefinition>,
    private readonly approval: ApprovalPort,
    private readonly options: {
      defaultTimeoutMs?: number;
      hooks?: HookRunner;
      onPostToolUse?: (records: PostToolRecord[]) => void;
      policy?: PolicyEngine;
      approvalReceipts?: ApprovalReceiptStore;
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

    const failureKey =
      tool.risk === 'read'
        ? undefined
        : this.failureKey(invocation, tool.name, input);
    const repeated = failureKey
      ? this.repeatedFailures.get(failureKey)
      : undefined;
    if (failureKey && repeated && repeated.count >= 3) {
      return {
        ...base,
        status: 'failed',
        error: new AgentError(
          'TOOL_RETRY_BLOCKED',
          `Blocked repeated ${tool.name} call after ${repeated.count} identical failures. Re-read current state or change the request before retrying.`,
          {
            details: {
              tool: tool.name,
              retryCount: repeated.count,
              lastCode: repeated.lastCode,
              suggestion:
                'Re-read the current file and submit a smaller or corrected operation',
            },
          }
        ).toStructured(),
      };
    }

    let policyRequiresApproval = false;
    let actionDigest: string | undefined;
    let approvalContext: JsonValue | undefined;
    if (tool.approvalContext) {
      try {
        approvalContext = await tool.approvalContext(input, invocation);
      } catch (error) {
        return {
          ...base,
          status: 'failed',
          error: toStructuredError(
            error,
            'TOOL_APPROVAL_CONTEXT_FAILED'
          ),
        };
      }
    }
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
          ...(approvalContext === undefined ? {} : { approvalContext }),
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
        const receiptError = await this.recordApprovalReceipt(
          invocation,
          tool,
          approvalContext,
          'cancelled',
          actionDigest
        );
        if (receiptError) {
          return {
            ...base,
            status: 'failed',
            error: receiptError.toStructured(),
          };
        }
        return { ...base, status: 'failed', error: toStructuredError(error, 'TOOL_APPROVAL_FAILED') };
      }
      if (!approved) {
        const receiptError = await this.recordApprovalReceipt(
          invocation,
          tool,
          approvalContext,
          'denied',
          actionDigest
        );
        if (receiptError) {
          return {
            ...base,
            status: 'failed',
            error: receiptError.toStructured(),
          };
        }
        return {
          ...base,
          status: 'denied',
          error: new AgentError('TOOL_DENIED', `User denied ${tool.name}`).toStructured(),
        };
      }
      const receiptError = await this.recordApprovalReceipt(
        invocation,
        tool,
        approvalContext,
        'approved',
        actionDigest
      );
      if (receiptError) {
        return {
          ...base,
          status: 'failed',
          error: receiptError.toStructured(),
        };
      }
    }

    try {
      const execution = await this.executeWithTimeout(tool, input, invocation);
      const executionStatus = execution.metadata?.status ?? 'succeeded';
      if (tool.outputSchema && executionStatus === 'succeeded') {
        validateToolInput(
          tool.outputSchema,
          execution.value as Record<string, JsonValue>
        );
      }
      this.assertActive(invocation.signal);
      const output = await this.artifactize(execution.value, invocation);
      const metadata = await this.materializeArtifacts(
        execution,
        invocation
      );
      if (executionStatus === 'failed' || executionStatus === 'cancelled') {
        const result: ToolExecutionResult = {
          ...base,
          status: executionStatus,
          output,
          ...(metadata ? { metadata } : {}),
          error: new AgentError(
            executionStatus === 'cancelled'
              ? 'TOOL_CANCELLED'
              : 'TOOL_EXECUTION_FAILED',
            executionStatus === 'cancelled'
              ? `${tool.name} was cancelled`
              : `${tool.name} failed`
          ).toStructured(),
        };
        if (failureKey) {
          this.recordFailure(failureKey, result.error!.code);
        }
        await this.runPostHooks(invocation, input, result);
        return result;
      }
      const result: ToolExecutionResult = {
        ...base,
        status: 'succeeded',
        output,
        ...(metadata ? { metadata } : {}),
      };
      await this.runPostHooks(invocation, input, result);
      if (failureKey) this.repeatedFailures.delete(failureKey);
      return result;
    } catch (error) {
      const structured = toStructuredError(error, 'TOOL_EXECUTION_FAILED');
      const result: ToolExecutionResult = {
        ...base,
        status: 'failed',
        error: structured,
      };
      if (failureKey) {
        this.recordFailure(failureKey, structured.code);
      }
      await this.runPostHooks(invocation, input, result);
      return result;
    }
  }

  private failureKey(
    invocation: ToolInvocation,
    toolName: string,
    input: Record<string, JsonValue>
  ): string {
    return [
      invocation.sessionId,
      invocation.taskId,
      toolName,
      String(hashString(JSON.stringify(input))),
    ].join(':');
  }

  private recordFailure(key: string, code: string): void {
    const previous = this.repeatedFailures.get(key);
    if (this.repeatedFailures.size >= 1_000 && !previous) {
      const oldest = this.repeatedFailures.keys().next().value;
      if (oldest) this.repeatedFailures.delete(oldest);
    }
    this.repeatedFailures.set(key, {
      count: (previous?.count ?? 0) + 1,
      lastCode: code,
    });
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentError('TASK_CANCELLED', 'Task was cancelled');
  }

  private async executeWithTimeout(
    tool: ToolDefinition,
    input: JsonValue,
    invocation: ToolInvocation
  ): Promise<ToolExecutionOutput> {
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
        tool.executeDetailed
          ? tool.executeDetailed(input, {
              ...invocation,
              signal: controller.signal,
            })
          : tool.execute(input, { ...invocation, signal: controller.signal }).then(
              (value) => ({ value })
            ),
        timeout,
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      invocation.signal.removeEventListener('abort', abort);
    }
  }

  private async materializeArtifacts(
    execution: ToolExecutionOutput,
    invocation: ToolInvocation
  ): Promise<ToolExecutionMetadata | undefined> {
    const attachments = execution.attachments ?? [];
    if (attachments.length === 0) return execution.metadata;
    if (!this.options.artifacts) {
      throw new AgentError(
        'ARTIFACT_STORE_UNAVAILABLE',
        'Action returned binary attachments but no ArtifactStore is configured'
      );
    }
    const refs: ToolArtifactRef[] = [];
    for (const attachment of attachments) {
      refs.push(
        await this.options.artifacts.store.put({
          name: attachment.name,
          mimeType: attachment.mimeType,
          kind: attachment.kind,
          data: attachment.data,
          sessionId: invocation.sessionId,
          taskId: invocation.taskId,
        })
      );
    }
    const metadata = execution.metadata ?? {};
    const artifactIds = [
      ...new Set([
        ...(metadata.artifactIds ?? []),
        ...refs.map((ref) => ref.artifactId),
      ]),
    ];
    return {
      ...metadata,
      artifacts: [...(metadata.artifacts ?? []), ...refs],
      ...(artifactIds.length ? { artifactIds } : {}),
    };
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

  private async recordApprovalReceipt(
    invocation: ToolInvocation,
    tool: ToolDefinition,
    approvalContext: JsonValue | undefined,
    decision: ApprovalDecision,
    actionDigest: string | undefined
  ): Promise<AgentError | undefined> {
    if (!this.options.approvalReceipts) return undefined;
    try {
      await this.options.approvalReceipts.record({
        id: `approval:${invocation.sessionId}:${invocation.call.id}`,
        sessionId: invocation.sessionId,
        taskId: invocation.taskId,
        callId: invocation.call.id,
        toolName: tool.name,
        risk: tool.risk === 'read'
          ? 'write'
          : tool.risk,
        decision,
        inputDigest:
          actionDigest ??
          `fnv:${hashString(JSON.stringify({
            input: invocation.call.arguments,
            tool: tool.name,
          }))}`,
        ...(actionDigest ? { actionDigest } : {}),
        ...(approvalContext === undefined ? {} : { approvalContext }),
        createdAt: Date.now(),
      });
      return undefined;
    } catch (error) {
      return new AgentError(
        'APPROVAL_RECEIPT_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
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

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function toolResultText(result: ToolExecutionResult): string {
  if (result.status === 'succeeded') {
    const output =
      result.output === undefined
        ? '(no output)'
        : typeof result.output === 'string'
          ? result.output
          : JSON.stringify(result.output);
    return result.metadata
      ? JSON.stringify({
          output: result.output ?? null,
          toolMetadata: result.metadata,
        })
      : output;
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
