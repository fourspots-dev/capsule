"use strict";
(() => {
  // src/sidepanel/html.ts
  function escapeHtml(value) {
    return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function md(source) {
    const codeBlocks = [];
    const escaped = escapeHtml(source).replace(
      /```([\w+-]*)\n([\s\S]*?)```/g,
      (_match, language, code) => {
        const index = codeBlocks.length;
        codeBlocks.push(
          `<div class="wb-rt-codewrap"><pre class="wb-rt-pre"><code class="language-${escapeHtml(language)}">${code.replace(/\n$/, "")}</code></pre><button type="button" class="wb-rt-copy" data-action="copy-code">Copy</button></div>`
        );
        return `\0CODE${index}\0`;
      }
    );
    let html = renderBlocks(escaped.split("\n")).join("");
    for (const [index, block] of codeBlocks.entries()) {
      html = html.replace(`\0CODE${index}\0`, block);
    }
    return html;
  }
  function inline(source) {
    return source.replace(/`([^`]+)`/g, '<code class="wb-rt-code">$1</code>').replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(
      /\[([^\]]+)\]\(((?:https?:|#|\/)[^)\s]+)\)/g,
      '<a class="wb-rt-a" href="$2" target="_blank" rel="noreferrer">$1</a>'
    );
  }
  function renderBlocks(lines) {
    const output = [];
    let index = 0;
    while (index < lines.length) {
      const line = lines[index];
      if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
        output.push(line.trim());
        index += 1;
        continue;
      }
      if (!line.trim()) {
        index += 1;
        continue;
      }
      const heading = line.match(/^(#{1,3})\s+/);
      if (heading) {
        const level = heading[1].length;
        output.push(
          `<h${level + 1} class="wb-rt-h${level}">${inline(line.replace(/^#{1,3}\s+/, ""))}</h${level + 1}>`
        );
        index += 1;
        continue;
      }
      if (/^\s*[-*]\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
          items.push(`<li>${inline(lines[index].replace(/^\s*[-*]\s+/, ""))}</li>`);
          index += 1;
        }
        output.push(`<ul class="wb-rt-ul">${items.join("")}</ul>`);
        continue;
      }
      if (/^\s*\d+\.\s+/.test(line)) {
        const items = [];
        while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
          items.push(`<li>${inline(lines[index].replace(/^\s*\d+\.\s+/, ""))}</li>`);
          index += 1;
        }
        output.push(`<ol class="wb-rt-ol">${items.join("")}</ol>`);
        continue;
      }
      if (line.trim().startsWith("|")) {
        const rows = [];
        while (index < lines.length && lines[index].trim().startsWith("|")) {
          rows.push(lines[index]);
          index += 1;
        }
        output.push(table(rows) ?? `<p class="wb-rt-p">${inline(rows.join(" "))}</p>`);
        continue;
      }
      if (line.trim().startsWith("&gt;")) {
        output.push(
          `<blockquote class="wb-rt-blockquote">${inline(line.replace(/^\s*&gt;\s?/, ""))}</blockquote>`
        );
        index += 1;
        continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !/^#{1,3}\s+/.test(lines[index]) && !/^\s*[-*]\s+/.test(lines[index]) && !/^\s*\d+\.\s+/.test(lines[index]) && !lines[index].trim().startsWith("|") && !/^\u0000CODE\d+\u0000$/.test(lines[index].trim())) {
        paragraph.push(lines[index]);
        index += 1;
      }
      output.push(`<p class="wb-rt-p">${paragraph.map(inline).join("<br>")}</p>`);
    }
    return output;
  }
  function table(rows) {
    if (rows.length < 2 || !/^\s*\|?[\s:|-]+\|?\s*$/.test(rows[1])) return null;
    const cells = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((cell) => cell.trim());
    const head = cells(rows[0]);
    const body = rows.slice(2).map(cells);
    return '<div class="wb-rt-tablewrap"><table class="wb-rt-table"><thead><tr>' + head.map((cell) => `<th class="wb-rt-th">${inline(cell)}</th>`).join("") + "</tr></thead><tbody>" + body.map((row) => `<tr>${row.map((cell) => `<td class="wb-rt-td">${inline(cell)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>";
  }

  // src/host/profile-matrix.ts
  var portableProfile = (id, label, options = {}) => ({
    id,
    label,
    requiredTiers: ["core", "workspace", "portable-coding"],
    requiredHostCapabilities: options.requiredHostCapabilities ?? [],
    optionalHostCapabilities: options.optionalHostCapabilities ?? [
      "actions",
      "interactiveActions",
      "network",
      "terminal",
      "process",
      "pty"
    ],
    forbiddenActionPrefixes: [
      "host.storage",
      "host.filesystem",
      "host.clock",
      "host.scheduler",
      "host.crypto",
      "host.session"
    ]
  });
  var HOST_BASELINE_PROFILES = Object.freeze({
    "tui-local": portableProfile("tui-local", "Local TUI"),
    chrome: portableProfile("chrome", "Chrome extension"),
    ios: portableProfile("ios", "iOS native host"),
    sandbox: portableProfile("sandbox", "Restricted sandbox"),
    memory: portableProfile("memory", "Memory/test host")
  });

  // src/git/binary.ts
  var encoder = new TextEncoder();

  // src/git/objects.ts
  var encoder2 = new TextEncoder();

  // src/platform/workspace-edit-prompt.ts
  var workspaceEditPrompt = [
    "When editing workspace files, use apply_patch with *** Begin Patch / *** End Patch for multi-line or multi-file changes.",
    "Every Update hunk starts with @@ or @@ anchor text; context lines start with a space, removals with -, additions with +.",
    "Do not calculate unified-diff line counts or send ---/+++ headers to apply_patch.",
    "Use apply_unified_diff only when explicitly handling a strict Git unified diff.",
    "After PATCH_CONTEXT_NOT_FOUND, PATCH_CONTEXT_AMBIGUOUS, PATCH_STALE_FILE or TOOL_RETRY_BLOCKED, re-read the target before retrying."
  ].join("\n");

  // src/adapters/chrome-prompts.ts
  var baseSystemPrompt = [
    "You are tinyai, an AI agent operating the user's real Chrome browser.",
    "",
    "Work by observing, not guessing:",
    "- Ground answers in what you actually read from a tab, never in assumptions about a page you have not inspected.",
    "- When you can find something out yourself (the page content, which tabs are open, a value on a page), use your tools instead of asking the user.",
    "",
    "Act through tool calls, never through narration:",
    "- If you intend to do something, emit the tool call in the same turn. A reply that only describes an action performs nothing.",
    "- Never claim that work is running, queued, or done unless you actually made the tool call and saw its result.",
    "",
    "Reading and acting:",
    "- To read content or locate elements, use read_page / snapshot / find \u2014 not screenshots.",
    "- To act on an element, target it by an @ref from snapshot/find, or a CSS selector.",
    "- Screenshot only when the task genuinely needs visual appearance.",
    "",
    "Editing workspace files:",
    workspaceEditPrompt,
    "",
    "When tabs are grouped as the current workspace, use list_tabs / switch_tab only within that group. Never operate on tabs outside the active workspace.",
    "Keep answers concise and in the user's language."
  ].join("\n");

  // src/core/projection.ts
  function applyProjectionDelta(current, delta) {
    const next = {
      ...current,
      rows: current.rows.map(cloneRow)
    };
    if (delta.type === "row.appended") next.rows.push(cloneRow(delta.row));
    if (delta.type === "row.upserted") {
      const index = next.rows.findIndex((row) => row.id === delta.row.id);
      if (index >= 0) next.rows[index] = cloneRow(delta.row);
      else next.rows.push(cloneRow(delta.row));
    }
    if (delta.type === "row.removed") {
      next.rows = next.rows.filter((row) => row.id !== delta.fromRowId);
    }
    if (delta.type === "row.delta") {
      const row = next.rows.find((candidate) => candidate.id === delta.rowId);
      if (!row) throw new Error(`Cannot apply row delta: ${delta.rowId}`);
      if (delta.path === "text") row.text += delta.append;
    }
    if (delta.type === "state.updated") Object.assign(next, delta.patch);
    return next;
  }
  function createProjectionFrame(previous, next) {
    if (!previous || previous.sessionId !== next.sessionId || previous.logEpoch !== next.logEpoch || next.revision <= previous.revision) {
      return { type: "snapshot", projection: cloneProjection(next) };
    }
    const deltas = [];
    const statePatch = {};
    for (const key of [
      "phase",
      "lifecycle",
      "taskStatus",
      "inputRouting",
      "queueLength",
      "activeTaskId",
      "lastError",
      "permissionMode",
      "plan",
      "children",
      "availability"
    ]) {
      if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
        statePatch[key] = next[key];
      }
    }
    if (Object.keys(statePatch).length) {
      deltas.push({ type: "state.updated", patch: statePatch });
    }
    const previousRows = new Map(previous.rows.map((row) => [row.id, row]));
    const nextRows = new Map(next.rows.map((row) => [row.id, row]));
    for (const row of previous.rows) {
      if (!nextRows.has(row.id)) deltas.push({ type: "row.removed", fromRowId: row.id });
    }
    for (const row of next.rows) {
      const old = previousRows.get(row.id);
      if (!old) {
        deltas.push({ type: "row.appended", row: cloneRow(row) });
        continue;
      }
      if (old.kind === row.kind && old.entityId === row.entityId && old.productTurnId === row.productTurnId && old.status === row.status && old.callId === row.callId && old.toolName === row.toolName && row.text.startsWith(old.text)) {
        if (row.text !== old.text) {
          deltas.push({
            type: "row.delta",
            rowId: row.id,
            path: "text",
            append: row.text.slice(old.text.length)
          });
        }
      } else if (JSON.stringify(old) !== JSON.stringify(row)) {
        deltas.push({ type: "row.upserted", row: cloneRow(row) });
      }
    }
    return {
      type: "delta",
      sessionId: next.sessionId,
      logEpoch: next.logEpoch,
      baseRevision: previous.revision,
      revision: next.revision,
      eventSeq: next.eventSeq,
      deltas
    };
  }
  function applyProjectionFrame(current, frame) {
    if (frame.type === "snapshot") return cloneProjection(frame.projection);
    if (!current) {
      throw new Error("Cannot apply a projection delta without a snapshot");
    }
    if (current.sessionId !== frame.sessionId || current.logEpoch !== frame.logEpoch || current.revision !== frame.baseRevision) {
      throw new Error(
        `Projection frame gap: expected ${current.revision}, received ${frame.baseRevision}`
      );
    }
    let next = cloneProjection(current);
    for (const delta of frame.deltas) next = applyProjectionDelta(next, delta);
    next.revision = frame.revision;
    next.eventSeq = frame.eventSeq;
    return next;
  }
  var ProjectionStore = class {
    current;
    previous;
    apply(frame) {
      this.previous = this.current;
      this.current = applyProjectionFrame(this.current, frame);
      return cloneProjection(this.current);
    }
    snapshot() {
      return this.current ? cloneProjection(this.current) : void 0;
    }
    frame(next) {
      return createProjectionFrame(this.previous ?? this.current, next);
    }
  };
  function cloneProjection(projection) {
    return {
      ...projection,
      ...projection.lastError ? { lastError: { ...projection.lastError } } : {},
      availability: { ...projection.availability },
      ...projection.children ? { children: projection.children.map((child) => ({ ...child })) } : {},
      rows: projection.rows.map(cloneRow)
    };
  }
  function cloneRow(row) {
    return {
      ...row,
      ...row.toolMetadata ? { toolMetadata: structuredClone(row.toolMetadata) } : {}
    };
  }

  // src/runtime/storage-migration.ts
  var CONFIG_KEY = "tinyai:v2:config";

  // src/workspace/codec.ts
  var encoder3 = new TextEncoder();

  // src/workspace/capsule-v2.ts
  var CAPSULE_V2_MAGIC = new TextEncoder().encode("TNYCAP2\n");
  var DEFAULT_CHUNK_BYTES = 256 * 1024;

  // src/runtime/chrome-runtime.ts
  var KERNEL_PORT_NAME = "tinyai-runtime-v1";

  // src/sidepanel/kernel-client.ts
  var KernelClient = class {
    constructor(connectPort, options = {}) {
      this.connectPort = connectPort;
      this.options = options;
    }
    connectPort;
    options;
    port;
    sequence = 0;
    pending = /* @__PURE__ */ new Map();
    projectionListeners = /* @__PURE__ */ new Set();
    approvalListeners = /* @__PURE__ */ new Set();
    handoffListeners = /* @__PURE__ */ new Set();
    disconnectListeners = /* @__PURE__ */ new Set();
    resyncing = /* @__PURE__ */ new Set();
    expectedSubscriptions = /* @__PURE__ */ new Map();
    async command(command) {
      return await this.request({ type: "command", command });
    }
    async subscribe(sessionId) {
      const subscriptionId = `subscription_${++this.sequence}`;
      this.expectedSubscriptions.set(sessionId, subscriptionId);
      try {
        await this.request({ type: "subscribe", sessionId, subscriptionId });
      } catch (error) {
        if (this.expectedSubscriptions.get(sessionId) === subscriptionId) {
          this.expectedSubscriptions.delete(sessionId);
        }
        throw error;
      }
    }
    async unsubscribe(sessionId) {
      this.expectedSubscriptions.delete(sessionId);
      await this.request({ type: "unsubscribe", sessionId });
    }
    async projection(sessionId) {
      return await this.request({ type: "get_projection", sessionId });
    }
    async stopSession(sessionId) {
      await this.request({ type: "stop_session", sessionId });
    }
    async listSessions() {
      return await this.request({ type: "list_sessions" });
    }
    async deleteSession(sessionId) {
      await this.request({ type: "delete_session", sessionId });
    }
    async renameSession(sessionId, title) {
      await this.request({ type: "rename_session", sessionId, title });
    }
    async clearHistory() {
      return await this.request({ type: "clear_history" });
    }
    async restartSession(sessionId) {
      await this.request({ type: "restart_session", sessionId });
    }
    async listSkills() {
      return await this.request({ type: "list_skills" });
    }
    async reloadRuntime() {
      await this.request({ type: "reload_runtime" });
    }
    async readArtifact(artifactId) {
      return await this.request({
        type: "read_artifact",
        artifactId
      });
    }
    async listTabs() {
      return await this.request({ type: "list_tabs" });
    }
    async selectTab(sessionId, tabId) {
      await this.request({ type: "select_tab", sessionId, tabId });
    }
    async resolveTabSession(windowId, tabId, groupId) {
      return await this.request({
        type: "resolve_tab_session",
        windowId,
        tabId,
        ...groupId !== void 0 ? { groupId } : {}
      });
    }
    async createTabSession(windowId, tabId, groupId) {
      return await this.request({
        type: "create_tab_session",
        windowId,
        tabId,
        ...groupId !== void 0 ? { groupId } : {}
      });
    }
    async bindTabSession(windowId, tabId, sessionId, groupId) {
      return await this.request({
        type: "bind_tab_session",
        windowId,
        tabId,
        sessionId,
        ...groupId !== void 0 ? { groupId } : {}
      });
    }
    async forgetTabSession(windowId, tabId, groupId) {
      await this.request({
        type: "forget_tab_session",
        windowId,
        tabId,
        ...groupId !== void 0 ? { groupId } : {}
      });
    }
    async respondApproval(approvalId, approved) {
      await this.request({ type: "approval_response", approvalId, approved });
    }
    async respondHandoff(handoffId, decision) {
      await this.request({ type: "handoff_response", handoffId, decision });
    }
    onProjection(listener) {
      this.projectionListeners.add(listener);
      return () => this.projectionListeners.delete(listener);
    }
    onApproval(listener) {
      this.approvalListeners.add(listener);
      return () => this.approvalListeners.delete(listener);
    }
    onHandoff(listener) {
      this.handoffListeners.add(listener);
      return () => this.handoffListeners.delete(listener);
    }
    onDisconnect(listener) {
      this.disconnectListeners.add(listener);
      return () => this.disconnectListeners.delete(listener);
    }
    disconnect() {
      this.clearConnection(new Error("Kernel client disconnected"));
    }
    async request(request) {
      const port = this.ensurePort();
      const requestId = request.requestId ?? `client_${++this.sequence}`;
      const message = { ...request, requestId };
      return new Promise((resolve, reject) => {
        const timeoutMs = this.options.requestTimeoutMs ?? 3e4;
        const timer = setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error(`Kernel request timed out: ${request.type}`));
        }, timeoutMs);
        this.pending.set(requestId, { resolve, reject, timer });
        port.postMessage(message);
      });
    }
    ensurePort() {
      if (this.port) return this.port;
      const port = this.connectPort();
      this.port = port;
      port.onMessage.addListener((message) => this.onMessage(message));
      port.onDisconnect.addListener(
        () => this.clearConnection(new Error("Kernel runtime disconnected"))
      );
      return port;
    }
    onMessage(message) {
      if (message.type === "response") {
        const pending = this.pending.get(message.requestId);
        if (!pending) return;
        this.pending.delete(message.requestId);
        if (pending.timer) clearTimeout(pending.timer);
        if (message.ok) pending.resolve(message.data);
        else {
          const error = new Error(message.error.message);
          error.name = message.error.code;
          pending.reject(error);
        }
        return;
      }
      if (message.type === "projection") {
        const expected = this.expectedSubscriptions.get(message.sessionId);
        if (expected && message.subscriptionId && message.subscriptionId !== expected) {
          return;
        }
        const frameSessionId = message.frame.type === "snapshot" ? message.frame.projection.sessionId : message.frame.sessionId;
        const frameEpoch = message.frame.type === "snapshot" ? message.frame.projection.logEpoch : message.frame.logEpoch;
        if (frameSessionId !== message.sessionId || frameEpoch !== message.logEpoch) {
          return;
        }
        const projection = this.applyFrame(message.frame);
        if (projection) {
          for (const listener of this.projectionListeners) {
            listener(projection.sessionId, projection);
          }
        }
        return;
      }
      if (message.type === "approval_request") {
        const { type: _type, ...event } = message;
        for (const listener of this.approvalListeners) listener(event);
        return;
      }
      if (message.type === "handoff_request") {
        const { type: _type, ...event } = message;
        for (const listener of this.handoffListeners) listener(event);
      }
    }
    stores = /* @__PURE__ */ new Map();
    applyFrame(frame) {
      if (frame.type === "snapshot") {
        const store2 = new ProjectionStore();
        const projection = store2.apply(frame);
        this.stores.set(projection.sessionId, store2);
        return projection;
      }
      const store = this.stores.get(frame.sessionId);
      if (!store) {
        this.clearConnection(new Error("Projection delta arrived without a snapshot"));
        return void 0;
      }
      const current = store.snapshot();
      if (current && frame.revision <= current.revision) return current;
      try {
        return store.apply(frame);
      } catch (error) {
        void this.resync(frame.sessionId);
        return void 0;
      }
    }
    async resync(sessionId) {
      if (this.resyncing.has(sessionId)) return;
      this.resyncing.add(sessionId);
      try {
        const projection = await this.projection(sessionId);
        const store = new ProjectionStore();
        const applied = store.apply({ type: "snapshot", projection });
        this.stores.set(sessionId, store);
        for (const listener of this.projectionListeners) listener(sessionId, applied);
      } finally {
        this.resyncing.delete(sessionId);
      }
    }
    clearConnection(error) {
      this.port = void 0;
      this.stores.clear();
      this.resyncing.clear();
      this.expectedSubscriptions.clear();
      for (const pending of this.pending.values()) {
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      for (const listener of this.disconnectListeners) listener();
    }
  };
  function connectChromeKernelPort(api, name = "tinyai-runtime-v1") {
    const port = api.runtime.connect({ name });
    const messageWrappers = /* @__PURE__ */ new Map();
    const disconnectWrappers = /* @__PURE__ */ new Map();
    return {
      postMessage: (message) => port.postMessage(message),
      onMessage: {
        addListener: (listener) => {
          const wrapped = (message) => listener(message);
          messageWrappers.set(listener, wrapped);
          port.onMessage.addListener(wrapped);
        },
        removeListener: (listener) => {
          const wrapped = messageWrappers.get(listener);
          if (!wrapped) return;
          port.onMessage.removeListener(wrapped);
          messageWrappers.delete(listener);
        }
      },
      onDisconnect: {
        addListener: (listener) => {
          const wrapped = () => listener();
          disconnectWrappers.set(listener, wrapped);
          port.onDisconnect.addListener(wrapped);
        },
        removeListener: (listener) => {
          const wrapped = disconnectWrappers.get(listener);
          if (!wrapped) return;
          port.onDisconnect.removeListener(wrapped);
          disconnectWrappers.delete(listener);
        }
      }
    };
  }

  // src/sidepanel/icons.ts
  var icons = {
    plus: "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true'><path d='M10 4v12M4 10h12' stroke='currentColor' stroke-width='1.6' stroke-linecap='round'/></svg>",
    clock: "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true'><circle cx='12' cy='12' r='9' stroke='currentColor' stroke-width='1.7'/><path d='M12 7.2v5.1l3.2 2' stroke='currentColor' stroke-width='1.7' stroke-linecap='round'/></svg>",
    gear: '<svg viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="h-5 w-5"><circle cx="12" cy="12" r="3.2" stroke="currentColor" stroke-width="1.7"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1.1-1.55 1.7 1.7 0 0 0-1.88.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1.1 1.7 1.7 0 0 0-.34-1.88l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.01a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.01a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
    send: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-arrow-up h-3.5 w-3.5"><path d="m5 12 7-7 7 7"></path><path d="M12 19V5"></path></svg>',
    stop: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="currentColor" class="h-3.5 w-3.5"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>',
    chevron: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-down h-3.5 w-3.5"><path d="m6 9 6 6 6-6"></path></svg>',
    chevronRight: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-chevron-right h-4 w-4"><path d="m9 18 6-6-6-6"></path></svg>',
    chevronDown: "<svg viewBox='0 0 18 18' fill='none' aria-hidden='true' class='wb-set-select-chevron'><path fill-rule='evenodd' clip-rule='evenodd' d='M8.54 12.54a.7.7 0 0 0 .96 0l5.23-5.24a.7.7 0 1 0-.96-.96L9.02 11.1 4.23 6.35a.7.7 0 0 0-.96.96z' fill='currentColor'/></svg>",
    back: "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true'><path d='M12.5 4.5 7 10l5.5 5.5' stroke='currentColor' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'/></svg>",
    check: "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true' class='wb-pop-check'><path d='M19.3 5.9a1 1 0 0 1 0 1.4L9.7 16.9a1 1 0 0 1-1.4 0l-4.3-4.3a1 1 0 1 1 1.4-1.4l3.6 3.6 8.9-8.9a1 1 0 0 1 1.4 0Z' fill='currentColor'/></svg>",
    safe: "<svg viewBox='0 0 18 18' fill='none' aria-hidden='true'><path d='M9 1.8 15 4v5.3c0 3.2-2.2 5.8-6 7-3.8-1.2-6-3.8-6-7V4l6-2.2Z' stroke='currentColor' stroke-width='1.35' stroke-linejoin='round'/><path d='m6.2 9 1.8 1.8 3.9-4' stroke='currentColor' stroke-width='1.35' stroke-linecap='round' stroke-linejoin='round'/></svg>",
    globe: "<svg viewBox='0 0 24 24' fill='none' aria-hidden='true'><circle cx='12' cy='12' r='10' stroke='currentColor' stroke-width='2'/><path d='M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20' stroke='currentColor' stroke-width='2'/></svg>",
    file: "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true' class='wb-prompt-chip-icon'><path d='M6 2.75h5l4 4v10.5H6z' stroke='currentColor' stroke-width='1.4' stroke-linejoin='round'/><path d='M11 2.75v4.5h4.5' stroke='currentColor' stroke-width='1.4' stroke-linejoin='round'/></svg>",
    paper: "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true' class='wb-prompt-chip-icon'><path d='M15.5 9.5 9 16a3.3 3.3 0 0 1-4.7-4.7l7-7a2.2 2.2 0 0 1 3.1 3.1l-7 7a1.1 1.1 0 0 1-1.6-1.6l6.4-6.4' stroke='currentColor' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/></svg>",
    list: "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true' class='wb-prompt-chip-icon'><path d='M7 5.5h8M7 10h8M7 14.5h8' stroke='currentColor' stroke-width='1.4' stroke-linecap='round'/><path d='M4 5.5h.01M4 10h.01M4 14.5h.01' stroke='currentColor' stroke-width='2' stroke-linecap='round'/></svg>",
    sparkle: "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true'><path d='m10 2.8 1.7 5.5L17.2 10l-5.5 1.7L10 17.2l-1.7-5.5L2.8 10l5.5-1.7z' stroke='currentColor' stroke-width='1.5' stroke-linejoin='round'/></svg>",
    link: "<svg viewBox='0 0 20 20' fill='none' aria-hidden='true'><path d='M8.2 11.8 11.8 8.2M6.5 14.5l-1 1a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0M13.5 5.5l1-1a2.8 2.8 0 0 1 4 4l-3 3a2.8 2.8 0 0 1-4 0' stroke='currentColor' stroke-width='1.5' stroke-linecap='round'/></svg>",
    sun: "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round'><circle cx='10' cy='10' r='3.2'/><path d='M10 2v2M10 16v2M2 10h2M16 10h2M4.3 4.3l1.4 1.4M14.3 14.3l1.4 1.4M15.7 4.3l-1.4 1.4M5.7 14.3l-1.4 1.4'/></svg>",
    zoom: "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round'><circle cx='8.5' cy='8.5' r='4.8'/><path d='M12.2 12.2 17 17M6.5 8.5h4M8.5 6.5v4'/></svg>",
    shield: "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M10 2.5 16 5v4.6c0 3.5-2.4 6-6 7.9-3.6-1.9-6-4.4-6-7.9V5z'/><path d='m7.3 9.8 1.8 1.8 3.6-3.8'/></svg>",
    info: "<svg viewBox='0 0 20 20' fill='none' stroke='currentColor' stroke-width='1.5' stroke-linecap='round'><circle cx='10' cy='10' r='7'/><path d='M10 9v4M10 6.5v.1'/></svg>"
  };

  // src/sidepanel/turn-render-model.ts
  var EXPLORE_TOOLS = /* @__PURE__ */ new Set([
    "list_tabs",
    "list_frames",
    "snapshot",
    "read_page",
    "find",
    "wait",
    "scroll",
    "list_files",
    "read_file"
  ]);
  var TERMINAL_TOOLS = /* @__PURE__ */ new Set(["exec", "run_tests"]);
  var CHANGE_TOOLS = /* @__PURE__ */ new Set([
    "write_file",
    "apply_patch",
    "apply_unified_diff",
    "edit"
  ]);
  var SUBAGENT_TOOLS = /* @__PURE__ */ new Set([
    "spawn_agent",
    "send_message",
    "wait_agent",
    "stop_agent",
    "list_agents"
  ]);
  function buildTurnRenderUnits(projection) {
    const grouped = /* @__PURE__ */ new Map();
    for (const row of projection.rows) {
      const turnId = row.productTurnId || "unassigned";
      const rows = grouped.get(turnId) ?? [];
      rows.push(row);
      grouped.set(turnId, rows);
    }
    return [...grouped.entries()].map(([productTurnId, rows]) => {
      const children = (projection.children ?? []).filter(
        (child) => child.parentTaskId === productTurnId
      );
      return {
        key: productTurnId,
        productTurnId,
        rows,
        children,
        segments: splitSegments(
          productTurnId,
          rows,
          children,
          projection.taskStatus,
          projection
        )
      };
    });
  }
  function splitSegments(productTurnId, rows, children, taskStatus, projection) {
    const starts = rows.map((row, index) => row.kind === "user" ? index : -1).filter((index) => index >= 0);
    if (starts.length === 0) {
      return [
        buildSegment(
          productTurnId,
          `${productTurnId}:0`,
          void 0,
          rows,
          children,
          taskStatus,
          projection
        )
      ];
    }
    return starts.map((start, index) => {
      const end = starts[index + 1] ?? rows.length;
      return buildSegment(
        productTurnId,
        `${productTurnId}:${index}`,
        rows[start],
        rows.slice(start + 1, end),
        index === starts.length - 1 ? children : [],
        taskStatus,
        projection
      );
    });
  }
  function buildSegment(productTurnId, key, user, rows, children, taskStatus, projection) {
    const latestAssistantIndex = findLatestAssistantIndex(rows);
    const historyRows = latestAssistantIndex >= 0 ? rows.slice(0, latestAssistantIndex) : rows;
    const latestAssistant = latestAssistantIndex >= 0 ? rows[latestAssistantIndex] : void 0;
    const tailRows = latestAssistantIndex >= 0 ? rows.slice(latestAssistantIndex + 1) : [];
    const activeProductTurn = !projection.activeTaskId || projection.activeTaskId === productTurnId;
    const running = activeProductTurn && (projection.taskStatus === "running" || projection.taskStatus === "queued" || projection.taskStatus === "waiting");
    const state = taskStatus === "completed" ? "completed" : taskStatus === "failed" ? "failed" : taskStatus === "cancelled" ? "cancelled" : running ? "running" : "idle";
    const durationMs = durationOf(rows);
    const defaultOpen = running || state === "failed" || state === "cancelled" || !latestAssistant || children.some((child) => child.status === "running");
    return {
      key,
      user,
      historyRows,
      latestAssistant,
      tailRows,
      children,
      workItems: buildWorkItems(historyRows, children),
      running,
      state,
      durationMs,
      defaultOpen
    };
  }
  function findLatestAssistantIndex(rows) {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.kind !== "assistant" || !row.text.trim()) continue;
      const followedByWork = rows.slice(index + 1).some((candidate) => candidate.kind === "tool" || candidate.kind === "reasoning");
      return followedByWork ? -1 : index;
    }
    return -1;
  }
  function durationOf(rows) {
    const durations = rows.flatMap(
      (row) => row.kind === "activity" && typeof row.startedAt === "number" && typeof row.completedAt === "number" ? [Math.max(0, row.completedAt - row.startedAt)] : []
    );
    return durations.length ? durations.reduce((total, duration) => total + duration, 0) : void 0;
  }
  function buildWorkItems(rows, children) {
    const items = [];
    let pendingGroup;
    const flushGroup = () => {
      if (!pendingGroup) return;
      if (pendingGroup.rows.length >= 2) {
        items.push({
          kind: "tool-group",
          key: pendingGroup.key,
          group: pendingGroup
        });
      } else {
        const row = pendingGroup.rows[0];
        items.push({ kind: "tool", key: row.id, row });
      }
      pendingGroup = void 0;
    };
    for (const row of rows) {
      if (row.kind === "tool") {
        const family = toolFamily(row.toolName ?? "");
        if (family !== "other") {
          if (pendingGroup?.family === family) {
            pendingGroup.rows.push(row);
          } else {
            flushGroup();
            pendingGroup = {
              key: `group:${row.id}`,
              family,
              rows: [row]
            };
          }
          continue;
        }
      }
      flushGroup();
      if (row.kind === "activity" && (row.text === "Thinking" || row.text === "Thinking complete")) {
        continue;
      }
      if (row.kind === "assistant" && row.status === "streaming" && !row.text.trim()) continue;
      items.push({
        kind: row.kind === "reasoning" ? "reasoning" : row.kind === "assistant" ? "assistant" : row.kind === "plan" ? "plan" : row.kind === "activity" ? "activity" : "tool",
        key: row.id,
        row
      });
    }
    flushGroup();
    for (const child of children) {
      items.push({ kind: "child", key: `child:${child.taskId}`, child });
    }
    return items;
  }
  function toolFamily(name) {
    if (EXPLORE_TOOLS.has(name)) return "explore";
    if (TERMINAL_TOOLS.has(name)) return "terminal";
    if (CHANGE_TOOLS.has(name)) return "changes";
    if (SUBAGENT_TOOLS.has(name)) return "subagent";
    if (name === "screenshot" || name.includes("artifact")) return "artifact";
    if (["navigate", "click", "mouse_click", "fill", "select_option", "type_text", "send_keys"].includes(
      name
    )) {
      return "browser";
    }
    return "other";
  }
  function workStateLabel(segment, language) {
    const zh = language.startsWith("zh");
    if (segment.state === "running") return zh ? "\u5DE5\u4F5C\u4E2D" : "Working";
    if (segment.state === "failed") return zh ? "\u5931\u8D25" : "Failed";
    if (segment.state === "cancelled") return zh ? "\u5DF2\u505C\u6B62" : "Stopped";
    if (segment.durationMs !== void 0) {
      const seconds = Math.max(1, Math.round(segment.durationMs / 1e3));
      return zh ? `\u5DF2\u5DE5\u4F5C ${seconds} \u79D2` : `Worked for ${seconds}s`;
    }
    return zh ? "\u5DF2\u5DE5\u4F5C" : "Worked";
  }

  // src/sidepanel/kernel-panel.ts
  async function initKernelUi() {
    const root = document.querySelector("#root");
    if (!root) throw new Error("Missing #root");
    let pageConfig = await readPageConfig();
    root.innerHTML = shell(pageConfig);
    applyPageAppearance();
    const client = new KernelClient(() => connectChromeKernelPort(chrome, KERNEL_PORT_NAME), {
      requestTimeoutMs: 12e4
    });
    let projection;
    let sessionId = `session_${crypto.randomUUID()}`;
    let approvals = [];
    let handoffs = [];
    const approvalsBySession = /* @__PURE__ */ new Map();
    const handoffsBySession = /* @__PURE__ */ new Map();
    const drafts = /* @__PURE__ */ new Map();
    let windowId;
    let activeTabId;
    let activeGroupId;
    let activeScope = "tab";
    let workspaceMemberTabIds = [];
    let activationGeneration = 0;
    let sessionActivated = false;
    let skills = [];
    let selectedSkill;
    let attachments = [];
    let modelLabel = pageConfig.language.startsWith("zh") ? "\u9009\u62E9\u6A21\u578B" : "Choose model";
    let pageView = null;
    let pageSessions = [];
    let editingConnectionId;
    let connectionTestMessage = "";
    let pageError = "";
    let error = "";
    let busy = false;
    let busyStartedAt = 0;
    let reconnectAttempts = 0;
    const detailState = /* @__PURE__ */ new Map();
    const activationTargetCount = () => Math.max(1, workspaceMemberTabIds.length);
    const render = () => {
      const zh = pageConfig.language.startsWith("zh");
      const rows = document.querySelector("#kernel-rows");
      const status = document.querySelector("#kernel-status");
      const send = document.querySelector("#kernel-send");
      const stop = document.querySelector("#kernel-stop");
      const modeButton = document.querySelector("#kernel-mode");
      const approvePlan = document.querySelector("#kernel-approve-plan");
      const compact = document.querySelector("#kernel-compact");
      const attachmentList = document.querySelector("#kernel-attachments");
      const workspace = document.querySelector("#kernel-workspace");
      const queue = document.querySelector("#kernel-queue");
      const modelLabelNode = document.querySelector("#kernel-model-label");
      const input = document.querySelector("#kernel-input");
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
      status.dataset.error = error ? "true" : "false";
      send.disabled = !sessionActivated || Boolean(error) || projection?.availability.canSend === false || !input.value.trim() && !attachments.length && !selectedSkill;
      stop.hidden = !projection?.availability.canStop;
      modeButton.textContent = projection?.permissionMode === "plan" ? pageConfig.language.startsWith("zh") ? "\u9000\u51FA\u8BA1\u5212\u6A21\u5F0F" : "Exit plan" : pageConfig.language.startsWith("zh") ? "\u8BA1\u5212\u6A21\u5F0F" : "Plan mode";
      approvePlan.hidden = projection?.permissionMode !== "plan" || !projection.rows.some((row) => row.kind === "assistant" && row.text.trim());
      compact.hidden = !projection || busy || projection.rows.filter((row) => row.kind !== "tool").length < 2;
      queue.hidden = !projection?.queueLength;
      queue.innerHTML = projection?.queueLength ? `<span class="kernel-queue-dot" aria-hidden="true"></span><span>${escapeHtml(
        zh ? `${projection.queueLength} \u6761\u6D88\u606F\u6392\u961F` : `${projection.queueLength} ${projection.queueLength === 1 ? "message" : "messages"} queued`
      )}</span>` : "";
      workspace.hidden = !projection;
      workspace.innerHTML = projection ? `<span class="kernel-workspace-mark" aria-hidden="true">\u2318</span><span>${escapeHtml(
        activeScope === "group" ? zh ? `\u5DE5\u4F5C\u533A \xB7 ${activationTargetCount()} \u4E2A\u6807\u7B7E` : `Workspace \xB7 ${activationTargetCount()} ${activationTargetCount() === 1 ? "tab" : "tabs"}` : zh ? "\u72EC\u7ACB\u6807\u7B7E" : "Independent tab"
      )}</span>` : "";
      attachmentList.innerHTML = [
        ...selectedSkill ? [`<span class="wb-chip"><span class="wb-chip-name">Skill: ${escapeHtml(selectedSkill.name)}</span></span>`] : [],
        ...attachments.map(
          (attachment) => `<span class="wb-chip"><span class="wb-chip-name">${escapeHtml(attachment.name)}</span><button type="button" data-remove-attachment="${escapeHtml(attachment.name)}" aria-label="Remove">\xD7</button></span>`
        )
      ].join("");
      const conversationHtml = (projection?.plan?.text ? `<section class="kernel-plan-card">
            <div class="kernel-plan-head"><span>${zh ? "\u8BA1\u5212" : "Plan"}</span><span>${projection.plan.approvedAt ? zh ? "\u5DF2\u6279\u51C6" : "Approved" : zh ? "\u8349\u7A3F" : "Draft"}</span></div>
            <div class="kernel-plan-body">${md(projection.plan.text)}</div>
          </section>` : "") + (projection ? buildTurnRenderUnits(projection).map(
        (unit) => renderTurnUnit(unit, pageConfig.language, pageConfig.showReasoning)
      ).join("") : "") + approvals.map(
        (approval) => `<article class="wb-permission-card kernel-approval" data-ui-key="approval:${escapeHtml(approval.approvalId)}">
            <div class="wb-permission-title">${zh ? "\u5141\u8BB8" : "Allow"} ${escapeHtml(toolLabel(approval.toolName))}?</div>
            <div class="kernel-permission-summary">${escapeHtml(approvalSummary(approval.toolName, approval.input, zh))}</div>
            <details class="kernel-raw-details">
              <summary>${zh ? "\u67E5\u770B\u53C2\u6570" : "Show arguments"}</summary>
              <div class="wb-permission-args">${escapeHtml(JSON.stringify(approval.input, null, 2))}</div>
            </details>
            <div class="wb-permission-actions">
              <button type="button" class="kernel-btn kernel-btn--primary" data-approval="${escapeHtml(approval.approvalId)}" data-decision="allow">${zh ? "\u5141\u8BB8" : "Allow"}</button>
              <button type="button" class="kernel-btn" data-approval="${escapeHtml(approval.approvalId)}" data-decision="deny">${zh ? "\u62D2\u7EDD" : "Deny"}</button>
            </div>
          </article>`
      ).join("") + handoffs.map(
        (handoff) => `<article class="wb-permission-card kernel-handoff">
            <div class="wb-permission-title">${zh ? "\u9700\u8981\u4F60\u624B\u52A8\u64CD\u4F5C" : "Manual action required"}</div>
            <div class="wb-handoff-reason">${escapeHtml(handoff.reason)}</div>
            <div class="wb-permission-actions">
              <button type="button" class="kernel-btn kernel-btn--primary" data-handoff="${escapeHtml(handoff.handoffId)}" data-decision="continue">${zh ? "\u7EE7\u7EED" : "Continue"}</button>
              <button type="button" class="kernel-btn" data-handoff="${escapeHtml(handoff.handoffId)}" data-decision="cancel">${zh ? "\u53D6\u6D88" : "Cancel"}</button>
            </div>
          </article>`
      ).join("");
      const scroll = document.querySelector(".wb-scroll");
      const stickToBottom = scroll ? scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 72 : true;
      rows.innerHTML = conversationHtml || emptyHtml(pageConfig.language);
      restoreDetailState(rows, detailState);
      if (scroll && stickToBottom) scroll.scrollTop = scroll.scrollHeight;
    };
    const saveCurrentDraft = () => {
      const input = document.querySelector("#kernel-input");
      const text = input?.value ?? "";
      if (text || attachments.length || selectedSkill) {
        drafts.set(sessionId, {
          text,
          attachments: attachments.map((attachment) => ({ ...attachment })),
          ...selectedSkill ? { selectedSkill: selectedSkill.name } : {}
        });
      } else {
        drafts.delete(sessionId);
      }
    };
    const restoreCurrentDraft = () => {
      const draft = drafts.get(sessionId);
      const input = document.querySelector("#kernel-input");
      if (input) input.value = draft?.text ?? "";
      attachments = (draft?.attachments ?? []).map((attachment) => ({ ...attachment }));
      selectedSkill = draft?.selectedSkill ? skills.find((skill) => skill.name === draft.selectedSkill) : void 0;
      const skillSelect2 = document.querySelector("#kernel-skill");
      if (skillSelect2) skillSelect2.value = selectedSkill?.name ?? "";
    };
    async function activateSession(load) {
      const generation = ++activationGeneration;
      sessionActivated = false;
      render();
      saveCurrentDraft();
      let activation;
      try {
        activation = await load();
      } catch (cause) {
        if (generation === activationGeneration) throw cause;
        return false;
      }
      if (generation !== activationGeneration) return false;
      const previousSession = sessionId;
      if (projection && previousSession !== activation.sessionId) {
        await client.unsubscribe(previousSession).catch(() => void 0);
      }
      sessionId = activation.sessionId;
      activeTabId = activation.activeTabId;
      activeGroupId = activation.groupId;
      activeScope = activation.scope;
      workspaceMemberTabIds = [...activation.memberTabIds];
      document.documentElement.dataset.tinyaiTabId = activeTabId;
      document.documentElement.dataset.tinyaiSessionId = sessionId;
      projection = activation.projection;
      approvals = [...approvalsBySession.get(sessionId) ?? []];
      handoffs = [...handoffsBySession.get(sessionId) ?? []];
      busy = projection.taskStatus === "running" || projection.taskStatus === "queued" || projection.taskStatus === "waiting";
      busyStartedAt = busy ? Date.now() : 0;
      error = "";
      reconnectAttempts = 0;
      await client.subscribe(sessionId);
      restoreCurrentDraft();
      sessionActivated = true;
      render();
      return true;
    }
    async function switchToTab(tabId, force = false) {
      if (windowId === void 0 || tabId === activeTabId && !force) return;
      let tab;
      try {
        tab = await chrome.tabs.get(Number(tabId));
      } catch {
        if (activeTabId === tabId) activeTabId = void 0;
        return;
      }
      try {
        await activateSession(
          () => client.resolveTabSession(windowId, tabId, tab.groupId)
        );
      } catch (cause) {
        if (!isMissingTabError(cause)) throw cause;
        const [current] = await chrome.tabs.query({
          active: true,
          windowId
        });
        if (current?.id !== void 0 && String(current.id) === tabId) {
          if (!isInspectablePageUrl(current.url)) {
            error = pageConfig.language.startsWith("zh") ? "\u5F53\u524D\u6807\u7B7E\u9875\u4E0D\u652F\u6301 Agent \u64CD\u4F5C\uFF0C\u8BF7\u5207\u6362\u5230\u666E\u901A\u7F51\u9875\u3002" : "This tab cannot be used by the Agent. Switch to a regular web page.";
            render();
            return;
          }
          error = pageConfig.language.startsWith("zh") ? "\u5F53\u524D\u6807\u7B7E\u9875\u6682\u65F6\u4E0D\u53EF\u7528\uFF0C\u8BF7\u91CD\u65B0\u5207\u6362\u540E\u91CD\u8BD5\u3002" : "The current tab is temporarily unavailable. Switch tabs and retry.";
          render();
          return;
        }
        if (current?.id !== void 0) {
          await switchToTab(String(current.id));
        } else if (activeTabId === tabId) {
          activeTabId = void 0;
        }
      }
    }
    async function startNewSession() {
      if (windowId === void 0 || !activeTabId) {
        throw new Error("No active browser tab is available");
      }
      await activateSession(
        () => client.createTabSession(windowId, activeTabId, activeGroupId)
      );
    }
    async function reloadRuntimeForCurrentTab() {
      await client.reloadRuntime();
      if (windowId === void 0 || !activeTabId) {
        throw new Error("No active browser tab is available");
      }
      await activateSession(
        () => client.resolveTabSession(windowId, activeTabId, activeGroupId)
      );
    }
    client.onProjection((eventSessionId, next) => {
      if (eventSessionId !== sessionId) return;
      reconnectAttempts = 0;
      projection = next;
      const nextBusy = next.taskStatus === "running" || next.taskStatus === "queued" || next.taskStatus === "waiting";
      if (nextBusy && !busy) busyStartedAt = Date.now();
      if (!nextBusy) busyStartedAt = 0;
      busy = nextBusy;
      error = "";
      render();
    });
    client.onApproval((approval) => {
      const pending = [
        ...approvalsBySession.get(approval.sessionId) ?? [],
        approval
      ];
      approvalsBySession.set(approval.sessionId, pending);
      if (approval.sessionId === sessionId) {
        approvals = pending;
        render();
      }
    });
    client.onHandoff((handoff) => {
      const pending = [
        ...handoffsBySession.get(handoff.sessionId) ?? [],
        handoff
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
      error = pageConfig.language.startsWith("zh") ? "Kernel \u8FD0\u884C\u65F6\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u6B63\u5728\u91CD\u8FDE\u2026" : "Kernel runtime disconnected. Reconnecting\u2026";
      render();
      if (reconnectAttempts >= 2) {
        error = pageConfig.language.startsWith("zh") ? "Kernel \u8FD0\u884C\u65F6\u8FDE\u63A5\u5931\u8D25\uFF0C\u8BF7\u91CD\u65B0\u52A0\u8F7D\u6269\u5C55\u3002" : "Kernel runtime connection failed. Reload the extension.";
        render();
        return;
      }
      reconnectAttempts += 1;
      window.setTimeout(() => {
        void client.projection(sessionId).then(async (next) => {
          projection = next;
          await client.subscribe(sessionId);
          busy = next.taskStatus === "running" || next.taskStatus === "queued" || next.taskStatus === "waiting";
          busyStartedAt = busy ? Date.now() : 0;
          error = "";
          reconnectAttempts = 0;
          render();
        }).catch((cause) => {
          error = errorMessage(cause);
          render();
        });
      }, reconnectAttempts * 250);
    });
    chrome.tabs.onActivated.addListener((info) => {
      if (windowId === void 0 || info.windowId !== windowId) return;
      void switchToTab(String(info.tabId)).catch(showError);
    });
    chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
      if (windowId === void 0 || changeInfo.groupId === void 0 || String(tabId) !== activeTabId) {
        return;
      }
      const groupId = changeInfo.groupId >= 0 ? changeInfo.groupId : void 0;
      if (groupId === activeGroupId) return;
      void switchToTab(String(tabId), true).catch(showError);
    });
    chrome.tabs.onRemoved.addListener((tabId) => {
      if (!activeTabId || String(tabId) !== activeTabId) return;
      activeTabId = void 0;
      void chrome.tabs.query({ active: true, windowId }).then(async ([next]) => {
        if (next?.id !== void 0) await switchToTab(String(next.id));
      }).catch(showError);
    });
    chrome.tabs.onDetached.addListener((tabId, info) => {
      void client.forgetTabSession(info.oldWindowId, String(tabId)).catch(() => void 0);
    });
    document.querySelector("#kernel-form")?.addEventListener("submit", (event) => {
      event.preventDefault();
      void submit();
    });
    document.querySelector("#kernel-stop")?.addEventListener("click", () => {
      void client.stopSession(sessionId).catch(showError);
    });
    document.querySelector("#kernel-settings")?.addEventListener("click", () => {
      void showPage("settings").catch(showError);
    });
    document.querySelector("#kernel-history")?.addEventListener("click", () => {
      void showPage("history").catch(showError);
    });
    document.querySelector(".kernel-shell")?.addEventListener("click", (event) => {
      const target = event.target.closest("[data-page-action]");
      if (!target?.dataset.pageAction) return;
      pageError = "";
      void handlePageAction(target.dataset.pageAction, target).catch((cause) => {
        pageError = errorMessage(cause);
        renderPage();
      });
    });
    document.querySelector("#kernel-slash")?.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = document.querySelector("#kernel-command-menu");
      if (menu) menu.hidden = !menu.hidden;
      const modelMenu = document.querySelector("#kernel-model-menu");
      if (modelMenu) modelMenu.hidden = true;
      const tabMenu = document.querySelector("#kernel-tab-menu");
      if (tabMenu) tabMenu.hidden = true;
    });
    document.querySelector("#kernel-tabs")?.addEventListener("click", (event) => {
      event.stopPropagation();
      void openTabMenu().catch(showError);
    });
    document.querySelector("#kernel-tab-menu")?.addEventListener("click", (event) => {
      const tab = event.target.closest("[data-kernel-tab]");
      if (!tab?.dataset.kernelTab) return;
      const tabId = tab.dataset.kernelTab;
      void chrome.tabs.update(Number(tabId), { active: true }).then(() => {
        const menu = document.querySelector("#kernel-tab-menu");
        if (menu) menu.hidden = true;
        if (windowId !== void 0) return switchToTab(tabId);
      }).catch(showError);
    });
    document.querySelector("#kernel-model")?.addEventListener("click", (event) => {
      event.stopPropagation();
      void openModelMenu().catch(showError);
    });
    document.querySelector("#kernel-model-menu")?.addEventListener("click", (event) => {
      const option = event.target.closest("[data-kernel-model]");
      if (!option) return;
      void switchModel(
        option.dataset.kernelConnection ?? "",
        option.dataset.kernelModel ?? ""
      ).catch(showError);
    });
    document.querySelector("#kernel-artifact-close")?.addEventListener("click", () => {
      document.querySelector("#kernel-artifact-dialog")?.close();
    });
    document.querySelector("#kernel-attach")?.addEventListener("click", () => {
      document.querySelector("#kernel-file-input")?.click();
    });
    document.querySelector("#kernel-file-input")?.addEventListener("change", (event) => {
      const files = Array.from(event.target.files ?? []);
      void readAttachments(files).catch(showError);
    });
    document.querySelector("#kernel-skill")?.addEventListener("change", (event) => {
      const name = event.target.value;
      selectedSkill = skills.find((skill) => skill.name === name);
      render();
    });
    document.querySelector("#kernel-attachments")?.addEventListener("click", (event) => {
      const removeAttachment = event.target.closest("[data-remove-attachment]");
      if (!removeAttachment) return;
      attachments = attachments.filter(
        (attachment) => attachment.name !== removeAttachment.dataset.removeAttachment
      );
      render();
    });
    document.querySelector("#kernel-rows")?.addEventListener("click", (event) => {
      const summary = event.target.closest("summary");
      const details = summary?.closest("details[data-ui-key]");
      const detailKey = details?.dataset.uiKey;
      if (details && detailKey) {
        queueMicrotask(() => {
          if (details.isConnected) detailState.set(detailKey, details.open);
        });
      }
      const prompt = event.target.closest("[data-kernel-prompt]");
      if (prompt) {
        const input = document.querySelector("#kernel-input");
        if (input) {
          input.value = prompt.dataset.kernelPrompt ?? "";
          input.focus();
        }
      }
    });
    document.querySelector("#kernel-mode")?.addEventListener("click", () => {
      const next = projection?.permissionMode === "plan" ? "guarded" : "plan";
      void sendControlCommand("set_mode", { mode: next }).catch(showError);
    });
    document.querySelector("#kernel-approve-plan")?.addEventListener("click", () => {
      const plan = [...projection?.rows ?? []].reverse().find((row) => row.kind === "assistant" && row.text.trim())?.text;
      if (!plan) return;
      void sendControlCommand("submit_plan", { plan }).then(() => sendControlCommand("approve_plan", {})).then(() => sendControlCommand("set_mode", { mode: "build" })).catch(showError);
    });
    document.querySelector("#kernel-new")?.addEventListener("click", () => {
      void startNewSession().then(() => {
        detailState.clear();
        render();
      }).catch(showError);
    });
    document.addEventListener("change", (event) => {
      const target = event.target;
      if (target.id === "kernel-page-language") {
        pageConfig.language = target.value;
        void writePageConfig().then(() => renderPage()).catch((cause) => {
          pageError = errorMessage(cause);
          renderPage();
        });
        return;
      }
      if (target.id === "kernel-page-model") {
        const [connection, ...modelParts] = target.value.split("|");
        const model = modelParts.join("|");
        if (!connection || !model) return;
        pageConfig.connection = connection;
        pageConfig.model = model;
        modelLabel = model;
        void writePageConfig().then(() => reloadRuntimeForCurrentTab()).then(() => renderPage()).catch((cause) => {
          pageError = errorMessage(cause);
          renderPage();
        });
      }
    });
    document.querySelector("#kernel-compact")?.addEventListener("click", () => {
      void sendControlCommand("compact", {}).catch(showError);
    });
    document.querySelector("#kernel-rows")?.addEventListener("click", (event) => {
      const childTarget = event.target.closest("[data-open-child]");
      if (childTarget?.dataset.openChild) {
        void switchSession(childTarget.dataset.openChild).catch(showError);
        return;
      }
      const artifactTarget = event.target.closest("[data-artifact]");
      if (artifactTarget?.dataset.artifact) {
        void openArtifact(artifactTarget.dataset.artifact).catch(showError);
        return;
      }
      const copyTarget = event.target.closest("[data-copy-message]");
      if (copyTarget?.dataset.copyMessage) {
        const text = projection?.rows.find((row) => row.id === copyTarget.dataset.copyMessage)?.text ?? "";
        void navigator.clipboard.writeText(text).then(() => {
          copyTarget.textContent = pageConfig.language.startsWith("zh") ? "\u5DF2\u590D\u5236" : "Copied";
        }).catch(showError);
        return;
      }
      const exportTarget = event.target.closest("[data-export-message]");
      if (exportTarget?.dataset.exportMessage) {
        const text = projection?.rows.find((row) => row.id === exportTarget.dataset.exportMessage)?.text ?? "";
        const href = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
        const anchor = document.createElement("a");
        anchor.href = href;
        anchor.download = `tinyai-${Date.now()}.md`;
        anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(href), 1e3);
        return;
      }
      const handoffTarget = event.target.closest("[data-handoff]");
      if (handoffTarget) {
        const handoffId = handoffTarget.dataset.handoff;
        const decision = handoffTarget.dataset.decision === "continue" ? "continue" : "cancel";
        if (!handoffId) return;
        handoffs = handoffs.filter((item) => item.handoffId !== handoffId);
        handoffsBySession.set(sessionId, handoffs);
        void client.respondHandoff(handoffId, decision).catch(showError);
        render();
        return;
      }
      const target = event.target.closest("[data-approval]");
      if (!target) return;
      const approvalId = target.dataset.approval;
      const approved = target.dataset.decision === "allow";
      if (!approvalId) return;
      approvals = approvals.filter((item) => item.approvalId !== approvalId);
      approvalsBySession.set(sessionId, approvals);
      void client.respondApproval(approvalId, approved).catch(showError);
      render();
    });
    document.querySelector("#kernel-input")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    document.querySelector("#kernel-input")?.addEventListener("input", () => {
      syncSendButton();
    });
    document.addEventListener("click", (event) => {
      const target = event.target;
      if (target.closest("#kernel-command-menu") || target.closest("#kernel-slash")) return;
      const commandMenu = document.querySelector("#kernel-command-menu");
      if (commandMenu) commandMenu.hidden = true;
      const tabMenu = document.querySelector("#kernel-tab-menu");
      if (tabMenu) tabMenu.hidden = true;
      if (target.closest("#kernel-model-menu") || target.closest("#kernel-model")) return;
      const modelMenu = document.querySelector("#kernel-model-menu");
      if (modelMenu) modelMenu.hidden = true;
    });
    window.setInterval(() => {
      if (!busy) return;
      const status = document.querySelector("#kernel-status");
      if (status) {
        const text = status.querySelector(".wb-run-text");
        if (text) text.textContent = statusText(
          projection,
          busy,
          error,
          busyStartedAt,
          approvals.length > 0 || handoffs.length > 0,
          pageConfig.language
        );
      }
    }, 1e3);
    async function submit() {
      const input = document.querySelector("#kernel-input");
      const text = input?.value.trim() ?? "";
      if (!text && !attachments.length && !selectedSkill) return;
      if (projection?.availability.canSend === false) return;
      if (text === "/new") {
        if (input) input.value = "";
        await startNewSession();
        detailState.clear();
        render();
        return;
      }
      if (text === "/compact") {
        if (input) input.value = "";
        void sendControlCommand("compact", {}).catch(showError);
        return;
      }
      if (text === "/plan") {
        if (input) input.value = "";
        void sendControlCommand("set_mode", {
          mode: projection?.permissionMode === "plan" ? "guarded" : "plan"
        }).catch(showError);
        return;
      }
      busy = true;
      busyStartedAt = Date.now();
      error = "";
      if (input) input.value = "";
      render();
      try {
        const planInstruction = projection?.permissionMode === "plan" ? "\n\nPlan mode: return a concise plan. Do not perform write, execute or network actions." : "";
        const ack = await client.command({
          commandId: crypto.randomUUID(),
          clientId: "sidepanel",
          sessionId,
          type: "send_input",
          payload: {
            text: `${text || "Please inspect the provided context."}${planInstruction}`,
            context: {
              ...selectedSkill ? {
                skill: {
                  name: selectedSkill.name,
                  instructions: selectedSkill.body
                }
              } : {},
              ...attachments.length ? { attachments: attachments.map((item) => ({ ...item })) } : {}
            }
          },
          issuedAt: Date.now()
        });
        if (ack.status !== "accepted" && ack.status !== "duplicate") {
          throw Object.assign(new Error(ack.error?.message ?? `Command ${ack.status}`), {
            name: ack.error?.code ?? "COMMAND_REJECTED"
          });
        }
        projection = await client.projection(sessionId);
        busy = projection.taskStatus === "running" || projection.taskStatus === "queued" || projection.taskStatus === "waiting";
        await client.subscribe(sessionId);
        attachments = [];
        selectedSkill = void 0;
        drafts.delete(sessionId);
        const skillSelect2 = document.querySelector("#kernel-skill");
        if (skillSelect2) skillSelect2.value = "";
        const fileInput = document.querySelector("#kernel-file-input");
        if (fileInput) fileInput.value = "";
        render();
      } catch (cause) {
        showError(cause);
      }
    }
    function syncSendButton() {
      const send = document.querySelector("#kernel-send");
      const input = document.querySelector("#kernel-input");
      if (!send || !input) return;
      send.disabled = !sessionActivated || Boolean(error) || projection?.availability.canSend === false || !input.value.trim() && !attachments.length && !selectedSkill;
    }
    async function sendControlCommand(type, payload) {
      const ack = await client.command({
        commandId: crypto.randomUUID(),
        clientId: "sidepanel",
        sessionId,
        type,
        payload,
        issuedAt: Date.now()
      });
      if (ack.status !== "accepted" && ack.status !== "duplicate" && ack.status !== "noop") {
        throw Object.assign(new Error(ack.error?.message ?? `Command ${ack.status}`), {
          name: ack.error?.code ?? "COMMAND_REJECTED"
        });
      }
      projection = await client.projection(sessionId);
      render();
    }
    async function readAttachments(files) {
      const maxFiles = 8;
      const maxBytes = 5 * 1024 * 1024;
      for (const file of files.slice(0, maxFiles)) {
        if (file.size > maxBytes) {
          throw new Error(`${file.name} exceeds the 5 MB attachment limit`);
        }
        if (file.type.startsWith("text/") || /\.(md|ts|tsx|js|jsx|json|css|html|txt)$/i.test(file.name)) {
          attachments.push({ name: file.name, type: file.type || "text/plain", text: await file.text() });
        } else if (file.type.startsWith("image/")) {
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error ?? new Error(`Failed to read ${file.name}`));
            reader.readAsDataURL(file);
          });
          attachments.push({
            name: file.name,
            type: file.type,
            dataBase64: dataUrl.slice(dataUrl.indexOf(",") + 1)
          });
        } else {
          throw new Error(`Unsupported attachment type: ${file.type || file.name}`);
        }
      }
      attachments = attachments.slice(-maxFiles);
      render();
    }
    async function showPage(view) {
      pageConfig = await readPageConfig();
      if (view === "history") pageSessions = await client.listSessions();
      pageView = view;
      pageError = "";
      connectionTestMessage = "";
      renderPage();
    }
    function closePage() {
      pageView = null;
      document.querySelector("#kernel-page-layer")?.remove();
    }
    function renderPage() {
      const root2 = document.querySelector(".kernel-shell");
      if (!root2 || !pageView) return;
      document.querySelector("#kernel-page-layer")?.remove();
      root2.insertAdjacentHTML("beforeend", pageMarkup());
    }
    function pageMarkup() {
      if (pageView === "connections") return connectionsPageMarkup();
      if (pageView === "history") return historyPageMarkup();
      return settingsPageMarkup();
    }
    function stageMarkup(inner) {
      return `<div id="kernel-page-layer" class="kernel-page-layer">
      <div class="wb-stage" data-wb-theme="${effectiveTheme()}" style="--wb-page-rgb: 83,177,255; --wb-dock-h: 160px;">
        ${inner}
        <div class="wb-fx-grain"></div>
        <div class="wb-fx-scan"></div>
      </div>
    </div>`;
    }
    function settingsHead(title, action = "back") {
      return `<div class="wb-settings-head">
      <button type="button" class="wb-icon-button wb-settings-back" data-page-action="${action}" aria-label="${pageConfig.language.startsWith("zh") ? "\u8FD4\u56DE" : "Back"}">${icons.back}</button>
      <div class="wb-settings-title">${escapeHtml(title)}</div>
    </div>`;
    }
    function pageAlertMarkup() {
      return pageError ? `<div class="wb-notice wb-notice-error">${escapeHtml(pageError)}</div>` : "";
    }
    function settingsPageMarkup() {
      const zh = pageConfig.language.startsWith("zh");
      const models = pageConfig.connections.flatMap(
        (connection) => connection.models.map((model) => ({
          connection: connection.id,
          model,
          label: `${model}`
        }))
      );
      return stageMarkup(`${settingsHead(zh ? "\u8BBE\u7F6E" : "Settings")}
      <div class="wb-settings-body">
        <div class="wb-set-card wb-set-account">
          <div class="wb-account-row">
            <span class="wb-account-avatar wb-account-avatar--logo" aria-hidden="true"><img class="wb-account-avatar-img" alt="" src="icon/tinyai.svg"></span>
            <span class="wb-account-copy"><span class="wb-account-name-row"><span class="wb-account-name">tinyai</span></span><span class="wb-account-line">${zh ? "\u6240\u6709\u5BF9\u8BDD\u548C\u6A21\u578B Key \u90FD\u4FDD\u5B58\u5728\u672C\u673A\u3002" : "All chats and model keys stay on this machine."}</span></span>
            <span class="wb-badge">${zh ? "\u672C\u5730 Agent" : "Local agent"}</span>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? "\u901A\u7528" : "General"}</div>
          <div class="wb-set-card">
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.sun}</span>${zh ? "\u5916\u89C2" : "Appearance"}</span>
              <button type="button" class="wb-set-select" data-page-action="theme"><span class="wb-set-select-value">${escapeHtml(themeLabel(pageConfig.theme, zh))}</span>${icons.chevronDown}</button></div>
            <div class="wb-set-sepa"></div>
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.globe}</span>${zh ? "\u8BED\u8A00" : "Language"}</span>
              <select id="kernel-page-language" class="wb-native-select">${[
        ["en", "English"],
        ["zh", "\u4E2D\u6587"],
        ["zh-TW", "\u7E41\u9AD4\u4E2D\u6587"],
        ["ja", "\u65E5\u672C\u8A9E"],
        ["ko", "\uD55C\uAD6D\uC5B4"],
        ["es", "Espa\xF1ol"],
        ["fr", "Fran\xE7ais"],
        ["de", "Deutsch"]
      ].map(([value, label]) => `<option value="${value}" ${value === pageConfig.language ? "selected" : ""}>${label}</option>`).join("")}</select></div>
            <div class="wb-set-sepa"></div>
            <div class="wb-set-row"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.zoom}</span>${zh ? "\u7F29\u653E" : "Zoom"}</span><span class="wb-input-grow"></span>
              <button type="button" class="wb-set-stepper-btn" data-page-action="zoom" data-delta="-10" aria-label="Zoom out">\u2212</button>
              <button type="button" class="wb-set-stepper-value" data-page-action="zoom" data-delta="0">${pageConfig.zoom}%</button>
              <button type="button" class="wb-set-stepper-btn" data-page-action="zoom" data-delta="10" aria-label="Zoom in">+</button></div>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? "\u6A21\u578B" : "Models"}</div>
          <div class="wb-set-card">
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.sparkle}</span>${zh ? "\u6A21\u578B" : "Model"}</span>
              <select class="wb-native-select" id="kernel-page-model">${models.length ? models.map((item) => `<option value="${escapeHtml(item.connection + "|" + item.model)}" ${item.connection === pageConfig.connection && item.model === pageConfig.model ? "selected" : ""}>${escapeHtml(item.label)}</option>`).join("") : `<option>${zh ? "\u672A\u914D\u7F6E\u6A21\u578B" : "No model"}</option>`}</select></div>
            <div class="wb-set-sepa"></div>
            <div class="wb-set-row wb-set-navrow wb-clickable" data-page-action="connections"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.link}</span>${zh ? "\u6A21\u578B\u8FDE\u63A5" : "Model connections"}</span><span class="wb-input-grow"></span><span class="wb-set-row-value">${pageConfig.connections.length}</span>${icons.chevronDown}</div>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? "\u6743\u9650" : "Permissions"}</div>
          <div class="wb-set-card">
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.shield}</span>${zh ? "\u64CD\u4F5C\u5BA1\u6279" : "Action approval"}</span>
              <button type="button" class="wb-set-select" data-page-action="approval"><span class="wb-set-select-value">${pageConfig.approval === "auto" ? zh ? "\u81EA\u52A8\u6267\u884C" : "Auto-approve" : zh ? "\u9700\u8981\u5BA1\u6279" : "Requires approval"}</span>${icons.chevronDown}</button></div>
            <div class="wb-set-sepa"></div>
            <div class="wb-set-row wb-set-selectrow"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.sparkle}</span>${zh ? "\u663E\u793A\u63A8\u7406\u8FC7\u7A0B" : "Reasoning"}</span>
              <button type="button" class="wb-set-select" data-page-action="reasoning"><span class="wb-set-select-value">${pageConfig.showReasoning ? zh ? "\u663E\u793A" : "Show" : zh ? "\u9690\u85CF" : "Hidden"}</span>${icons.chevronDown}</button></div>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? "\u6570\u636E" : "Data"}</div>
          <div class="wb-set-card">
            <button type="button" class="wb-set-row wb-set-navrow wb-clickable kernel-danger-row" data-page-action="clear-history">
              <span class="wb-set-row-label">${icons.info}${zh ? "\u6E05\u9664\u5168\u90E8\u804A\u5929\u5386\u53F2" : "Clear all chat history"}</span>
              <span class="wb-input-grow"></span>
              ${icons.chevronDown}
            </button>
          </div>
        </div>
        <div class="wb-set-group"><div class="wb-set-group-label">${zh ? "\u5173\u4E8E" : "About"}</div>
          <div class="wb-set-card">
            <div class="wb-set-row"><span class="wb-set-row-label"><span class="wb-set-row-icon">${icons.info}</span>${zh ? "\u7248\u672C" : "Version"}</span><span class="wb-input-grow"></span><span class="wb-set-row-value">${escapeHtml(chrome.runtime.getManifest().version)}</span></div>
          </div>
        </div>
        ${pageAlertMarkup()}
      </div>`);
    }
    function connectionsPageMarkup() {
      const zh = pageConfig.language.startsWith("zh");
      const cards = pageConfig.connections.map(
        (connection) => `<div class="wb-conn-card">
          <div class="wb-conn-head"><span class="wb-conn-name">${escapeHtml(connection.label)}</span>${connection.vision ? '<span class="wb-badge">vision</span>' : ""}</div>
          <div class="wb-conn-url">${escapeHtml(connection.baseUrl)}</div>
          <div class="wb-conn-models">${connection.models.length ? escapeHtml(connection.models.join(", ")) : "\u2014"} \xB7 ${connection.apiKey ? "key \u2713" : "no key"}</div>
          <div class="wb-conn-actions">
            <button type="button" class="wb-ghost-btn" data-page-action="conn-edit" data-id="${escapeHtml(connection.id)}">${zh ? "\u7F16\u8F91" : "Edit"}</button>
            <button type="button" class="wb-ghost-btn" data-page-action="conn-delete" data-id="${escapeHtml(connection.id)}">${zh ? "\u5220\u9664" : "Delete"}</button>
          </div>
        </div>`
      ).join("");
      const form = editingConnectionId !== void 0 ? connectionFormMarkup(
        editingConnectionId === null ? null : pageConfig.connections.find((item) => item.id === editingConnectionId) ?? null
      ) : "";
      return stageMarkup(`${settingsHead(zh ? "\u6A21\u578B\u8FDE\u63A5" : "Connections", "back-connections")}
      <div class="wb-settings-body">
        ${cards || `<div class="wb-menu-empty">${zh ? "\u8FD8\u6CA1\u6709\u6A21\u578B\u8FDE\u63A5\u3002" : "No model connections yet."}</div>`}
        ${form || `<button type="button" class="wb-btn wb-btn--primary" data-page-action="conn-add">${zh ? "\u6DFB\u52A0\u8FDE\u63A5" : "Add connection"}</button>`}
        ${pageAlertMarkup()}
      </div>`);
    }
    function connectionFormMarkup(connection) {
      const zh = pageConfig.language.startsWith("zh");
      return `<form id="kernel-connection-form" class="wb-form">
      <label>${zh ? "\u540D\u79F0" : "Label"}<input id="kernel-page-conn-label" type="text" value="${escapeHtml(connection?.label ?? "")}"></label>
      <label>${zh ? "\u63A5\u53E3\u5730\u5740" : "Base URL"}<input id="kernel-page-conn-base" type="text" value="${escapeHtml(connection?.baseUrl ?? "")}" placeholder="https://api.deepseek.com/v1"></label>
      <label>API Key<input id="kernel-page-conn-key" type="password" value="" placeholder="${connection?.apiKey ? zh ? "\u5DF2\u4FDD\u5B58\uFF0C\u7559\u7A7A\u4FDD\u6301\u4E0D\u53D8" : "Saved \u2014 leave blank to keep" : "sk-..."}" autocomplete="off"></label>
      <label>${zh ? "\u6A21\u578B\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF09" : "Models (one per line)"}<textarea id="kernel-page-conn-models">${escapeHtml(connection?.models.join("\n") ?? "")}</textarea></label>
      <label class="wb-row"><input id="kernel-page-conn-vision" type="checkbox" ${connection?.vision ? "checked" : ""}> ${zh ? "\u652F\u6301\u56FE\u7247\u8F93\u5165" : "Supports image input"}</label>
      <div class="wb-form-actions">
        <button type="button" class="wb-btn wb-btn--primary" data-page-action="conn-save">${zh ? "\u4FDD\u5B58" : "Save"}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="conn-test">${zh ? "\u6D4B\u8BD5\u8FDE\u63A5" : "Test connection"}</button>
        <button type="button" class="wb-ghost-btn" data-page-action="conn-cancel">${zh ? "\u53D6\u6D88" : "Cancel"}</button>
        ${connectionTestMessage ? `<span class="wb-form-ok">${escapeHtml(connectionTestMessage)}</span>` : ""}
      </div>
      <div class="wb-conn-url">${zh ? "\u652F\u6301\u4EFB\u4F55 OpenAI \u517C\u5BB9\u7AEF\u70B9\u3002" : "Any OpenAI-compatible endpoint works."}</div>
    </form>`;
    }
    function historyPageMarkup() {
      const zh = pageConfig.language.startsWith("zh");
      return stageMarkup(`${settingsHead(zh ? "\u804A\u5929\u8BB0\u5F55" : "Chat history")}
      <div class="wb-settings-body">
        ${pageSessions.length ? pageSessions.map((session) => `<div class="wb-history-item ${session.sessionId === sessionId ? "is-current" : ""}">
          <div class="wb-history-main" data-page-action="history-open" data-id="${escapeHtml(session.sessionId)}"><div class="wb-history-title">${escapeHtml(session.title)}</div><div class="wb-history-meta">${escapeHtml(statusLabel(session.taskStatus, pageConfig.language))} \xB7 ${session.rowCount} ${zh ? "\u6761" : "messages"}</div></div>
          ${session.sessionId === sessionId ? `<span class="wb-badge">${zh ? "\u5F53\u524D" : "Current"}</span>` : ""}
          <button type="button" class="wb-ghost-btn" data-page-action="history-delete" data-id="${escapeHtml(session.sessionId)}" aria-label="delete">\xD7</button>
        </div>`).join("") : `<div class="wb-menu-empty">${zh ? "\u8FD8\u6CA1\u6709\u5386\u53F2\u4F1A\u8BDD\u3002" : "No history yet."}</div>`}
        <div class="wb-history-foot">${zh ? "\u6700\u591A\u4FDD\u7559\u6700\u8FD1 10 \u6761\u4F1A\u8BDD" : "Keeps your 10 most recent chats"}</div>
        ${pageAlertMarkup()}
      </div>`);
    }
    async function readPageConfig() {
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      const raw = stored[CONFIG_KEY] ?? {};
      const sourceConnections = Array.isArray(raw.connections) ? raw.connections : [];
      const connections = sourceConnections.flatMap((value, index) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) return [];
        const item = value;
        return [{
          id: String(item.id ?? `connection-${index + 1}`),
          label: String(item.label ?? item.id ?? "Custom"),
          baseUrl: String(item.baseUrl ?? item["base-url"] ?? ""),
          apiKey: String(item.apiKey ?? item["api-key"] ?? ""),
          models: Array.isArray(item.models) ? item.models.map(String) : [],
          vision: Boolean(item.vision)
        }];
      });
      return {
        approval: raw.approval === "auto" ? "auto" : "ask",
        showReasoning: raw.showReasoning !== false,
        theme: raw.theme === "dark" || raw.theme === "system" ? raw.theme : "light",
        language: typeof raw.language === "string" ? raw.language : "en",
        zoom: Number(raw.zoom ?? 100),
        connection: typeof raw.connection === "string" ? raw.connection : null,
        model: typeof raw.model === "string" ? raw.model : null,
        connections
      };
    }
    async function writePageConfig(config = pageConfig) {
      await chrome.storage.local.set({ [CONFIG_KEY]: config });
      pageConfig = config;
      modelLabel = config.model || config.connections.flatMap((item) => item.models)[0] || (pageConfig.language.startsWith("zh") ? "\u9009\u62E9\u6A21\u578B" : "Choose model");
      applyPageAppearance();
      render();
    }
    function applyPageAppearance() {
      const stage = document.querySelector(".kernel-shell");
      if (!stage) return;
      stage.dataset.wbTheme = effectiveTheme();
      stage.style.zoom = "";
      document.documentElement.style.zoom = String(
        Math.max(70, Math.min(150, pageConfig.zoom || 100)) / 100
      );
      document.documentElement.lang = pageConfig.language;
      document.body.dataset.wbTheme = effectiveTheme();
    }
    function applyLanguageToShell() {
      const zh = pageConfig.language.startsWith("zh");
      const setLabel = (selector, value) => {
        const node = document.querySelector(selector);
        if (node) node.textContent = value;
      };
      document.querySelector("#kernel-new")?.setAttribute("aria-label", zh ? "\u65B0\u5EFA\u4EFB\u52A1" : "New task");
      document.querySelector("#kernel-history")?.setAttribute("aria-label", zh ? "\u804A\u5929\u8BB0\u5F55" : "History");
      document.querySelector("#kernel-settings")?.setAttribute("aria-label", zh ? "\u8BBE\u7F6E" : "Settings");
      const input = document.querySelector("#kernel-input");
      if (input) {
        input.placeholder = zh ? "\u7ED9 tinyai \u53D1\u6D88\u606F\uFF0C\u6309 @ \u9009\u62E9\u6807\u7B7E\u9875\uFF0C/ \u67E5\u770B\u547D\u4EE4" : "Type a task, Enter to send";
        input.setAttribute("aria-label", zh ? "\u4EFB\u52A1" : "Task");
      }
      setLabel("#kernel-compact", zh ? "\u538B\u7F29\u4E0A\u4E0B\u6587" : "Compact context");
      setLabel("#kernel-approve-plan", zh ? "\u6279\u51C6\u8BA1\u5212" : "Approve plan");
      const skill = document.querySelector("#kernel-skill");
      if (skill?.options[0]) skill.options[0].textContent = zh ? "\u4E0D\u4F7F\u7528 Skill" : "No skill";
    }
    function effectiveTheme() {
      const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches;
      return pageConfig.theme === "dark" || pageConfig.theme === "system" && systemDark ? "dark" : "light";
    }
    async function handlePageAction(action, target) {
      if (action === "back") {
        closePage();
        return;
      }
      if (action === "back-connections") {
        editingConnectionId = void 0;
        connectionTestMessage = "";
        pageView = "settings";
        renderPage();
        return;
      }
      if (action === "theme") {
        pageConfig.theme = pageConfig.theme === "light" ? "dark" : pageConfig.theme === "dark" ? "system" : "light";
        await writePageConfig();
        renderPage();
        return;
      }
      if (action === "language") {
        pageConfig.language = pageConfig.language.startsWith("zh") ? "en" : "zh";
        await writePageConfig();
        applyLanguageToShell();
        renderPage();
        return;
      }
      if (action === "approval") {
        pageConfig.approval = pageConfig.approval === "ask" ? "auto" : "ask";
        await writePageConfig();
        renderPage();
        return;
      }
      if (action === "reasoning") {
        pageConfig.showReasoning = !pageConfig.showReasoning;
        await writePageConfig();
        renderPage();
        return;
      }
      if (action === "clear-history") {
        const confirmed = window.confirm(
          pageConfig.language.startsWith("zh") ? "\u786E\u5B9A\u6C38\u4E45\u6E05\u9664\u5168\u90E8\u804A\u5929\u5386\u53F2\uFF1F\u6B64\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002" : "Permanently clear all chat history? This cannot be undone."
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
      if (action === "zoom") {
        const delta = Number(target.dataset.delta ?? 0);
        pageConfig.zoom = delta === 0 ? 100 : Math.max(70, Math.min(150, (pageConfig.zoom || 100) + delta));
        await writePageConfig();
        renderPage();
        return;
      }
      if (action === "connections") {
        pageView = "connections";
        editingConnectionId = void 0;
        renderPage();
        return;
      }
      if (action === "conn-add") {
        editingConnectionId = null;
        renderPage();
        return;
      }
      if (action === "conn-edit") {
        editingConnectionId = target.dataset.id ?? null;
        renderPage();
        return;
      }
      if (action === "conn-cancel") {
        editingConnectionId = void 0;
        connectionTestMessage = "";
        renderPage();
        return;
      }
      if (action === "conn-delete") {
        const id = target.dataset.id;
        if (!id) return;
        if (!window.confirm(pageConfig.language.startsWith("zh") ? "\u786E\u5B9A\u5220\u9664\u8FD9\u6761\u8FDE\u63A5\uFF1F" : "Delete this connection?")) {
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
      if (action === "conn-save") {
        await saveConnectionForm();
        return;
      }
      if (action === "conn-test") {
        await testConnectionForm();
        return;
      }
      if (action === "history-open") {
        const id = target.dataset.id;
        if (!id) return;
        closePage();
        await switchSession(id);
        return;
      }
      if (action === "history-delete") {
        const id = target.dataset.id;
        if (!id) return;
        await client.deleteSession(id);
        pageSessions = await client.listSessions();
        renderPage();
      }
    }
    async function saveConnectionForm() {
      const label = pageValue("#kernel-page-conn-label");
      const baseUrl = pageValue("#kernel-page-conn-base").replace(/\/+$/, "");
      const keyInput = pageValue("#kernel-page-conn-key");
      const models = pageValue("#kernel-page-conn-models").split(/\n|,/).map((model) => model.trim()).filter(Boolean);
      const previous = editingConnectionId && editingConnectionId !== null ? pageConfig.connections.find((item) => item.id === editingConnectionId) : void 0;
      if (!label || !baseUrl || !models.length) {
        throw new Error("Name, base URL, and at least one model are required");
      }
      const connection = {
        id: previous?.id ?? crypto.randomUUID(),
        label,
        baseUrl,
        ...keyInput || previous?.apiKey ? { apiKey: keyInput || previous?.apiKey } : {},
        models,
        vision: document.querySelector("#kernel-page-conn-vision")?.checked ?? false
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
      pageView = "settings";
      editingConnectionId = void 0;
      renderPage();
    }
    async function testConnectionForm() {
      const baseUrl = pageValue("#kernel-page-conn-base").replace(/\/+$/, "");
      const key = pageValue("#kernel-page-conn-key") || pageConfig.connections.find((item) => item.id === editingConnectionId)?.apiKey || "";
      if (!baseUrl) throw new Error("Base URL is required");
      const response = await fetch(`${baseUrl}/models`, {
        headers: key ? { Authorization: `Bearer ${key}` } : {}
      });
      if (!response.ok) throw new Error(`Connection failed: HTTP ${response.status}`);
      const payload = await response.json();
      const models = (payload.data ?? []).map((item) => item.id).filter(Boolean);
      connectionTestMessage = models.length ? `Connection OK \xB7 ${models.length} models available` : "Connection OK";
      renderPage();
    }
    function pageValue(selector) {
      return document.querySelector(
        selector
      )?.value.trim() ?? "";
    }
    async function openTabMenu() {
      const zh = pageConfig.language.startsWith("zh");
      const tabs = await client.listTabs();
      const menu = document.querySelector("#kernel-tab-menu");
      const commandMenu = document.querySelector("#kernel-command-menu");
      const modelMenu = document.querySelector("#kernel-model-menu");
      if (commandMenu) commandMenu.hidden = true;
      if (modelMenu) modelMenu.hidden = true;
      if (!menu) return;
      const currentTabs = activeScope === "tab" ? tabs.filter((tab) => tab.id === activeTabId) : [];
      const tabsWithGroups = await chrome.tabs.query({ windowId });
      const groupMembers = activeScope === "group" && activeGroupId !== void 0 ? tabsWithGroups.filter((tab) => tab.groupId === activeGroupId).map((tab) => ({
        id: String(tab.id),
        title: tab.title,
        url: tab.url,
        active: Boolean(tab.active)
      })) : [];
      const workspaceTabs = currentTabs.length ? currentTabs : groupMembers;
      const workspaceIds = new Set(workspaceTabs.map((tab) => tab.id));
      const otherTabs = tabs.filter((tab) => !workspaceIds.has(tab.id));
      const tabButton = (tab) => `<button type="button" class="wb-pop-item${tab.id === activeTabId ? " selected" : ""}" data-kernel-tab="${escapeHtml(tab.id)}"><span class="wb-pop-copy"><span class="wb-pop-title">${escapeHtml(tab.title || tab.url || tab.id)}</span><span class="wb-pop-desc">${escapeHtml(tab.url ?? "")}</span></span></button>`;
      menu.innerHTML = (workspaceTabs.length ? `<div class="wb-menu-heading">${zh ? "\u5F53\u524D\u5DE5\u4F5C\u533A" : "Current workspace"}</div>${workspaceTabs.map(tabButton).join("")}` : "") + (otherTabs.length ? `<div class="wb-menu-heading">${zh ? "\u5176\u4ED6\u72EC\u7ACB\u6807\u7B7E" : "Other independent tabs"}</div>${otherTabs.map(tabButton).join("")}` : "") || `<div class="wb-menu-empty">${zh ? "\u6CA1\u6709\u53EF\u7528\u7684\u7F51\u9875\u6807\u7B7E\u9875" : "No browser tabs"}</div>`;
      menu.hidden = false;
    }
    async function openModelMenu() {
      const zh = pageConfig.language.startsWith("zh");
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      const config = stored[CONFIG_KEY] ?? {};
      const connections = Array.isArray(config.connections) ? config.connections : [];
      const selectedConnection = typeof config.connection === "string" ? config.connection : connections.find(
        (connection) => (connection.models ?? []).map(String).includes(String(config.model ?? ""))
      )?.id ?? connections[0]?.id;
      const selectedModel = typeof config.model === "string" && config.model ? config.model : connections.find((connection) => connection.id === selectedConnection)?.models?.map(String)[0] ?? "";
      const menu = document.querySelector("#kernel-model-menu");
      const commandMenu = document.querySelector("#kernel-command-menu");
      if (commandMenu) commandMenu.hidden = true;
      if (!menu) return;
      const groups = connections.flatMap((connection) => {
        const models = Array.isArray(connection.models) ? connection.models.map(String) : [];
        return models.length ? [`<div class="wb-menu-heading">${escapeHtml(connection.label ?? connection.id ?? "Model")}</div>${models.map(
          (model) => {
            const selected = model === selectedModel && (connection.id ?? "") === (selectedConnection ?? "");
            return `<button type="button" class="wb-pop-item${selected ? " selected" : ""}" data-kernel-model="${escapeHtml(model)}" data-kernel-connection="${escapeHtml(connection.id ?? "")}" aria-pressed="${selected ? "true" : "false"}"><span class="wb-pop-copy"><span class="wb-pop-title">${escapeHtml(model)}</span></span>${selected ? icons.check : ""}</button>`;
          }
        ).join("")}`] : [];
      });
      menu.innerHTML = groups.join("") || `<div class="wb-menu-empty">${zh ? "\u672A\u914D\u7F6E\u6A21\u578B" : "No model configured"}</div><button type="button" class="wb-pop-item" id="kernel-model-settings">${zh ? "\u6253\u5F00\u8BBE\u7F6E" : "Open settings"}</button>`;
      menu.hidden = false;
      menu.querySelector("#kernel-model-settings")?.addEventListener("click", () => {
        menu.hidden = true;
        void showPage("settings").catch(showError);
      });
    }
    async function switchModel(connection, model) {
      if (!connection || !model) return;
      if (pageConfig.connection === connection && pageConfig.model === model) {
        await openModelMenu();
        return;
      }
      const menu = document.querySelector("#kernel-model-menu");
      if (menu) {
        menu.querySelectorAll("[data-kernel-model]").forEach((option) => {
          option.disabled = true;
        });
        markModelOptionSelected(menu, connection, model);
        modelLabel = model;
        const label = document.querySelector("#kernel-model-label");
        if (label) label.textContent = model;
      }
      const stored = await chrome.storage.local.get(CONFIG_KEY);
      const config = stored[CONFIG_KEY] ?? {};
      await chrome.storage.local.set({
        [CONFIG_KEY]: { ...config, connection, model }
      });
      pageConfig.connection = connection;
      pageConfig.model = model;
      modelLabel = model;
      await reloadRuntimeForCurrentTab();
      render();
      await openModelMenu();
    }
    async function openArtifact(artifactId) {
      const artifact = await client.readArtifact(artifactId);
      const title = document.querySelector("#kernel-artifact-title");
      const body = document.querySelector("#kernel-artifact-body");
      if (!title || !body) return;
      title.textContent = artifact.metadata.name;
      if (artifact.metadata.mimeType.startsWith("image/")) {
        body.innerHTML = `<img class="kernel-tool-image" alt="${escapeHtml(artifact.metadata.name)}" src="data:${escapeHtml(artifact.metadata.mimeType)};base64,${artifact.dataBase64}">`;
      } else if (artifact.metadata.mimeType === "application/pdf") {
        body.innerHTML = `<a class="kernel-primary" download="${escapeHtml(artifact.metadata.name)}" href="data:application/pdf;base64,${artifact.dataBase64}">Download PDF</a>`;
      } else {
        const bytes = Uint8Array.from(atob(artifact.dataBase64), (char) => char.charCodeAt(0));
        body.innerHTML = `<pre>${escapeHtml(new TextDecoder().decode(bytes).slice(0, 1e5))}</pre>`;
      }
      document.querySelector("#kernel-artifact-dialog")?.showModal();
    }
    async function switchSession(nextSessionId) {
      if (nextSessionId === sessionId && projection) return;
      detailState.clear();
      if (windowId === void 0 || !activeTabId) {
        throw new Error("No active browser tab is available");
      }
      await activateSession(
        () => client.bindTabSession(
          windowId,
          activeTabId,
          nextSessionId,
          activeGroupId
        )
      );
    }
    function showError(cause) {
      error = cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
      busy = false;
      busyStartedAt = 0;
      render();
    }
    try {
      const currentWindow = await chrome.windows.getCurrent();
      if (currentWindow.id === void 0) throw new Error("No browser window is available");
      windowId = currentWindow.id;
      document.documentElement.dataset.tinyaiWindowId = String(windowId);
      const [activeTab] = await chrome.tabs.query({
        active: true,
        windowId
      });
      if (activeTab?.id === void 0) throw new Error("No active browser tab is available");
      activeTabId = String(activeTab.id);
      activeGroupId = activeTab.groupId !== void 0 && activeTab.groupId >= 0 ? activeTab.groupId : void 0;
      await activateSession(
        () => client.resolveTabSession(windowId, activeTabId, activeGroupId)
      );
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (!/SESSION_NOT_FOUND|Session not found/i.test(message)) error = message;
    }
    skills = await client.listSkills().catch(() => []);
    const storedConfig = await chrome.storage.local.get(CONFIG_KEY).catch(() => ({}));
    const initialConfig = storedConfig[CONFIG_KEY] ?? {};
    modelLabel = String(initialConfig.model ?? "").trim() || String(initialConfig.connections?.[0]?.models?.[0] ?? "").trim() || (pageConfig.language.startsWith("zh") ? "\u9009\u62E9\u6A21\u578B" : "Choose model");
    const skillSelect = document.querySelector("#kernel-skill");
    if (skillSelect) {
      skillSelect.innerHTML = `<option value="">${pageConfig.language.startsWith("zh") ? "\u4E0D\u4F7F\u7528 Skill" : "No skill"}</option>` + skills.map(
        (skill) => `<option value="${escapeHtml(skill.name)}">${escapeHtml(skill.name)}${skill.description ? ` \xB7 ${escapeHtml(skill.description)}` : ""}</option>`
      ).join("");
    }
    render();
  }
  function emptyHtml(language = "en") {
    const zh = language.startsWith("zh");
    const prompts = zh ? [
      { icon: icons.file, text: "\u603B\u7ED3\u8FD9\u4E2A\u9875\u9762" },
      { icon: icons.paper, text: "\u8C03\u7814 arXiv \u4E0A\u7684\u76F8\u5173\u8BBA\u6587" },
      { icon: icons.list, text: "\u5E2E\u6211\u505A\u4E00\u4E2A\u95EE\u5377" }
    ] : [
      { icon: icons.file, text: "Summarize this page" },
      { icon: icons.paper, text: "Survey related arXiv papers" },
      { icon: icons.list, text: "Build a questionnaire" }
    ];
    return `<div class="wb-empty kernel-empty">
    <div class="wb-empty-head">
      <img class="wb-empty-avatar" src="icon/tinyai.svg" alt="" aria-hidden="true">
      <div class="wb-empty-title">${zh ? "\u4F60\u597D\uFF0C\u60F3\u8BA9\u6211\u505A\u4EC0\u4E48\uFF1F" : "What should tinyai do?"}</div>
    </div>
    <div class="wb-prompt-chips">
      ${prompts.map((prompt) => `<button type="button" class="wb-prompt-chip" data-kernel-prompt="${escapeHtml(prompt.text)}">${prompt.icon}<span>${escapeHtml(prompt.text)}</span></button>`).join("")}
    </div>
  </div>`;
  }
  function renderTurnUnit(unit, language, showReasoning) {
    return `<article class="kernel-turn" data-product-turn="${escapeHtml(unit.productTurnId)}">
    ${unit.segments.map((segment) => renderWorkSegment(segment, language, showReasoning)).join("")}
  </article>`;
  }
  function renderWorkSegment(segment, language, showReasoning) {
    const zh = language.startsWith("zh");
    const user = segment.user ? renderUserRow(segment.user.text) : "";
    const workItems = segment.workItems.map((item) => renderWorkItem(item, showReasoning, language)).filter(Boolean);
    const work = workItems.length ? renderWorkHistory(segment, workItems.join(""), language) : "";
    const answer = segment.latestAssistant ? renderAssistantRow(segment.latestAssistant, language, true) : "";
    const tail = segment.tailRows.map((row) => renderTailRow(row, showReasoning, language)).filter(Boolean).join("");
    return `<section class="kernel-work-segment kernel-work-segment--${escapeHtml(segment.state)}">
    ${user}
    ${work}
    ${answer}
    ${tail || (segment.running && !answer ? `<div class="kernel-turn-placeholder">${zh ? "\u6B63\u5728\u51C6\u5907\u56DE\u590D\u2026" : "Preparing a response\u2026"}</div>` : "")}
  </section>`;
  }
  function renderUserRow(text) {
    return `<div class="wb-stream-row kernel-message-row kernel-message-row--user">
    <div class="wb-msg wb-msg-user"><div class="wb-user-bubble">${escapeHtml(text)}</div></div>
  </div>`;
  }
  function renderWorkHistory(segment, content, language) {
    const zh = language.startsWith("zh");
    if (segment.running) {
      return `<section class="kernel-work kernel-work--running" aria-live="polite">
      <div class="kernel-work-items">${content}</div>
    </section>`;
    }
    const forceOpen = segment.state === "failed" || segment.state === "cancelled";
    return `<details class="kernel-work kernel-work--${escapeHtml(segment.state)}" data-ui-key="work:${escapeHtml(segment.key)}"${forceOpen ? ' data-force-open="true"' : ""}${segment.defaultOpen ? " open" : ""}>
    <summary class="kernel-work-summary">
      <span class="kernel-work-summary-icon" aria-hidden="true">${icons.sparkle}</span>
      <span>${escapeHtml(workStateLabel(segment, language))}</span>
      ${segment.state === "failed" ? `<span class="kernel-work-state">${zh ? "\u5931\u8D25" : "Failed"}</span>` : ""}
      ${segment.state === "cancelled" ? `<span class="kernel-work-state">${zh ? "\u5DF2\u505C\u6B62" : "Stopped"}</span>` : ""}
      <span class="kernel-work-chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="kernel-work-items">${content}</div>
  </details>`;
  }
  function renderWorkItem(item, showReasoning, language) {
    if (item.kind === "reasoning" && item.row) {
      return renderReasoningRow(item.row, showReasoning, language);
    }
    if (item.kind === "tool" && item.row) {
      return renderToolRow(item.row, language);
    }
    if (item.kind === "tool-group" && item.group) {
      return renderToolGroup(item.group.family, item.group.rows, language);
    }
    if (item.kind === "child" && item.child) {
      return renderChildRow(item.child, language);
    }
    if (item.kind === "assistant" && item.row) {
      return renderAssistantRow(item.row, language, false);
    }
    if (item.kind === "plan" && item.row) {
      return renderPlanRow(item.row, language);
    }
    if (item.kind === "activity" && item.row) {
      return renderActivityRow(item.row, language);
    }
    return "";
  }
  function renderReasoningRow(row, showReasoning, language) {
    if (!showReasoning || !row.text.trim()) return "";
    const zh = language.startsWith("zh");
    const running = row.status === "streaming" || row.status === "pending";
    return `<details class="kernel-reasoning" data-ui-key="reasoning:${escapeHtml(row.id)}">
    <summary>
      <span class="kernel-reasoning-icon" aria-hidden="true">${icons.sparkle}</span>
      <span>${zh ? "\u63A8\u7406\u8FC7\u7A0B" : "Reasoning"}</span>
      ${running ? `<span class="kernel-reasoning-running">${zh ? "\u601D\u8003\u4E2D" : "Thinking"}</span>` : ""}
      <span class="kernel-work-chevron" aria-hidden="true">${icons.chevronRight}</span>
    </summary>
    <div class="kernel-reasoning-body">${escapeHtml(row.text)}</div>
  </details>`;
  }
  function renderToolRow(row, language) {
    const zh = language.startsWith("zh");
    const running = row.status === "pending" || row.status === "streaming";
    const failed = row.status === "failed" || row.status === "denied";
    const status = row.status === "denied" ? zh ? "\u5DF2\u62D2\u7EDD" : "Denied" : failed ? zh ? "\u5931\u8D25" : "Failed" : running ? zh ? "\u6267\u884C\u4E2D" : "Running" : "";
    return `<div class="wb-stream-row kernel-tool-row">
    <details class="wb-step kernel-tool-step" data-call-id="${escapeHtml(row.callId ?? row.id)}" data-ui-key="tool:${escapeHtml(row.id)}"${failed ? ' data-force-open="true"' : ""}${failed || running ? " open" : ""}>
      <summary class="wb-step-row">
        <span class="wb-step-ico" aria-hidden="true">${familyIcon(toolFamily(row.toolName ?? ""))}</span>
        <span class="wb-step-text">
          <span class="wb-step-name">${escapeHtml(toolSummary(row.toolName ?? "tool"))}</span>
          ${status ? `<span class="wb-tool-status${running ? " wb-tool-status--running" : failed ? " wb-tool-status--error" : ""}">${status}</span>` : ""}
        </span>
        <span class="wb-tool-group-chev" aria-hidden="true">${icons.chevronRight}</span>
      </summary>
      <div class="wb-tool-body"><div class="wb-tool-card">${row.text ? toolOutput(row.toolName, row.text) : `<pre class="wb-kv-block">${running ? zh ? "\u6267\u884C\u4E2D\u2026" : "Running\u2026" : zh ? "\uFF08\u65E0\u8F93\u51FA\uFF09" : "(no output)"}</pre>`}</div></div>
    </details>
  </div>`;
  }
  function renderToolGroup(family, rows, language) {
    return `<section class="kernel-tool-group">
    <div class="kernel-tool-group-head">
      <span class="kernel-tool-group-icon" aria-hidden="true">${familyIcon(family)}</span>
      <span>${escapeHtml(familySummary(family, rows.length, language))}</span>
    </div>
    <div class="kernel-tool-group-rows">
      ${rows.map((row) => renderToolRow(row, language)).join("")}
    </div>
  </section>`;
  }
  function renderAssistantRow(row, language, withFeedback) {
    if (!row.text && !withFeedback) return "";
    const zh = language.startsWith("zh");
    const body = row.text ? `${md(row.text)}${row.status === "streaming" ? '<span class="wb-cursor"></span>' : ""}` : "";
    const feedback = withFeedback && row.status === "completed" ? `<div class="wb-feedback">
        <button type="button" class="wb-mini-action" data-copy-message="${escapeHtml(row.id)}">${icons.file}${zh ? "\u590D\u5236" : "Copy"}</button>
        <button type="button" class="wb-mini-action" data-export-message="${escapeHtml(row.id)}">${zh ? "\u5BFC\u51FA" : "Export"}</button>
      </div>` : "";
    return `<div class="wb-stream-row kernel-message-row kernel-answer-row">
    <div class="wb-msg"><div class="wb-assistant"><div class="wb-assistant-body">${body}</div>${feedback}</div></div>
  </div>`;
  }
  function renderPlanRow(row, language) {
    const zh = language.startsWith("zh");
    return `<details class="kernel-plan-inline" data-ui-key="plan:${escapeHtml(row.id)}">
    <summary>${zh ? "\u8BA1\u5212" : "Plan"} \xB7 ${escapeHtml(statusLabel(row.status, language))}</summary>
    <div>${md(row.text)}</div>
  </details>`;
  }
  function renderActivityRow(row, language) {
    if (row.text === "Thinking" || row.text === "Thinking complete") return "";
    const running = row.status === "streaming" || row.status === "pending";
    return `<div class="kernel-activity${running ? " is-running" : ""}">
    <span class="kernel-activity-mark" aria-hidden="true"></span>
    <span>${escapeHtml(row.text)}</span>
  </div>`;
  }
  function renderChildRow(child, language) {
    const zh = language.startsWith("zh");
    return `<article class="kernel-child kernel-child--${escapeHtml(child.status)}" data-child-task="${escapeHtml(child.taskId)}">
    <span class="kernel-child-line" aria-hidden="true"></span>
    <span class="kernel-child-icon" aria-hidden="true">\u2301</span>
    <div class="kernel-child-copy">
      <div><strong>${escapeHtml(child.profileName)}</strong><span class="kernel-child-status">${escapeHtml(statusLabel(child.status, language))}</span></div>
      <p>${escapeHtml(child.summary ?? `${child.executionMode} \xB7 ${zh ? "\u7B49\u5F85\u9996\u6B21\u66F4\u65B0" : "waiting for first update"}`)}</p>
    </div>
    <button type="button" class="kernel-child-open" data-open-child="${escapeHtml(child.sessionId)}">${zh ? "\u67E5\u770B" : "View"}</button>
  </article>`;
  }
  function renderTailRow(row, showReasoning, language) {
    if (row.kind === "reasoning") return renderReasoningRow(row, showReasoning, language);
    if (row.kind === "tool") return renderToolRow(row, language);
    if (row.kind === "assistant") return renderAssistantRow(row, language, true);
    if (row.kind === "plan") return renderPlanRow(row, language);
    if (row.kind === "activity") return renderActivityRow(row, language);
    return "";
  }
  function restoreDetailState(root, state) {
    root.querySelectorAll("details[data-ui-key]").forEach((details) => {
      const key = details.dataset.uiKey;
      if (details.dataset.forceOpen === "true") details.open = true;
      else if (key && state.has(key)) details.open = state.get(key) ?? false;
    });
  }
  function toolSummary(name) {
    const family = toolFamily(name);
    if (family === "explore") return toolLabel(name);
    if (family === "browser") return toolLabel(name);
    if (family === "terminal") return toolLabel(name);
    if (family === "changes") return toolLabel(name);
    if (family === "subagent") return toolLabel(name);
    if (family === "artifact") return toolLabel(name);
    return toolLabel(name);
  }
  function familyLabel(family, language) {
    const zh = language.startsWith("zh");
    return {
      explore: zh ? "\u63A2\u7D22" : "Explore",
      browser: zh ? "\u6D4F\u89C8\u5668" : "Browser",
      terminal: zh ? "\u7EC8\u7AEF" : "Terminal",
      changes: zh ? "\u53D8\u66F4" : "Changes",
      subagent: zh ? "\u5B50 Agent" : "Subagents",
      artifact: zh ? "\u4EA7\u7269" : "Artifacts",
      other: zh ? "\u5DE5\u5177" : "Tools"
    }[family];
  }
  function familySummary(family, count, language) {
    const zh = language.startsWith("zh");
    if (family === "explore") return zh ? `\u63A2\u7D22\u4E86 ${count} \u4E2A\u6B65\u9AA4` : `Explored ${count} steps`;
    if (family === "browser") return zh ? `\u6D4F\u89C8\u5668\u64CD\u4F5C ${count} \u6B21` : `Used browser ${count} times`;
    if (family === "terminal") return zh ? `\u8FD0\u884C\u4E86 ${count} \u6761\u547D\u4EE4` : `Ran ${count} commands`;
    if (family === "changes") return zh ? `\u4FEE\u6539\u4E86 ${count} \u5904` : `Made ${count} changes`;
    if (family === "subagent") return zh ? `\u534F\u8C03\u4E86 ${count} \u4E2A\u5B50 Agent \u64CD\u4F5C` : `Coordinated ${count} subagent actions`;
    if (family === "artifact") return zh ? `\u751F\u6210\u4E86 ${count} \u4E2A\u4EA7\u7269` : `Created ${count} artifacts`;
    return `${familyLabel(family, language)} \xB7 ${count}`;
  }
  function familyIcon(family) {
    if (family === "browser" || family === "explore") return icons.globe;
    if (family === "terminal") return icons.file;
    if (family === "subagent") return icons.sparkle;
    if (family === "artifact") return icons.file;
    return icons.gear;
  }
  function toolLabel(name) {
    const labels = {
      list_tabs: "List tabs",
      list_frames: "Inspect frames",
      snapshot: "Read page structure",
      read_page: "Read page",
      find: "Find element",
      navigate: "Open page",
      click: "Click",
      mouse_click: "Click",
      fill: "Fill input",
      select_option: "Select option",
      wait: "Wait",
      screenshot: "Screenshot",
      spawn_agent: "Start subagent",
      send_message: "Message subagent",
      wait_agent: "Wait for subagent",
      stop_agent: "Stop subagent",
      list_agents: "List subagents",
      run_tests: "Run tests",
      read_file: "Read file",
      write_file: "Write file",
      list_files: "List files",
      exec: "Run command"
    };
    return labels[name] ?? name.replace(/_/g, " ");
  }
  function markModelOptionSelected(menu, connection, model) {
    menu.querySelectorAll("[data-kernel-model]").forEach((option) => {
      const selected = option.dataset.kernelModel === model && (option.dataset.kernelConnection ?? "") === connection;
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-pressed", selected ? "true" : "false");
      option.querySelector(".wb-pop-check")?.remove();
      if (selected) option.insertAdjacentHTML("beforeend", icons.check);
    });
  }
  function approvalSummary(name, input, zh) {
    const values = input && typeof input === "object" && !Array.isArray(input) ? input : {};
    const stringValue = (...keys) => {
      const value = keys.map((key) => values[key]).find((item) => typeof item === "string");
      return typeof value === "string" ? value : "";
    };
    const target = stringValue("url", "path", "selector", "command", "profile", "reason");
    const suffix = target ? ` \xB7 ${truncateText(target, 90)}` : "";
    if (name === "navigate") return `${zh ? "\u6253\u5F00\u9875\u9762" : "Open page"}${suffix}`;
    if (name === "exec") return `${zh ? "\u6267\u884C\u547D\u4EE4" : "Run command"}${suffix}`;
    if (name === "run_tests") return `${zh ? "\u8FD0\u884C\u6D4B\u8BD5" : "Run tests"}${suffix}`;
    if (name === "write_file" || name === "apply_patch" || name === "apply_unified_diff" || name === "edit") {
      return `${zh ? "\u4FEE\u6539\u6587\u4EF6" : "Edit file"}${suffix}`;
    }
    if (name === "spawn_agent") return `${zh ? "\u542F\u52A8\u5B50 Agent" : "Start subagent"}${suffix}`;
    if (name === "await_user_action") {
      return target || (zh ? "\u9700\u8981\u4F60\u5B8C\u6210\u4E00\u6B21\u624B\u52A8\u64CD\u4F5C" : "Manual action required");
    }
    return `${toolLabel(name)}${suffix}`;
  }
  function truncateText(value, maxLength) {
    const compact = value.replace(/\s+/g, " ").trim();
    return compact.length > maxLength ? `${compact.slice(0, maxLength - 1)}\u2026` : compact;
  }
  function shell(config) {
    const zh = config.language.startsWith("zh");
    const theme = config.theme === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" : config.theme;
    return `<div class="wb-stage kernel-shell" data-wb-theme="${theme}" style="--wb-page-rgb: 83,177,255; --wb-dock-h: 160px;">
    <header class="wb-header">
      <div class="wb-pop-anchor wb-topnav-left">
        <button type="button" id="kernel-new" class="wb-topnav-circle wb-sk-tip-anchor" aria-label="${zh ? "\u65B0\u5EFA\u4EFB\u52A1" : "New task"}">
          ${icons.plus}<span class="wb-sk-tip is-down is-start" role="tooltip">${zh ? "\u65B0\u5EFA\u4EFB\u52A1" : "New task"}</span>
        </button>
        <button type="button" id="kernel-history" class="wb-topnav-circle wb-sk-tip-anchor" aria-label="${zh ? "\u804A\u5929\u8BB0\u5F55" : "History"}">
          ${icons.clock}<span class="wb-sk-tip is-down is-start" role="tooltip">${zh ? "\u804A\u5929\u8BB0\u5F55" : "History"}</span>
        </button>
      </div>
      <div class="wb-pop-anchor wb-topnav-settings">
        <button type="button" id="kernel-settings" class="wb-topnav-circle wb-sk-tip-anchor" aria-label="${zh ? "\u8BBE\u7F6E" : "Settings"}">
          ${icons.gear}<span class="wb-sk-tip is-down is-end" role="tooltip">${zh ? "\u8BBE\u7F6E" : "Settings"}</span>
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
            <textarea id="kernel-input" class="wb-editor kernel-editor" rows="1" placeholder="${zh ? "\u7ED9 tinyai \u53D1\u6D88\u606F\uFF0C\u6309 @ \u9009\u62E9\u6807\u7B7E\u9875\uFF0C/ \u67E5\u770B\u547D\u4EE4" : "Type a task, Enter to send"}" aria-label="${zh ? "\u4EFB\u52A1" : "Task"}"></textarea>
          </div>
          <input id="kernel-file-input" type="file" multiple accept="text/*,image/*,.md,.ts,.tsx,.js,.jsx,.json,.css,.html,.txt" hidden>
          <div class="wb-input-bar">
            <button type="button" id="kernel-tabs" class="wb-icon-button wb-sk-tip-anchor" aria-label="${zh ? "\u9009\u62E9\u6807\u7B7E\u9875" : "Select tabs"}">
              <span class="wb-composer-glyph wb-composer-glyph--at" aria-hidden="true"></span><span class="wb-sk-tip is-start" role="tooltip">${zh ? "\u9009\u62E9\u6807\u7B7E\u9875" : "Select tabs"}</span>
            </button>
            <button type="button" id="kernel-slash" class="wb-icon-button wb-sk-tip-anchor" aria-label="${zh ? "\u547D\u4EE4" : "Commands"}">
              <span class="wb-composer-glyph wb-composer-glyph--skill" aria-hidden="true"></span><span class="wb-sk-tip is-start" role="tooltip">${zh ? "\u547D\u4EE4" : "Commands"}</span>
            </button>
            <button type="button" id="kernel-attach" class="wb-icon-button wb-sk-tip-anchor" aria-label="${zh ? "\u6DFB\u52A0\u6587\u4EF6\u6216\u56FE\u7247" : "Add a file or image"}">
              <span class="wb-composer-glyph wb-composer-glyph--clip" aria-hidden="true"></span><span class="wb-sk-tip" role="tooltip">${zh ? "\u6DFB\u52A0\u6587\u4EF6\u6216\u56FE\u7247" : "Add a file or image"}</span>
            </button>
            <div id="kernel-tab-menu" class="kernel-command-menu kernel-tab-menu" hidden></div>
            <div id="kernel-command-menu" class="kernel-command-menu" hidden>
              <div class="wb-menu-heading">Skills</div>
              <select id="kernel-skill" class="kernel-skill-select" aria-label="Skill"><option value="">No skill</option></select>
              <div class="wb-menu-heading">Commands</div>
              <button type="button" id="kernel-mode" class="kernel-tool-button">${zh ? "\u8BA1\u5212\u6A21\u5F0F" : "Plan mode"}</button>
              <button type="button" id="kernel-compact" class="kernel-tool-button" hidden>${zh ? "\u538B\u7F29\u4E0A\u4E0B\u6587" : "Compact context"}</button>
              <button type="button" id="kernel-approve-plan" class="kernel-tool-button" hidden>${zh ? "\u6279\u51C6\u8BA1\u5212" : "Approve plan"}</button>
            </div>
            <span class="wb-input-grow"></span>
            <div class="wb-pop-anchor wb-composer-model">
              <button type="button" id="kernel-model" class="wb-mode-toggle"><span id="kernel-model-label" class="wb-model-name">${zh ? "\u9009\u62E9\u6A21\u578B" : "Choose model"}</span>${icons.chevron}</button>
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
  function statusText(projection, busy, error, busyStartedAt, blockingInteraction, language = "en") {
    const zh = language.startsWith("zh");
    if (error) return error;
    if (!projection) return busy ? zh ? "\u6B63\u5728\u542F\u52A8\u2026" : "Starting\u2026" : zh ? "\u53EF\u4EE5\u5F00\u59CB\u65B0\u4EFB\u52A1" : "Ready for a new task";
    if (busy) {
      const elapsed = busyStartedAt ? ` \xB7 ${Math.floor((Date.now() - busyStartedAt) / 1e3)}s` : "";
      if (blockingInteraction) return `${zh ? "\u7B49\u5F85\u4F60\u7684\u8F93\u5165" : "Waiting for your input"}${elapsed}`;
      if (projection.taskStatus === "waiting") return `${zh ? "\u7B49\u5F85\u4E2D" : "Waiting"}${elapsed}`;
      if (projection.rows.some((row) => row.kind === "tool" && row.status === "pending")) {
        return `${zh ? "\u6B63\u5728\u6267\u884C\u5DE5\u5177" : "Running tool"}${elapsed}`;
      }
      if (projection.rows.some((row) => row.kind === "assistant" && row.status === "streaming" && row.text)) {
        return `${zh ? "\u6B63\u5728\u8F93\u51FA" : "Writing"}${elapsed}`;
      }
      return `${zh ? "\u601D\u8003\u4E2D" : "Thinking"}${elapsed}`;
    }
    return projection.taskStatus === "failed" ? projection.lastError?.message ?? (zh ? "\u4EFB\u52A1\u5931\u8D25" : "Task failed") : zh ? "\u5C31\u7EEA" : "Ready";
  }
  function toolOutput(name, text) {
    if (name === "screenshot") {
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed.dataUrl === "string" && parsed.dataUrl.startsWith("data:image/")) {
          return `<img class="kernel-tool-image" src="${escapeHtml(parsed.dataUrl)}" alt="Page screenshot">`;
        }
      } catch {
      }
    }
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.artifact?.artifactId === "string") {
        return `<button type="button" class="kernel-artifact-link" data-artifact="${escapeHtml(parsed.artifact.artifactId)}">
        Open artifact: ${escapeHtml(String(parsed.artifact.name ?? parsed.artifact.artifactId))}
        ${typeof parsed.artifact.bytes === "number" ? ` \xB7 ${parsed.artifact.bytes} bytes` : ""}
      </button>`;
      }
    } catch {
    }
    return `<pre>${escapeHtml(text.length > 8e3 ? `${text.slice(0, 8e3)}
\u2026(truncated in UI)` : text)}</pre>`;
  }
  function themeLabel(theme, zh) {
    if (theme === "dark") return zh ? "\u6DF1\u8272" : "Dark mode";
    if (theme === "system") return zh ? "\u8DDF\u968F\u7CFB\u7EDF" : "System";
    return zh ? "\u6D45\u8272" : "Light mode";
  }
  function errorMessage(cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
  function isMissingTabError(cause) {
    return cause instanceof Error && cause.name === "BROWSER_TAB_NOT_FOUND";
  }
  function isInspectablePageUrl(url) {
    return /^(https?|file):/.test(String(url ?? "")) || url === "about:blank";
  }
  function statusLabel(status, language) {
    if (!language.startsWith("zh")) return status;
    return {
      completed: "\u5DF2\u5B8C\u6210",
      running: "\u6267\u884C\u4E2D",
      queued: "\u6392\u961F\u4E2D",
      waiting: "\u7B49\u5F85\u4E2D",
      failed: "\u5931\u8D25",
      cancelled: "\u5DF2\u53D6\u6D88",
      denied: "\u5DF2\u62D2\u7EDD"
    }[status] ?? status;
  }

  // src/sidepanel.ts
  async function init() {
    try {
      await initKernelUi();
    } catch (error) {
      console.error("tinyai init failed", error);
      const root = document.querySelector("#root");
      if (root) {
        root.textContent = "tinyai failed to start. Open chrome://extensions and reload the extension.";
      }
    }
  }
  init();
})();
