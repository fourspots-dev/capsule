import type { ProductProjection } from '../core/types';
import type { SkillDefinition } from '../core/extension-registry';
import { escapeHtml, md } from './html';
import {
  KERNEL_PORT_NAME,
  REMOTE_ACTIONS_KEY,
} from '../runtime/chrome-runtime';
import { CONFIG_KEY } from '../runtime/storage-migration';
import type { RuntimeCapabilityStatus } from '../runtime/runtime-gateway';
import {
  DEBUG_SERVICE_KEY,
  normalizeEndpoint,
  testDebugService,
  type DebugServiceConfig,
} from '../observability/debug-service-config';
import type { KernelApprovalEvent, KernelHandoffEvent } from './kernel-client';
import { KernelClient, connectChromeKernelPort } from './kernel-client';
import { icons } from './icons';
import {
  settingsCard,
  settingsField,
  settingsForm,
  settingsGroup,
  settingsNavRow,
  settingsRow,
  settingsSelectRow,
  settingsSeparator,
  settingsSubpage,
} from './settings-components';
import {
  STREAM_RENDER_INTERVAL_MS,
  excerptText,
  selectRenderWindow,
} from './render-window';
import {
  buildTurnRenderUnits,
  toolDisplayLabel,
  toolFamily,
  workStateLabel,
  type ToolFamily,
  type TurnRenderUnit,
  type WorkItem,
  type WorkSegment,
} from './turn-render-model';

interface KernelConnectionConfig {
  id: string;
  label: string;
  baseUrl: string;
  apiKey?: string;
  models: string[];
  vision?: boolean;
}

interface KernelStoredConfig {
  approval: 'ask' | 'auto';
  showReasoning: boolean;
  theme: 'light' | 'dark' | 'system';
  language: string;
  zoom: number;
  connection: string | null;
  model: string | null;
  connections: KernelConnectionConfig[];
}

interface KernelRemoteActionConfig {
  endpoint: string;
  token?: string;
  allowedActionIds?: string[];
  timeoutMs?: number;
}

interface ComposerDraft {
  text: string;
  attachments: Array<{
    name: string;
    type: string;
    text?: string;
    dataBase64?: string;
  }>;
  selectedSkill?: string;
}

