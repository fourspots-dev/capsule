export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface StructuredError {
  code: string;
  message: string;
  retryable: boolean;
  details?: JsonValue;
}

export type SessionLifecycleState =
  | 'unloaded'
  | 'starting'
  | 'ready'
  | 'stopping'
  | 'faulted';

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type InputDelivery = 'startNow' | 'guide' | 'queue';
export type InputLedgerStatus =
  | 'admitted'
  | 'promoted'
  | 'cancelled'
  | 'discarded'
  | 'failed';

export interface InputLedgerEntry {
  inputId: string;
  sourceCommandId: string;
  status: InputLedgerStatus;
  delivery: InputDelivery;
  text: string;
  admittedAt: number;
  terminalReason?: string;
}

export type ConversationCommandType =
  | 'send_input'
  | 'stop'
  | 'set_mode'
  | 'submit_plan'
  | 'approve_plan'
  | 'compact';

export interface SendInputPayload {
  text: string;
  delivery?: InputDelivery;
  context?: {
    skill?: {
      name: string;
      instructions: string;
    };
    attachments?: Array<{
      name: string;
      type: string;
      text?: string;
      dataBase64?: string;
    }>;
  };
}

export interface StopPayload {
  reason?: string;
}

export interface SetModePayload {
  mode: 'plan' | 'build' | 'edit' | 'guarded' | 'sandbox-auto';
}

export interface PlanPayload {
  plan: string;
}

export interface CompactPayload {
  summary?: string;
  budget?: {
    contextWindow: number;
    reserveTokens: number;
    keepRecentTokens: number;
    maxOutputTokens: number;
  };
  details?: {
    readFiles?: string[];
    modifiedFiles?: string[];
    approvedPlanPath?: string;
  };
}

export interface CommandEnvelope {
  commandId: string;
  clientId: string;
  sessionId: string;
  baseRevision?: number;
  type: ConversationCommandType;
  payload:
    | SendInputPayload
    | StopPayload
    | SetModePayload
    | PlanPayload
    | CompactPayload;
  issuedAt: number;
}

export type CommandAckStatus =
  | 'accepted'
  | 'rejected'
  | 'stale'
  | 'duplicate'
  | 'noop'
  | 'failed';

export interface CommandAck {
  commandId: string;
  sessionId: string;
  status: CommandAckStatus;
  revision: number;
  inputId?: string;
  taskId?: string;
  error?: StructuredError;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ModelMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; reasoning?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; callId: string; name: string; content: string };

export interface ModelRequest {
  sessionId: string;
  taskId: string;
  messages: readonly ModelMessage[];
  tools: readonly ToolDescriptor[];
  signal: AbortSignal;
}

export interface ModelToolDescriptor {
  name: string;
  description: string;
  parameters: Record<string, JsonValue>;
}

export type ToolDescriptor = ModelToolDescriptor;

export type ModelEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'reasoning_delta'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'finish'; reason: string }
  | { type: 'error'; error: StructuredError };

export type ToolRisk = 'read' | 'write' | 'dangerous';

export interface ToolInvocation {
  sessionId: string;
  taskId: string;
  call: ToolCall;
  signal: AbortSignal;
}

export interface ToolArtifactRef {
  artifactId: string;
  name: string;
  mimeType: string;
  bytes: number;
  kind: 'text' | 'image' | 'pdf' | 'log' | 'diff' | 'binary';
}

export interface ToolExecutionMetadata {
  status?: 'succeeded' | 'failed' | 'cancelled';
  action?: {
    id: string;
    version: string;
    sourceId?: string;
  };
  durationMs?: number;
  exitCode?: number;
  truncated?: boolean;
  replayed?: boolean;
  evidence?: {
    id: string;
    status: 'current' | 'stale' | 'failed' | 'invalid';
  };
  artifactIds?: string[];
  artifacts?: ToolArtifactRef[];
}

export interface ToolExecutionAttachment {
  name: string;
  mimeType: string;
  kind: ToolArtifactRef['kind'];
  data: Uint8Array;
}

