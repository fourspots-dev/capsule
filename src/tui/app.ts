import type { ProductProjection } from '../core/types';
import type { ApprovalRequest } from '../core/ports';
import { buildAgentRows, selectAgent } from './agent-board';
import {
  clampCursor,
  deleteBackward,
  deleteForward,
  insertAtCursor,
  moveCursor,
} from './cursor';
import { mapKey, type TuiIntent } from './keymap';
import {
  renderTui,
  renderTuiFrame,
  type TuiRenderedFrame,
  type TuiRenderSnapshot,
} from './render';
import { RouteController } from './route-controller';
import { buildSessionRows } from './session-list';
import { SessionController } from './session-controller';
import type {
  AgentFilter,
  RuntimeSessionSummary,
  ReasoningMode,
  StatusBarFacts,
  TuiAgentRecord,
  TuiFocus,
  TuiRuntimePort,
  TuiReviewProvider,
  TuiReviewSnapshot,
} from './types';
import { ViewStateStore } from './view-state-store';

export interface TuiAppOptions {
  runtime: TuiRuntimePort;
  viewState?: ViewStateStore;
  project?: string;
  branch?: string;
  model?: string;
  provider?: string;
  processAvailable?: boolean;
  review?: TuiReviewProvider;
  agentWorkspace?: TuiAgentWorkspacePort;
  capsuleExport?: () => Promise<{ path: string }>;
  now?: () => number;
}

export interface TuiAgentWorkspacePort {
  previewMerge(taskId: string): Promise<TuiReviewSnapshot>;
  applyMerge(taskId: string): Promise<void>;
}

interface Confirmation {
  kind: 'rename' | 'delete' | 'merge' | 'approval';
  sessionId: string;
  value: string;
  taskId?: string;
  approval?: {
    request: ApprovalRequest;
    resolve(value: boolean): void;
    abort: () => void;
  };
}

export class TuiApp {
  readonly routes = new RouteController();
  readonly sessionsController: SessionController;
  private readonly viewState: ViewStateStore;
  private readonly now: () => number;
  private sessions: RuntimeSessionSummary[] = [];
  private selectedSessionId?: string;
  private sessionQuery = '';
  private composer = '';
  private composerCursor = 0;
  private statusMessage?: string;
  private exitArmed = false;
  private shouldExit = false;
  private confirmation?: Confirmation;
  private sessionSequence = 0;
  private filterIndex = 0;
  private agentFilter: AgentFilter = 'all';
  private review?: TuiReviewSnapshot;
  private readonly mergePreviewed = new Set<string>();
  private readonly renderListeners = new Set<() => void>();
  private reasoningMode: ReasoningMode = 'preview';

  constructor(private readonly options: TuiAppOptions) {
    this.now = options.now ?? (() => Date.now());
    this.viewState = options.viewState ?? new ViewStateStore();
    this.sessionsController = new SessionController(
      options.runtime,
      this.viewState,
      this.now
    );
    this.sessionsController.subscribe(() => {
      this.syncActiveSummary();
      this.notifyRender();
    });
  }

  get exitRequested(): boolean {
    return this.shouldExit;
  }