export async function initKernelUi(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) throw new Error('Missing #root');
  let pageConfig: KernelStoredConfig = await readPageConfig();
  let remoteActionConfig = await readRemoteActionConfig();
  let debugServiceConfig = await readDebugServiceConfig();
  root.innerHTML = shell(pageConfig);
  applyPageAppearance();

  const client = new KernelClient(() => connectChromeKernelPort(chrome, KERNEL_PORT_NAME), {
    requestTimeoutMs: 120_000,
  });
  let projection: ProductProjection | undefined;
  let sessionId = `session_${crypto.randomUUID()}`;
  let approvals: KernelApprovalEvent[] = [];
  let handoffs: KernelHandoffEvent[] = [];
  const approvalsBySession = new Map<string, KernelApprovalEvent[]>();
  const handoffsBySession = new Map<string, KernelHandoffEvent[]>();
  const drafts = new Map<string, ComposerDraft>();
  let windowId: number | undefined;
  let activeTabId: string | undefined;
  let executionTabId: string | undefined;
  let activeGroupId: number | undefined;
  let activeScope: 'group' | 'tab' = 'tab';
  let workspaceMemberTabIds: string[] = [];
  let activationGeneration = 0;
  let sessionActivated = false;
  let skills: SkillDefinition[] = [];
  let selectedSkill: SkillDefinition | undefined;
  let attachments: Array<{
    name: string;
    type: string;
    text?: string;
    dataBase64?: string;
  }> = [];
  let modelLabel = pageConfig.language.startsWith('zh') ? '选择模型' : 'Choose model';
  let pageView:
    | 'settings'
    | 'connections'
    | 'history'
    | 'capabilities'
    | 'remote-actions'
    | 'debug-service'
    | null = null;
  let pageSessions: Awaited<ReturnType<KernelClient['listSessions']>> = [];
  let editingConnectionId: string | null | undefined;
  let connectionTestMessage = '';
  let debugServiceTestMessage = '';
  let capabilityStatus: RuntimeCapabilityStatus | undefined;
  let capabilityStatusError = '';
  let pageError = '';
  let error = '';
  let busy = false;
  let busyStartedAt = 0;
  let reconnectAttempts = 0;
  let renderScheduled = false;
  const detailState = new Map<string, boolean>();

  const activationTargetCount = (): number =>
    Math.max(1, workspaceMemberTabIds.length);

  const render = (): void => {
    const zh = pageConfig.language.startsWith('zh');
    const rows = document.querySelector<HTMLElement>('#kernel-rows');
    const status = document.querySelector<HTMLElement>('#kernel-status');
    const send = document.querySelector<HTMLButtonElement>('#kernel-send');
    const stop = document.querySelector<HTMLButtonElement>('#kernel-stop');
    const modeButton = document.querySelector<HTMLButtonElement>('#kernel-mode');
    const approvePlan = document.querySelector<HTMLButtonElement>('#kernel-approve-plan');
    const compact = document.querySelector<HTMLButtonElement>('#kernel-compact');
    const attachmentList = document.querySelector<HTMLElement>('#kernel-attachments');
    const workspace = document.querySelector<HTMLElement>('#kernel-workspace');
    const queue = document.querySelector<HTMLElement>('#kernel-queue');
    const modelLabelNode = document.querySelector<HTMLElement>('#kernel-model-label');
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    if (!rows || !status || !send || !stop || !input || !modeButton || !approvePlan || !compact || !attachmentList || !workspace || !queue || !modelLabelNode) return;
    document.documentElement.dataset.tinyaiActivated = String(sessionActivated);
    document.documentElement.dataset.tinyaiCanSend = String(
      projection?.availability.canSend ?? false
    );
    modelLabelNode.textContent = modelLabel;
    status.innerHTML = `<span class="wb-run-spinner"></span><span class="wb-run-text">${escapeHtml(statusText(
      projection,
      busy,
      error,
      busyStartedAt,
      approvals.length > 0 || handoffs.length > 0,
      pageConfig.language
    ))}</span>`;
    status.hidden = !busy && !error;
    status.dataset.error = error ? 'true' : 'false';
    send.disabled =
      !sessionActivated ||
      Boolean(error) ||
      projection?.availability.canSend === false ||
      (!input.value.trim() && !attachments.length && !selectedSkill);
    stop.hidden = !projection?.availability.canStop;
    modeButton.textContent =
      projection?.permissionMode === 'plan'
        ? (pageConfig.language.startsWith('zh') ? '退出计划模式' : 'Exit plan')
        : (pageConfig.language.startsWith('zh') ? '计划模式' : 'Plan mode');
    approvePlan.hidden =
      projection?.permissionMode !== 'plan' ||
      !projection.rows.some((row) => row.kind === 'assistant' && row.text.trim());
    compact.hidden = !projection || busy || projection.rows.filter((row) => row.kind !== 'tool').length < 2;
    queue.hidden = !projection?.queueLength;
    queue.innerHTML = projection?.queueLength
      ? `<span class="kernel-queue-dot" aria-hidden="true"></span><span>${escapeHtml(
          zh
            ? `${projection.queueLength} 条消息排队`
            : `${projection.queueLength} ${projection.queueLength === 1 ? 'message' : 'messages'} queued`
        )}</span>`
      : '';
    workspace.hidden = !projection;
    workspace.innerHTML = projection
      ? `<span class="kernel-workspace-mark" aria-hidden="true">⌘</span><span>${escapeHtml(
          activeScope === 'group'
            ? zh
              ? `工作区 · ${activationTargetCount()} 个标签`
              : `Workspace · ${activationTargetCount()} ${activationTargetCount() === 1 ? 'tab' : 'tabs'}`
            : zh
              ? '独立标签'
              : 'Independent tab'
        )}</span>`
      : '';
    attachmentList.innerHTML = [
      ...(selectedSkill
        ? [`<span class="wb-chip"><span class="wb-chip-name">Skill: ${escapeHtml(selectedSkill.name)}</span></span>`]
        : []),
      ...attachments.map(
        (attachment) =>
          `<span class="wb-chip"><span class="wb-chip-name">${escapeHtml(attachment.name)}</span><button type="button" data-remove-attachment="${escapeHtml(attachment.name)}" aria-label="Remove">×</button></span>`
      ),
    ].join('');
    const windowed = selectRenderWindow(projection?.rows ?? []);
    const hiddenRowCount = windowed.hiddenCount;
    const renderedProjection =
      projection
        ? {
            ...projection,
            rows: windowed.rows,
          }
        : projection;
    const conversationHtml =
      (projection?.plan?.text
        ? `<section class="kernel-plan-card">
            <div class="kernel-plan-head"><span>${zh ? '计划' : 'Plan'}</span><span>${projection.plan.approvedAt ? (zh ? '已批准' : 'Approved') : (zh ? '草稿' : 'Draft')}</span></div>
            <div class="kernel-plan-body">${md(projection.plan.text)}</div>
          </section>`
        : '') +
      (hiddenRowCount > 0
        ? `<div class="kernel-history-window">${zh ? `较早的 ${hiddenRowCount} 条记录已省略` : `${hiddenRowCount} earlier rows hidden`}</div>`
        : '') +
      (renderedProjection
        ? buildTurnRenderUnits(renderedProjection)
            .map((unit) =>
              renderTurnUnit(unit, pageConfig.language, pageConfig.showReasoning)
            )
            .join('')
        : '') +
      approvals
        .map(
          (approval) => `<article class="wb-permission-card kernel-approval" data-ui-key="approval:${escapeHtml(approval.approvalId)}">
            <div class="wb-permission-title">${zh ? '允许' : 'Allow'} ${escapeHtml(toolLabel(approval.toolName, pageConfig.language))}?</div>
            <div class="kernel-permission-summary">${escapeHtml(approvalSummary(approval.toolName, approval.input, zh))}</div>
            <details class="kernel-raw-details">
              <summary>${zh ? '查看参数' : 'Show arguments'}</summary>
              <div class="wb-permission-args">${escapeHtml(JSON.stringify(approval.input, null, 2))}</div>
            </details>
            <div class="wb-permission-actions">
              <button type="button" class="kernel-btn kernel-btn--primary" data-approval="${escapeHtml(approval.approvalId)}" data-decision="allow">${zh ? '允许' : 'Allow'}</button>
              <button type="button" class="kernel-btn" data-approval="${escapeHtml(approval.approvalId)}" data-decision="deny">${zh ? '拒绝' : 'Deny'}</button>
            </div>
          </article>`
        )
        .join('') +
      handoffs
        .map(
          (handoff) => `<article class="wb-permission-card kernel-handoff">
            <div class="wb-permission-title">${zh ? '需要你手动操作' : 'Manual action required'}</div>
            <div class="wb-handoff-reason">${escapeHtml(handoff.reason)}</div>
            <div class="wb-permission-actions">
              <button type="button" class="kernel-btn kernel-btn--primary" data-handoff="${escapeHtml(handoff.handoffId)}" data-decision="continue">${zh ? '继续' : 'Continue'}</button>
              <button type="button" class="kernel-btn" data-handoff="${escapeHtml(handoff.handoffId)}" data-decision="cancel">${zh ? '取消' : 'Cancel'}</button>
            </div>
          </article>`
        )
        .join('');
    const scroll = document.querySelector<HTMLElement>('.wb-scroll');
    const stickToBottom = scroll
      ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72
      : true;
    rows.innerHTML = conversationHtml || emptyHtml(pageConfig.language);
    restoreDetailState(rows, detailState);
    if (scroll && stickToBottom) scroll.scrollTop = scroll.scrollHeight;
  };

  const scheduleRender = (): void => {
    if (renderScheduled) return;
    renderScheduled = true;
    window.setTimeout(() => {
      renderScheduled = false;
      render();
    }, STREAM_RENDER_INTERVAL_MS);
  };

  const saveCurrentDraft = (): void => {
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    const text = input?.value ?? '';
    if (text || attachments.length || selectedSkill) {
      drafts.set(sessionId, {
        text,
        attachments: attachments.map((attachment) => ({ ...attachment })),
        ...(selectedSkill ? { selectedSkill: selectedSkill.name } : {}),
      });
    } else {
      drafts.delete(sessionId);
    }
  };

  const restoreCurrentDraft = (): void => {
    const draft = drafts.get(sessionId);
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    if (input) input.value = draft?.text ?? '';
    attachments = (draft?.attachments ?? []).map((attachment) => ({ ...attachment }));
    selectedSkill = draft?.selectedSkill
      ? skills.find((skill) => skill.name === draft.selectedSkill)
      : undefined;
    const skillSelect = document.querySelector<HTMLSelectElement>('#kernel-skill');
    if (skillSelect) skillSelect.value = selectedSkill?.name ?? '';
  };

  async function activateSession(
    load: () => Promise<{
      sessionId: string;
      workspaceId: string;
      activeTabId: string;
      groupId?: number;
      scope: 'group' | 'tab';
      executionTabId: string;
      memberTabIds: string[];
      projection: ProductProjection;
    }>
  ): Promise<boolean> {
    const generation = ++activationGeneration;
    sessionActivated = false;
    render();
    saveCurrentDraft();
    let activation: Awaited<ReturnType<typeof load>>;
    try {
      activation = await load();
    } catch (cause) {
      if (generation === activationGeneration) throw cause;
      return false;
    }
    if (generation !== activationGeneration) return false;
    const previousSession = sessionId;
    if (projection && previousSession !== activation.sessionId) {
      await client.unsubscribe(previousSession).catch(() => undefined);
    }
    sessionId = activation.sessionId;
    activeTabId = activation.activeTabId;
    executionTabId = activation.executionTabId;
    activeGroupId = activation.groupId;
    activeScope = activation.scope;
    workspaceMemberTabIds = [...activation.memberTabIds];
    document.documentElement.dataset.tinyaiTabId = activeTabId;
    document.documentElement.dataset.tinyaiExecutionTabId = executionTabId;
    document.documentElement.dataset.tinyaiSessionId = sessionId;
    document.documentElement.dataset.tinyaiWorkspaceId = activation.workspaceId;
    projection = activation.projection;
    approvals = [...(approvalsBySession.get(sessionId) ?? [])];
    handoffs = [...(handoffsBySession.get(sessionId) ?? [])];
    busy =
      projection.taskStatus === 'running' ||
      projection.taskStatus === 'queued' ||
      projection.taskStatus === 'waiting';
    busyStartedAt = busy ? Date.now() : 0;
    error = '';
    reconnectAttempts = 0;
    await client.subscribe(sessionId);
    restoreCurrentDraft();
    sessionActivated = true;
    render();
    return true;
  }

  async function switchToTab(tabId: string, force = false): Promise<void> {
    if (windowId === undefined || (tabId === activeTabId && !force)) return;
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(Number(tabId));
    } catch {
      if (activeTabId === tabId) activeTabId = undefined;
      return;
    }
    try {
      await activateSession(() =>
        client.resolveTabSession(windowId!, tabId, tab.groupId)
      );
    } catch (cause) {
      if (!isMissingTabError(cause)) throw cause;
      const [current] = await chrome.tabs.query({
        active: true,
        windowId,
      });
      if (current?.id !== undefined && String(current.id) === tabId) {
        if (!isInspectablePageUrl(current.url)) {
          error = pageConfig.language.startsWith('zh')
            ? '当前标签页不支持 Agent 操作，请切换到普通网页。'
            : 'This tab cannot be used by the Agent. Switch to a regular web page.';
          render();
          return;
        }
        error = pageConfig.language.startsWith('zh')
          ? '当前标签页暂时不可用，请重新切换后重试。'
          : 'The current tab is temporarily unavailable. Switch tabs and retry.';
        render();
        return;
      }
      if (current?.id !== undefined) {
        await switchToTab(String(current.id));
      } else if (activeTabId === tabId) {
        activeTabId = undefined;
      }
    }
  }

  async function startNewSession(): Promise<void> {
    if (windowId === undefined || !activeTabId) {
      throw new Error('No active browser tab is available');
    }
    await activateSession(() =>
      client.createTabSession(windowId!, activeTabId!, activeGroupId)
    );
  }

  async function reloadRuntimeForCurrentTab(): Promise<void> {
    await client.reloadRuntime();
    if (windowId === undefined || !activeTabId) {
      throw new Error('No active browser tab is available');
    }
    await activateSession(() =>
      client.resolveTabSession(windowId!, activeTabId!, activeGroupId)
    );
  }

  client.onProjection((eventSessionId, next) => {
    if (eventSessionId !== sessionId) return;
    reconnectAttempts = 0;
    projection = next;
    const nextBusy =
      next.taskStatus === 'running' ||
      next.taskStatus === 'queued' ||
      next.taskStatus === 'waiting';
    if (nextBusy && !busy) busyStartedAt = Date.now();
    if (!nextBusy) busyStartedAt = 0;
    busy = nextBusy;
    error = '';
    scheduleRender();
  });
  client.onApproval((approval) => {
    const pending = [
      ...(approvalsBySession.get(approval.sessionId) ?? []),
      approval,
    ];
    approvalsBySession.set(approval.sessionId, pending);
    if (approval.sessionId === sessionId) {
      approvals = pending;
      render();
    }
  });
  client.onHandoff((handoff) => {
    const pending = [
      ...(handoffsBySession.get(handoff.sessionId) ?? []),
      handoff,
    ];
    handoffsBySession.set(handoff.sessionId, pending);
    if (handoff.sessionId === sessionId) {
      handoffs = pending;
      render();
    }
  });
  client.onDisconnect(() => {
    busy = false;
    busyStartedAt = 0;
    error = pageConfig.language.startsWith('zh')
      ? 'Kernel 运行时连接中断，正在重连…'
      : 'Kernel runtime disconnected. Reconnecting…';
    render();
    if (reconnectAttempts >= 2) {
      error = pageConfig.language.startsWith('zh')
        ? 'Kernel 运行时连接失败，请重新加载扩展。'
        : 'Kernel runtime connection failed. Reload the extension.';
      render();
      return;
    }
    reconnectAttempts += 1;
    window.setTimeout(() => {
      void client
        .projection(sessionId)
        .then(async (next) => {
          projection = next;
          await client.subscribe(sessionId);
          busy =
            next.taskStatus === 'running' ||
            next.taskStatus === 'queued' ||
            next.taskStatus === 'waiting';
          busyStartedAt = busy ? Date.now() : 0;
          error = '';
          reconnectAttempts = 0;
          render();
        })
        .catch((cause) => {
          error = errorMessage(cause);
          render();
        });
    }, reconnectAttempts * 250);
  });
  chrome.tabs.onActivated.addListener((info) => {
    if (windowId === undefined || info.windowId !== windowId) return;
    void switchToTab(String(info.tabId)).catch(showError);
  });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (
      windowId === undefined ||
      changeInfo.groupId === undefined ||
      String(tabId) !== activeTabId
    ) {
      return;
    }
    const groupId =
      changeInfo.groupId >= 0 ? changeInfo.groupId : undefined;
    if (groupId === activeGroupId) return;
    void switchToTab(String(tabId), true).catch(showError);
  });
  chrome.tabs.onRemoved.addListener((tabId) => {
    if (!activeTabId || String(tabId) !== activeTabId) return;
    activeTabId = undefined;
    void chrome.tabs
      .query({ active: true, windowId })
      .then(async ([next]) => {
        if (next?.id !== undefined) await switchToTab(String(next.id));
      })
      .catch(showError);
  });
  chrome.tabs.onDetached.addListener((tabId, info) => {
    void client
      .forgetTabSession(info.oldWindowId, String(tabId))
      .catch(() => undefined);
  });

  document.querySelector('#kernel-form')?.addEventListener('submit', (event) => {
    event.preventDefault();
    void submit();
  });
  document.querySelector('#kernel-stop')?.addEventListener('click', () => {
    void client.stopSession(sessionId).catch(showError);
  });
  document.querySelector('#kernel-settings')?.addEventListener('click', () => {
    void showPage('settings').catch(showError);
  });
  document.querySelector('#kernel-history')?.addEventListener('click', () => {
    void showPage('history').catch(showError);
  });
  document.querySelector('.kernel-shell')?.addEventListener('click', (event) => {
    const target = (event.target as Element).closest<HTMLElement>('[data-page-action]');
    if (!target?.dataset.pageAction) return;
    pageError = '';
    void handlePageAction(target.dataset.pageAction, target).catch((cause) => {
      pageError = errorMessage(cause);
      renderPage();
    });
  });
  document.querySelector('#kernel-slash')?.addEventListener('click', (event) => {
    event.stopPropagation();
    const menu = document.querySelector<HTMLElement>('#kernel-command-menu');
    if (menu) menu.hidden = !menu.hidden;
    const modelMenu = document.querySelector<HTMLElement>('#kernel-model-menu');
    if (modelMenu) modelMenu.hidden = true;
    const tabMenu = document.querySelector<HTMLElement>('#kernel-tab-menu');
    if (tabMenu) tabMenu.hidden = true;
  });
  document.querySelector('#kernel-tabs')?.addEventListener('click', (event) => {
    event.stopPropagation();
    void openTabMenu().catch(showError);
  });
  document.querySelector('#kernel-tab-menu')?.addEventListener('click', (event) => {
    const tab = (event.target as Element).closest<HTMLElement>('[data-kernel-tab]');
    if (!tab?.dataset.kernelTab) return;
    const tabId = tab.dataset.kernelTab;
    void chrome.tabs
      .update(Number(tabId), { active: true })
      .then(() => {
        const menu = document.querySelector<HTMLElement>('#kernel-tab-menu');
        if (menu) menu.hidden = true;
        if (windowId !== undefined) return switchToTab(tabId);
      })
      .catch(showError);
  });
  document.querySelector('#kernel-model')?.addEventListener('click', (event) => {
    event.stopPropagation();
    void openModelMenu().catch(showError);
  });
  document.querySelector('#kernel-model-menu')?.addEventListener('click', (event) => {
    const option = (event.target as Element).closest<HTMLElement>('[data-kernel-model]');
    if (!option) return;
    void switchModel(
      option.dataset.kernelConnection ?? '',
      option.dataset.kernelModel ?? ''
    ).catch(showError);
  });
  document.querySelector('#kernel-artifact-close')?.addEventListener('click', () => {
    document.querySelector<HTMLDialogElement>('#kernel-artifact-dialog')?.close();
  });
  document.querySelector('#kernel-attach')?.addEventListener('click', () => {
    document.querySelector<HTMLInputElement>('#kernel-file-input')?.click();
  });
  document.querySelector<HTMLInputElement>('#kernel-file-input')?.addEventListener('change', (event) => {
    const files = Array.from((event.target as HTMLInputElement).files ?? []);
    void readAttachments(files).catch(showError);
  });
  document.querySelector<HTMLSelectElement>('#kernel-skill')?.addEventListener('change', (event) => {
    const name = (event.target as HTMLSelectElement).value;
    selectedSkill = skills.find((skill) => skill.name === name);
    render();
  });
  document.querySelector('#kernel-attachments')?.addEventListener('click', (event) => {
    const removeAttachment = (event.target as Element).closest<HTMLElement>('[data-remove-attachment]');
    if (!removeAttachment) return;
    attachments = attachments.filter(
      (attachment) => attachment.name !== removeAttachment.dataset.removeAttachment
    );
    render();
  });
  document.querySelector('#kernel-rows')?.addEventListener('click', (event) => {
    const summary = (event.target as Element).closest<HTMLElement>('summary');
    const details = summary?.closest<HTMLDetailsElement>('details[data-ui-key]');
    const detailKey = details?.dataset.uiKey;
    if (details && detailKey) {
      queueMicrotask(() => {
        if (details.isConnected) detailState.set(detailKey, details.open);
      });
    }
    const prompt = (event.target as Element).closest<HTMLElement>('[data-kernel-prompt]');
    if (prompt) {
      const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
      if (input) {
        input.value = prompt.dataset.kernelPrompt ?? '';
        input.focus();
      }
    }
  });
  document.querySelector('#kernel-mode')?.addEventListener('click', () => {
    const next = projection?.permissionMode === 'plan' ? 'guarded' : 'plan';
    void sendControlCommand('set_mode', { mode: next }).catch(showError);
  });
  document.querySelector('#kernel-approve-plan')?.addEventListener('click', () => {
    const plan = [...(projection?.rows ?? [])]
      .reverse()
      .find((row) => row.kind === 'assistant' && row.text.trim())?.text;
    if (!plan) return;
    void sendControlCommand('submit_plan', { plan })
      .then(() => sendControlCommand('approve_plan', {}))
      .then(() => sendControlCommand('set_mode', { mode: 'build' }))
      .catch(showError);
  });
  document.querySelector('#kernel-new')?.addEventListener('click', () => {
    void startNewSession()
      .then(() => {
        detailState.clear();
        render();
      })
      .catch(showError);
  });
  document.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement | HTMLInputElement;
    if (target.id === 'kernel-page-language') {
      pageConfig.language = target.value;
      void writePageConfig().then(() => renderPage()).catch((cause) => {
        pageError = errorMessage(cause);
        renderPage();
      });
      return;
    }
    if (target.id === 'kernel-page-model') {
      const [connection, ...modelParts] = target.value.split('|');
      const model = modelParts.join('|');
      if (!connection || !model) return;
      pageConfig.connection = connection;
      pageConfig.model = model;
      modelLabel = model;
      void writePageConfig()
        .then(() => reloadRuntimeForCurrentTab())
        .then(() => renderPage())
        .catch((cause) => {
          pageError = errorMessage(cause);
          renderPage();
        });
    }
    if (target.id === 'kernel-capsule-file') {
      const file = (target as HTMLInputElement).files?.[0];
      if (file) void importWorkspaceCapsule(file).catch(showError);
      return;
    }
  });
  document.querySelector('#kernel-compact')?.addEventListener('click', () => {
    void sendControlCommand('compact', {}).catch(showError);
  });
  document.querySelector('#kernel-rows')?.addEventListener('click', (event) => {
    const childTarget = (event.target as Element).closest<HTMLElement>('[data-open-child]');
    if (childTarget?.dataset.openChild) {
      void switchSession(childTarget.dataset.openChild).catch(showError);
      return;
    }
    const artifactTarget = (event.target as Element).closest<HTMLElement>('[data-artifact]');
    if (artifactTarget?.dataset.artifact) {
      void openArtifact(artifactTarget.dataset.artifact).catch(showError);
      return;
    }
    const copyTarget = (event.target as Element).closest<HTMLElement>('[data-copy-message]');
    if (copyTarget?.dataset.copyMessage) {
      const text =
        projection?.rows.find((row) => row.id === copyTarget.dataset.copyMessage)?.text ?? '';
      void navigator.clipboard.writeText(text).then(() => {
        copyTarget.textContent = pageConfig.language.startsWith('zh') ? '已复制' : 'Copied';
      }).catch(showError);
      return;
    }
    const exportTarget = (event.target as Element).closest<HTMLElement>('[data-export-message]');
    if (exportTarget?.dataset.exportMessage) {
      const text =
        projection?.rows.find((row) => row.id === exportTarget.dataset.exportMessage)?.text ?? '';
      const href = URL.createObjectURL(new Blob([text], { type: 'text/markdown' }));
      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = `tinyai-${Date.now()}.md`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(href), 1000);
      return;
    }
    const handoffTarget = (event.target as Element).closest<HTMLElement>('[data-handoff]');
    if (handoffTarget) {
      const handoffId = handoffTarget.dataset.handoff;
      const decision = handoffTarget.dataset.decision === 'continue' ? 'continue' : 'cancel';
      if (!handoffId) return;
      handoffs = handoffs.filter((item) => item.handoffId !== handoffId);
      handoffsBySession.set(sessionId, handoffs);
      void client.respondHandoff(handoffId, decision).catch(showError);
      render();
      return;
    }
    const target = (event.target as Element).closest<HTMLElement>('[data-approval]');
    if (!target) return;
    const approvalId = target.dataset.approval;
    const approved = target.dataset.decision === 'allow';
    if (!approvalId) return;
    approvals = approvals.filter((item) => item.approvalId !== approvalId);
    approvalsBySession.set(sessionId, approvals);
    void client.respondApproval(approvalId, approved).catch(showError);
    render();
  });
  document.querySelector<HTMLTextAreaElement>('#kernel-input')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
    }
  });
  document.querySelector<HTMLTextAreaElement>('#kernel-input')?.addEventListener('input', () => {
    syncSendButton();
  });
  document.addEventListener('click', (event) => {
    const target = event.target as Element;
    if (target.closest('#kernel-command-menu') || target.closest('#kernel-slash')) return;
    const commandMenu = document.querySelector<HTMLElement>('#kernel-command-menu');
    if (commandMenu) commandMenu.hidden = true;
    const tabMenu = document.querySelector<HTMLElement>('#kernel-tab-menu');
    if (tabMenu) tabMenu.hidden = true;
    if (target.closest('#kernel-model-menu') || target.closest('#kernel-model')) return;
    const modelMenu = document.querySelector<HTMLElement>('#kernel-model-menu');
    if (modelMenu) modelMenu.hidden = true;
  });
  window.setInterval(() => {
    if (!busy) return;
    const status = document.querySelector<HTMLElement>('#kernel-status');
    if (status) {
      const text = status.querySelector<HTMLElement>('.wb-run-text');
      if (text) text.textContent = statusText(
        projection,
        busy,
        error,
        busyStartedAt,
        approvals.length > 0 || handoffs.length > 0,
        pageConfig.language
      );
    }
  }, 1000);

  async function submit(): Promise<void> {
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    const text = input?.value.trim() ?? '';
    if (!text && !attachments.length && !selectedSkill) return;
    if (projection?.availability.canSend === false) return;
    if (text === '/new') {
      if (input) input.value = '';
      await startNewSession();
      detailState.clear();
      render();
      return;
    }
    if (text === '/compact') {
      if (input) input.value = '';
      void sendControlCommand('compact', {}).catch(showError);
      return;
    }
    if (text === '/plan') {
      if (input) input.value = '';
      void sendControlCommand('set_mode', {
        mode: projection?.permissionMode === 'plan' ? 'guarded' : 'plan',
      }).catch(showError);
      return;
    }
    busy = true;
    busyStartedAt = Date.now();
    error = '';
    if (input) input.value = '';
    render();
    try {
      const planInstruction =
        projection?.permissionMode === 'plan'
          ? '\n\nPlan mode: return a concise plan. Do not perform write, execute or network actions.'
          : '';
      const ack = await client.command({
        commandId: crypto.randomUUID(),
        clientId: 'sidepanel',
        sessionId,
        type: 'send_input',
        payload: {
          text: `${text || 'Please inspect the provided context.'}${planInstruction}`,
          context: {
            ...(selectedSkill
              ? {
                  skill: {
                    name: selectedSkill.name,
                    instructions: selectedSkill.body,
                  },
                }
              : {}),
            ...(attachments.length ? { attachments: attachments.map((item) => ({ ...item })) } : {}),
          },
        },
        issuedAt: Date.now(),
      });
      if (ack.status !== 'accepted' && ack.status !== 'duplicate') {
        throw Object.assign(new Error(ack.error?.message ?? `Command ${ack.status}`), {
          name: ack.error?.code ?? 'COMMAND_REJECTED',
        });
      }
      projection = await client.projection(sessionId);
      busy =
        projection.taskStatus === 'running' ||
        projection.taskStatus === 'queued' ||
        projection.taskStatus === 'waiting';
      await client.subscribe(sessionId);
      attachments = [];
      selectedSkill = undefined;
      drafts.delete(sessionId);
      const skillSelect = document.querySelector<HTMLSelectElement>('#kernel-skill');
      if (skillSelect) skillSelect.value = '';
      const fileInput = document.querySelector<HTMLInputElement>('#kernel-file-input');
      if (fileInput) fileInput.value = '';
      render();
    } catch (cause) {
      showError(cause);
    }
  }

  function syncSendButton(): void {
    const send = document.querySelector<HTMLButtonElement>('#kernel-send');
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    if (!send || !input) return;
    send.disabled =
      !sessionActivated ||
      Boolean(error) ||
      projection?.availability.canSend === false ||
      (!input.value.trim() && !attachments.length && !selectedSkill);
  }

  async function sendControlCommand(
    type: 'set_mode' | 'submit_plan' | 'approve_plan' | 'compact',
    payload: Record<string, unknown>
  ): Promise<void> {
    const ack = await client.command({
      commandId: crypto.randomUUID(),
      clientId: 'sidepanel',
      sessionId,
      type,
      payload: payload as never,
      issuedAt: Date.now(),
    });
    if (ack.status !== 'accepted' && ack.status !== 'duplicate' && ack.status !== 'noop') {
      throw Object.assign(new Error(ack.error?.message ?? `Command ${ack.status}`), {
        name: ack.error?.code ?? 'COMMAND_REJECTED',
      });
    }
    projection = await client.projection(sessionId);
    render();
  }

  async function readAttachments(files: File[]): Promise<void> {
    const maxFiles = 8;
    const maxBytes = 5 * 1024 * 1024;
    for (const file of files.slice(0, maxFiles)) {
      if (file.size > maxBytes) {
        throw new Error(`${file.name} exceeds the 5 MB attachment limit`);
      }
      if (file.type.startsWith('text/') || /\.(md|ts|tsx|js|jsx|json|css|html|txt)$/i.test(file.name)) {
        attachments.push({ name: file.name, type: file.type || 'text/plain', text: await file.text() });
      } else if (file.type.startsWith('image/')) {
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
          reader.readAsDataURL(file);
        });
        attachments.push({
          name: file.name,
          type: file.type,
          dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1),
        });
      } else {
        throw new Error(`Unsupported attachment type: ${file.type || file.name}`);
      }
    }
    attachments = attachments.slice(-maxFiles);
    render();
  }

  async function showPage(
    view:
      | 'settings'
      | 'connections'
      | 'history'
      | 'capabilities'
      | 'remote-actions'
      | 'debug-service'
  ): Promise<void> {
    pageConfig = await readPageConfig();
    remoteActionConfig = await readRemoteActionConfig();
    debugServiceConfig = await readDebugServiceConfig();
    if (view === 'history') pageSessions = await client.listSessions();
    capabilityStatus = undefined;
    capabilityStatusError = '';
    if (
      (view === 'settings' ||
        view === 'capabilities' ||
        view === 'remote-actions' ||
        view === 'debug-service') &&
      sessionActivated
    ) {
      try {
        capabilityStatus = await client.capabilityStatus(sessionId);
      } catch (cause) {
        capabilityStatusError = errorMessage(cause);
      }
    }
    pageView = view;
    pageError = '';
    connectionTestMessage = '';
    debugServiceTestMessage = '';
    renderPage();
  }

  function closePage(): void {
    pageView = null;
    document.querySelector('#kernel-page-layer')?.remove();
  }

  function renderPage(): void {
    const root = document.querySelector<HTMLElement>('.kernel-shell');
    if (!root || !pageView) return;
    document.querySelector('#kernel-page-layer')?.remove();
    root.insertAdjacentHTML('beforeend', pageMarkup());
  }

  function pageMarkup(): string {
    if (pageView === 'connections') return connectionsPageMarkup();
    if (pageView === 'history') return historyPageMarkup();
    if (pageView === 'capabilities') return capabilitiesPageMarkup();
    if (pageView === 'remote-actions') return remoteActionsPageMarkup();
    if (pageView === 'debug-service') return debugServicePageMarkup();
    return settingsPageMarkup();
  }

  function pageAlertMarkup(): string {
    return pageError
      ? `<div class="wb-notice wb-notice-error">${escapeHtml(pageError)}</div>`
      : '';
  }

  function settingsPageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    const models = pageConfig.connections.flatMap((connection) =>
      connection.models.map((model) => ({
        connection: connection.id,
        model,
        label: `${model}`,
      }))
    );
    const body = `
      ${settingsCard(
        `
          <div class="wb-account-row">
            <span class="wb-account-avatar wb-account-avatar--logo" aria-hidden="true"><img class="wb-account-avatar-img" alt="" src="icon/tinyai.svg"></span>
            <span class="wb-account-copy"><span class="wb-account-name-row"><span class="wb-account-name">tinyai</span></span><span class="wb-account-line">${zh ? '所有对话和模型 Key 都保存在本机。' : 'All chats and model keys stay on this machine.'}</span></span>
            <span class="wb-badge">${zh ? '本地 Agent' : 'Local agent'}</span>
          </div>
        `,
        'wb-set-account'
      )}
      ${settingsGroup({
        label: zh ? '通用' : 'General',
        content: [
          settingsSelectRow({
            label: zh ? '外观' : 'Appearance',
            icon: icons.sun,
            value: themeLabel(pageConfig.theme, zh),
            action: 'theme',
          }),
          settingsSeparator(),
          settingsSelectRow({
            label: zh ? '语言' : 'Language',
            icon: icons.globe,
            control: `<select id="kernel-page-language" class="wb-native-select">${[
                ['en', 'English'],
                ['zh', '中文'],
                ['zh-TW', '繁體中文'],
                ['ja', '日本語'],
                ['ko', '한국어'],
                ['es', 'Español'],
                ['fr', 'Français'],
                ['de', 'Deutsch'],
              ].map(([value, label]) => `<option value="${value}" ${value === pageConfig.language ? 'selected' : ''}>${label}</option>`).join('')}</select>`,
          }),
          settingsSeparator(),
          settingsRow({
            label: zh ? '缩放' : 'Zoom',
            icon: icons.zoom,
            control: `
              <button type="button" class="wb-set-stepper-btn" data-page-action="zoom" data-delta="-10" aria-label="Zoom out">−</button>
              <button type="button" class="wb-set-stepper-value" data-page-action="zoom" data-delta="0">${pageConfig.zoom}%</button>
              <button type="button" class="wb-set-stepper-btn" data-page-action="zoom" data-delta="10" aria-label="Zoom in">+</button>`,
          }),
        ].join(''),
      })}
      ${settingsGroup({
        label: zh ? '模型' : 'Models',
        content: [
          settingsSelectRow({
            label: zh ? '模型' : 'Model',
            icon: icons.sparkle,
            control: `<select class="wb-native-select" id="kernel-page-model">${models.length ? models.map((item) => `<option value="${escapeHtml(item.connection + '|' + item.model)}" ${item.connection === pageConfig.connection && item.model === pageConfig.model ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('') : `<option>${zh ? '未配置模型' : 'No model'}</option>`}</select>`,
          }),
          settingsSeparator(),
          settingsNavRow({
            label: zh ? '模型连接' : 'Model connections',
            icon: icons.link,
            value: String(pageConfig.connections.length),
            action: 'connections',
          }),
        ].join(''),
      })}
      ${settingsGroup({
        label: zh ? '权限' : 'Permissions',
        content: [
          settingsSelectRow({
            label: zh ? '操作审批' : 'Action approval',
            icon: icons.shield,
            value:
              pageConfig.approval === 'auto'
                ? zh
                  ? '自动执行'
                  : 'Auto-approve'
                : zh
                  ? '需要审批'
                  : 'Requires approval',
            action: 'approval',
          }),
          settingsSeparator(),
          settingsSelectRow({
            label: zh ? '显示推理过程' : 'Reasoning',
            icon: icons.sparkle,
            value: pageConfig.showReasoning
              ? zh
                ? '显示'
                : 'Show'
              : zh
                ? '隐藏'
                : 'Hidden',
            action: 'reasoning',
          }),
        ].join(''),
      })}
      ${settingsGroup({
        label: zh ? '运行时' : 'Runtime',
        content: [
          settingsNavRow({
            label: zh ? '能力' : 'Capabilities',
            icon: icons.sparkle,
            value: runtimeCapabilitySummary(zh),
            action: 'capabilities',
          }),
          settingsSeparator(),
          settingsNavRow({
            label: zh ? '远程 Action' : 'Remote Actions',
            icon: icons.link,
            value: remoteActionConfig
              ? zh
                ? '已配置'
                : 'Configured'
              : zh
                ? '未配置'
                : 'Not configured',
            action: 'remote-actions',
          }),
          settingsSeparator(),
          settingsNavRow({
            label: zh ? '调试服务' : 'Debug Service',
            icon: icons.info,
            value:
              debugServiceConfig?.enabled
                ? zh
                  ? '已启用'
                  : 'Enabled'
                : zh
                  ? '未启用'
                  : 'Disabled',
            action: 'debug-service',
          }),
        ].join(''),
      })}
      ${settingsGroup({
        label: zh ? '数据' : 'Data',
        content: [
          settingsNavRow({
            label: zh ? '导出 Workspace Capsule' : 'Export Workspace Capsule',
            icon: icons.download,
            action: 'capsule-export',
          }),
          settingsSeparator(),
          settingsNavRow({
            label: zh ? '导入 Workspace Capsule' : 'Import Workspace Capsule',
            icon: icons.file,
            action: 'capsule-import',
          }),
          '<input id="kernel-capsule-file" type="file" accept=".capsule,.tinyai,application/octet-stream" hidden>',
          settingsSeparator(),
          settingsNavRow({
            label: zh ? '清除全部聊天历史' : 'Clear all chat history',
            icon: icons.info,
            action: 'clear-history',
            destructive: true,
          }),
        ].join(''),
      })}
      ${settingsGroup({
        label: zh ? '关于' : 'About',
        content: settingsRow({
          label: zh ? '版本' : 'Version',
          icon: icons.info,
          value: chrome.runtime.getManifest().version,
        }),
      })}
      ${pageAlertMarkup()}`;
    return settingsSubpage({
      title: zh ? '设置' : 'Settings',
      backLabel: zh ? '返回' : 'Back',
      backIcon: icons.back,
      theme: effectiveTheme(),
      body,
    });
  }

  function capabilitiesPageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    return settingsSubpage({
      title: zh ? '能力与证据' : 'Capabilities & evidence',
      backAction: 'back-runtime',
      backLabel: zh ? '返回' : 'Back',
      backIcon: icons.back,
      theme: effectiveTheme(),
      body: `${capabilityBoardMarkup(zh)}${pageAlertMarkup()}`,
    });
  }

  function remoteActionsPageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    return settingsSubpage({
      title: zh ? '远程 Action' : 'Remote Actions',
      backAction: 'back-runtime',
      backLabel: zh ? '返回' : 'Back',
      backIcon: icons.back,
      theme: effectiveTheme(),
      body: `${remoteActionFormMarkup(zh)}${pageAlertMarkup()}`,
    });
  }

  function debugServicePageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    return settingsSubpage({
      title: zh ? '调试服务' : 'Debug Service',
      backAction: 'back-runtime',
      backLabel: zh ? '返回' : 'Back',
      backIcon: icons.back,
      theme: effectiveTheme(),
      body: `${debugServiceFormMarkup(zh)}${pageAlertMarkup()}`,
    });
  }

  function debugServiceFormMarkup(zh: boolean): string {
    return settingsForm({
      id: 'kernel-debug-service-form',
      content: `${settingsField({
        label: zh ? '服务地址' : 'Service endpoint',
        control: `<input id="kernel-debug-endpoint" type="url" value="${escapeHtml(debugServiceConfig?.endpoint ?? '')}" placeholder="http://127.0.0.1:4399">`,
      })}
      ${settingsField({
        label: 'Pairing Token',
        control: `<input id="kernel-debug-token" type="password" value="" placeholder="${debugServiceConfig?.token ? (zh ? '已保存，留空保持不变' : 'Saved — leave blank to keep') : 'optional for health check'}" autocomplete="off">`,
      })}
      ${settingsField({
        label: zh ? '启用实时上报' : 'Enable live reporting',
        className: 'wb-row',
        control: `<input id="kernel-debug-enabled" type="checkbox" ${debugServiceConfig?.enabled ? 'checked' : ''}>`,
        controlFirst: true,
      })}
      <div class="wb-form-actions">
        <button type="button" class="wb-btn wb-btn--primary" data-page-action="debug-save">${zh ? '保存并应用' : 'Save and apply'}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="debug-test">${zh ? '测试连接' : 'Test connection'}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="debug-disable">${zh ? '停用' : 'Disable'}</button>
        ${debugServiceTestMessage ? `<span class="wb-form-ok">${escapeHtml(debugServiceTestMessage)}</span>` : ''}
      </div>
      <div class="wb-conn-url">${zh ? '服务启动命令：tinyai debug serve；密码用于服务端鉴权。' : 'Start with tinyai debug serve. The token authenticates event ingestion and queries.'}</div>`,
    });
  }

  function runtimeCapabilitySummary(zh: boolean): string {
    if (capabilityStatusError) return zh ? '不可用' : 'Unavailable';
    if (!capabilityStatus) return zh ? '等待运行' : 'Not available';
    const counts = capabilityCounts();
    return zh
      ? `${counts.available} 可用 · ${counts.currentEvidence} 证据`
      : `${counts.available} available · ${counts.currentEvidence} evidence`;
  }

  function capabilityCounts(): {
    available: number;
    degraded: number;
    currentEvidence: number;
    staleEvidence: number;
  } {
    const actions = capabilityStatus?.actions ?? [];
    const evidence = capabilityStatus?.evidence ?? [];
    const available = actions.filter(
      (action) => action.state === 'available'
    ).length;
    return {
      available,
      degraded: actions.length - available,
      currentEvidence: evidence.filter(
        (record) => record.status === 'current'
      ).length,
      staleEvidence: evidence.filter(
        (record) => record.status === 'stale'
      ).length,
    };
  }

  function capabilityBoardMarkup(zh: boolean): string {
    if (capabilityStatusError) {
      return settingsCard(
        `<div class="kernel-capability-empty">${escapeHtml(capabilityStatusError)}</div>
        <button type="button" class="wb-ghost-btn" data-page-action="capability-refresh">${zh ? '重试' : 'Retry'}</button>`,
        'kernel-capability-card'
      );
    }
    if (!capabilityStatus) {
      return settingsCard(
        `<div class="kernel-capability-empty">${zh ? '运行时尚未启动。' : 'Runtime is not available yet.'}</div>`,
        'kernel-capability-card'
      );
    }
    const {
      available,
      degraded,
      currentEvidence,
      staleEvidence,
    } = capabilityCounts();
    const actionRows = capabilityStatus.actions.slice(0, 8).map(
      (action) => `<div class="kernel-capability-row">
        <span class="kernel-capability-dot" data-state="${escapeHtml(action.state)}" aria-hidden="true"></span>
        <span class="kernel-capability-copy">
          <span class="kernel-capability-title">${escapeHtml(action.title || action.id)}</span>
          <span class="kernel-capability-meta">${escapeHtml(action.id)} · v${escapeHtml(action.version)}</span>
          ${action.reason ? `<span class="kernel-capability-reason">${escapeHtml(action.reason)}</span>` : ''}
          ${action.lastOutcome ? `<span class="kernel-capability-meta">${zh ? '最近调用' : 'Last call'} · ${escapeHtml(action.lastOutcome)}</span>` : ''}
        </span>
        <span class="kernel-capability-state" data-state="${escapeHtml(action.state)}">${escapeHtml(action.state)}</span>
      </div>`
    );
    const diagnostics = capabilityStatus.diagnostics.slice(0, 4).map(
      (item) => `<div class="kernel-capability-diagnostic">${escapeHtml(item.code)} · ${escapeHtml(item.message)}</div>`
    );
    return settingsCard(`
      <div class="kernel-capability-summary">
        <span><b>${available}</b> ${zh ? '可用' : 'available'}</span>
        <span><b>${degraded}</b> ${zh ? '降级' : 'degraded'}</span>
        <span><b>${currentEvidence}</b> ${zh ? '当前证据' : 'current evidence'}</span>
        ${staleEvidence ? `<span><b>${staleEvidence}</b> ${zh ? '过期证据' : 'stale evidence'}</span>` : ''}
        <button type="button" class="wb-set-select kernel-capability-refresh" data-page-action="capability-refresh">${zh ? '重新探测' : 'Re-probe'}</button>
      </div>
      ${actionRows.join('') || `<div class="kernel-capability-empty">${zh ? '没有已注册的远程 Action。' : 'No remote Actions registered.'}</div>`}
      ${diagnostics.join('')}
    `, 'kernel-capability-card');
  }

  function remoteActionFormMarkup(zh: boolean): string {
    return settingsForm({
      id: 'kernel-remote-action-form',
      className: 'kernel-remote-action-form',
      content: `${settingsField({
        label: zh ? 'Action 端点' : 'Action endpoint',
        control: `<input id="kernel-remote-endpoint" type="url" value="${escapeHtml(remoteActionConfig?.endpoint ?? '')}" placeholder="https://actions.example.com/rpc">`,
      })}
      ${settingsField({
        label: 'Bearer Token',
        control: `<input id="kernel-remote-token" type="password" value="" placeholder="${remoteActionConfig?.token ? (zh ? '已保存，留空保持不变' : 'Saved — leave blank to keep') : 'optional'}" autocomplete="off">`,
      })}
      ${settingsField({
        label: zh ? '允许的 Action ID（每行一个）' : 'Allowed Action IDs (one per line)',
        control: `<textarea id="kernel-remote-allowlist">${escapeHtml(remoteActionConfig?.allowedActionIds?.join('\n') ?? '')}</textarea>`,
      })}
      ${settingsField({
        label: zh ? '超时（毫秒）' : 'Timeout (ms)',
        control: `<input id="kernel-remote-timeout" type="number" min="1" value="${remoteActionConfig?.timeoutMs ?? 300000}">`,
      })}
      <div class="wb-form-actions">
        <button type="button" class="wb-btn wb-btn--primary" data-page-action="remote-save">${zh ? '保存并探测' : 'Save and probe'}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="remote-clear">${zh ? '停用远程 Action' : 'Disable remote Actions'}</button>
      </div>
      <div class="wb-conn-url">${zh ? '只接受具名 Action；端点不会获得通用 Shell。' : 'Only named Actions are exposed; the endpoint never receives a generic shell.'}</div>`,
    });
  }

  function connectionsPageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    const cards = pageConfig.connections
      .map(
        (connection) => settingsCard(`<div class="wb-conn-card">
          <div class="wb-conn-head"><span class="wb-conn-name">${escapeHtml(connection.label)}</span>${connection.vision ? '<span class="wb-badge">vision</span>' : ''}</div>
          <div class="wb-conn-url">${escapeHtml(connection.baseUrl)}</div>
          <div class="wb-conn-models">${connection.models.length ? escapeHtml(connection.models.join(', ')) : '—'} · ${connection.apiKey ? 'key ✓' : 'no key'}</div>
          <div class="wb-conn-actions">
            <button type="button" class="wb-ghost-btn" data-page-action="conn-edit" data-id="${escapeHtml(connection.id)}">${zh ? '编辑' : 'Edit'}</button>
            <button type="button" class="wb-ghost-btn" data-page-action="conn-delete" data-id="${escapeHtml(connection.id)}">${zh ? '删除' : 'Delete'}</button>
          </div>
        </div>`)
      )
      .join('');
    const form =
      editingConnectionId !== undefined
        ? connectionFormMarkup(
            editingConnectionId === null
              ? null
              : pageConfig.connections.find((item) => item.id === editingConnectionId) ?? null
          )
        : '';
    return settingsSubpage({
      title: zh ? '模型连接' : 'Connections',
      backAction: 'back-connections',
      backLabel: zh ? '返回' : 'Back',
      backIcon: icons.back,
      theme: effectiveTheme(),
      body: `
        ${cards || `<div class="wb-menu-empty">${zh ? '还没有模型连接。' : 'No model connections yet.'}</div>`}
        ${form || `<button type="button" class="wb-btn wb-btn--primary" data-page-action="conn-add">${zh ? '添加连接' : 'Add connection'}</button>`}
        ${pageAlertMarkup()}`,
    });
  }

  function connectionFormMarkup(connection: KernelConnectionConfig | null): string {
    const zh = pageConfig.language.startsWith('zh');
    return settingsForm({
      id: 'kernel-connection-form',
      content: `${settingsField({
        label: zh ? '名称' : 'Label',
        control: `<input id="kernel-page-conn-label" type="text" value="${escapeHtml(connection?.label ?? '')}">`,
      })}
      ${settingsField({
        label: zh ? '接口地址' : 'Base URL',
        control: `<input id="kernel-page-conn-base" type="text" value="${escapeHtml(connection?.baseUrl ?? '')}" placeholder="https://api.deepseek.com/v1">`,
      })}
      ${settingsField({
        label: 'API Key',
        control: `<input id="kernel-page-conn-key" type="password" value="" placeholder="${connection?.apiKey ? (zh ? '已保存，留空保持不变' : 'Saved — leave blank to keep') : 'sk-...'}" autocomplete="off">`,
      })}
      ${settingsField({
        label: zh ? '模型（每行一个）' : 'Models (one per line)',
        control: `<textarea id="kernel-page-conn-models">${escapeHtml(connection?.models.join('\n') ?? '')}</textarea>`,
      })}
      ${settingsField({
        label: zh ? '支持图片输入' : 'Supports image input',
        className: 'wb-row',
        control: `<input id="kernel-page-conn-vision" type="checkbox" ${connection?.vision ? 'checked' : ''}>`,
        controlFirst: true,
      })}
      <div class="wb-form-actions">
        <button type="button" class="wb-btn wb-btn--primary" data-page-action="conn-save">${zh ? '保存' : 'Save'}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="conn-test">${zh ? '测试连接' : 'Test connection'}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="conn-cancel">${zh ? '取消' : 'Cancel'}</button>
        ${connectionTestMessage ? `<span class="wb-form-ok">${escapeHtml(connectionTestMessage)}</span>` : ''}
      </div>
      <div class="wb-conn-url">${zh ? '支持任何 OpenAI 兼容端点。' : 'Any OpenAI-compatible endpoint works.'}</div>`,
    });
  }

  function historyPageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    return settingsSubpage({
      title: zh ? '聊天记录' : 'Chat history',
      backLabel: zh ? '返回' : 'Back',
      backIcon: icons.back,
      theme: effectiveTheme(),
      body: `
        ${pageSessions.length ? pageSessions.map((session) => settingsCard(`<div class="wb-history-item ${session.sessionId === sessionId ? 'is-current' : ''}">
          <div class="wb-history-main" data-page-action="history-open" data-id="${escapeHtml(session.sessionId)}"><div class="wb-history-title">${escapeHtml(session.title)}</div><div class="wb-history-meta">${escapeHtml(statusLabel(session.taskStatus, pageConfig.language))} · ${session.rowCount} ${zh ? '条' : 'messages'}</div></div>
          ${session.sessionId === sessionId ? `<span class="wb-badge">${zh ? '当前' : 'Current'}</span>` : ''}
          <button type="button" class="wb-ghost-btn" data-page-action="history-delete" data-id="${escapeHtml(session.sessionId)}" aria-label="delete">×</button>
        </div>`)).join('') : `<div class="wb-menu-empty">${zh ? '还没有历史会话。' : 'No history yet.'}</div>`}
        <div class="wb-history-foot">${zh ? '最多保留最近 10 条会话' : 'Keeps your 10 most recent chats'}</div>
        ${pageAlertMarkup()}`,
    });
  }

  async function readPageConfig(): Promise<KernelStoredConfig> {
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const raw = (stored[CONFIG_KEY] ?? {}) as Record<string, unknown>;
    const sourceConnections = Array.isArray(raw.connections) ? raw.connections : [];
    const connections = sourceConnections.flatMap((value, index) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      return [{
        id: String(item.id ?? `connection-${index + 1}`),
        label: String(item.label ?? item.id ?? 'Custom'),
        baseUrl: String(item.baseUrl ?? item['base-url'] ?? ''),
        apiKey: String(item.apiKey ?? item['api-key'] ?? ''),
        models: Array.isArray(item.models) ? item.models.map(String) : [],
        vision: Boolean(item.vision),
      }];
    });
    return {
      approval: raw.approval === 'auto' ? 'auto' : 'ask',
      showReasoning: raw.showReasoning !== false,
      theme: raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : 'light',
      language: typeof raw.language === 'string' ? raw.language : 'en',
      zoom: Number(raw.zoom ?? 100),
      connection: typeof raw.connection === 'string' ? raw.connection : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      connections,
    };
  }

  async function readRemoteActionConfig(): Promise<
    KernelRemoteActionConfig | undefined
  > {
    const stored = await chrome.storage.local.get(REMOTE_ACTIONS_KEY);
    const raw = stored[REMOTE_ACTIONS_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    if (typeof value.endpoint !== 'string' || !value.endpoint.trim()) {
      return undefined;
    }
    return {
      endpoint: value.endpoint,
      ...(typeof value.token === 'string' && value.token
        ? { token: value.token }
        : {}),
      ...(Array.isArray(value.allowedActionIds)
        ? {
            allowedActionIds: value.allowedActionIds
              .map(String)
              .filter(Boolean),
          }
        : {}),
      ...(typeof value.timeoutMs === 'number' && value.timeoutMs > 0
        ? { timeoutMs: value.timeoutMs }
        : {}),
    };
  }

  async function readDebugServiceConfig(): Promise<
    DebugServiceConfig | undefined
  > {
    const stored = await chrome.storage.local.get(DEBUG_SERVICE_KEY);
    const raw = stored[DEBUG_SERVICE_KEY];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const value = raw as Record<string, unknown>;
    const endpoint = normalizeEndpoint(value.endpoint);
    if (!endpoint) return undefined;
    return {
      enabled: value.enabled !== false,
      endpoint,
      ...(typeof value.token === 'string' && value.token
        ? { token: value.token }
        : {}),
    };
  }

  async function writePageConfig(config = pageConfig): Promise<void> {
    await chrome.storage.local.set({ [CONFIG_KEY]: config });
    pageConfig = config;
    modelLabel =
      config.model ||
      config.connections.flatMap((item) => item.models)[0] ||
      (pageConfig.language.startsWith('zh') ? '选择模型' : 'Choose model');
    applyPageAppearance();
    render();
  }

  function applyPageAppearance(): void {
    const stage = document.querySelector<HTMLElement>('.kernel-shell');
    if (!stage) return;
    stage.dataset.wbTheme = effectiveTheme();
    stage.style.zoom = '';
    document.documentElement.style.zoom = String(
      Math.max(70, Math.min(150, pageConfig.zoom || 100)) / 100
    );
    document.documentElement.lang = pageConfig.language;
    document.body.dataset.wbTheme = effectiveTheme();
  }

  function applyLanguageToShell(): void {
    const zh = pageConfig.language.startsWith('zh');
    const setLabel = (selector: string, value: string): void => {
      const node = document.querySelector<HTMLElement>(selector);
      if (node) node.textContent = value;
    };
    document.querySelector('#kernel-new')?.setAttribute('aria-label', zh ? '新建任务' : 'New task');
    document.querySelector('#kernel-history')?.setAttribute('aria-label', zh ? '聊天记录' : 'History');
    document.querySelector('#kernel-settings')?.setAttribute('aria-label', zh ? '设置' : 'Settings');
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    if (input) {
      input.placeholder = zh
        ? '给 tinyai 发消息，按 @ 选择标签页，/ 查看命令'
        : 'Type a task, Enter to send';
      input.setAttribute('aria-label', zh ? '任务' : 'Task');
    }
    setLabel('#kernel-compact', zh ? '压缩上下文' : 'Compact context');
    setLabel('#kernel-approve-plan', zh ? '批准计划' : 'Approve plan');
    const skill = document.querySelector<HTMLSelectElement>('#kernel-skill');
    if (skill?.options[0]) skill.options[0].textContent = zh ? '不使用 Skill' : 'No skill';
  }

  function effectiveTheme(): 'light' | 'dark' {
    const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    return pageConfig.theme === 'dark' || (pageConfig.theme === 'system' && systemDark)
      ? 'dark'
      : 'light';
  }

  async function handlePageAction(action: string, target: HTMLElement): Promise<void> {
    if (action === 'back') {
      closePage();
      return;
    }
    if (action === 'back-connections') {
      editingConnectionId = undefined;
      connectionTestMessage = '';
      pageView = 'settings';
      renderPage();
      return;
    }
    if (action === 'back-runtime') {
      pageView = 'settings';
      renderPage();
      return;
    }
    if (action === 'theme') {
      pageConfig.theme =
        pageConfig.theme === 'light'
          ? 'dark'
          : pageConfig.theme === 'dark'
            ? 'system'
            : 'light';
      await writePageConfig();
      renderPage();
      return;
    }
    if (action === 'language') {
      pageConfig.language = pageConfig.language.startsWith('zh') ? 'en' : 'zh';
      await writePageConfig();
      applyLanguageToShell();
      renderPage();
      return;
    }
    if (action === 'approval') {
      pageConfig.approval = pageConfig.approval === 'ask' ? 'auto' : 'ask';
      await writePageConfig();
      renderPage();
      return;
    }
    if (action === 'reasoning') {
      pageConfig.showReasoning = !pageConfig.showReasoning;
      await writePageConfig();
      renderPage();
      return;
    }
    if (action === 'capability-refresh') {
      capabilityStatusError = '';
      try {
        capabilityStatus = await client.capabilityStatus(sessionId);
      } catch (cause) {
        capabilityStatusError = errorMessage(cause);
      }
      renderPage();
      return;
    }
    if (action === 'capabilities') {
      pageView = 'capabilities';
      pageError = '';
      renderPage();
      return;
    }
    if (action === 'remote-actions') {
      pageView = 'remote-actions';
      pageError = '';
      renderPage();
      return;
    }
    if (action === 'debug-service') {
      pageView = 'debug-service';
      pageError = '';
      renderPage();
      return;
    }
    if (action === 'debug-save') {
      await saveDebugServiceConfig(true);
      return;
    }
    if (action === 'debug-test') {
      await testDebugServiceForm();
      return;
    }
    if (action === 'debug-disable') {
      await saveDebugServiceConfig(false);
      return;
    }
    if (action === 'remote-save') {
      await saveRemoteActionConfig();
      return;
    }
    if (action === 'remote-clear') {
      await chrome.storage.local.remove(REMOTE_ACTIONS_KEY);
      remoteActionConfig = undefined;
      await reloadRuntimeForCurrentTab();
      capabilityStatus = await client.capabilityStatus(sessionId);
      renderPage();
      return;
    }
    if (action === 'capsule-export') {
      await exportWorkspaceCapsule();
      return;
    }
    if (action === 'capsule-import') {
      document.querySelector<HTMLInputElement>('#kernel-capsule-file')?.click();
      return;
    }
    if (action === 'clear-history') {
      const confirmed = window.confirm(
        pageConfig.language.startsWith('zh')
          ? '确定永久清除全部聊天历史？此操作无法撤销。'
          : 'Permanently clear all chat history? This cannot be undone.'
      );
      if (!confirmed) return;
      await client.clearHistory();
      approvalsBySession.clear();
      handoffsBySession.clear();
      approvals = [];
      handoffs = [];
      drafts.clear();
      detailState.clear();
      closePage();
      await startNewSession();
      return;
    }
    if (action === 'zoom') {
      const delta = Number(target.dataset.delta ?? 0);
      pageConfig.zoom =
        delta === 0 ? 100 : Math.max(70, Math.min(150, (pageConfig.zoom || 100) + delta));
      await writePageConfig();
      renderPage();
      return;
    }
    if (action === 'connections') {
      pageView = 'connections';
      editingConnectionId = undefined;
      renderPage();
      return;
    }
    if (action === 'conn-add') {
      editingConnectionId = null;
      renderPage();
      return;
    }
    if (action === 'conn-edit') {
      editingConnectionId = target.dataset.id ?? null;
      renderPage();
      return;
    }
    if (action === 'conn-cancel') {
      editingConnectionId = undefined;
      connectionTestMessage = '';
      renderPage();
      return;
    }
    if (action === 'conn-delete') {
      const id = target.dataset.id;
      if (!id) return;
      if (!window.confirm(pageConfig.language.startsWith('zh') ? '确定删除这条连接？' : 'Delete this connection?')) {
        return;
      }
      pageConfig.connections = pageConfig.connections.filter((item) => item.id !== id);
      if (pageConfig.connection === id) {
        pageConfig.connection = pageConfig.connections[0]?.id ?? null;
        pageConfig.model = pageConfig.connections[0]?.models[0] ?? null;
      }
      await writePageConfig();
      renderPage();
      return;
    }
    if (action === 'conn-save') {
      await saveConnectionForm();
      return;
    }
    if (action === 'conn-test') {
      await testConnectionForm();
      return;
    }
    if (action === 'history-open') {
      const id = target.dataset.id;
      if (!id) return;
      closePage();
      await switchSession(id);
      return;
    }
    if (action === 'history-delete') {
      const id = target.dataset.id;
      if (!id) return;
      await client.deleteSession(id);
      pageSessions = await client.listSessions();
      renderPage();
    }
  }

  async function saveConnectionForm(): Promise<void> {
    const label = pageValue('#kernel-page-conn-label');
    const baseUrl = pageValue('#kernel-page-conn-base').replace(/\/+$/, '');
    const keyInput = pageValue('#kernel-page-conn-key');
    const models = pageValue('#kernel-page-conn-models')
      .split(/\n|,/)
      .map((model) => model.trim())
      .filter(Boolean);
    const previous =
      editingConnectionId && editingConnectionId !== null
        ? pageConfig.connections.find((item) => item.id === editingConnectionId)
        : undefined;
    if (!label || !baseUrl || !models.length) {
      throw new Error('Name, base URL, and at least one model are required');
    }
    const connection: KernelConnectionConfig = {
      id: previous?.id ?? crypto.randomUUID(),
      label,
      baseUrl,
      ...(keyInput || previous?.apiKey ? { apiKey: keyInput || previous?.apiKey } : {}),
      models,
      vision:
        document.querySelector<HTMLInputElement>('#kernel-page-conn-vision')?.checked ?? false,
    };
    const index = pageConfig.connections.findIndex((item) => item.id === connection.id);
    if (index >= 0) pageConfig.connections[index] = connection;
    else pageConfig.connections.push(connection);
    pageConfig.connection = connection.id;
    if (!pageConfig.model || !connection.models.includes(pageConfig.model)) {
      pageConfig.model = connection.models[0];
    }
    await writePageConfig();
    await reloadRuntimeForCurrentTab();
    pageView = 'settings';
    editingConnectionId = undefined;
    renderPage();
  }

  async function testConnectionForm(): Promise<void> {
    const baseUrl = pageValue('#kernel-page-conn-base').replace(/\/+$/, '');
    const key =
      pageValue('#kernel-page-conn-key') ||
      pageConfig.connections.find((item) => item.id === editingConnectionId)?.apiKey ||
      '';
    if (!baseUrl) throw new Error('Base URL is required');
    const response = await fetch(`${baseUrl}/models`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
    if (!response.ok) throw new Error(`Connection failed: HTTP ${response.status}`);
    const payload = (await response.json()) as { data?: Array<{ id?: string }> };
    const models = (payload.data ?? []).map((item) => item.id).filter(Boolean);
    connectionTestMessage = models.length
      ? `Connection OK · ${models.length} models available`
      : 'Connection OK';
    renderPage();
  }

  async function saveRemoteActionConfig(): Promise<void> {
    const endpoint = pageValue('#kernel-remote-endpoint').replace(/\/+$/, '');
    const tokenInput = pageValue('#kernel-remote-token');
    const allowedActionIds = pageValue('#kernel-remote-allowlist')
      .split(/\n|,/)
      .map((value) => value.trim())
      .filter(Boolean);
    const timeoutMs = Number(pageValue('#kernel-remote-timeout'));
    if (!/^https?:\/\/[^/]+/i.test(endpoint)) {
      throw new Error(
        pageConfig.language.startsWith('zh')
          ? '远程 Action 端点必须是 HTTP(S) URL。'
          : 'Remote Action endpoint must be an HTTP(S) URL.'
      );
    }
    const retainedToken =
      remoteActionConfig?.endpoint === endpoint
        ? remoteActionConfig.token
        : undefined;
    const config: KernelRemoteActionConfig = {
      endpoint,
      ...(tokenInput || retainedToken
        ? { token: tokenInput || retainedToken }
        : {}),
      ...(allowedActionIds.length ? { allowedActionIds } : {}),
      ...(Number.isFinite(timeoutMs) && timeoutMs > 0 ? { timeoutMs } : {}),
    };
    await chrome.storage.local.set({ [REMOTE_ACTIONS_KEY]: config });
    remoteActionConfig = config;
    await reloadRuntimeForCurrentTab();
    capabilityStatusError = '';
    try {
      capabilityStatus = await client.capabilityStatus(sessionId);
    } catch (cause) {
      capabilityStatusError = errorMessage(cause);
    }
    renderPage();
  }

  async function exportWorkspaceCapsule(): Promise<void> {
    const capsule = await client.serializeCapsule();
    const bytes = Uint8Array.from(atob(capsule.dataBase64), (char) =>
      char.charCodeAt(0)
    );
    const href = URL.createObjectURL(
      new Blob([bytes], { type: 'application/octet-stream' })
    );
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = `tinyai-workspace-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}.capsule`;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1_000);
  }

  async function importWorkspaceCapsule(file: File): Promise<void> {
    const zh = pageConfig.language.startsWith('zh');
    if (
      !window.confirm(
        zh
          ? '导入会替换当前 Workspace 项目并恢复胶囊中的会话。继续吗？'
          : 'Importing replaces the current Workspace project and restores its sessions. Continue?'
      )
    ) {
      return;
    }
    const dataBase64 = bytesToBase64(new Uint8Array(await file.arrayBuffer()));
    const imported = await client.importCapsule(dataBase64);
    pageError = '';
    closePage();
    await client.reloadRuntime();
    if (imported.sessions.length && windowId !== undefined && activeTabId) {
      await activateSession(() =>
        client.bindTabSession(
          windowId!,
          activeTabId!,
          imported.sessions[0],
          activeGroupId
        )
      );
    } else {
      await reloadRuntimeForCurrentTab();
    }
  }

  async function saveDebugServiceConfig(enabled: boolean): Promise<void> {
    const endpoint = normalizeEndpoint(pageValue('#kernel-debug-endpoint'));
    if (!endpoint) {
      throw new Error(
        pageConfig.language.startsWith('zh')
          ? '调试服务地址必须是 HTTP(S) 地址；非本机地址必须使用 HTTPS。'
          : 'Debug Service must use HTTP(S); non-local endpoints require HTTPS.'
      );
    }
    const tokenInput = pageValue('#kernel-debug-token');
    const retainedToken =
      debugServiceConfig?.endpoint === endpoint
        ? debugServiceConfig.token
        : undefined;
    const token = tokenInput || retainedToken;
    if (enabled && !token) {
      throw new Error(
        pageConfig.language.startsWith('zh')
          ? '启用实时上报需要 Pairing Token。'
          : 'A Pairing Token is required to enable live reporting.'
      );
    }
    const config: DebugServiceConfig = {
      enabled,
      endpoint,
      ...(token ? { token } : {}),
    };
    await chrome.storage.local.set({ [DEBUG_SERVICE_KEY]: config });
    debugServiceConfig = config;
    await reloadRuntimeForCurrentTab();
    debugServiceTestMessage = enabled
      ? pageConfig.language.startsWith('zh')
        ? '已保存并启用'
        : 'Saved and enabled'
      : pageConfig.language.startsWith('zh')
        ? '已停用'
        : 'Disabled';
    renderPage();
  }

  async function testDebugServiceForm(): Promise<void> {
    const endpoint = normalizeEndpoint(pageValue('#kernel-debug-endpoint'));
    if (!endpoint) {
      throw new Error(
        pageConfig.language.startsWith('zh')
          ? '调试服务地址无效。'
          : 'Debug Service endpoint is invalid.'
      );
    }
    const token =
      pageValue('#kernel-debug-token') ||
      (debugServiceConfig?.endpoint === endpoint
        ? debugServiceConfig.token
        : undefined);
    await testDebugService({ endpoint, ...(token ? { token } : {}) });
    debugServiceConfig = {
      enabled:
        document.querySelector<HTMLInputElement>('#kernel-debug-enabled')
          ?.checked ?? true,
      endpoint,
      ...(token ? { token } : {}),
    };
    debugServiceTestMessage = pageConfig.language.startsWith('zh')
      ? '连接成功'
      : 'Connection OK';
    renderPage();
  }

  function pageValue(selector: string): string {
    return document.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(
      selector
    )?.value.trim() ?? '';
  }

  async function openTabMenu(): Promise<void> {
    const zh = pageConfig.language.startsWith('zh');
    const tabs = await client.listTabs();
    const menu = document.querySelector<HTMLElement>('#kernel-tab-menu');
    const commandMenu = document.querySelector<HTMLElement>('#kernel-command-menu');
    const modelMenu = document.querySelector<HTMLElement>('#kernel-model-menu');
    if (commandMenu) commandMenu.hidden = true;
    if (modelMenu) modelMenu.hidden = true;
    if (!menu) return;
    const currentTabs =
      activeScope === 'tab'
        ? tabs.filter((tab) => tab.id === activeTabId)
        : [];
    const tabsWithGroups = await chrome.tabs.query({ windowId });
    const groupMembers =
      activeScope === 'group' && activeGroupId !== undefined
        ? tabsWithGroups
            .filter((tab) => tab.groupId === activeGroupId)
            .map((tab) => ({
              id: String(tab.id),
              title: tab.title,
              url: tab.url,
              active: Boolean(tab.active),
            }))
        : [];
    const workspaceTabs = currentTabs.length ? currentTabs : groupMembers;
    const workspaceIds = new Set(workspaceTabs.map((tab) => tab.id));
    const otherTabs = tabs.filter((tab) => !workspaceIds.has(tab.id));
    const tabButton = (tab: (typeof tabs)[number]): string =>
      `<button type="button" class="wb-pop-item${tab.id === activeTabId ? ' selected' : ''}" data-kernel-tab="${escapeHtml(tab.id)}"><span class="wb-pop-copy"><span class="wb-pop-title">${escapeHtml(tab.title || tab.url || tab.id)}</span><span class="wb-pop-desc">${escapeHtml(tab.url ?? '')}</span></span>${tab.id === executionTabId ? `<span class="wb-badge">${zh ? '任务标签' : 'Task tab'}</span>` : ''}</button>`;
    menu.innerHTML =
      (workspaceTabs.length
        ? `<div class="wb-menu-heading">${zh ? '当前工作区' : 'Current workspace'}</div>${workspaceTabs
            .map(tabButton)
            .join('')}`
        : '') +
      (otherTabs.length
        ? `<div class="wb-menu-heading">${zh ? '其他独立标签' : 'Other independent tabs'}</div>${otherTabs
            .map(tabButton)
            .join('')}`
        : '') ||
      `<div class="wb-menu-empty">${zh ? '没有可用的网页标签页' : 'No browser tabs'}</div>`;
    menu.hidden = false;
  }

  async function openModelMenu(): Promise<void> {
    const zh = pageConfig.language.startsWith('zh');
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const config = (stored[CONFIG_KEY] ?? {}) as {
      connection?: string;
      model?: string;
      connections?: Array<{
        id?: string;
        label?: string;
        models?: unknown[];
      }>;
    };
    const connections = Array.isArray(config.connections) ? config.connections : [];
    const selectedConnection =
      typeof config.connection === 'string'
        ? config.connection
        : connections.find((connection) =>
            (connection.models ?? []).map(String).includes(String(config.model ?? ''))
          )?.id ?? connections[0]?.id;
    const selectedModel =
      typeof config.model === 'string' && config.model
        ? config.model
        : connections
            .find((connection) => connection.id === selectedConnection)
            ?.models?.map(String)[0] ?? '';
    const menu = document.querySelector<HTMLElement>('#kernel-model-menu');
    const commandMenu = document.querySelector<HTMLElement>('#kernel-command-menu');
    if (commandMenu) commandMenu.hidden = true;
    if (!menu) return;
    const groups = connections.flatMap((connection) => {
      const models = Array.isArray(connection.models) ? connection.models.map(String) : [];
      return models.length
        ? [`<div class="wb-menu-heading">${escapeHtml(connection.label ?? connection.id ?? 'Model')}</div>${models
            .map(
              (model) => {
                const selected =
                  model === selectedModel &&
                  (connection.id ?? '') === (selectedConnection ?? '');
                return `<button type="button" class="wb-pop-item${selected ? ' selected' : ''}" data-kernel-model="${escapeHtml(model)}" data-kernel-connection="${escapeHtml(connection.id ?? '')}" aria-pressed="${selected ? 'true' : 'false'}"><span class="wb-pop-copy"><span class="wb-pop-title">${escapeHtml(model)}</span></span>${selected ? icons.check : ''}</button>`;
              }
            )
            .join('')}`]
        : [];
    });
    menu.innerHTML =
      groups.join('') ||
      `<div class="wb-menu-empty">${zh ? '未配置模型' : 'No model configured'}</div><button type="button" class="wb-pop-item" id="kernel-model-settings">${zh ? '打开设置' : 'Open settings'}</button>`;
    menu.hidden = false;
    menu.querySelector('#kernel-model-settings')?.addEventListener('click', () => {
      menu.hidden = true;
      void showPage('settings').catch(showError);
    });
  }

  async function switchModel(connection: string, model: string): Promise<void> {
    if (!connection || !model) return;
    if (pageConfig.connection === connection && pageConfig.model === model) {
      await openModelMenu();
      return;
    }
    const menu = document.querySelector<HTMLElement>('#kernel-model-menu');
    if (menu) {
      menu.querySelectorAll<HTMLButtonElement>('[data-kernel-model]').forEach((option) => {
        option.disabled = true;
      });
      markModelOptionSelected(menu, connection, model);
      modelLabel = model;
      const label = document.querySelector<HTMLElement>('#kernel-model-label');
      if (label) label.textContent = model;
    }
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const config = (stored[CONFIG_KEY] ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({
      [CONFIG_KEY]: { ...config, connection, model },
    });
    pageConfig.connection = connection;
    pageConfig.model = model;
    modelLabel = model;
    await reloadRuntimeForCurrentTab();
    render();
    await openModelMenu();
  }

  async function openArtifact(artifactId: string): Promise<void> {
    const artifact = await client.readArtifact(artifactId);
    const title = document.querySelector<HTMLElement>('#kernel-artifact-title');
    const body = document.querySelector<HTMLElement>('#kernel-artifact-body');
    if (!title || !body) return;
    title.textContent = artifact.metadata.name;
    if (artifact.metadata.mimeType.startsWith('image/')) {
      body.innerHTML = `<img class="kernel-tool-image" alt="${escapeHtml(artifact.metadata.name)}" src="data:${escapeHtml(artifact.metadata.mimeType)};base64,${artifact.dataBase64}">`;
    } else if (artifact.metadata.mimeType === 'application/pdf') {
      body.innerHTML = `<a class="kernel-primary" download="${escapeHtml(artifact.metadata.name)}" href="data:application/pdf;base64,${artifact.dataBase64}">Download PDF</a>`;
    } else {
      const bytes = Uint8Array.from(atob(artifact.dataBase64), (char) => char.charCodeAt(0));
      body.innerHTML = `<pre>${escapeHtml(new TextDecoder().decode(bytes).slice(0, 100_000))}</pre>`;
    }
    document.querySelector<HTMLDialogElement>('#kernel-artifact-dialog')?.showModal();
  }

  async function switchSession(nextSessionId: string): Promise<void> {
    if (nextSessionId === sessionId && projection) return;
    detailState.clear();
    if (windowId === undefined || !activeTabId) {
      throw new Error('No active browser tab is available');
    }
    await activateSession(() =>
      client.bindTabSession(
        windowId!,
        activeTabId!,
        nextSessionId,
        activeGroupId
      )
    );
  }

  function showError(cause: unknown): void {
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    busy = false;
    busyStartedAt = 0;
    render();
  }

  try {
    const currentWindow = await chrome.windows.getCurrent();
    if (currentWindow.id === undefined) throw new Error('No browser window is available');
    windowId = currentWindow.id;
    document.documentElement.dataset.tinyaiWindowId = String(windowId);
    const [activeTab] = await chrome.tabs.query({
      active: true,
      windowId,
    });
    if (activeTab?.id === undefined) throw new Error('No active browser tab is available');
    activeTabId = String(activeTab.id);
    activeGroupId =
      activeTab.groupId !== undefined && activeTab.groupId >= 0
        ? activeTab.groupId
        : undefined;
    await activateSession(() =>
      client.resolveTabSession(windowId!, activeTabId!, activeGroupId)
    );
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    if (!/SESSION_NOT_FOUND|Session not found/i.test(message)) error = message;
  }
  skills = await client.listSkills().catch(() => []);
  const storedConfig: Record<string, unknown> = await chrome.storage.local
    .get(CONFIG_KEY)
    .catch(() => ({}) as Record<string, unknown>);
  const initialConfig = (storedConfig[CONFIG_KEY] ?? {}) as {
    model?: unknown;
    connections?: Array<{ models?: unknown[] }>;
  };
  modelLabel =
    String(initialConfig.model ?? '').trim() ||
    String(initialConfig.connections?.[0]?.models?.[0] ?? '').trim() ||
    (pageConfig.language.startsWith('zh') ? '选择模型' : 'Choose model');
  const skillSelect = document.querySelector<HTMLSelectElement>('#kernel-skill');
  if (skillSelect) {
    skillSelect.innerHTML =
      `<option value="">${pageConfig.language.startsWith('zh') ? '不使用 Skill' : 'No skill'}</option>` +
      skills
        .map(
          (skill) =>
            `<option value="${escapeHtml(skill.name)}">${escapeHtml(skill.name)}${skill.description ? ` · ${escapeHtml(skill.description)}` : ''}</option>`
        )
        .join('');
  }
  render();
}

function emptyHtml(language = 'en'): string {
  const zh = language.startsWith('zh');
  const prompts = zh
    ? [
        { icon: icons.file, text: '总结这个页面' },
        { icon: icons.paper, text: '调研 arXiv 上的相关论文' },
        { icon: icons.list, text: '帮我做一个问卷' },
      ]
    : [
        { icon: icons.file, text: 'Summarize this page' },
        { icon: icons.paper, text: 'Survey related arXiv papers' },
        { icon: icons.list, text: 'Build a questionnaire' },
      ];
  return `<div class="wb-empty kernel-empty">
    <div class="wb-empty-head">
      <img class="wb-empty-avatar" src="icon/tinyai.svg" alt="" aria-hidden="true">
      <div class="wb-empty-title">${zh ? '你好，想让我做什么？' : 'What should tinyai do?'}</div>
    </div>
    <div class="wb-prompt-chips">
      ${prompts.map((prompt) => `<button type="button" class="wb-prompt-chip" data-kernel-prompt="${escapeHtml(prompt.text)}">${prompt.icon}<span>${escapeHtml(prompt.text)}</span></button>`).join('')}
    </div>
  </div>`;
}

function renderTurnUnit(
  unit: TurnRenderUnit,
  language: string,
  showReasoning: boolean
): string {
  return `<article class="kernel-turn" data-product-turn="${escapeHtml(unit.productTurnId)}">
    ${unit.segments
      .map((segment) => renderWorkSegment(segment, language, showReasoning))
      .join('')}
  </article>`;
}

function renderWorkSegment(
  segment: WorkSegment,
  language: string,
  showReasoning: boolean
): string {
  const zh = language.startsWith('zh');
  const user = segment.user ? renderUserRow(segment.user.text) : '';
  const workItems = segment.workItems
    .map((item) => renderWorkItem(item, showReasoning, language))
    .filter(Boolean);
  const work = workItems.length
    ? renderWorkHistory(segment, workItems.join(''), language)
    : '';
  const answer = segment.latestAssistant
    ? renderAssistantRow(segment.latestAssistant, language, true)
    : '';
  const tail = segment.tailRows
    .map((row) => renderTailRow(row, showReasoning, language))
    .filter(Boolean)
    .join('');
  return `<section class="kernel-work-segment kernel-work-segment--${escapeHtml(segment.state)}">
    ${user}
    ${work}
    ${answer}
    ${tail || (segment.running && !answer ? `<div class="kernel-turn-placeholder">${zh ? '正在准备回复…' : 'Preparing a response…'}</div>` : '')}
  </section>`;
}

function renderUserRow(text: string): string {
  return `<div class="wb-stream-row kernel-message-row kernel-message-row--user">
    <div class="wb-msg wb-msg-user"><div class="wb-user-bubble">${escapeHtml(excerptText(text))}</div></div>
  </div>`;
}

function renderWorkHistory(
  segment: WorkSegment,
  content: string,
  language: string
): string {
  const zh = language.startsWith('zh');
  if (segment.running) {
    return `<section class="kernel-work kernel-work--running" aria-live="polite">
      <div class="kernel-work-items">${content}</div>
    </section>`;
  }
  const forceOpen = segment.state === 'failed' || segment.state === 'cancelled';
  return `<details class="kernel-work kernel-work--${escapeHtml(segment.state)}" data-ui-key="work:${escapeHtml(segment.key)}"${forceOpen ? ' data-force-open="true"' : ''}${segment.defaultOpen ? ' open' : ''}>
    <summary class="kernel-work-summary">
      <span class="kernel-work-summary-icon" aria-hidden="true">${icons.sparkle}</span>
      <span>${escapeHtml(workStateLabel(segment, language))}</span>
      ${segment.state === 'failed' ? `<span class="kernel-work-state">${zh ? '失败' : 'Failed'}</span>` : ''}
      ${segment.state === 'cancelled' ? `<span class="kernel-work-state">${zh ? '已停止' : 'Stopped'}</span>` : ''}
      <span class="kernel-work-chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="kernel-work-items">${content}</div>
  </details>`;
}

function renderWorkItem(
  item: WorkItem,
  showReasoning: boolean,
  language: string
): string {
  if (item.kind === 'reasoning' && item.row) {
    return renderReasoningRow(item.row, showReasoning, language);
  }
  if (item.kind === 'tool' && item.row) {
    return renderToolRow(item.row, language);
  }
  if (item.kind === 'tool-group' && item.group) {
    return renderToolGroup(item.group.family, item.group.rows, language);
  }
  if (item.kind === 'child' && item.child) {
    return renderChildRow(item.child, language);
  }
  if (item.kind === 'assistant' && item.row) {
    return renderAssistantRow(item.row, language, false);
  }
  if (item.kind === 'plan' && item.row) {
    return renderPlanRow(item.row, language);
  }
  if (item.kind === 'activity' && item.row) {
    return renderActivityRow(item.row, language);
  }
  return '';
}

function renderReasoningRow(
  row: ProductProjection['rows'][number],
  showReasoning: boolean,
  language: string
): string {
  if (!showReasoning || !row.text.trim()) return '';
  const zh = language.startsWith('zh');
  const running = row.status === 'streaming' || row.status === 'pending';
  return `<details class="kernel-reasoning" data-ui-key="reasoning:${escapeHtml(row.id)}">
    <summary>
      <span class="kernel-reasoning-icon" aria-hidden="true">${icons.sparkle}</span>
      <span>${zh ? '推理过程' : 'Reasoning'}</span>
      ${running ? `<span class="kernel-reasoning-running">${zh ? '思考中' : 'Thinking'}</span>` : ''}
      <span class="kernel-work-chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="kernel-reasoning-body">${escapeHtml(excerptText(row.text))}</div>
  </details>`;
}

function renderToolRow(
  row: ProductProjection['rows'][number],
  language: string
): string {
  const zh = language.startsWith('zh');
  const running = row.status === 'pending' || row.status === 'streaming';
  const failed = row.status === 'failed' || row.status === 'denied';
  const status =
    row.status === 'denied'
      ? (zh ? '已拒绝' : 'Denied')
      : failed
        ? (zh ? '失败' : 'Failed')
        : running
          ? (zh ? '执行中' : 'Running')
          : '';
  return `<div class="wb-stream-row kernel-tool-row">
    <details class="wb-step kernel-tool-step" data-call-id="${escapeHtml(row.callId ?? row.id)}" data-ui-key="tool:${escapeHtml(row.id)}"${failed ? ' data-force-open="true"' : ''}${failed || running ? ' open' : ''}>
      <summary class="wb-step-row">
        <span class="wb-step-ico" aria-hidden="true">${familyIcon(toolFamily(row.toolName ?? ''))}</span>
        <span class="wb-step-text">
          <span class="wb-step-name">${escapeHtml(toolSummary(row.toolName ?? 'tool', language))}</span>
          ${status ? `<span class="wb-tool-status${running ? ' wb-tool-status--running' : failed ? ' wb-tool-status--error' : ''}">${status}</span>` : ''}
        </span>
        <span class="wb-tool-group-chev" aria-hidden="true">${icons.chevronRight}</span>
      </summary>
      <div class="wb-tool-body"><div class="wb-tool-card">${
        row.text
          ? toolOutput(row.toolName, row.text)
          : `<pre class="wb-kv-block">${running ? (zh ? '执行中…' : 'Running…') : (zh ? '（无输出）' : '(no output)')}</pre>`
      }</div></div>
    </details>
  </div>`;
}

function renderToolGroup(
  family: ToolFamily,
  rows: ProductProjection['rows'],
  language: string
): string {
  return `<section class="kernel-tool-group">
    <div class="kernel-tool-group-head">
      <span class="kernel-tool-group-icon" aria-hidden="true">${familyIcon(family)}</span>
      <span>${escapeHtml(familySummary(family, rows.length, language))}</span>
    </div>
    <div class="kernel-tool-group-rows">
      ${rows.map((row) => renderToolRow(row, language)).join('')}
    </div>
  </section>`;
}

function renderAssistantRow(
  row: ProductProjection['rows'][number],
  language: string,
  withFeedback: boolean
): string {
  if (!row.text && !withFeedback) return '';
  const zh = language.startsWith('zh');
  const body = row.text
    ? `${md(excerptText(row.text))}${row.status === 'streaming' ? '<span class="wb-cursor"></span>' : ''}`
    : '';
  const feedback = withFeedback && row.status === 'completed'
    ? `<div class="wb-feedback">
        <button type="button" class="wb-mini-action" data-copy-message="${escapeHtml(row.id)}">${icons.file}${zh ? '复制' : 'Copy'}</button>
        <button type="button" class="wb-mini-action" data-export-message="${escapeHtml(row.id)}">${zh ? '导出' : 'Export'}</button>
      </div>`
    : '';
  return `<div class="wb-stream-row kernel-message-row kernel-answer-row">
    <div class="wb-msg"><div class="wb-assistant"><div class="wb-assistant-body">${body}</div>${feedback}</div></div>
  </div>`;
}

function renderPlanRow(
  row: ProductProjection['rows'][number],
  language: string
): string {
  const zh = language.startsWith('zh');
  return `<details class="kernel-plan-inline" data-ui-key="plan:${escapeHtml(row.id)}">
    <summary>${zh ? '计划' : 'Plan'} · ${escapeHtml(statusLabel(row.status, language))}</summary>
    <div>${md(excerptText(row.text))}</div>
  </details>`;
}

function renderActivityRow(
  row: ProductProjection['rows'][number],
  language: string
): string {
  if (row.text === 'Thinking' || row.text === 'Thinking complete') return '';
  const running = row.status === 'streaming' || row.status === 'pending';
  return `<div class="kernel-activity${running ? ' is-running' : ''}">
    <span class="kernel-activity-mark" aria-hidden="true"></span>
    <span>${escapeHtml(row.text)}</span>
  </div>`;
}

function renderChildRow(
  child: NonNullable<ProductProjection['children']>[number],
  language: string
): string {
  const zh = language.startsWith('zh');
  return `<article class="kernel-child kernel-child--${escapeHtml(child.status)}" data-child-task="${escapeHtml(child.taskId)}">
    <span class="kernel-child-line" aria-hidden="true"></span>
    <span class="kernel-child-icon" aria-hidden="true">⌁</span>
    <div class="kernel-child-copy">
      <div><strong>${escapeHtml(child.profileName)}</strong><span class="kernel-child-status">${escapeHtml(statusLabel(child.status, language))}</span></div>
      <p>${escapeHtml(child.summary ?? `${child.executionMode} · ${zh ? '等待首次更新' : 'waiting for first update'}`)}</p>
    </div>
    <button type="button" class="kernel-child-open" data-open-child="${escapeHtml(child.sessionId)}">${zh ? '查看' : 'View'}</button>
  </article>`;
}

function renderTailRow(
  row: ProductProjection['rows'][number],
  showReasoning: boolean,
  language: string
): string {
  if (row.kind === 'reasoning') return renderReasoningRow(row, showReasoning, language);
  if (row.kind === 'tool') return renderToolRow(row, language);
  if (row.kind === 'assistant') return renderAssistantRow(row, language, true);
  if (row.kind === 'plan') return renderPlanRow(row, language);
  if (row.kind === 'activity') return renderActivityRow(row, language);
  return '';
}

function restoreDetailState(
  root: HTMLElement,
  state: Map<string, boolean>
): void {
  root.querySelectorAll<HTMLDetailsElement>('details[data-ui-key]').forEach((details) => {
    const key = details.dataset.uiKey;
    if (details.dataset.forceOpen === 'true') details.open = true;
    else if (key && state.has(key)) details.open = state.get(key) ?? false;
  });
}

function toolSummary(name: string, language: string): string {
  const family = toolFamily(name);
  if (family === 'explore') return toolLabel(name, language);
  if (family === 'browser') return toolLabel(name, language);
  if (family === 'terminal') return toolLabel(name, language);
  if (family === 'changes') return toolLabel(name, language);
  if (family === 'subagent') return toolLabel(name, language);
  if (family === 'artifact') return toolLabel(name, language);
  return toolLabel(name, language);
}

function familyLabel(family: ToolFamily, language: string): string {
  const zh = language.startsWith('zh');
  return {
    explore: zh ? '探索' : 'Explore',
    browser: zh ? '浏览器' : 'Browser',
    terminal: zh ? '终端' : 'Terminal',
    changes: zh ? '变更' : 'Changes',
    subagent: zh ? '子 Agent' : 'Subagents',
    artifact: zh ? '产物' : 'Artifacts',
    other: zh ? '工具' : 'Tools',
  }[family];
}

function familySummary(family: ToolFamily, count: number, language: string): string {
  const zh = language.startsWith('zh');
  if (family === 'explore') return zh ? `探索了 ${count} 个步骤` : `Explored ${count} steps`;
  if (family === 'browser') return zh ? `浏览器操作 ${count} 次` : `Used browser ${count} times`;
  if (family === 'terminal') return zh ? `运行了 ${count} 条命令` : `Ran ${count} commands`;
  if (family === 'changes') return zh ? `修改了 ${count} 处` : `Made ${count} changes`;
  if (family === 'subagent') return zh ? `协调了 ${count} 个子 Agent 操作` : `Coordinated ${count} subagent actions`;
  if (family === 'artifact') return zh ? `生成了 ${count} 个产物` : `Created ${count} artifacts`;
  return `${familyLabel(family, language)} · ${count}`;
}

function familyIcon(family: ToolFamily): string {
  if (family === 'browser' || family === 'explore') return icons.globe;
  if (family === 'terminal') return icons.file;
  if (family === 'subagent') return icons.sparkle;
  if (family === 'artifact') return icons.file;
  return icons.gear;
}

function toolLabel(name: string, language = 'en'): string {
  return toolDisplayLabel(name, language);
}

function markModelOptionSelected(
  menu: HTMLElement,
  connection: string,
  model: string
): void {
  menu.querySelectorAll<HTMLButtonElement>('[data-kernel-model]').forEach((option) => {
    const selected =
      option.dataset.kernelModel === model &&
      (option.dataset.kernelConnection ?? '') === connection;
    option.classList.toggle('selected', selected);
    option.setAttribute('aria-pressed', selected ? 'true' : 'false');
    option.querySelector('.wb-pop-check')?.remove();
    if (selected) option.insertAdjacentHTML('beforeend', icons.check);
  });
}

function approvalSummary(name: string, input: unknown, zh: boolean): string {
  const values =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  const stringValue = (...keys: string[]): string => {
    const value = keys.map((key) => values[key]).find((item) => typeof item === 'string');
    return typeof value === 'string' ? value : '';
  };
  const target = stringValue('url', 'path', 'selector', 'command', 'profile', 'reason');
  const suffix = target ? ` · ${truncateText(target, 90)}` : '';
  if (name === 'navigate') return `${zh ? '打开页面' : 'Open page'}${suffix}`;
  if (name === 'exec') return `${zh ? '执行命令' : 'Run command'}${suffix}`;
  if (name === 'run_tests') return `${zh ? '运行测试' : 'Run tests'}${suffix}`;
  if (
    name === 'write_file' ||
    name === 'apply_patch' ||
    name === 'apply_unified_diff' ||
    name === 'edit'
  ) {
    return `${zh ? '修改文件' : 'Edit file'}${suffix}`;
  }
  if (name === 'spawn_agent') return `${zh ? '启动子 Agent' : 'Start subagent'}${suffix}`;
  if (name === 'await_user_action') {
    return target || (zh ? '需要你完成一次手动操作' : 'Manual action required');
  }
  return `${toolLabel(name, zh ? 'zh' : 'en')}${suffix}`;
}

function truncateText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}…` : compact;
}