export interface ToolExecutionOutput {
  value: JsonValue;
  metadata?: ToolExecutionMetadata;
  attachments?: ToolExecutionAttachment[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, JsonValue>;
  outputSchema?: Record<string, JsonValue>;
  risk: ToolRisk;
  capabilities?: string[];
  effect?: 'read' | 'write' | 'execute' | 'network';
  executionMode?: 'parallel' | 'sequential';
  replay?: 'never' | 'safe';
  timeoutMs?: number;
  approvalContext?: (
    input: JsonValue,
    invocation: ToolInvocation
  ) => JsonValue | Promise<JsonValue>;
  execute: (input: JsonValue, invocation: ToolInvocation) => Promise<JsonValue>;
  executeDetailed?: (
    input: JsonValue,
    invocation: ToolInvocation
  ) => Promise<ToolExecutionOutput>;
}

export type ToolExecutionStatus =
  | 'succeeded'
  | 'failed'
  | 'denied'
  | 'cancelled';

export interface ToolExecutionResult {
  callId: string;
  name: string;
  status: ToolExecutionStatus;
  output?: JsonValue;
  error?: StructuredError;
  metadata?: ToolExecutionMetadata;
}

export type AgentLoopEvent =
  | { type: 'turn_start'; taskId: string; turn: number }
  | { type: 'message_start'; taskId: string; messageId: string; role: 'assistant' }
  | { type: 'message_update'; taskId: string; messageId: string; delta: string }
  | { type: 'reasoning_update'; taskId: string; messageId: string; delta: string }
  | { type: 'message_end'; taskId: string; messageId: string; message: ModelMessage }
  | { type: 'tool_execution_start'; taskId: string; result: ToolExecutionResult }
  | { type: 'tool_execution_end'; taskId: string; result: ToolExecutionResult }
  | { type: 'turn_end'; taskId: string; turn: number }
  | { type: 'run_end'; taskId: string; status: 'completed' | 'failed' | 'cancelled' };

export interface AgentLoopResult {
  status: 'completed' | 'failed' | 'cancelled';
  messages: ModelMessage[];
  error?: StructuredError;
}

export type ConversationRowKind =
  | 'user'
  | 'assistant'
  | 'reasoning'
  | 'tool'
  | 'activity'
  | 'plan';

export interface ConversationRow {
  id: string;
  entityId: string;
  productTurnId: string;
  kind: ConversationRowKind;
  text: string;
  status: 'pending' | 'streaming' | 'completed' | 'failed' | 'denied' | 'cancelled';
  callId?: string;
  toolName?: string;
  toolMetadata?: ToolExecutionMetadata;
  startedAt?: number;
  completedAt?: number;
}

export type ConversationPhase =
  | 'draft'
  | 'prewarming'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'error';

export interface ActionAvailability {
  canSend: boolean;
  canStop: boolean;
  canApprove: boolean;
  canQueue: boolean;
}

export interface ChildTaskProjection {
  taskId: string;
  sessionId: string;
  parentTaskId: string;
  parentSessionId?: string;
  profileName: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  executionMode: 'foreground' | 'background' | 'isolated-worktree' | 'sandbox';
  summary?: string;
  updatedAt?: number;
  workspaceId?: string;
  changedFiles?: number;
}

export interface ProductProjection {
  sessionId: string;
  revision: number;
  eventSeq: number;
  logEpoch: string;
  phase: ConversationPhase;
  lifecycle: SessionLifecycleState;
  taskStatus: TaskStatus;
  inputRouting: 'startNow' | 'queue' | 'guide' | 'blocked';
  queueLength: number;
  activeTaskId?: string;
  lastError?: StructuredError;
  permissionMode: 'plan' | 'build' | 'edit' | 'guarded' | 'sandbox-auto';
  plan?: {
    text?: string;
    approvedAt?: number;
    approvedDigest?: string;
  };
  children?: ChildTaskProjection[];
  rows: ConversationRow[];
  availability: ActionAvailability;
}

export interface SessionView {
  sessionId: string;
  lifecycle: SessionLifecycleState;
  taskStatus: TaskStatus;
  revision: number;
  eventSeq: number;
  logEpoch: string;
  queueLength: number;
  activeTaskId?: string;
  lastError?: StructuredError;
  permissionMode: 'plan' | 'build' | 'edit' | 'guarded' | 'sandbox-auto';
  plan?: {
    text?: string;
    approvedAt?: number;
    approvedDigest?: string;
  };
  children?: ChildTaskProjection[];
  rows: readonly ConversationRow[];
  pendingApproval: boolean;
  ledger: readonly InputLedgerEntry[];
}