  requestApproval(
    request: ApprovalRequest,
    signal: AbortSignal
  ): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (this.confirmation) {
      return Promise.reject(new Error('Another TUI confirmation is active'));
    }
    return new Promise<boolean>((resolveApproval) => {
      const abort = () => {
        if (this.confirmation?.kind !== 'approval') return;
        this.confirmation = undefined;
        resolveApproval(false);
        this.notifyRender();
      };
      signal.addEventListener('abort', abort, { once: true });
      this.confirmation = {
        kind: 'approval',
        sessionId: request.sessionId,
        value: '',
        approval: {
          request,
          resolve: resolveApproval,
          abort: () => signal.removeEventListener('abort', abort),
        },
      };
      this.notifyRender();
    });
  }

  async initialize(): Promise<void> {
    this.sessions = await this.options.runtime.listSessions();
    const active = await this.sessionsController.initialize();
    this.reasoningMode = this.viewState.preferredReasoningMode;
    this.selectedSessionId = active ?? this.sessions[0]?.sessionId;
    if (this.selectedSessionId && !active) {
      await this.sessionsController.switch(this.selectedSessionId);
    }
    if (this.sessionsController.active) {
      const state = await this.viewState.get(this.sessionsController.active);
      this.composer = state.draftText;
      this.composerCursor = clampCursor(this.composer, state.cursor);
    }
  }

  async handleInput(input: string): Promise<void> {
    for (const key of splitInput(input)) {
      if (await this.handleKey(key)) break;
    }
  }

  async action(intent: TuiIntent): Promise<void> {
    if (intent.type === 'export-capsule') {
      await this.exportCapsule();
      return;
    }
    if (this.confirmation) {
      await this.handleConfirmation(intent);
      return;
    }
    if (intent.type === 'sessions') {
      await this.openSessions();
      return;
    }
    if (intent.type === 'reasoning-mode') {
      const modes: ReasoningMode[] = ['hidden', 'preview', 'full'];
      const index = modes.indexOf(this.reasoningMode);
      this.reasoningMode = modes[(index + 1) % modes.length];
      await this.viewState.setReasoningMode(this.reasoningMode);
      this.statusMessage = `Reasoning view: ${this.reasoningMode}`;
      return;
    }
    if (intent.type === 'agents') {
      if (this.sessionsController.active) {
        this.agentFilter = (
          await this.viewState.get(this.sessionsController.active)
        ).boardFilter;
      }
      this.filterIndex = ['all', 'active', 'attention', 'done'].indexOf(
        this.agentFilter
      );
      this.routes.push({
        kind: 'agents',
        rootSessionId: this.sessionsController.active ?? '',
      });
      this.selectFirstAgent();
      return;
    }
    if (intent.type === 'status') {
      if (this.sessionsController.active) {
        this.routes.push({
          kind: 'status',
          targetSessionId: this.sessionsController.active,
        });
      }
      return;
    }
    if (intent.type === 'review') {
      if (this.sessionsController.active) {
        if (this.options.review) {
          try {
            this.review = await this.options.review();
          } catch (error) {
            this.statusMessage =
              error instanceof Error ? error.message : String(error);
          }
        }
        this.routes.push({
          kind: 'review',
          targetSessionId: this.sessionsController.active,
        });
      }
      return;
    }
    if (intent.type === 'commands' || intent.type === 'help') {
      this.routes.push({ kind: intent.type === 'commands' ? 'commands' : 'help', query: '' });
      return;
    }
    if (intent.type === 'back') {
      this.confirmation = undefined;
      const next = this.routes.back();
      if (
        next.kind === 'agents' &&
        next.rootSessionId &&
        next.rootSessionId !== this.sessionsController.active
      ) {
        await this.switchSession(next.rootSessionId, false);
        this.agentFilter = (
          await this.viewState.get(next.rootSessionId)
        ).boardFilter;
        this.routes.replace(next);
      }
      return;
    }
    if (this.routes.current.kind === 'sessions') {
      await this.handleSessionsIntent(intent);
      return;
    }
    if (this.routes.current.kind === 'agents') {
      await this.handleAgentsIntent(intent);
      return;
    }
    if (this.routes.current.kind !== 'conversation') return;
    await this.handleConversationIntent(intent);
  }

  private async exportCapsule(): Promise<void> {
    if (!this.options.capsuleExport) {
      this.statusMessage = 'Workspace Capsule export is unavailable';
      this.notifyRender();
      return;
    }
    try {
      this.statusMessage = 'Exporting Workspace Capsule…';
      this.notifyRender();
      const result = await this.options.capsuleExport();
      this.statusMessage = `Capsule exported: ${result.path}`;
    } catch (error) {
      this.statusMessage = `Capsule export failed: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
    this.notifyRender();
  }

  render(width: number, height: number): string[] {
    return renderTui(this.snapshot(), width, height);
  }

  renderStyled(
    width: number,
    height: number,
    options?: Parameters<typeof renderTuiFrame>[3]
  ): string[] {
    return this.renderFrame(width, height, options).lines;
  }

  renderFrame(
    width: number,
    height: number,
    options?: Parameters<typeof renderTuiFrame>[3]
  ): TuiRenderedFrame {
    return renderTuiFrame(this.snapshot(), width, height, options);
  }

  onRender(listener: () => void): () => void {
    this.renderListeners.add(listener);
    return () => this.renderListeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.sessionsController.active) {
      await this.viewState.update(this.sessionsController.active, {
        draftText: this.composer,
        cursor: this.composerCursor,
      });
    }
    await this.sessionsController.dispose();
  }

  private async handleKey(key: string): Promise<boolean> {
    const intent = mapKey(
      key,
      this.keymapContext()
    );
    if (intent) await this.action(intent);
    else if (key.length > 1 && !key.startsWith('\x1b')) {
      await this.insertText(key);
    }
    if (this.shouldExit) return true;
    if (intent && intent.type !== 'stop') this.exitArmed = false;
    return false;
  }

  private keymapContext() {
    return {
      route: this.routes.current,
      focus: (this.routes.current.kind === 'conversation'
        ? 'composer'
        : 'overlay') as TuiFocus,
      composerEmpty: !this.composer,
    };
  }

  private async handleConversationIntent(intent: TuiIntent): Promise<void> {
    if (intent.type === 'text') {
      await this.insertText(intent.text);
      return;
    }
    if (intent.type === 'newline') {
      await this.insertText('\n');
      return;
    }
    if (intent.type === 'backspace') {
      const next = deleteBackward(this.composer, this.composerCursor);
      this.composer = next.value;
      this.composerCursor = next.cursor;
      await this.persistDraft();
      return;
    }
    if (intent.type === 'delete') {
      const next = deleteForward(this.composer, this.composerCursor);
      this.composer = next.value;
      this.composerCursor = next.cursor;
      await this.persistDraft();
      return;
    }
    if (
      intent.type === 'left' ||
      intent.type === 'right' ||
      intent.type === 'home' ||
      intent.type === 'end'
    ) {
      this.composerCursor = moveCursor(
        this.composer,
        this.composerCursor,
        intent.type
      );
      await this.persistDraft();
      return;
    }
    if (intent.type === 'send') {
      await this.send();
      return;
    }
    if (intent.type === 'stop') {
      const projection = this.sessionsController.currentProjection;
      if (
        projection &&
        ['queued', 'running', 'waiting'].includes(projection.taskStatus)
      ) {
        await this.sessionsController.stop();
        this.statusMessage = 'Stopping current task…';
      } else if (this.exitArmed) {
        this.shouldExit = true;
      } else {
        this.exitArmed = true;
        this.statusMessage = 'No task running. Ctrl+C again to exit.';
      }
    }
  }

  private async handleSessionsIntent(intent: TuiIntent): Promise<void> {
    if (intent.type === 'up' || intent.type === 'down') {
      this.moveSession(intent.type === 'up' ? -1 : 1);
      return;
    }
    const key = intent.type === 'text' ? intent.text.toLowerCase() : '';
    if (key === 'n') {
      await this.newSession();
      return;
    }
    if (key === 'r' && this.selectedSessionId) {
      this.confirmation = {
        kind: 'rename',
        sessionId: this.selectedSessionId,
        value: this.sessions.find((item) => item.sessionId === this.selectedSessionId)?.title ?? '',
      };
      return;
    }
    if (key === 'd' && this.selectedSessionId) {
      this.confirmation = {
        kind: 'delete',
        sessionId: this.selectedSessionId,
        value: '',
      };
      return;
    }
    if (intent.type === 'text') {
      this.sessionQuery += intent.text;
      this.selectFirstSession();
      return;
    }
    if (intent.type === 'backspace') {
      this.sessionQuery = this.sessionQuery.slice(0, -1);
      this.selectFirstSession();
      return;
    }
    if (intent.type === 'activate') {
      if (!this.selectedSessionId) return;
      await this.switchSession(this.selectedSessionId);
      return;
    }
  }

  private async handleAgentsIntent(intent: TuiIntent): Promise<void> {
    const controls = this.agentControls();
    if (intent.type === 'up' || intent.type === 'down') {
      const selected = selectAgent(
        controls.rows,
        controls.route.selectedId,
        intent.type === 'up' ? -1 : 1
      );
      if (this.sessionsController.active) {
        await this.viewState.update(this.sessionsController.active, {
          boardSelection: selected,
        });
      }
      this.routes.replace({ ...controls.route, selectedId: selected });
      return;
    }
    if (intent.type === 'text' && intent.text.toLowerCase() === 'f') {
      const filters: AgentFilter[] = ['all', 'active', 'attention', 'done'];
      this.filterIndex = (this.filterIndex + 1) % filters.length;
      if (this.sessionsController.active) {
        await this.viewState.setBoardFilter(
          this.sessionsController.active,
          filters[this.filterIndex]
        );
      }
      this.agentFilter = filters[this.filterIndex];
      return;
    }
    if (intent.type === 'text' && intent.text.toLowerCase() === 's') {
      const selected = controls.rows.find(
        (row) => row.agent.taskId === controls.route.selectedId
      );
      if (selected) {
        await this.options.runtime.stopSession(selected.agent.sessionId);
        this.statusMessage = 'Stop requested';
      }
      return;
    }
    if (intent.type === 'text' && intent.text.toLowerCase() === 'm') {
      const selected = controls.rows.find(
        (row) => row.agent.taskId === controls.route.selectedId
      );
      if (selected && this.options.agentWorkspace) {
        try {
          this.review = await this.options.agentWorkspace.previewMerge(
            selected.agent.taskId
          );
          this.mergePreviewed.add(selected.agent.taskId);
          this.routes.push({
            kind: 'review',
            targetSessionId: this.sessionsController.active ?? '',
          });
        } catch (error) {
          this.statusMessage =
            error instanceof Error ? error.message : String(error);
        }
      } else if (selected) {
        this.statusMessage = 'Workspace merge is unavailable for this driver';
      }
      return;
    }
    if (intent.type === 'text' && intent.text.toLowerCase() === 'a') {
      const selected = controls.rows.find(
        (row) => row.agent.taskId === controls.route.selectedId
      );
      if (selected && this.options.agentWorkspace) {
        if (!this.mergePreviewed.has(selected.agent.taskId)) {
          this.statusMessage = 'Preview this merge with M before applying it';
          return;
        }
        this.confirmation = {
          kind: 'merge',
          sessionId: this.sessionsController.active ?? '',
          value: '',
          taskId: selected.agent.taskId,
        };
      }
      return;
    }
    if (intent.type === 'activate') {
      const selected = controls.rows.find(
        (row) => row.agent.taskId === controls.route.selectedId
      );
      if (selected) {
        await this.switchSession(selected.agent.sessionId, false);
        this.routes.push({
          kind: 'conversation',
        });
      }
    }
  }

  private async handleConfirmation(intent: TuiIntent): Promise<void> {
    const confirmation = this.confirmation!;
    if (intent.type === 'back') {
      if (confirmation.kind === 'approval') {
        confirmation.approval?.abort();
        confirmation.approval?.resolve(false);
      }
      this.confirmation = undefined;
      this.notifyRender();
      return;
    }
    if (confirmation.kind === 'approval') {
      if (intent.type === 'activate' || intent.type === 'send') {
        confirmation.approval?.abort();
        confirmation.approval?.resolve(true);
        this.confirmation = undefined;
        this.notifyRender();
      }
      return;
    }
    if (confirmation.kind === 'rename') {
      if (intent.type === 'text') confirmation.value += intent.text;
      if (intent.type === 'backspace') confirmation.value = confirmation.value.slice(0, -1);
      if (intent.type === 'activate' || intent.type === 'send') {
        if (confirmation.value.trim()) {
          await this.options.runtime.renameSession(
            confirmation.sessionId,
            confirmation.value.trim()
          );
          await this.refreshSessions();
        }
        this.confirmation = undefined;
      }
      return;
    }
    if (confirmation.kind === 'merge') {
      if (intent.type === 'activate' || intent.type === 'send') {
        try {
          await this.options.agentWorkspace!.applyMerge(confirmation.taskId!);
          this.mergePreviewed.delete(confirmation.taskId!);
          this.statusMessage = 'Child workspace merged';
          this.confirmation = undefined;
          this.routes.back();
        } catch (error) {
          this.statusMessage =
            error instanceof Error ? error.message : String(error);
          this.confirmation = undefined;
        }
      }
      return;
    }
    if (intent.type === 'activate' || intent.type === 'send') {
      await this.options.runtime.deleteSession(confirmation.sessionId);
      await this.viewState.remove(confirmation.sessionId);
      await this.refreshSessions();
      this.selectedSessionId = this.sessions[0]?.sessionId;
      if (this.selectedSessionId) await this.switchSession(this.selectedSessionId);
      this.confirmation = undefined;
    }
  }

  private async send(): Promise<void> {
    const text = this.composer.trim();
    if (!text) return;
    if (!this.sessionsController.active) {
      const id = this.newSessionId();
      this.sessionsController.activateLocal(id);
    }
    this.composer = '';
    this.composerCursor = 0;
    await this.persistDraft();
    const active = this.sessionsController.active;
    const ack = await this.sessionsController.send(text);
    if (active && !this.sessionsController.currentProjection) {
      await this.sessionsController.switch(active);
    }
    this.statusMessage =
      ack.status === 'accepted' || ack.status === 'duplicate'
        ? undefined
        : `Send failed: ${ack.error?.message ?? ack.status}`;
    await this.refreshSessions();
  }

  private async insertText(text: string): Promise<void> {
    const next = insertAtCursor(this.composer, this.composerCursor, text);
    this.composer = next.value;
    this.composerCursor = next.cursor;
    await this.persistDraft();
  }

  private async persistDraft(): Promise<void> {
    const active = this.sessionsController.active;
    if (!active) return;
    await this.viewState.update(active, {
      draftText: this.composer,
      cursor: this.composerCursor,
    });
  }

  private async openSessions(): Promise<void> {
    await this.refreshSessions();
    this.routeToSessionsAndSelect();
    this.routes.push({ kind: 'sessions', query: this.sessionQuery });
  }

  private async newSession(): Promise<void> {
    const id = this.newSessionId();
    this.sessions.unshift({
      sessionId: id,
      title: 'New chat',
      taskStatus: 'completed',
      lifecycle: 'unloaded',
      revision: 0,
      eventSeq: 0,
      updatedAt: this.now(),
      rowCount: 0,
      childCount: 0,
      attentionCount: 0,
      ...(this.options.project ? { project: this.options.project } : {}),
      ...(this.options.branch ? { branch: this.options.branch } : {}),
    });
    this.selectedSessionId = id;
    this.sessionsController.activateLocal(id);
    this.composer = '';
    this.composerCursor = 0;
    this.routes.reset();
  }

  private async switchSession(sessionId: string, resetRoute = true): Promise<void> {
    await this.sessionsController.switch(sessionId);
    this.selectedSessionId = sessionId;
    const state = await this.viewState.get(sessionId);
    this.composer = state.draftText;
    this.composerCursor = clampCursor(this.composer, state.cursor);
    if (resetRoute) this.routes.reset();
  }

  private async refreshSessions(): Promise<void> {
    const runtimeSessions = await this.options.runtime.listSessions();
    const current = this.sessions.find(
      (session) =>
        session.sessionId === this.sessionsController.active &&
        session.revision === 0
    );
    this.sessions = current ? [current, ...runtimeSessions] : runtimeSessions;
    this.selectFirstSession();
  }

  private syncActiveSummary(): void {
    const active = this.sessionsController.active;
    const projection = this.sessionsController.currentProjection;
    if (!active || !projection) return;
    const index = this.sessions.findIndex((session) => session.sessionId === active);
    const summary: RuntimeSessionSummary = {
      sessionId: active,
      title: this.sessions[index]?.title ?? (this.composer.trim() || 'New chat'),
      taskStatus: projection.taskStatus,
      lifecycle: projection.lifecycle,
      revision: projection.revision,
      eventSeq: projection.eventSeq,
      updatedAt: this.now(),
      rowCount: projection.rows.length,
      queueLength: projection.queueLength,
      childCount: projection.children?.length ?? 0,
      attentionCount:
        projection.children?.filter(
          (child) => child.status === 'failed' || child.status === 'cancelled'
        ).length ?? 0,
      ...(this.options.project ? { project: this.options.project } : {}),
      ...(this.options.branch ? { branch: this.options.branch } : {}),
    };
    if (index >= 0) this.sessions[index] = summary;
    else this.sessions.unshift(summary);
  }

  private routeToSessionsAndSelect(): void {
    this.selectFirstSession();
  }

  private moveSession(direction: -1 | 1): void {
    const rows = this.visibleSessions();
    if (!rows.length) return;
    const index = rows.findIndex((row) => row.sessionId === this.selectedSessionId);
    const next = index < 0 ? 0 : (index + direction + rows.length) % rows.length;
    this.selectedSessionId = rows[next].sessionId;
  }

  private selectFirstSession(): void {
    const rows = this.visibleSessions();
    if (!rows.some((row) => row.sessionId === this.selectedSessionId)) {
      this.selectedSessionId = rows[0]?.sessionId;
    }
  }

  private visibleSessions() {
    return buildSessionRows(
      this.sessions,
      this.sessionQuery,
      this.sessionsController.active
    );
  }

  private agentControls() {
    const route = this.routes.current.kind === 'agents'
      ? this.routes.current
      : { kind: 'agents' as const, rootSessionId: this.sessionsController.active ?? '' };
    const projection = this.sessionsController.currentProjection;
    const agents: TuiAgentRecord[] = (projection?.children ?? []).map((child) => ({
      taskId: child.taskId,
      sessionId: child.sessionId,
      parentTaskId: child.parentTaskId,
      parentSessionId: this.sessionsController.active,
      profileName: child.profileName,
      status: child.status,
      executionMode: child.executionMode,
      updatedAt: child.updatedAt,
      ...(child.summary ? { summary: child.summary } : {}),
    }));
    return {
      route,
      rows: buildAgentRows(agents, route.rootSessionId, this.agentFilter),
    };
  }

  private selectFirstAgent(): void {
    const controls = this.agentControls();
    const selected = controls.route.selectedId ?? controls.rows[0]?.agent.taskId;
    if (this.routes.current.kind === 'agents') {
      this.routes.replace({ ...this.routes.current, selectedId: selected });
    }
  }

  private snapshot(): TuiRenderSnapshot {
    const projection = this.sessionsController.currentProjection;
    const controls = this.agentControls();
    return {
      route: this.routes.current,
      status: this.statusFacts(projection),
      ...(this.sessionsController.active
        ? { activeSessionId: this.sessionsController.active }
        : {}),
      activeSessionTitle:
        this.sessions.find((item) => item.sessionId === this.sessionsController.active)
          ?.title ?? 'New chat',
      ...(projection ? { projection } : {}),
      sessions: this.visibleSessions(),
      ...(this.selectedSessionId ? { selectedSessionId: this.selectedSessionId } : {}),
      sessionQuery: this.sessionQuery,
      agentRows: controls.rows,
      ...(controls.route.selectedId
        ? { selectedAgentId: controls.route.selectedId }
        : {}),
      agentFilter: this.agentFilter,
      composer: this.composer,
      composerCursor: this.composerCursor,
      reasoningMode: this.reasoningMode,
      ...(this.statusMessage ? { statusMessage: this.statusMessage } : {}),
      ...(this.confirmation
        ? {
            prompt: {
              label:
                this.confirmation.kind === 'rename'
                  ? 'Rename: '
                  : this.confirmation.kind === 'merge'
                    ? 'Apply reviewed child workspace merge? Enter confirm, Esc cancel · '
                    : this.confirmation.kind === 'approval'
                      ? `Allow ${this.confirmation.approval?.request.toolName ?? 'Action'} (${this.confirmation.approval?.request.risk ?? 'write'})? Enter allow, Esc deny · `
                      : `Delete ${this.confirmation.sessionId}? Enter confirm, Esc cancel · `,
              value: this.confirmation.value,
            },
          }
        : {}),
      ...(this.review ? { review: this.review } : {}),
    };
  }

  private statusFacts(projection: ProductProjection | undefined): StatusBarFacts {
    const blockers = projection?.lastError ? ['ERR'] : [];
    return {
      blockers,
      connection: 'online',
      ...(projection ? { taskStatus: projection.taskStatus } : {}),
      ...(projection
        ? {
            elapsedMs:
              projection.taskStatus === 'running' ||
              projection.taskStatus === 'queued' ||
              projection.taskStatus === 'waiting'
                ? Math.max(
                    0,
                    this.now() -
                      ([...projection.rows]
                        .reverse()
                        .find((row) => row.startedAt !== undefined)?.startedAt ??
                        this.now())
                  )
                : undefined,
          }
        : {}),
      ...(projection?.activeTaskId &&
      this.sessions.find(
        (item) => item.sessionId === this.sessionsController.active
      )?.parentSessionId
        ? { sessionKind: 'child' as const }
        : {}),
      sessionTitle:
        this.sessions.find((item) => item.sessionId === this.sessionsController.active)
          ?.title ?? 'New chat',
      ...(this.options.project ? { project: this.options.project } : {}),
      ...(this.options.branch ? { branch: this.options.branch } : {}),
      workspaceRevision: projection?.revision,
      queueLength: projection?.queueLength,
      agentCount: projection?.children?.length,
      agentAttention:
        projection?.children?.filter(
          (child) => child.status === 'failed' || child.status === 'cancelled'
        ).length,
      ...(this.options.model ? { model: this.options.model } : {}),
      ...(this.options.provider ? { provider: this.options.provider } : {}),
      processAvailable: this.options.processAvailable,
    };
  }

  private newSessionId(): string {
    return `session_${this.now().toString(36)}_${++this.sessionSequence}`;
  }

  private notifyRender(): void {
    for (const listener of this.renderListeners) listener();
  }
}

function splitInput(input: string): string[] {
  const keys: string[] = [];
  for (let index = 0; index < input.length; index += 1) {
    if (input[index] !== '\x1b') {
      const codePoint = input.codePointAt(index)!;
      const char = String.fromCodePoint(codePoint);
      keys.push(char);
      index += char.length - 1;
      continue;
    }
    const rest = input.slice(index);
    const match = /^\x1b(?:\[[0-9;]*[A-Za-z~]|O[A-Za-z])/.exec(rest);
    const sequence = match?.[0] ?? '\x1b';
    keys.push(sequence);
    index += sequence.length - 1;
  }
  return keys;
}
