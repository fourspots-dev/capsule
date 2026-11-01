import type {
  CommandAck,
  CommandEnvelope,
  ProductProjection,
  StructuredError,
  TaskStatus,
} from '../core/types';

export type TuiRoute =
  | { kind: 'conversation' }
  | { kind: 'sessions'; query: string; selectedId?: string }
  | { kind: 'agents'; rootSessionId: string; selectedId?: string }
  | { kind: 'review'; targetSessionId: string }
  | { kind: 'status'; targetSessionId: string }
  | { kind: 'actions'; selectedId?: string }
  | { kind: 'commands'; query: string }
  | { kind: 'help' };

export type TuiFocus = 'composer' | 'transcript' | 'overlay';
export type TuiConnectionState = 'online' | 'reconnecting' | 'offline';
export type AgentFilter = 'all' | 'active' | 'attention' | 'done';
export type ReasoningMode = 'hidden' | 'preview' | 'full';

export interface RuntimeSessionSummary {
  sessionId: string;
  parentSessionId?: string;
  title: string;
  project?: string;
  branch?: string;
  taskStatus: TaskStatus;
  lifecycle?: 'unloaded' | 'starting' | 'ready' | 'stopping' | 'faulted';
  revision?: number;
  eventSeq?: number;
  updatedAt: number;
  rowCount?: number;
  queueLength?: number;
  childCount?: number;
  attentionCount?: number;
  lastError?: StructuredError;
}

export interface ProjectionEnvelope {
  sessionId: string;
  logEpoch: string;
  subscriptionId?: string;
  frame:
    | { type: 'snapshot'; projection: ProductProjection }
    | {
        type: 'delta';
        sessionId: string;
        logEpoch: string;
        baseRevision: number;
        revision: number;
        eventSeq: number;
        deltas: import('../core/projection').ProjectionDelta[];
      };
}

export interface TuiRuntimePort {
  listSessions(): Promise<RuntimeSessionSummary[]>;
  loadProjection(sessionId: string): Promise<ProductProjection>;
  subscribe(
    sessionId: string,
    subscriptionId: string,
    listener: (envelope: ProjectionEnvelope) => void
  ): Promise<() => void>;
  command(command: CommandEnvelope): Promise<CommandAck>;
  stopSession(sessionId: string): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  renameSession(sessionId: string, title: string): Promise<void>;
}

export interface SessionUiState {
  sessionId: string;
  draftText: string;
  cursor: number;
  attachments: Array<{
    id: string;
    name: string;
    mimeType: string;
    artifactId?: string;
  }>;
  selectedSkill?: string;
  scrollAnchor?: string;
  expandedItemIds: string[];
  selectionId?: string;
  lastSeenEventSeq: number;
  boardFilter: AgentFilter;
  boardSelection?: string;
}

export interface StatusBarFacts {
  blockers?: string[];
  connection: TuiConnectionState;
  taskStatus?: TaskStatus;
  taskLabel?: string;
  elapsedMs?: number;
  sessionTitle?: string;
  sessionKind?: 'root' | 'child';
  project?: string;
  branch?: string;
  dirty?: boolean;
  workspaceRevision?: number;
  queueLength?: number;
  agentCount?: number;
  agentAttention?: number;
  model?: string;
  provider?: string;
  processAvailable?: boolean;
  extensionCells?: StatusExtension[];
}

export interface StatusExtension {
  key: string;
  text: string;
  priority: number;
  severity?: 'info' | 'warning' | 'error';
}

export interface TuiAgentRecord {
  taskId: string;
  sessionId: string;
  parentTaskId: string;
  parentSessionId?: string;
  profileName: string;
  brief?: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  executionMode: string;
  workspaceId?: string;
  createdAt?: number;
  updatedAt?: number;
  summary?: string;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  attention?: boolean;
  resumable?: boolean;
}

export interface TuiActionInfo {
  id: string;
  version: string;
  title: string;
  description: string;
  sourceId: string;
  state: 'available' | 'degraded' | 'unavailable';
  effects: string[];
  risk: 'read' | 'write' | 'dangerous';
  limitations?: string[];
}

export interface AgentTreeRow {
  agent: TuiAgentRecord;
  depth: number;
  hasChildren: boolean;
}

export interface TuiReviewSnapshot {
  from: string;
  to: string;
  files: Array<{
    path: string;
    status: 'added' | 'deleted' | 'modified' | 'binary';
    patch?: string;
  }>;
  additions?: number;
  deletions?: number;
  verification?: Array<{
    name: string;
    status: 'passed' | 'failed' | 'skipped';
    detail?: string;
  }>;
  risks?: string[];
}

export type TuiReviewProvider = () => Promise<TuiReviewSnapshot>;