function shell(config: KernelStoredConfig): string {
  const zh = config.language.startsWith('zh');
  const theme =
    config.theme === 'system'
      ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : config.theme;
  return `<div class="wb-stage kernel-shell" data-wb-theme="${theme}" style="--wb-page-rgb: 83,177,255; --wb-dock-h: 160px;">
    <header class="wb-header">
      <div class="wb-pop-anchor wb-topnav-left">
        <button type="button" id="kernel-new" class="wb-topnav-circle wb-sk-tip-anchor" aria-label="${zh ? '新建任务' : 'New task'}">
          ${icons.plus}<span class="wb-sk-tip is-down is-start" role="tooltip">${zh ? '新建任务' : 'New task'}</span>
        </button>
        <button type="button" id="kernel-history" class="wb-topnav-circle wb-sk-tip-anchor" aria-label="${zh ? '聊天记录' : 'History'}">
          ${icons.clock}<span class="wb-sk-tip is-down is-start" role="tooltip">${zh ? '聊天记录' : 'History'}</span>
        </button>
      </div>
      <div class="wb-pop-anchor wb-topnav-settings">
        <button type="button" id="kernel-settings" class="wb-topnav-circle wb-sk-tip-anchor" aria-label="${zh ? '设置' : 'Settings'}">
          ${icons.gear}<span class="wb-sk-tip is-down is-end" role="tooltip">${zh ? '设置' : 'Settings'}</span>
        </button>
      </div>
    </header>
    <div class="wb-scroll">
      <main id="kernel-rows" class="wb-stream kernel-rows">
        ${emptyHtml(config.language)}
      </main>
    </div>
    <div class="wb-dock">
      <div id="kernel-queue" class="kernel-queue" hidden></div>
      <div id="kernel-workspace" class="kernel-workspace-context" hidden></div>
      <div id="kernel-status" class="wb-bridge-note kernel-status" hidden></div>
      <div id="kernel-attachments" class="wb-attachment-bar kernel-context-list"></div>
      <form id="kernel-form" class="wb-composer">
        <div class="wb-inputbox">
          <div class="wb-input-main">
            <span class="wb-input-prompt">&gt;</span>
            <textarea id="kernel-input" class="wb-editor kernel-editor" rows="1" placeholder="${zh ? '给 tinyai 发消息，按 @ 选择标签页，/ 查看命令' : 'Type a task, Enter to send'}" aria-label="${zh ? '任务' : 'Task'}"></textarea>
          </div>
          <input id="kernel-file-input" type="file" multiple accept="text/*,image/*,.md,.ts,.tsx,.js,.jsx,.json,.css,.html,.txt" hidden>
          <div class="wb-input-bar">
            <button type="button" id="kernel-tabs" class="wb-icon-button wb-sk-tip-anchor" aria-label="${zh ? '选择标签页' : 'Select tabs'}">
              <span class="wb-composer-glyph wb-composer-glyph--at" aria-hidden="true"></span><span class="wb-sk-tip is-start" role="tooltip">${zh ? '选择标签页' : 'Select tabs'}</span>
            </button>
            <button type="button" id="kernel-slash" class="wb-icon-button wb-sk-tip-anchor" aria-label="${zh ? '命令' : 'Commands'}">
              <span class="wb-composer-glyph wb-composer-glyph--skill" aria-hidden="true"></span><span class="wb-sk-tip is-start" role="tooltip">${zh ? '命令' : 'Commands'}</span>
            </button>
            <button type="button" id="kernel-attach" class="wb-icon-button wb-sk-tip-anchor" aria-label="${zh ? '添加文件或图片' : 'Add a file or image'}">
              <span class="wb-composer-glyph wb-composer-glyph--clip" aria-hidden="true"></span><span class="wb-sk-tip" role="tooltip">${zh ? '添加文件或图片' : 'Add a file or image'}</span>
            </button>
            <div id="kernel-tab-menu" class="kernel-command-menu kernel-tab-menu" hidden></div>
            <div id="kernel-command-menu" class="kernel-command-menu" hidden>
              <div class="wb-menu-heading">Skills</div>
              <select id="kernel-skill" class="kernel-skill-select" aria-label="Skill"><option value="">No skill</option></select>
              <div class="wb-menu-heading">Commands</div>
              <button type="button" id="kernel-mode" class="kernel-tool-button">${zh ? '计划模式' : 'Plan mode'}</button>
              <button type="button" id="kernel-compact" class="kernel-tool-button" hidden>${zh ? '压缩上下文' : 'Compact context'}</button>
              <button type="button" id="kernel-approve-plan" class="kernel-tool-button" hidden>${zh ? '批准计划' : 'Approve plan'}</button>
            </div>
            <span class="wb-input-grow"></span>
            <div class="wb-pop-anchor wb-composer-model">
              <button type="button" id="kernel-model" class="wb-mode-toggle"><span id="kernel-model-label" class="wb-model-name">${zh ? '选择模型' : 'Choose model'}</span>${icons.chevron}</button>
              <div id="kernel-model-menu" class="kernel-command-menu kernel-model-menu" hidden></div>
            </div>
            <button type="button" id="kernel-stop" class="wb-send kernel-stop-button" hidden aria-label="Stop">${icons.stop}</button>
            <button type="submit" id="kernel-send" class="wb-send" aria-label="Send" disabled>${icons.send}</button>
          </div>
        </div>
      </form>
    </div>
    <dialog id="kernel-artifact-dialog" class="kernel-dialog kernel-artifact-dialog">
      <div class="kernel-artifact-view">
        <header><h2 id="kernel-artifact-title">Artifact</h2><button type="button" id="kernel-artifact-close">Close</button></header>
        <div id="kernel-artifact-body"></div>
      </div>
    </dialog>
  </div>`;
}

