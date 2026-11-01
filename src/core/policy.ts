import { AgentError } from './errors';
import type { JsonValue, ToolDefinition } from './types';

export type PermissionMode =
  | 'plan'
  | 'build'
  | 'edit'
  | 'guarded'
  | 'sandbox-auto';

export interface ActionRequest {
  sessionId: string;
  taskId: string;
  callId: string;
  toolName: string;
  capabilities: string[];
  effect: NonNullable<ToolDefinition['effect']>;
  risk: ToolDefinition['risk'];
  input: JsonValue;
  approvalContext?: JsonValue;
}

export interface PolicyDecision {
  decision: 'allow' | 'ask' | 'deny';
  actionDigest: string;
  reason?: string;
}

export interface PlanSnapshot {
  mode: PermissionMode;
  plan?: string;
  approvedAt?: number;
  approvedDigest?: string;
}

export class PlanModeController {
  private snapshot: PlanSnapshot;

  constructor(
    private readonly now: () => number = () => Date.now(),
    initial: PermissionMode = 'guarded'
  ) {
    this.snapshot = { mode: initial };
  }

  getState(): PlanSnapshot {
    return { ...this.snapshot };
  }

  setMode(mode: PermissionMode): PlanSnapshot {
    if (this.snapshot.mode === 'plan' && mode === 'build' && !this.snapshot.approvedAt) {
      throw new AgentError('PLAN_NOT_APPROVED', 'The current plan must be approved before build mode');
    }
    this.snapshot =
      mode === 'plan'
        ? { mode }
        : { ...this.snapshot, mode };
    return this.getState();
  }

  async submitPlan(plan: string): Promise<PlanSnapshot> {
    if (this.snapshot.mode !== 'plan') {
      throw new AgentError('PLAN_MODE_REQUIRED', 'A plan can only be submitted in plan mode');
    }
    if (!plan.trim()) throw new AgentError('PLAN_EMPTY', 'Plan cannot be empty');
    this.snapshot = {
      mode: 'plan',
      plan: plan.trim(),
      approvedDigest: await digest(plan.trim()),
    };
    return this.getState();
  }

  approvePlan(expectedDigest?: string): PlanSnapshot {
    if (!this.snapshot.plan || !this.snapshot.approvedDigest) {
      throw new AgentError('PLAN_NOT_SUBMITTED', 'No plan is available for approval');
    }
    if (expectedDigest && expectedDigest !== this.snapshot.approvedDigest) {
      throw new AgentError('PLAN_DIGEST_MISMATCH', 'The plan changed before approval');
    }
    this.snapshot = {
      ...this.snapshot,
      approvedAt: this.now(),
    };
    return this.getState();
  }

  restore(snapshot: PlanSnapshot): void {
    const modes: PermissionMode[] = ['plan', 'build', 'edit', 'guarded', 'sandbox-auto'];
    if (!modes.includes(snapshot.mode)) {
      throw new AgentError('PLAN_STATE_INVALID', `Unknown permission mode: ${snapshot.mode}`);
    }
    this.snapshot = {
      mode: snapshot.mode,
      ...(snapshot.plan ? { plan: snapshot.plan } : {}),
      ...(snapshot.approvedAt ? { approvedAt: snapshot.approvedAt } : {}),
      ...(snapshot.approvedDigest ? { approvedDigest: snapshot.approvedDigest } : {}),
    };
  }
}

export class PermissionModeRegistry {
  private readonly controllers = new Map<string, PlanModeController>();

  constructor(
    private readonly defaultMode: PermissionMode = 'guarded',
    private readonly now: () => number = () => Date.now()
  ) {}

  get(sessionId: string): PlanModeController {
    const existing = this.controllers.get(sessionId);
    if (existing) return existing;
    const controller = new PlanModeController(this.now, this.defaultMode);
    this.controllers.set(sessionId, controller);
    return controller;
  }

  mode(sessionId: string): PermissionMode {
    return this.get(sessionId).getState().mode;
  }

  delete(sessionId: string): void {
    this.controllers.delete(sessionId);
  }

  restore(sessionId: string, snapshot: PlanSnapshot): void {
    this.get(sessionId).restore(snapshot);
  }
}

export class PolicyEngine {
  constructor(
    private readonly mode: (sessionId: string) => PermissionMode
  ) {}

  async evaluate(
    request: ActionRequest,
    signal?: AbortSignal
  ): Promise<PolicyDecision> {
    if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'Policy evaluation was cancelled');
    const actionDigest = await digest(JSON.stringify(request));
    const mode = this.mode(request.sessionId);
    if (mode === 'plan' && request.effect !== 'read') {
      return {
        decision: 'deny',
        actionDigest,
        reason: 'Plan mode only allows read-only capabilities',
      };
    }
    if (mode === 'guarded' || mode === 'plan') {
      return {
        decision: request.effect === 'read' ? 'allow' : 'ask',
        actionDigest,
      };
    }
    if (mode === 'edit') {
      return {
        decision: request.risk === 'dangerous' || request.effect === 'execute' ? 'ask' : 'allow',
        actionDigest,
      };
    }
    if (mode === 'sandbox-auto') {
      return {
        decision: request.effect === 'network' ? 'ask' : 'allow',
        actionDigest,
      };
    }
    return {
      decision: request.risk === 'dangerous' ? 'ask' : 'allow',
      actionDigest,
    };
  }
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
