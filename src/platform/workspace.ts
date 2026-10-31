import type { ProductProjection, SessionView } from '../core/types';

export type WorkspaceId = string;
export type WorkspaceTargetId = string;

export interface WorkspaceActivation {
  sessionId: string;
  workspaceId: WorkspaceId;
  activeTargetId?: WorkspaceTargetId;
  generation: number;
}

export interface WorkspaceTarget {
  id: WorkspaceTargetId;
  kind: string;
  title?: string;
  active: boolean;
}

export interface SessionAccessPort {
  hydrateSession(sessionId: string): Promise<SessionView | undefined>;
  ensureSessionReady(sessionId: string): Promise<void>;
  loadProjection(sessionId: string): Promise<ProductProjection>;
}

export interface WorkspaceControlPort<ActivationInput = unknown> {
  resolve(input: ActivationInput): Promise<WorkspaceActivation>;
  create(input?: ActivationInput): Promise<WorkspaceActivation>;
  bind(
    sessionId: string,
    input: ActivationInput
  ): Promise<WorkspaceActivation>;
  listTargets(sessionId: string): Promise<WorkspaceTarget[]>;
  assertTarget(sessionId: string, targetId: WorkspaceTargetId): Promise<void>;
  release(sessionId: string): Promise<void>;
  clear(): Promise<void>;
}

export interface WorkspaceTargetControl {
  createTarget(
    sessionId: string,
    spec?: Record<string, unknown>
  ): Promise<WorkspaceTarget>;
  activateTarget(sessionId: string, targetId: WorkspaceTargetId): Promise<void>;
  listTargets(sessionId: string): Promise<WorkspaceTarget[]>;
  assertTarget(sessionId: string, targetId: WorkspaceTargetId): Promise<void>;
}