function statusText(
  projection: ProductProjection | undefined,
  busy: boolean,
  error: string,
  busyStartedAt: number,
  blockingInteraction: boolean,
  language = 'en'
): string {
  const zh = language.startsWith('zh');
  if (error) return error;
  if (!projection) return busy ? (zh ? '正在启动…' : 'Starting…') : (zh ? '可以开始新任务' : 'Ready for a new task');
  if (busy) {
    const elapsed = busyStartedAt ? ` · ${Math.floor((Date.now() - busyStartedAt) / 1000)}s` : '';
    if (blockingInteraction) return `${zh ? '等待你的输入' : 'Waiting for your input'}${elapsed}`;
    if (projection.taskStatus === 'waiting') return `${zh ? '等待中' : 'Waiting'}${elapsed}`;
    if (projection.rows.some((row) => row.kind === 'tool' && row.status === 'pending')) {
      return `${zh ? '正在执行工具' : 'Running tool'}${elapsed}`;
    }
    if (projection.rows.some((row) => row.kind === 'assistant' && row.status === 'streaming' && row.text)) {
      return `${zh ? '正在输出' : 'Writing'}${elapsed}`;
    }
    return `${zh ? '思考中' : 'Thinking'}${elapsed}`;
  }
  return projection.taskStatus === 'failed'
    ? projection.lastError?.message ?? (zh ? '任务失败' : 'Task failed')
    : (zh ? '就绪' : 'Ready');
}

