import type { ProductProjection } from '../core/types';
import type { SkillDefinition } from '../core/extension-registry';
import { escapeHtml, md } from './html';
import { KERNEL_PORT_NAME } from '../runtime/chrome-runtime';
import { CONFIG_KEY } from '../runtime/storage-migration';
import type { KernelApprovalEvent, KernelHandoffEvent } from './kernel-client';
import { KernelClient, connectChromeKernelPort } from './kernel-client';
import { icons } from './icons';

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
  theme: 'light' | 'dark' | 'system';
  language: string;
  zoom: number;
  connection: string | null;
  model: string | null;
  connections: KernelConnectionConfig[];
}

export async function initKernelUi(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#root');
  if (!root) throw new Error('Missing #root');
  let pageConfig: KernelStoredConfig = await readPageConfig();
  root.innerHTML = shell(pageConfig);
  applyPageAppearance();

  const client = new KernelClient(() => connectChromeKernelPort(chrome, KERNEL_PORT_NAME), {
    requestTimeoutMs: 120_000,
  });
  let projection: ProductProjection | undefined;
  let sessionId = `session_${crypto.randomUUID()}`;
  let approvals: KernelApprovalEvent[] = [];
  let handoffs: KernelHandoffEvent[] = [];
  let skills: SkillDefinition[] = [];
  let selectedSkill: SkillDefinition | undefined;
  let attachments: Array<{
    name: string;
    type: string;
    text?: string;
    dataBase64?: string;
  }> = [];
  let modelLabel = pageConfig.language.startsWith('zh') ? '选择模型' : 'Choose model';
  let pageView: 'settings' | 'connections' | 'history' | null = null;
  let pageSessions: Awaited<ReturnType<KernelClient['listSessions']>> = [];
  let editingConnectionId: string | null | undefined;
  let connectionTestMessage = '';
  let pageError = '';
  let error = '';
  let busy = false;
  let busyStartedAt = 0;

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
    const modelLabelNode = document.querySelector<HTMLElement>('#kernel-model-label');
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    if (!rows || !status || !send || !stop || !input || !modeButton || !approvePlan || !compact || !attachmentList || !modelLabelNode) return;
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
      busy ||
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
    attachmentList.innerHTML = [
      ...(selectedSkill
        ? [`<span class="wb-chip"><span class="wb-chip-name">Skill: ${escapeHtml(selectedSkill.name)}</span></span>`]
        : []),
      ...attachments.map(
        (attachment) =>
          `<span class="wb-chip"><span class="wb-chip-name">${escapeHtml(attachment.name)}</span><button type="button" data-remove-attachment="${escapeHtml(attachment.name)}" aria-label="Remove">×</button></span>`
      ),
    ].join('');
    const conversationHtml =
      (projection?.plan?.text
        ? `<section class="kernel-plan-card">
            <div class="kernel-plan-head"><span>${zh ? '计划' : 'Plan'}</span><span>${projection.plan.approvedAt ? (zh ? '已批准' : 'Approved') : (zh ? '草稿' : 'Draft')}</span></div>
            <div class="kernel-plan-body">${md(projection.plan.text)}</div>
          </section>`
        : '') +
      (projection?.rows ?? []).map((row) => rowHtml(row, pageConfig.language)).join('') +
      (projection?.children ?? [])
        .map(
          (child) => `<article class="kernel-child kernel-child--${escapeHtml(child.status)}" data-child-task="${escapeHtml(child.taskId)}">
            <span class="kernel-child-line" aria-hidden="true"></span>
            <span class="kernel-child-icon" aria-hidden="true">⌁</span>
            <div class="kernel-child-copy">
              <div><strong>${escapeHtml(child.profileName)}</strong><span class="kernel-child-status">${escapeHtml(statusLabel(child.status, pageConfig.language))}</span></div>
              <p>${escapeHtml(child.summary ?? `${child.executionMode} · ${zh ? '等待首次更新' : 'waiting for first update'}`)}</p>
            </div>
            <button type="button" class="kernel-child-open" data-open-child="${escapeHtml(child.sessionId)}">${zh ? '查看' : 'View'}</button>
          </article>`
        )
        .join('') +
      approvals
        .map(
          (approval) => `<article class="wb-permission-card kernel-approval">
            <div class="wb-permission-title">${zh ? '允许' : 'Allow'} ${escapeHtml(toolLabel(approval.toolName))}?</div>
            <div class="wb-permission-args">${escapeHtml(JSON.stringify(approval.input, null, 2))}</div>
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
    rows.innerHTML = conversationHtml || emptyHtml(pageConfig.language);
    const scroll = document.querySelector<HTMLElement>('.wb-scroll');
    if (scroll) scroll.scrollTop = scroll.scrollHeight;
  };

  client.onProjection((_sessionId, next) => {
    projection = next;
    const nextBusy =
      next.taskStatus === 'running' ||
      next.taskStatus === 'queued' ||
      next.taskStatus === 'waiting';
    if (nextBusy && !busy) busyStartedAt = Date.now();
    if (!nextBusy) busyStartedAt = 0;
    busy = nextBusy;
    error = '';
    render();
  });
  client.onApproval((approval) => {
    approvals = [...approvals, approval];
    render();
  });
  client.onHandoff((handoff) => {
    handoffs = [...handoffs, handoff];
    render();
  });
  client.onDisconnect(() => {
    error = 'Kernel runtime disconnected';
    busy = false;
    busyStartedAt = 0;
    render();
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
    void client.selectTab(sessionId, tab.dataset.kernelTab).then(() => {
      const menu = document.querySelector<HTMLElement>('#kernel-tab-menu');
      if (menu) menu.hidden = true;
    }).catch(showError);
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
    const prompt = (event.target as Element).closest<HTMLElement>('[data-kernel-prompt]');
    if (!prompt) return;
    const input = document.querySelector<HTMLTextAreaElement>('#kernel-input');
    if (input) {
      input.value = prompt.dataset.kernelPrompt ?? '';
      input.focus();
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
    sessionId = `session_${crypto.randomUUID()}`;
    projection = undefined;
    approvals = [];
    handoffs = [];
    error = '';
    busy = false;
    busyStartedAt = 0;
    render();
  });
  document.addEventListener('change', (event) => {
    const target = event.target as HTMLSelectElement;
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
        .then(() => client.reloadRuntime())
        .then(() => renderPage())
        .catch((cause) => {
          pageError = errorMessage(cause);
          renderPage();
        });
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
    if ((!text && !attachments.length && !selectedSkill) || busy) return;
    if (text === '/new') {
      if (input) input.value = '';
      sessionId = `session_${crypto.randomUUID()}`;
      projection = undefined;
      approvals = [];
      handoffs = [];
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
      busy ||
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

  async function showPage(view: 'settings' | 'connections' | 'history'): Promise<void> {
    pageConfig = await readPageConfig();
    if (view === 'history') pageSessions = await client.listSessions();
    pageView = view;
    pageError = '';
    connectionTestMessage = '';
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
    return settingsPageMarkup();
  }

  function stageMarkup(inner: string): string {
    return `<div id="kernel-page-layer" class="kernel-page-layer">
      <div class="wb-stage" data-wb-theme="${effectiveTheme()}" style="--wb-page-rgb: 83,177,255; --wb-dock-h: 160px;">
        ${inner}
        <div class="wb-fx-grain"></div>
        <div class="wb-fx-scan"></div>
      </div>
    </div>`;
  }

  function settingsHead(title: string, action = 'back'): string {
    return `<div class="wb-settings-head">
      <button type="button" class="wb-icon-button wb-settings-back" data-page-action="${action}" aria-label="${pageConfig.language.startsWith('zh') ? '返回' : 'Back'}">${icons.back}</button>
      <div class="wb-settings-title">${escapeHtml(title)}</div>
    </div>`;
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
    return stageMarkup(`${settingsHead(zh ? '设置' : 'Settings')}
      <div class="wb-settings-body">
        <div class="wb-set-card wb-set-account">
          <div class="wb-account-row">
            <span class="wb-account-avatar wb-account-avatar--logo" aria-hidden="true"><img class="wb-account-avatar-img" alt="" src="icon/tinyai.svg"></span>
            <span class="wb-account-copy"><span class="wb-account-name-row"><span class="wb-account-name">tinyai</span></span><span class="wb-account-line">${zh ? '所有对话和模型 Key 都保存在本机。' : 'All chats and model keys stay on this machine.'}</span></span>
            <span class="wb-badge">${zh ? '本地 Agent' : 'Local agent'}</span>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? '通用' : 'General'}</div>
          <div class="wb-set-card">
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.sun}</span>${zh ? '外观' : 'Appearance'}</span>
              <button type="button" class="wb-set-select" data-page-action="theme"><span class="wb-set-select-value">${escapeHtml(themeLabel(pageConfig.theme, zh))}</span>${icons.chevronDown}</button></div>
            <div class="wb-set-sepa"></div>
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.globe}</span>${zh ? '语言' : 'Language'}</span>
              <select id="kernel-page-language" class="wb-native-select">${[
                ['en', 'English'],
                ['zh', '中文'],
                ['zh-TW', '繁體中文'],
                ['ja', '日本語'],
                ['ko', '한국어'],
                ['es', 'Español'],
                ['fr', 'Français'],
                ['de', 'Deutsch'],
              ].map(([value, label]) => `<option value="${value}" ${value === pageConfig.language ? 'selected' : ''}>${label}</option>`).join('')}</select></div>
            <div class="wb-set-sepa"></div>
            <div class="wb-set-row"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.zoom}</span>${zh ? '缩放' : 'Zoom'}</span><span class="wb-input-grow"></span>
              <button type="button" class="wb-set-stepper-btn" data-page-action="zoom" data-delta="-10" aria-label="Zoom out">−</button>
              <button type="button" class="wb-set-stepper-value" data-page-action="zoom" data-delta="0">${pageConfig.zoom}%</button>
              <button type="button" class="wb-set-stepper-btn" data-page-action="zoom" data-delta="10" aria-label="Zoom in">+</button></div>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? '模型' : 'Models'}</div>
          <div class="wb-set-card">
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.sparkle}</span>${zh ? '模型' : 'Model'}</span>
              <select class="wb-native-select" id="kernel-page-model">${models.length ? models.map((item) => `<option value="${escapeHtml(item.connection + '|' + item.model)}" ${item.connection === pageConfig.connection && item.model === pageConfig.model ? 'selected' : ''}>${escapeHtml(item.label)}</option>`).join('') : `<option>${zh ? '未配置模型' : 'No model'}</option>`}</select></div>
            <div class="wb-set-sepa"></div>
            <div class="wb-set-row wb-set-navrow wb-clickable" data-page-action="connections"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.link}</span>${zh ? '模型连接' : 'Model connections'}</span><span class="wb-input-grow"></span><span class="wb-set-row-value">${pageConfig.connections.length}</span>${icons.chevronDown}</div>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? '权限' : 'Permissions'}</div>
          <div class="wb-set-card">
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.shield}</span>${zh ? '操作审批' : 'Action approval'}</span>
              <button type="button" class="wb-set-select" data-page-action="approval"><span class="wb-set-select-value">${pageConfig.approval === 'auto' ? (zh ? '自动执行' : 'Auto-approve') : (zh ? '需要审批' : 'Requires approval')}</span>${icons.chevronDown}</button></div>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? '关于' : 'About'}</div>
          <div class="wb-set-card">
            <div class="wb-set-row"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.info}</span>${zh ? '版本' : 'Version'}</span><span class="wb-input-grow"></span><span class="wb-set-row-value">${escapeHtml(chrome.runtime.getManifest().version)}</span></div>
          </div>
        </div>
        ${pageAlertMarkup()}
      </div>`);
  }

  function connectionsPageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    const cards = pageConfig.connections
      .map(
        (connection) => `<div class="wb-conn-card">
          <div class="wb-conn-head"><span class="wb-conn-name">${escapeHtml(connection.label)}</span>${connection.vision ? '<span class="wb-badge">vision</span>' : ''}</div>
          <div class="wb-conn-url">${escapeHtml(connection.baseUrl)}</div>
          <div class="wb-conn-models">${connection.models.length ? escapeHtml(connection.models.join(', ')) : '—'} · ${connection.apiKey ? 'key ✓' : 'no key'}</div>
          <div class="wb-conn-actions">
            <button type="button" class="wb-ghost-btn" data-page-action="conn-edit" data-id="${escapeHtml(connection.id)}">${zh ? '编辑' : 'Edit'}</button>
            <button type="button" class="wb-ghost-btn" data-page-action="conn-delete" data-id="${escapeHtml(connection.id)}">${zh ? '删除' : 'Delete'}</button>
          </div>
        </div>`
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
    return stageMarkup(`${settingsHead(zh ? '模型连接' : 'Connections', 'back-connections')}
      <div class="wb-settings-body">
        ${cards || `<div class="wb-menu-empty">${zh ? '还没有模型连接。' : 'No model connections yet.'}</div>`}
        ${form || `<button type="button" class="wb-btn wb-btn--primary" data-page-action="conn-add">${zh ? '添加连接' : 'Add connection'}</button>`}
        ${pageAlertMarkup()}
      </div>`);
  }

  function connectionFormMarkup(connection: KernelConnectionConfig | null): string {
    const zh = pageConfig.language.startsWith('zh');
    return `<form id="kernel-connection-form" class="wb-form">
      <label>${zh ? '名称' : 'Label'}<input id="kernel-page-conn-label" type="text" value="${escapeHtml(connection?.label ?? '')}"></label>
      <label>${zh ? '接口地址' : 'Base URL'}<input id="kernel-page-conn-base" type="text" value="${escapeHtml(connection?.baseUrl ?? '')}" placeholder="https://api.deepseek.com/v1"></label>
      <label>API Key<input id="kernel-page-conn-key" type="password" value="" placeholder="${connection?.apiKey ? (zh ? '已保存，留空保持不变' : 'Saved — leave blank to keep') : 'sk-...'}" autocomplete="off"></label>
      <label>${zh ? '模型（每行一个）' : 'Models (one per line)'}<textarea id="kernel-page-conn-models">${escapeHtml(connection?.models.join('\n') ?? '')}</textarea></label>
      <label class="wb-row"><input id="kernel-page-conn-vision" type="checkbox" ${connection?.vision ? 'checked' : ''}> ${zh ? '支持图片输入' : 'Supports image input'}</label>
      <div class="wb-form-actions">
        <button type="button" class="wb-btn wb-btn--primary" data-page-action="conn-save">${zh ? '保存' : 'Save'}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="conn-test">${zh ? '测试连接' : 'Test connection'}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="conn-cancel">${zh ? '取消' : 'Cancel'}</button>
        ${connectionTestMessage ? `<span class="wb-form-ok">${escapeHtml(connectionTestMessage)}</span>` : ''}
      </div>
      <div class="wb-conn-url">${zh ? '支持任何 OpenAI 兼容端点。' : 'Any OpenAI-compatible endpoint works.'}</div>
    </form>`;
  }

  function historyPageMarkup(): string {
    const zh = pageConfig.language.startsWith('zh');
    return stageMarkup(`${settingsHead(zh ? '聊天记录' : 'Chat history')}
      <div class="wb-settings-body">
        ${pageSessions.length ? pageSessions.map((session) => `<div class="wb-history-item ${session.sessionId === sessionId ? 'is-current' : ''}">
          <div class="wb-history-main" data-page-action="history-open" data-id="${escapeHtml(session.sessionId)}"><div class="wb-history-title">${escapeHtml(session.title)}</div><div class="wb-history-meta">${escapeHtml(statusLabel(session.taskStatus, pageConfig.language))} · ${session.rowCount} ${zh ? '条' : 'messages'}</div></div>
          ${session.sessionId === sessionId ? `<span class="wb-badge">${zh ? '当前' : 'Current'}</span>` : ''}
          <button type="button" class="wb-ghost-btn" data-page-action="history-delete" data-id="${escapeHtml(session.sessionId)}" aria-label="delete">×</button>
        </div>`).join('') : `<div class="wb-menu-empty">${zh ? '还没有历史会话。' : 'No history yet.'}</div>`}
        <div class="wb-history-foot">${zh ? '最多保留最近 10 条会话' : 'Keeps your 10 most recent chats'}</div>
        ${pageAlertMarkup()}
      </div>`);
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
      theme: raw.theme === 'dark' || raw.theme === 'system' ? raw.theme : 'light',
      language: typeof raw.language === 'string' ? raw.language : 'en',
      zoom: Number(raw.zoom ?? 100),
      connection: typeof raw.connection === 'string' ? raw.connection : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      connections,
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
    await client.reloadRuntime();
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
    menu.innerHTML =
      `<div class="wb-menu-heading">${zh ? '标签页' : 'Tabs'}</div>` +
      (tabs.length
        ? tabs
            .map(
              (tab) =>
                `<button type="button" class="wb-pop-item${tab.active ? ' selected' : ''}" data-kernel-tab="${escapeHtml(tab.id)}"><span class="wb-pop-copy"><span class="wb-pop-title">${escapeHtml(tab.title || tab.url || tab.id)}</span><span class="wb-pop-desc">${escapeHtml(tab.url ?? '')}</span></span></button>`
            )
            .join('')
        : `<div class="wb-menu-empty">${zh ? '没有可用的网页标签页' : 'No browser tabs'}</div>`);
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
    const menu = document.querySelector<HTMLElement>('#kernel-model-menu');
    const commandMenu = document.querySelector<HTMLElement>('#kernel-command-menu');
    if (commandMenu) commandMenu.hidden = true;
    if (!menu) return;
    const groups = connections.flatMap((connection) => {
      const models = Array.isArray(connection.models) ? connection.models.map(String) : [];
      return models.length
        ? [`<div class="wb-menu-heading">${escapeHtml(connection.label ?? connection.id ?? 'Model')}</div>${models
            .map(
              (model) =>
                `<button type="button" class="wb-pop-item${model === config.model ? ' selected' : ''}" data-kernel-model="${escapeHtml(model)}" data-kernel-connection="${escapeHtml(connection.id ?? '')}"><span class="wb-pop-copy"><span class="wb-pop-title">${escapeHtml(model)}</span></span>${model === config.model ? icons.check : ''}</button>`
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
    const stored = await chrome.storage.local.get(CONFIG_KEY);
    const config = (stored[CONFIG_KEY] ?? {}) as Record<string, unknown>;
    await chrome.storage.local.set({
      [CONFIG_KEY]: { ...config, connection, model },
    });
    pageConfig.connection = connection;
    pageConfig.model = model;
    modelLabel = model;
    await client.reloadRuntime();
    render();
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
    if (projection) await client.unsubscribe(sessionId).catch(() => undefined);
    sessionId = nextSessionId;
    approvals = [];
    handoffs = [];
    error = '';
    projection = await client.projection(sessionId);
    await client.subscribe(sessionId);
    busy =
      projection.taskStatus === 'running' ||
      projection.taskStatus === 'queued' ||
      projection.taskStatus === 'waiting';
    busyStartedAt = busy ? Date.now() : 0;
    render();
  }

  function showError(cause: unknown): void {
    error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
    busy = false;
    busyStartedAt = 0;
    render();
  }

  try {
    const sessions = await client.listSessions();
    if (sessions[0]) sessionId = sessions[0].sessionId;
    projection = await client.projection(sessionId);
    await client.subscribe(sessionId);
    busy = projection.taskStatus === 'running' || projection.taskStatus === 'queued';
    busyStartedAt = busy ? Date.now() : 0;
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

function rowHtml(row: ProductProjection['rows'][number], language = 'en'): string {
  const zh = language.startsWith('zh');
  if (row.kind === 'user') {
    return `<div class="wb-stream-row kernel-message-row kernel-message-row--user">
      <div class="wb-msg wb-msg-user"><div class="wb-user-bubble">${escapeHtml(row.text)}</div></div>
    </div>`;
  }
  if (row.kind === 'assistant') {
    if (!row.text && row.status !== 'streaming') return '';
    const body =
      row.status === 'streaming' && !row.text
        ? '<span class="wb-thinking"><i></i><i></i><i></i></span>'
        : `${md(row.text)}${row.status === 'streaming' ? '<span class="wb-cursor"></span>' : ''}`;
    const feedback = !row.status || row.status === 'completed'
      ? `<div class="wb-feedback">
          <button type="button" class="wb-mini-action" data-copy-message="${escapeHtml(row.id)}">${icons.file}${zh ? '复制' : 'Copy'}</button>
          <button type="button" class="wb-mini-action" data-export-message="${escapeHtml(row.id)}">${zh ? '导出' : 'Export'}</button>
        </div>`
      : '';
    return `<div class="wb-stream-row kernel-message-row">
      <div class="wb-msg"><div class="wb-assistant"><div class="wb-assistant-body">${body}</div>${feedback}</div></div>
    </div>`;
  }
  if (row.kind === 'tool') {
    const running = row.status === 'pending' || row.status === 'streaming';
    const failed = row.status === 'failed' || row.status === 'denied';
    const statusLabel =
      row.status === 'denied'
        ? (zh ? '已拒绝' : 'Denied')
        : failed
          ? (zh ? '失败' : 'Failed')
          : running
            ? (zh ? '执行中' : 'Running')
            : '';
    return `<div class="wb-stream-row">
      <details class="wb-step kernel-tool-step" data-call-id="${escapeHtml(row.callId ?? row.id)}"${failed ? ' open' : ''}>
        <summary class="wb-step-row">
          <span class="wb-step-ico" aria-hidden="true">${icons.globe}</span>
          <span class="wb-step-text">
            <span class="wb-step-name">${escapeHtml(toolLabel(row.toolName ?? 'tool'))}</span>
            ${statusLabel ? `<span class="wb-tool-status${running ? ' wb-tool-status--running' : failed ? ' wb-tool-status--error' : ''}">${statusLabel}</span>` : ''}
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
  if (row.kind === 'activity') {
    const running = row.status === 'streaming' || row.status === 'pending';
    if (!running && row.text === 'Thinking complete') return '';
    return `<div class="kernel-activity${running ? ' is-running' : ''}">
      <span class="kernel-activity-mark" aria-hidden="true"></span>
      <span>${escapeHtml(running ? (zh ? '思考中' : 'Thinking') : row.text)}</span>
    </div>`;
  }
  if (row.kind === 'plan') {
    return `<details class="kernel-plan-inline"><summary>${zh ? '计划' : 'Plan'} · ${escapeHtml(row.status)}</summary><div>${md(row.text)}</div></details>`;
  }
  return '';
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    list_tabs: 'List tabs',
    list_frames: 'Inspect frames',
    snapshot: 'Read page structure',
    read_page: 'Read page',
    find: 'Find element',
    navigate: 'Open page',
    click: 'Click',
    mouse_click: 'Click',
    fill: 'Fill input',
    select_option: 'Select option',
    wait: 'Wait',
    screenshot: 'Screenshot',
    spawn_agent: 'Start subagent',
    send_message: 'Message subagent',
    wait_agent: 'Wait for subagent',
    stop_agent: 'Stop subagent',
    list_agents: 'List subagents',
    run_tests: 'Run tests',
    read_file: 'Read file',
    write_file: 'Write file',
    list_files: 'List files',
    exec: 'Run command',
  };
  return labels[name] ?? name.replace(/_/g, ' ');
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
            <button type="submit" id="kernel-send" class="wb-send" aria-label="Send">${icons.send}</button>
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
