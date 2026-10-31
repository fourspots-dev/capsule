import type {
  CommandEnvelope,
  ProductProjection,
  StructuredError,
} from '../core/types';
import type { ProjectionFrame } from '../core/projection';

export type RuntimeRequest =
  | { type: 'hello'; clientId: string; requestId?: string }
  | { type: 'subscribe'; sessionId: string; requestId?: string }
  | { type: 'unsubscribe'; sessionId: string; requestId?: string }
  | { type: 'command'; command: CommandEnvelope; requestId?: string }
  | { type: 'get_projection'; sessionId: string; requestId?: string }
  | { type: 'query_command'; sessionId: string; commandId: string; requestId?: string }
  | { type: 'stop_session'; sessionId: string; requestId?: string }
  | { type: 'list_sessions'; requestId?: string }
  | { type: 'clear_history'; requestId?: string }
  | { type: 'delete_session'; sessionId: string; requestId?: string }
  | { type: 'restart_session'; sessionId: string; requestId?: string }
  | { type: 'list_skills'; requestId?: string }
  | { type: 'reload_runtime'; requestId?: string }
  | { type: 'read_artifact'; artifactId: string; requestId?: string }
  | { type: 'list_tabs'; requestId?: string }
  | { type: 'select_tab'; sessionId: string; tabId: string; requestId?: string }
  | {
      type: 'resolve_tab_session';
      windowId: number;
      tabId: string;
      requestId?: string;
    }
  | {
      type: 'create_tab_session';
      windowId: number;
      tabId: string;
      requestId?: string;
    }
  | {
      type: 'bind_tab_session';
      windowId: number;
      tabId: string;
      sessionId: string;
      requestId?: string;
    }
  | {
      type: 'forget_tab_session';
      windowId: number;
      tabId: string;
      requestId?: string;
    }
  | { type: 'approval_response'; approvalId: string; approved: boolean; requestId?: string }
  | {
      type: 'handoff_response';
      handoffId: string;
      decision: 'continue' | 'cancel';
      requestId?: string;
    };

export type RuntimeResponse =
  | { type: 'ready'; revision: number }
  | { type: 'response'; requestId: string; ok: true; data?: unknown }
  | { type: 'response'; requestId: string; ok: false; error: StructuredError }
  | { type: 'projection'; frame: ProjectionFrame }
  | {
      type: 'approval_request';
      approvalId: string;
      sessionId: string;
      taskId: string;
      callId: string;
      toolName: string;
      risk: 'write' | 'dangerous';
      input: unknown;
    }
  | {
      type: 'handoff_request';
      handoffId: string;
      sessionId: string;
      taskId: string;
      toolName: string;
      reason: string;
    };

export interface RuntimePort {
  postMessage(message: RuntimeResponse | RuntimeRequest): void;
  onMessage: {
    addListener(listener: (message: RuntimeRequest | RuntimeResponse) => void): void;
    removeListener(listener: (message: RuntimeRequest | RuntimeResponse) => void): void;
  };
  onDisconnect: {
    addListener(listener: () => void): void;
    removeListener(listener: () => void): void;
  };
}
