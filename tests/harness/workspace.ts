import {
  SequentialIdGenerator,
  ToolExecutor,
  WorkspaceRuntime,
  type ApprovalPort,
  type CommandEnvelope,
  type SessionStore,
  type ToolDefinition,
} from '../../src/core';
import { FakeApproval, FakeClock, FakeModelTransport, type FakeModelHandler } from './fakes';

export interface TestWorkspaceOptions {
  model: FakeModelHandler;
  tools: ToolDefinition[];
  approval?: ApprovalPort;
  systemPrompt?: string;
  maxSteps?: number;
  sessionStore?: SessionStore;
}

export function createTestWorkspace(options: TestWorkspaceOptions) {
  const clock = new FakeClock();
  const ids = new SequentialIdGenerator();
  const model = new FakeModelTransport(options.model);
  const approval = options.approval ?? new FakeApproval();
  const tools = new ToolExecutor(options.tools, approval);
  const runtime = new WorkspaceRuntime({
    model,
    tools,
    clock,
    ids,
    systemPrompt: options.systemPrompt,
    maxSteps: options.maxSteps,
    sessionStore: options.sessionStore,
  });

  return { clock, ids, model, approval, tools, runtime };
}

export function command(
  sessionId: string,
  commandId: string,
  text: string,
  overrides: Partial<CommandEnvelope> = {}
): CommandEnvelope {
  return {
    commandId,
    clientId: 'test-client',
    sessionId,
    type: 'send_input',
    payload: { text },
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}

export function stopCommand(
  sessionId: string,
  commandId: string,
  overrides: Partial<CommandEnvelope> = {}
): CommandEnvelope {
  return {
    commandId,
    clientId: 'test-client',
    sessionId,
    type: 'stop',
    payload: { reason: 'test' },
    issuedAt: 1_700_000_000_000,
    ...overrides,
  };
}
