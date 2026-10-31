import { AgentError, isAbortError, toStructuredError } from './errors';
import type { IdGenerator, ModelTransport } from './ports';
import { createToolCall, toolResultText, ToolExecutor } from './tool-executor';
import type {
  AgentLoopEvent,
  AgentLoopResult,
  ModelMessage,
  ToolCall,
} from './types';

export interface AgentLoopOptions {
  model: ModelTransport;
  tools: ToolExecutor;
  ids: IdGenerator;
  maxSteps?: number;
}

export interface AgentLoopRequest {
  sessionId: string;
  taskId: string;
  messages: readonly ModelMessage[];
  signal: AbortSignal;
  onEvent?: (event: AgentLoopEvent) => void | Promise<void>;
}

export class AgentLoop {
  private readonly maxSteps: number;
  private readonly steering: ModelMessage[] = [];
  private readonly followUps: ModelMessage[] = [];

  constructor(private readonly options: AgentLoopOptions) {
    this.maxSteps = options.maxSteps ?? 60;
  }

  async run(request: AgentLoopRequest): Promise<AgentLoopResult> {
    const messages = request.messages.map(cloneMessage);

    try {
      for (let turn = 1; turn <= this.maxSteps; turn += 1) {
        this.assertActive(request.signal);
        messages.push(...this.steering.splice(0));
        await request.onEvent?.({ type: 'turn_start', taskId: request.taskId, turn });

        const messageId = this.options.ids.next('message');
        await request.onEvent?.({
          type: 'message_start',
          taskId: request.taskId,
          messageId,
          role: 'assistant',
        });

        let text = '';
        let reasoning = '';
        const calls: ToolCall[] = [];
        for await (const event of this.options.model.stream({
          sessionId: request.sessionId,
          taskId: request.taskId,
          messages: messages.map(cloneMessage),
          tools: this.options.tools.descriptors(),
          signal: request.signal,
        })) {
          this.assertActive(request.signal);
          if (event.type === 'text_delta') {
            text += event.text;
            await request.onEvent?.({
              type: 'message_update',
              taskId: request.taskId,
              messageId,
              delta: event.text,
            });
          } else if (event.type === 'reasoning_delta') {
            reasoning += event.text;
            await request.onEvent?.({
              type: 'reasoning_update',
              taskId: request.taskId,
              messageId,
              delta: event.text,
            });
          } else if (event.type === 'tool_call') {
            calls.push(createToolCall(event.call));
          } else if (event.type === 'error') {
            throw new AgentError(event.error.code, event.error.message, {
              retryable: event.error.retryable,
              details: event.error.details,
            });
          }
        }

        const assistantMessage: ModelMessage = {
          role: 'assistant',
          content: text,
          ...(reasoning ? { reasoning } : {}),
          ...(calls.length ? { toolCalls: calls } : {}),
        };
        messages.push(assistantMessage);
        await request.onEvent?.({
          type: 'message_end',
          taskId: request.taskId,
          messageId,
          message: assistantMessage,
        });

        if (calls.length === 0) {
          await request.onEvent?.({ type: 'turn_end', taskId: request.taskId, turn });
          if (this.steering.length > 0 || this.followUps.length > 0) {
            messages.push(...this.steering.splice(0), ...this.followUps.splice(0));
            continue;
          }
          await request.onEvent?.({ type: 'run_end', taskId: request.taskId, status: 'completed' });
          return { status: 'completed', messages };
        }

        const results = await this.executeTools(calls, request);
        for (let index = 0; index < calls.length; index += 1) {
          const call = calls[index];
          const result = results[index];
          messages.push({
            role: 'tool',
            callId: call.id,
            name: call.name,
            content: toolResultText(result),
          });
        }

        await request.onEvent?.({ type: 'turn_end', taskId: request.taskId, turn });
      }

      throw new AgentError('AGENT_MAX_STEPS', `Agent exceeded ${this.maxSteps} turns`);
    } catch (error) {
      const status = isAbortError(error) || request.signal.aborted ? 'cancelled' : 'failed';
      const structured =
        status === 'cancelled'
          ? new AgentError('TASK_CANCELLED', 'Task was cancelled').toStructured()
          : toStructuredError(error, 'AGENT_LOOP_FAILED');
      await request.onEvent?.({ type: 'run_end', taskId: request.taskId, status });
      return { status, messages, error: structured };
    }
  }

  private assertActive(signal: AbortSignal): void {
    if (signal.aborted) throw new AgentError('TASK_CANCELLED', 'Task was cancelled');
  }

  steer(message: string): void {
    if (message.trim()) this.steering.push({ role: 'user', content: message.trim() });
  }

  followUp(message: string): void {
    if (message.trim()) this.followUps.push({ role: 'user', content: message.trim() });
  }

  private async executeTools(
    calls: ToolCall[],
    request: AgentLoopRequest
  ): Promise<Awaited<ReturnType<ToolExecutor['execute']>>[]> {
    const allParallel = calls.every(
      (call) => this.options.tools.executionMode(call.name) === 'parallel'
    );
    const execute = async (call: ToolCall) => {
      this.assertActive(request.signal);
      const pending = {
        callId: call.id,
        name: call.name,
        status: 'failed' as const,
      };
      await request.onEvent?.({
        type: 'tool_execution_start',
        taskId: request.taskId,
        result: pending,
      });
      const result = await this.options.tools.execute({
        sessionId: request.sessionId,
        taskId: request.taskId,
        call,
        signal: request.signal,
      });
      await request.onEvent?.({
        type: 'tool_execution_end',
        taskId: request.taskId,
        result,
      });
      return result;
    };
    if (allParallel) return Promise.all(calls.map(execute));
    const results = [];
    for (const call of calls) results.push(await execute(call));
    return results;
  }
}

function cloneMessage(message: ModelMessage): ModelMessage {
  if (message.role === 'assistant') {
    return {
      ...message,
      ...(message.toolCalls
        ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) }
        : {}),
    };
  }
  return { ...message };
}