function toolOutput(name: string | undefined, text: string): string {
  if (name === 'screenshot') {
    try {
      const parsed = JSON.parse(text) as { dataUrl?: unknown };
      if (typeof parsed.dataUrl === 'string' && parsed.dataUrl.startsWith('data:image/')) {
        return `<img class="kernel-tool-image" src="${escapeHtml(parsed.dataUrl)}" alt="Page screenshot">`;
      }
    } catch {
      // Fall back to escaped text below.
    }
  }
  try {
    const parsed = JSON.parse(text) as {
      artifact?: { artifactId?: unknown; name?: unknown; bytes?: unknown };
    };
    if (typeof parsed.artifact?.artifactId === 'string') {
      return `<button type="button" class="kernel-artifact-link" data-artifact="${escapeHtml(parsed.artifact.artifactId)}">
        Open artifact: ${escapeHtml(String(parsed.artifact.name ?? parsed.artifact.artifactId))}
        ${typeof parsed.artifact.bytes === 'number' ? ` · ${parsed.artifact.bytes} bytes` : ''}
      </button>`;
    }
  } catch {
    // Plain tool output renders below.
  }
  return `<pre>${escapeHtml(text.length > 8_000 ? `${text.slice(0, 8_000)}\n…(truncated in UI)` : text)}</pre>`;
}

function defaultPageConfig(): KernelStoredConfig {
  return {
    approval: 'ask',
    showReasoning: true,
    theme: 'light',
    language: 'en',
    zoom: 100,
    connection: null,
    model: null,
    connections: [],
  };
}

function themeLabel(theme: 'light' | 'dark' | 'system', zh: boolean): string {
  if (theme === 'dark') return zh ? '深色' : 'Dark mode';
  if (theme === 'system') return zh ? '跟随系统' : 'System';
  return zh ? '浅色' : 'Light mode';
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}


function isMissingTabError(cause: unknown): boolean {
  return cause instanceof Error && cause.name === 'BROWSER_TAB_NOT_FOUND';
}

function isInspectablePageUrl(url: string | undefined): boolean {
  return /^(https?|file):/.test(String(url ?? '')) || url === 'about:blank';
}

function statusLabel(status: string, language: string): string {
  if (!language.startsWith('zh')) return status;
  return {
    completed: '已完成',
    running: '执行中',
    queued: '排队中',
    waiting: '等待中',
    failed: '失败',
    cancelled: '已取消',
    denied: '已拒绝',
  }[status] ?? status;
}
