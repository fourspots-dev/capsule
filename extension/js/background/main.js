"use strict";
(() => {
  // src/core/errors.ts
  var AgentError = class extends Error {
    code;
    retryable;
    details;
    constructor(code, message, options = {}) {
      super(message);
      this.name = "AgentError";
      this.code = code;
      this.retryable = options.retryable ?? false;
      this.details = options.details;
    }
    toStructured() {
      return {
        code: this.code,
        message: this.message,
        retryable: this.retryable,
        ...this.details === void 0 ? {} : { details: this.details }
      };
    }
  };
  function toStructuredError(error, fallbackCode = "INTERNAL_ERROR") {
    if (error instanceof AgentError) return error.toStructured();
    return {
      code: fallbackCode,
      message: error instanceof Error ? error.message : String(error),
      retryable: false
    };
  }
  function isAbortError(error) {
    return error instanceof Error && error.name === "AbortError" || error instanceof AgentError && error.code === "TASK_CANCELLED";
  }

  // src/adapters/chrome-browser.ts
  var INTERACTIVE_ROLES = /* @__PURE__ */ new Set([
    "button",
    "link",
    "textbox",
    "checkbox",
    "radio",
    "combobox",
    "listbox",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "searchbox",
    "slider",
    "spinbutton",
    "switch",
    "tab",
    "treeitem"
  ]);
  var PAPER_SIZES = {
    letter: [8.5, 11],
    legal: [8.5, 14],
    a4: [8.27, 11.69],
    a3: [11.69, 16.54],
    tabloid: [11, 17]
  };
  var ChromeBrowserProvider = class {
    tabs;
    debuggerApi;
    tabGroups;
    clock;
    sessions = /* @__PURE__ */ new Map();
    attachedTabs = /* @__PURE__ */ new Set();
    refs = /* @__PURE__ */ new Map();
    frameContexts = /* @__PURE__ */ new Map();
    dialogs = /* @__PURE__ */ new Map();
    networkStates = /* @__PURE__ */ new Map();
    onDebuggerEvent = (source, method, params) => {
      const tabId = String(source.tabId ?? "");
      if (!tabId) return;
      if (method === "Page.javascriptDialogOpening") {
        this.dialogs.set(tabId, params ?? {});
      } else if (method === "Page.javascriptDialogClosed") {
        this.dialogs.delete(tabId);
      } else if (method === "Network.requestWillBeSent") {
        this.networkRequest(tabId, params);
      } else if (method === "Network.responseReceived") {
        this.networkResponse(tabId, params);
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        this.networkFinished(tabId, params, method === "Network.loadingFailed");
      }
    };
    constructor(options = {}) {
      const defaults = options.tabs && options.debugger ? void 0 : defaultChromeApis();
      this.tabs = options.tabs ?? defaults.tabs;
      this.debuggerApi = options.debugger ?? defaults.debugger;
      this.tabGroups = options.tabGroups ?? defaults?.tabGroups;
      this.clock = options.clock ?? {
        now: () => Date.now(),
        setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms)
      };
      this.debuggerApi.onEvent.addListener(this.onDebuggerEvent);
    }
    async listTabs() {
      const tabs = await this.tabs.query({});
      return tabs.filter((tab) => isInspectable(tab.url)).filter((tab) => tab.id !== void 0).map(toDescriptor);
    }
    async getTab(tabId) {
      try {
        const tab = await this.tabs.get(Number(tabId));
        return isInspectable(tab.url) ? toDescriptor(tab) : null;
      } catch {
        return null;
      }
    }
    async createTab(url = "about:blank", options = {}) {
      const tab = await this.tabs.create({
        url: safeUrl(url),
        active: options.active ?? true
      });
      if (tab.id === void 0) throw new AgentError("BROWSER_TAB_CREATE_FAILED", "Chrome returned a tab without an id");
      return toDescriptor(tab);
    }
    async activateTab(tabId) {
      await this.tabs.update(Number(tabId), { active: true });
    }
    async removeTab(tabId) {
      await this.detach(tabId).catch(() => void 0);
      await this.tabs.remove(Number(tabId));
      for (const binding of this.sessions.values()) {
        binding.attached.delete(tabId);
        binding.ownedTabs.delete(tabId);
        if (binding.tabId === tabId) binding.tabId = "";
      }
      this.clearRefs(tabId);
      this.clearFrameContexts(tabId);
      this.dialogs.delete(tabId);
      this.attachedTabs.delete(tabId);
    }
    async ensureTaskGroup(sessionId) {
      const existing = this.sessions.get(sessionId);
      if (existing) return this.groupRef(sessionId, existing);
      const selected = (await this.listTabs()).find((tab) => tab.active);
      if (!selected) {
        throw new AgentError(
          "BROWSER_ACTIVE_TAB_UNAVAILABLE",
          "No inspectable active Chrome tab is available"
        );
      }
      const binding = {
        tabId: selected.id,
        ownedTabs: /* @__PURE__ */ new Set(),
        attached: /* @__PURE__ */ new Set()
      };
      if (selected.groupId !== void 0 && selected.groupId >= 0) {
        binding.groupId = selected.groupId;
      } else if (this.tabs.group) {
        try {
          binding.groupId = await this.tabs.group({ tabIds: [Number(selected.id)] });
          await this.tabGroups?.update(binding.groupId, {
            title: tabGroupTitle(selected.title),
            color: "blue"
          });
        } catch {
        }
      }
      this.sessions.set(sessionId, binding);
      return this.groupRef(sessionId, binding);
    }
    async setWorkingTab(sessionId, tabId, options = {}) {
      const tab = await this.getTab(tabId);
      if (!tab) throw new AgentError("BROWSER_TAB_NOT_FOUND", `Tab not found: ${tabId}`);
      const binding = this.sessions.get(sessionId) ?? {
        tabId,
        ownedTabs: /* @__PURE__ */ new Set(),
        attached: /* @__PURE__ */ new Set()
      };
      binding.tabId = tabId;
      if (tab.groupId !== void 0 && tab.groupId >= 0) {
        binding.groupId = tab.groupId;
      }
      this.sessions.set(sessionId, binding);
      if (binding.groupId !== void 0) {
        await this.tabGroups?.update(binding.groupId, { title: tabGroupTitle(tab.title) }).catch(() => void 0);
      }
      if (options.activate !== false) await this.activateTab(tabId);
    }
    async getWorkingTab(sessionId) {
      const binding = this.sessions.get(sessionId);
      if (!binding?.tabId) return null;
      return await this.getTab(binding.tabId) ? binding.tabId : null;
    }
    async addTabToSession(sessionId, tabId, options = {}) {
      const tab = await this.waitForTab(tabId);
      if (!tab) throw new AgentError("BROWSER_TAB_NOT_FOUND", `Tab not found: ${tabId}`);
      const binding = this.sessions.get(sessionId);
      if (!binding) {
        throw new AgentError("BROWSER_SESSION_NOT_FOUND", `Browser session not found: ${sessionId}`);
      }
      if (!this.tabs.group) {
        throw new AgentError("BROWSER_GROUP_UNAVAILABLE", "Chrome tabGroups are unavailable");
      }
      const existingGroup = binding.groupId ?? (await this.getTab(binding.tabId))?.groupId;
      binding.groupId = existingGroup !== void 0 && existingGroup >= 0 ? await this.tabs.group({
        groupId: existingGroup,
        tabIds: [Number(tabId)]
      }) : await this.tabs.group({
        tabIds: [Number(binding.tabId), Number(tabId)]
      });
      binding.tabId = tabId;
      if (options.owned) binding.ownedTabs.add(tabId);
      this.sessions.set(sessionId, binding);
      await this.tabGroups?.update(binding.groupId, { title: tabGroupTitle(tab.title) }).catch(() => void 0);
      return this.groupRef(sessionId, binding);
    }
    async listSessionTabs(sessionId) {
      const binding = this.sessions.get(sessionId);
      if (!binding) return [];
      if (binding.groupId !== void 0) {
        return (await this.listTabs()).filter(
          (tab2) => tab2.groupId === binding.groupId
        );
      }
      const tab = await this.getTab(binding.tabId);
      return tab ? [tab] : [];
    }
    async assertSessionTab(sessionId, tabId) {
      const tabs = await this.listSessionTabs(sessionId);
      if (!tabs.some((tab) => tab.id === tabId)) {
        throw new AgentError(
          "TARGET_OUTSIDE_WORKSPACE",
          `Tab ${tabId} does not belong to session ${sessionId}`
        );
      }
    }
    async closeSessionTabs(sessionId) {
      const binding = this.sessions.get(sessionId);
      if (!binding) {
        return { sessionId, detachedTabs: [], closedTabs: [], errors: [] };
      }
      const detachedTabs = [];
      const closedTabs = [];
      const errors = [];
      for (const tabId of binding.attached) {
        if (!this.attachedTabs.has(tabId)) continue;
        try {
          await this.detach(tabId);
          detachedTabs.push(tabId);
        } catch (error) {
          errors.push(toStructuredError(error, "BROWSER_DETACH_FAILED"));
        }
      }
      for (const tabId of binding.ownedTabs) {
        try {
          await this.tabs.remove(Number(tabId));
          closedTabs.push(tabId);
        } catch (error) {
          errors.push(toStructuredError(error, "BROWSER_TAB_CLOSE_FAILED"));
        }
      }
      this.sessions.delete(sessionId);
      this.refs.clear();
      this.frameContexts.clear();
      return { sessionId, detachedTabs, closedTabs, errors };
    }
    async releaseSession(sessionId) {
      const binding = this.sessions.get(sessionId);
      if (!binding) return;
      for (const tabId of binding.attached) {
        await this.detach(tabId).catch(() => void 0);
      }
      const groupedTabs = new Set([binding.tabId, ...binding.ownedTabs].filter(Boolean));
      const sharedGroup = binding.groupId !== void 0 && [...this.sessions.entries()].some(
        ([otherSession, other]) => otherSession !== sessionId && other.groupId === binding.groupId
      );
      if (this.tabs.ungroup && groupedTabs.size && !sharedGroup) {
        await this.tabs.ungroup([...groupedTabs].map(Number)).catch(() => void 0);
      }
      this.sessions.delete(sessionId);
    }
    async listFrames(tabId) {
      const result = await this.cdp(tabId, "Page.getFrameTree");
      return flattenFrames(result.frameTree);
    }
    async navigate(tabId, url, signal) {
      assertActive(signal);
      await this.tabs.update(Number(tabId), { url: safeUrl(url) });
      this.clearRefs(tabId);
      this.clearFrameContexts(tabId);
      await this.waitForScript(
        tabId,
        "document.readyState === 'complete'",
        2e4,
        signal
      ).catch(() => false);
      return this.pageInfo(tabId);
    }
    async snapshot(tabId, options = {}) {
      assertActive(options.signal);
      await this.cdp(tabId, "Accessibility.enable", {}, options.signal).catch(() => void 0);
      const result = await this.cdp(
        tabId,
        "Accessibility.getFullAXTree",
        options.frameId ? { frameId: options.frameId } : {},
        options.signal
      );
      const info = await this.pageInfo(tabId, options.frameId);
      const rendered = this.renderAx(
        tabId,
        options.frameId,
        result.nodes ?? [],
        options.maxChars ?? 12e3,
        options.interactiveOnly ?? false
      );
      return {
        ...info,
        ...options.frameId ? { frameId: options.frameId } : {},
        nodes: rendered.nodes,
        text: rendered.text,
        truncated: rendered.truncated,
        capturedAt: this.clock.now()
      };
    }
    async readText(tabId, maxChars = 3e4, options = {}) {
      return this.evaluate(
        tabId,
        `String((document.body?.innerText ?? '').slice(0, ${Math.max(1, maxChars)}))`,
        options
      );
    }
    async evaluate(tabId, expression, options = {}) {
      const contextId = options.frameId ? await this.frameContext(tabId, options.frameId) : void 0;
      const result = await this.cdp(tabId, "Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
        ...contextId === void 0 ? {} : { contextId }
      }, options.signal);
      if (result?.exceptionDetails) {
        throw new AgentError(
          "BROWSER_EVALUATION_FAILED",
          result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "Page evaluation failed"
        );
      }
      return result?.result?.value;
    }
    async click(tabId, target) {
      const objectId = await this.objectId(tabId, target);
      const result = await this.cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: "function(){ this.click(); return true; }",
        returnByValue: true
      });
      throwOnException(result, "click");
    }
    async mouseClick(tabId, target) {
      const objectId = await this.objectId(tabId, target);
      const center = await this.boxCenter(tabId, objectId);
      if (!center) throw new AgentError("BROWSER_ELEMENT_NOT_VISIBLE", "Element has no layout box");
      await this.dispatchMouse(tabId, "mouseMoved", center[0], center[1]);
      await this.dispatchMouse(tabId, "mousePressed", center[0], center[1]);
      await this.dispatchMouse(tabId, "mouseReleased", center[0], center[1]);
      return { x: Math.trunc(center[0]), y: Math.trunc(center[1]) };
    }
    async hover(tabId, target) {
      const objectId = await this.objectId(tabId, target);
      const center = await this.boxCenter(tabId, objectId);
      if (!center) throw new AgentError("BROWSER_ELEMENT_NOT_VISIBLE", "Element has no layout box");
      await this.dispatchMouse(tabId, "mouseMoved", center[0], center[1]);
      return { x: Math.trunc(center[0]), y: Math.trunc(center[1]) };
    }
    async fill(tabId, target, value) {
      const objectId = await this.objectId(tabId, target);
      const result = await this.cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(v) {
        this.focus();
        if (this.isContentEditable) {
          this.textContent = v;
          this.dispatchEvent(new InputEvent('input', {bubbles: true, data: v, inputType: 'insertText'}));
          return true;
        }
        const proto = this.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'value');
        if (desc && desc.set) desc.set.call(this, v); else this.value = v;
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
        return true;
      }`,
        arguments: [{ value }],
        returnByValue: true
      });
      throwOnException(result, "fill");
    }
    async selectOption(tabId, target, values = []) {
      const objectId = await this.objectId(tabId, target);
      const result = await this.cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `function(values) {
        if (!('options' in this)) throw new Error('Element is not a select control');
        const options = Array.from(this.options).map(o => ({value: o.value, label: o.text, selected: o.selected}));
        if (!values.length) return { selected: [], options };
        for (const option of this.options) {
          if (values.includes(option.value) || values.some(v => v.toLowerCase() === option.text.toLowerCase())) option.selected = true;
        }
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
        return { selected: Array.from(this.selectedOptions).map(o => o.value) };
      }`,
        arguments: [{ value: values }],
        returnByValue: true
      });
      throwOnException(result, "select option");
      return result?.result?.value;
    }
    async drag(tabId, from, to) {
      const fromId = await this.objectId(tabId, from);
      const toId = await this.objectId(tabId, to);
      const start = await this.boxCenter(tabId, fromId);
      const end = await this.boxCenter(tabId, toId);
      if (!start || !end) throw new AgentError("BROWSER_ELEMENT_NOT_VISIBLE", "Drag target has no layout box");
      await this.dispatchMouse(tabId, "mouseMoved", start[0], start[1]);
      await this.dispatchMouse(tabId, "mousePressed", start[0], start[1]);
      for (let step = 1; step <= 10; step += 1) {
        await this.cdp(tabId, "Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: start[0] + (end[0] - start[0]) * step / 10,
          y: start[1] + (end[1] - start[1]) * step / 10,
          button: "left",
          buttons: 1
        });
      }
      await this.dispatchMouse(tabId, "mouseReleased", end[0], end[1]);
    }
    async scroll(tabId, options) {
      return this.evaluate(
        tabId,
        `(() => {
        const root = document.scrollingElement || document.documentElement;
        let found = null;
        if (${JSON.stringify(Boolean(options.text))}) {
          const needle = ${JSON.stringify(options.text ?? "")}.toLowerCase();
          const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.textContent && node.textContent.toLowerCase().includes(needle)) { found = node.parentElement; break; }
          }
        }
        if (${JSON.stringify(Boolean(options.selector))}) found = document.querySelector(${JSON.stringify(options.selector ?? "")});
        if (found) found.scrollIntoView({block: 'center'});
        else if (${JSON.stringify(options.to ?? "")} === 'top') root.scrollTo(0, 0);
        else if (${JSON.stringify(options.to ?? "")} === 'bottom') root.scrollTo(0, root.scrollHeight);
        else root.scrollBy(0, (${JSON.stringify(options.direction ?? "down")} === 'up' ? -1 : 1) * Math.round(innerHeight * 0.9));
        const y = Math.round(scrollY || root.scrollTop || 0);
        return {scrollY: y, atTop: y <= 1, atBottom: y >= root.scrollHeight - innerHeight - 1, found: !!found};
      })()`,
        { frameId: options.frameId, signal: options.signal }
      );
    }
    async upload(tabId, target, files) {
      const objectId = await this.objectId(
        tabId,
        target ?? { selector: "input[type=file]" }
      );
      const result = await this.cdp(tabId, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `async function(files) {
        const dt = new DataTransfer();
        for (const f of files) {
          const bin = atob(f.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          dt.items.add(new File([bytes], f.name, {type: f.type}));
        }
        this.files = dt.files;
        this.dispatchEvent(new Event('input', {bubbles: true}));
        this.dispatchEvent(new Event('change', {bubbles: true}));
        return this.files.length;
      }`,
        arguments: [{ value: files }],
        awaitPromise: true,
        returnByValue: true
      });
      throwOnException(result, "upload");
      return Number(result?.result?.value ?? 0);
    }
    async waitFor(tabId, condition, signal, options = {}) {
      let expression;
      if (condition.selector) {
        expression = `(() => { const e = document.querySelector(${JSON.stringify(condition.selector)}); if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`;
      } else if (condition.textGone) {
        expression = `!(document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(condition.textGone.toLowerCase())}))`;
      } else if (condition.text) {
        expression = `!!(document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(condition.text.toLowerCase())}))`;
      } else {
        throw new AgentError("BROWSER_WAIT_INVALID", "waitFor requires text, textGone, or selector");
      }
      return this.waitForScript(
        tabId,
        expression,
        condition.timeoutMs ?? 1e4,
        signal,
        options.frameId
      );
    }
    async screenshot(tabId, format = "png") {
      const result = await this.cdp(tabId, "Page.captureScreenshot", { format });
      if (!result.data) throw new AgentError("BROWSER_SCREENSHOT_FAILED", "CDP returned no screenshot");
      return { dataUrl: `data:image/${format};base64,${result.data}`, format };
    }
    async printToPdf(tabId, options = {}) {
      const [width, height] = PAPER_SIZES[options.paperFormat ?? "letter"];
      const result = await this.cdp(tabId, "Page.printToPDF", {
        paperWidth: options.landscape ? height : width,
        paperHeight: options.landscape ? width : height,
        landscape: options.landscape ?? false,
        scale: options.scale ?? 1,
        printBackground: options.printBackground ?? true
      });
      if (!result.data) throw new AgentError("BROWSER_PDF_FAILED", "CDP returned no PDF");
      return { dataBase64: result.data, bytes: Math.floor(result.data.length * 3 / 4) };
    }
    async dialog(tabId, action, text = "") {
      if (action === "status") {
        const dialog = this.dialogs.get(tabId);
        return dialog ? {
          open: true,
          ...typeof dialog.message === "string" ? { message: dialog.message } : {},
          ...typeof dialog.type === "string" ? { type: dialog.type } : {},
          ...typeof dialog.defaultPrompt === "string" ? { defaultPrompt: dialog.defaultPrompt } : {}
        } : { open: false };
      }
      await this.cdp(tabId, "Page.handleJavaScriptDialog", {
        accept: action === "accept",
        ...text ? { promptText: text } : {}
      });
      this.dialogs.delete(tabId);
      return { accepted: action === "accept" };
    }
    async network(tabId, command) {
      if (command.cmd === "start") {
        this.networkStates.set(tabId, { enabled: true, entries: /* @__PURE__ */ new Map(), order: [] });
        await this.cdp(tabId, "Network.enable");
        return "Started capturing network requests";
      }
      if (command.cmd === "stop") {
        const state = this.networkStates.get(tabId);
        if (state) state.enabled = false;
        await this.cdp(tabId, "Network.disable").catch(() => void 0);
        return "Stopped capturing network requests";
      }
      if (command.cmd === "list") {
        const state = this.networkStates.get(tabId);
        const filter = command.filter?.toLowerCase() ?? "";
        const entries = (state?.order ?? []).map((id) => state?.entries.get(id)).filter((entry) => Boolean(entry)).filter((entry) => !filter || entry.url.toLowerCase().includes(filter)).slice(0, 100);
        return { entries };
      }
      if (command.cmd !== "detail") {
        throw new AgentError("BROWSER_NETWORK_COMMAND_INVALID", `Unknown network command: ${command.cmd}`);
      }
      const result = await this.cdp(
        tabId,
        "Network.getResponseBody",
        { requestId: command.requestId }
      );
      if (!result.body) return { body: "" };
      return {
        body: result.base64Encoded ? decodeBase64(result.body) : result.body
      };
    }
    async cdp(tabId, method, params = {}, signal) {
      assertActive(signal);
      await this.attach(tabId);
      if (this.dialogs.has(tabId) && !method.startsWith("Page.handleJavaScriptDialog")) {
        throw new AgentError(
          "BROWSER_DIALOG_OPEN",
          "The page has an open JavaScript dialog; handle it before issuing other commands"
        );
      }
      assertActive(signal);
      const result = await this.debuggerApi.sendCommand(
        { tabId: Number(tabId) },
        method,
        params
      );
      assertActive(signal);
      return result;
    }
    dispose() {
      this.debuggerApi.onEvent.removeListener(this.onDebuggerEvent);
      this.sessions.clear();
      this.attachedTabs.clear();
      this.refs.clear();
      this.frameContexts.clear();
      this.dialogs.clear();
    }
    async attach(tabId) {
      if (this.attachedTabs.has(tabId)) return;
      const target = { tabId: Number(tabId) };
      try {
        await this.debuggerApi.attach(target, "1.3");
        await this.debuggerApi.sendCommand(target, "Page.enable");
      } catch (error) {
        if (!(error instanceof Error) || !/already attached/i.test(error.message)) throw error;
        await this.debuggerApi.sendCommand(target, "Page.enable").catch(() => void 0);
      }
      this.attachedTabs.add(tabId);
      for (const binding of this.sessions.values()) {
        if (binding.tabId === tabId) binding.attached.add(tabId);
      }
    }
    async waitForTab(tabId, attempts = 20) {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const tab = await this.getTab(tabId);
        if (tab) return tab;
        await new Promise(
          (resolve) => this.clock.setTimeout(resolve, 25)
        );
      }
      return null;
    }
    async detach(tabId) {
      await this.debuggerApi.detach({ tabId: Number(tabId) });
      this.attachedTabs.delete(tabId);
      for (const binding of this.sessions.values()) binding.attached.delete(tabId);
    }
    async pageInfo(tabId, frameId) {
      const fallback = await this.getTab(tabId);
      const frame = frameId ? (await this.listFrames(tabId).catch(() => [])).find(
        (candidate) => candidate.frameId === frameId
      ) : void 0;
      try {
        const info = await this.evaluate(
          tabId,
          "({title: document.title, url: location.href})",
          frameId ? { frameId } : void 0
        );
        return {
          tabId,
          title: String(info?.title ?? fallback?.title ?? ""),
          url: String(info?.url ?? frame?.url ?? fallback?.url ?? "")
        };
      } catch {
        return {
          tabId,
          title: fallback?.title ?? "",
          url: frame?.url ?? fallback?.url ?? ""
        };
      }
    }
    renderAx(tabId, frameId, source, limit, interactiveOnly) {
      const byId = new Map(source.map((node) => [String(node.nodeId), node]));
      const keep = interactiveOnly ? interactiveSubtrees(source) : void 0;
      const refs = /* @__PURE__ */ new Map();
      this.refs.set(this.frameKey(tabId, frameId), refs);
      const nodes = [];
      const lines = [];
      let used = 0;
      let truncated = false;
      let sequence = 0;
      const walk = (node, depth) => {
        if (!node || truncated) return;
        if (node.ignored) {
          for (const child of node.childIds ?? []) walk(byId.get(String(child)), depth);
          return;
        }
        if (keep && !keep.has(String(node.nodeId))) return;
        const role = axValue(node, "role");
        const name = axValue(node, "name").slice(0, 200);
        const value = axValue(node, "value").slice(0, 200);
        const interactive = INTERACTIVE_ROLES.has(role);
        let ref;
        if (interactive && node.backendDOMNodeId !== void 0) {
          sequence += 1;
          ref = `e${sequence}`;
          refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name });
        }
        if (role && role !== "none" && role !== "generic" && role !== "InlineTextBox") {
          const rendered = `${role}${name ? ` ${JSON.stringify(name)}` : ""}${value ? ` = ${JSON.stringify(value)}` : ""}${ref ? ` @${ref}` : ""}`;
          nodes.push({ ...ref ? { ref } : {}, role, name, ...value ? { value } : {}, depth, interactive });
          lines.push(`${"  ".repeat(depth)}${rendered}`);
          used += rendered.length + 1;
          if (used > limit) truncated = true;
        }
        for (const child of node.childIds ?? []) {
          walk(byId.get(String(child)), ref ? depth + 1 : depth);
        }
      };
      walk(source[0], 0);
      return {
        nodes,
        text: lines.join("\n") + (truncated ? "\n\u2026(snapshot truncated)" : ""),
        truncated
      };
    }
    async objectId(tabId, target) {
      if (target.ref) {
        const entry = this.refs.get(this.frameKey(tabId, target.frameId))?.get(target.ref.replace(/^@/, ""));
        if (!entry) {
          throw new AgentError(
            "BROWSER_REF_INVALID",
            `Unknown ref ${target.ref}; take a fresh snapshot before acting`
          );
        }
        const result2 = await this.cdp(tabId, "DOM.resolveNode", {
          backendNodeId: entry.backendNodeId
        });
        if (!result2?.object?.objectId) {
          throw new AgentError("BROWSER_REF_INVALID", `Could not resolve ref ${target.ref}`);
        }
        return String(result2.object.objectId);
      }
      if (!target.selector) {
        throw new AgentError("BROWSER_TARGET_INVALID", "A ref or CSS selector is required");
      }
      const result = await this.cdp(tabId, "Runtime.evaluate", {
        expression: `document.querySelector(${JSON.stringify(target.selector)})`,
        returnByValue: false,
        ...target.frameId ? { contextId: await this.frameContext(tabId, target.frameId) } : {}
      });
      if (!result?.result?.objectId) {
        throw new AgentError("BROWSER_ELEMENT_NOT_FOUND", `Element not found: ${target.selector}`);
      }
      return String(result.result.objectId);
    }
    async boxCenter(tabId, objectId) {
      const result = await this.cdp(tabId, "DOM.getBoxModel", { objectId });
      const quad = result?.model?.content ?? [];
      if (!quad.length) return null;
      const xs = quad.filter((_, index) => index % 2 === 0);
      const ys = quad.filter((_, index) => index % 2 === 1);
      return [
        xs.reduce((sum, value) => sum + value, 0) / xs.length,
        ys.reduce((sum, value) => sum + value, 0) / ys.length
      ];
    }
    async dispatchMouse(tabId, type, x, y) {
      await this.cdp(tabId, "Input.dispatchMouseEvent", {
        type,
        x,
        y,
        ...type === "mouseMoved" ? {} : { button: "left", clickCount: 1 }
      });
    }
    async frameContext(tabId, frameId) {
      const key = this.frameKey(tabId, frameId);
      const cached = this.frameContexts.get(key);
      if (cached !== void 0) return cached;
      const result = await this.cdp(
        tabId,
        "Page.createIsolatedWorld",
        {
          frameId,
          worldName: `tinyai-frame-${frameId.slice(0, 16)}`,
          grantUniveralAccess: false
        }
      );
      if (result.executionContextId === void 0) {
        throw new AgentError(
          "BROWSER_FRAME_CONTEXT_FAILED",
          `Could not create an execution context for frame ${frameId}`
        );
      }
      this.frameContexts.set(key, result.executionContextId);
      return result.executionContextId;
    }
    frameKey(tabId, frameId) {
      return `${tabId}:${frameId ?? "main"}`;
    }
    clearRefs(tabId) {
      for (const key of this.refs.keys()) {
        if (key === this.frameKey(tabId) || key.startsWith(`${tabId}:`)) this.refs.delete(key);
      }
    }
    clearFrameContexts(tabId) {
      for (const key of this.frameContexts.keys()) {
        if (key.startsWith(`${tabId}:`)) this.frameContexts.delete(key);
      }
    }
    networkRequest(tabId, params) {
      const state = this.networkStates.get(tabId);
      if (!state?.enabled) return;
      const requestId = String(params.requestId ?? "");
      const request = params.request ?? {};
      state.order = [...state.order, requestId].slice(-300);
      state.entries.set(requestId, {
        requestId,
        url: String(request.url ?? ""),
        method: String(request.method ?? ""),
        type: String(params.type ?? ""),
        finished: false,
        failed: false
      });
    }
    networkResponse(tabId, params) {
      const entry = this.networkStates.get(tabId)?.entries.get(String(params.requestId ?? ""));
      if (!entry) return;
      entry.status = Number(params.response?.status ?? 0);
      entry.mimeType = String(params.response?.mimeType ?? "");
    }
    networkFinished(tabId, params, failed2) {
      const entry = this.networkStates.get(tabId)?.entries.get(String(params.requestId ?? ""));
      if (!entry) return;
      entry.finished = true;
      entry.failed = failed2;
    }
    async waitForScript(tabId, expression, timeoutMs, signal, frameId) {
      const deadline = this.clock.now() + timeoutMs;
      while (this.clock.now() <= deadline) {
        assertActive(signal);
        try {
          if (await this.evaluate(tabId, expression, { frameId, signal })) return true;
        } catch {
        }
        await new Promise((resolve) => this.clock.setTimeout(resolve, 250));
      }
      return false;
    }
    groupRef(sessionId, binding) {
      return {
        sessionId,
        tabId: binding.tabId,
        ...binding.groupId === void 0 ? {} : { groupId: binding.groupId },
        ownedTabs: [...binding.ownedTabs]
      };
    }
  };
  function defaultChromeApis() {
    const runtime = globalThis;
    if (!runtime.chrome?.tabs || !runtime.chrome.debugger) {
      throw new AgentError(
        "CHROME_BROWSER_UNAVAILABLE",
        "Chrome tabs/debugger APIs are unavailable; inject APIs for headless tests"
      );
    }
    return {
      tabs: runtime.chrome.tabs,
      debugger: runtime.chrome.debugger,
      tabGroups: runtime.chrome.tabGroups
    };
  }
  function toDescriptor(tab) {
    return {
      id: String(tab.id),
      ...tab.title ? { title: tab.title } : {},
      ...tab.url ? { url: tab.url } : {},
      active: Boolean(tab.active),
      ...tab.windowId === void 0 ? {} : { windowId: tab.windowId },
      ...tab.groupId === void 0 || tab.groupId === -1 ? {} : { groupId: tab.groupId }
    };
  }
  function tabGroupTitle(title) {
    const compact = (title ?? "").replace(/\s+/g, " ").trim();
    return compact ? `tinyai \xB7 ${compact.slice(0, 28)}` : "tinyai";
  }
  function isInspectable(url) {
    return /^(https?|file):/.test(String(url ?? "")) || url === "about:blank";
  }
  function safeUrl(url) {
    const value = url.trim();
    if (!value) return "about:blank";
    return /^(https?:|file:|about:blank)/.test(value) ? value : `https://${value}`;
  }
  function axValue(node, key) {
    return String(node?.[key]?.value ?? "");
  }
  function interactiveSubtrees(nodes) {
    const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));
    const memo = /* @__PURE__ */ new Map();
    const visit = (id, seen) => {
      if (memo.has(id)) return memo.get(id);
      if (seen.has(id)) return false;
      const node = byId.get(id);
      if (!node) return false;
      const nextSeen = new Set(seen).add(id);
      const result = INTERACTIVE_ROLES.has(axValue(node, "role")) || (node.childIds ?? []).some((child) => visit(String(child), nextSeen));
      memo.set(id, result);
      return result;
    };
    return new Set([...byId.keys()].filter((id) => visit(id, /* @__PURE__ */ new Set())));
  }
  function assertActive(signal) {
    if (signal?.aborted) throw new AgentError("TASK_CANCELLED", "Browser operation was cancelled");
  }
  function flattenFrames(root) {
    const frames = [];
    const visit = (node, parentFrameId) => {
      frames.push({
        frameId: node.frame.id,
        ...parentFrameId ? { parentFrameId } : {},
        ...node.frame.url ? { url: node.frame.url } : {},
        ...node.frame.name ? { name: node.frame.name } : {},
        ...node.frame.securityOrigin ? { securityOrigin: node.frame.securityOrigin } : {},
        main: frames.length === 0
      });
      for (const child of node.childFrames ?? []) visit(child, node.frame.id);
    };
    visit(root);
    return frames;
  }
  function throwOnException(result, action) {
    if (result?.exceptionDetails) {
      throw new AgentError(
        "BROWSER_ACTION_FAILED",
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? `${action} failed`
      );
    }
  }
  function decodeBase64(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }

  // src/adapters/chrome-artifact-store.ts
  var ChromeArtifactStore = class {
    constructor(storage, options = {}) {
      this.storage = storage;
      this.prefix = options.keyPrefix ?? "tinyai:artifact:v1:";
      this.now = options.now ?? (() => Date.now());
      this.newId = options.newId ?? (() => typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    }
    storage;
    prefix;
    now;
    newId;
    async put(input) {
      if (!(input.data instanceof Uint8Array) || !input.name.trim()) {
        throw new AgentError("ARTIFACT_INPUT_INVALID", "Artifact name and binary data are required");
      }
      const metadata = {
        id: this.newId(),
        name: input.name,
        mimeType: input.mimeType,
        bytes: input.data.byteLength,
        createdAt: this.now(),
        kind: input.kind,
        ...input.sessionId ? { sessionId: input.sessionId } : {},
        ...input.taskId ? { taskId: input.taskId } : {}
      };
      await this.storage.set({
        [this.key(metadata.id)]: {
          metadata,
          dataBase64: bytesToBase64(input.data)
        }
      });
      return {
        artifactId: metadata.id,
        name: metadata.name,
        mimeType: metadata.mimeType,
        bytes: metadata.bytes,
        kind: metadata.kind
      };
    }
    async metadata(artifactId) {
      return (await this.load(artifactId))?.metadata;
    }
    async read(artifactId) {
      const artifact = await this.load(artifactId);
      return artifact ? base64ToBytes(artifact.dataBase64) : void 0;
    }
    async remove(artifactId) {
      const existing = await this.load(artifactId);
      if (!existing) return false;
      if (!this.storage.remove) {
        throw new AgentError("CHROME_STORAGE_UNAVAILABLE", "storage.remove is unavailable");
      }
      await this.storage.remove(this.key(artifactId));
      return true;
    }
    async list(filter = {}) {
      const all = await this.storage.get(null);
      return Object.entries(all).filter(([key]) => key.startsWith(this.prefix)).map(([, value]) => validate(value)).filter((artifact) => Boolean(artifact)).map((artifact) => artifact.metadata).filter((metadata) => !filter.sessionId || metadata.sessionId === filter.sessionId).filter((metadata) => !filter.taskId || metadata.taskId === filter.taskId).filter((metadata) => !filter.kind || metadata.kind === filter.kind).sort((a, b) => a.createdAt - b.createdAt).map((metadata) => ({ ...metadata }));
    }
    async cleanup(before) {
      const artifacts = await this.list();
      const expired = artifacts.filter((artifact) => artifact.createdAt < before);
      for (const artifact of expired) await this.remove(artifact.id);
      return expired.length;
    }
    async load(artifactId) {
      const stored = await this.storage.get(this.key(artifactId));
      return validate(stored[this.key(artifactId)]);
    }
    key(artifactId) {
      return `${this.prefix}${encodeURIComponent(artifactId)}`;
    }
  };
  function validate(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return void 0;
    const artifact = value;
    if (!artifact.metadata || typeof artifact.metadata.id !== "string" || typeof artifact.metadata.name !== "string" || typeof artifact.metadata.bytes !== "number" || typeof artifact.dataBase64 !== "string") {
      return void 0;
    }
    return {
      metadata: { ...artifact.metadata },
      dataBase64: artifact.dataBase64
    };
  }
  function bytesToBase64(value) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function base64ToBytes(value) {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  // src/adapters/mcp-http.ts
  var HttpMcpTransport = class {
    constructor(options) {
      this.options = options;
      this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    }
    options;
    sequence = 0;
    sessionId;
    fetchImpl;
    async request(method, params, signal) {
      const response = await this.fetchImpl(this.options.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...this.sessionId ? { "Mcp-Session-Id": this.sessionId } : {},
          ...this.options.headers
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: ++this.sequence,
          method,
          params
        }),
        signal
      });
      if (!response.ok) {
        throw new AgentError(
          `MCP_HTTP_${response.status}`,
          `MCP HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 500)}`
        );
      }
      this.sessionId = response.headers.get("mcp-session-id") ?? this.sessionId;
      const payload = await response.json();
      if (payload.error) {
        throw new AgentError(
          `MCP_${payload.error.code ?? "ERROR"}`,
          payload.error.message ?? "MCP request failed"
        );
      }
      return payload.result ?? null;
    }
    async close() {
      this.sessionId = void 0;
    }
  };
  var HttpMcpClient = class {
    constructor(transport, prefix = "mcp") {
      this.transport = transport;
      this.prefix = prefix;
    }
    transport;
    prefix;
    async initialize(signal) {
      await this.transport.request(
        "initialize",
        {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "tinyai", version: "0.1.0" }
        },
        signal
      );
    }
    async tools(signal) {
      const result = await this.transport.request("tools/list", {}, signal);
      const tools = result?.tools;
      if (!Array.isArray(tools)) return [];
      return tools.flatMap((tool3) => {
        if (!tool3 || typeof tool3 !== "object") return [];
        const value = tool3;
        if (typeof value.name !== "string") return [];
        return [
          {
            name: value.name,
            description: typeof value.description === "string" ? value.description : "",
            inputSchema: value.inputSchema && typeof value.inputSchema === "object" ? value.inputSchema : { type: "object", properties: {} }
          }
        ];
      });
    }
    async call(name, input, signal) {
      return this.transport.request("tools/call", { name, arguments: input }, signal);
    }
    async definitions() {
      return (await this.tools()).map((tool3) => ({
        name: `${this.prefix}__${sanitize(tool3.name)}`,
        description: tool3.description,
        parameters: tool3.inputSchema,
        risk: "write",
        effect: "network",
        capabilities: ["mcp:call"],
        executionMode: "sequential",
        replay: "never",
        timeoutMs: 12e4,
        execute: async (input, invocation) => this.call(tool3.name, input, invocation.signal)
      }));
    }
    close() {
      return this.transport.close();
    }
  };
  function sanitize(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  // src/core/session-store.ts
  function summarizeSnapshot(snapshot) {
    const firstUser = snapshot.rows.find((row) => row.kind === "user" && row.text.trim());
    return {
      sessionId: snapshot.sessionId,
      revision: snapshot.revision,
      eventSeq: snapshot.eventSeq,
      taskStatus: snapshot.taskStatus,
      updatedAt: snapshot.events.at(-1)?.occurredAt ?? 0,
      title: firstUser?.text.slice(0, 80) || "New chat",
      rowCount: snapshot.rows.length
    };
  }
  function cloneSnapshot(snapshot) {
    return {
      ...snapshot,
      messages: snapshot.messages.map(
        (message) => message.role === "assistant" && message.toolCalls ? { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) } : { ...message }
      ),
      rows: snapshot.rows.map((row) => ({ ...row })),
      ledger: snapshot.ledger.map((entry) => ({ ...entry })),
      events: snapshot.events.map((event) => ({ ...event })),
      commands: (snapshot.commands ?? []).map((ack) => ({
        ...ack,
        ...ack.error ? { error: { ...ack.error } } : {}
      })),
      sessionEntries: (snapshot.sessionEntries ?? []).map((entry) => ({
        ...entry,
        payload: structuredClone(entry.payload)
      })),
      tasks: (snapshot.tasks ?? []).map((task) => structuredClone(task)),
      ...snapshot.permission ? { permission: { ...snapshot.permission } } : {}
    };
  }

  // src/adapters/chrome-session-store.ts
  var DEFAULT_KEY_PREFIX = "tinyai:session:v1:";
  var ChromeSessionStore = class {
    storage;
    keyPrefix;
    tails = /* @__PURE__ */ new Map();
    constructor(options = {}) {
      this.storage = options.storage ?? defaultChromeStorage();
      this.keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
    }
    async load(sessionId) {
      const key = this.keyFor(sessionId);
      await this.tails.get(key);
      const result = await this.storage.get(key);
      const raw = result[key];
      if (raw === void 0) return void 0;
      return validateSnapshot(raw, sessionId);
    }
    save(snapshot) {
      const stored = cloneSnapshot(snapshot);
      const key = this.keyFor(snapshot.sessionId);
      return this.enqueue(key, async () => {
        await this.storage.set({ [key]: stored });
      });
    }
    remove(sessionId) {
      const key = this.keyFor(sessionId);
      return this.enqueue(key, async () => {
        await this.storage.remove(key);
      });
    }
    async clear() {
      await Promise.all(this.tails.values());
      const all = await this.storage.get(null);
      const keys = Object.keys(all).filter((key) => key.startsWith(this.keyPrefix));
      if (keys.length) await this.storage.remove(keys);
      this.tails.clear();
    }
    async list() {
      const all = await this.storage.get(null);
      const summaries = [];
      for (const [key, value] of Object.entries(all)) {
        if (!key.startsWith(this.keyPrefix)) continue;
        const sessionId = decodeURIComponent(key.slice(this.keyPrefix.length));
        try {
          summaries.push(summarizeSnapshot(validateSnapshot(value, sessionId)));
        } catch {
        }
      }
      return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    storageKey(sessionId) {
      return this.keyFor(sessionId);
    }
    keyFor(sessionId) {
      if (!sessionId.trim()) {
        throw new AgentError("SESSION_ID_INVALID", "Session id cannot be empty");
      }
      return `${this.keyPrefix}${encodeURIComponent(sessionId)}`;
    }
    enqueue(key, operation) {
      const previous = this.tails.get(key) ?? Promise.resolve();
      const current = previous.catch(() => void 0).then(operation);
      const settled = current.catch(() => void 0);
      this.tails.set(key, settled);
      void settled.then(() => {
        if (this.tails.get(key) === settled) this.tails.delete(key);
      });
      return current;
    }
  };
  function defaultChromeStorage() {
    const runtime = globalThis;
    const storage = runtime.chrome?.storage?.local;
    if (!storage) {
      throw new AgentError(
        "CHROME_STORAGE_UNAVAILABLE",
        "chrome.storage.local is unavailable; inject a StorageArea for headless use"
      );
    }
    return storage;
  }
  function validateSnapshot(raw, sessionId) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw invalidSnapshot(sessionId, "stored value is not an object");
    }
    const snapshot = raw;
    if (snapshot.schemaVersion !== 1) {
      throw new AgentError(
        "STORAGE_SCHEMA_UNSUPPORTED",
        `Unsupported session snapshot schema: ${String(snapshot.schemaVersion)}`,
        { details: { sessionId, schemaVersion: toJson(snapshot.schemaVersion) } }
      );
    }
    if (snapshot.sessionId !== sessionId) {
      throw invalidSnapshot(sessionId, "stored session id does not match its key");
    }
    for (const field of ["messages", "rows", "ledger", "events"]) {
      if (!Array.isArray(snapshot[field])) {
        throw invalidSnapshot(sessionId, `${field} must be an array`);
      }
    }
    if (snapshot.commands !== void 0 && !Array.isArray(snapshot.commands)) {
      throw invalidSnapshot(sessionId, "commands must be an array when present");
    }
    if (snapshot.sessionEntries !== void 0 && !Array.isArray(snapshot.sessionEntries)) {
      throw invalidSnapshot(sessionId, "sessionEntries must be an array when present");
    }
    if (snapshot.tasks !== void 0 && !Array.isArray(snapshot.tasks)) {
      throw invalidSnapshot(sessionId, "tasks must be an array when present");
    }
    if (typeof snapshot.logEpoch !== "string" || typeof snapshot.revision !== "number" || typeof snapshot.eventSeq !== "number" || typeof snapshot.taskStatus !== "string") {
      throw invalidSnapshot(sessionId, "required scalar fields are missing or invalid");
    }
    return cloneSnapshot(snapshot);
  }
  function invalidSnapshot(sessionId, message) {
    return new AgentError("STORAGE_SNAPSHOT_INVALID", `Invalid session snapshot: ${message}`, {
      details: { sessionId }
    });
  }
  function toJson(value) {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean" || value === null ? value : String(value);
  }

  // src/adapters/chrome-skill-store.ts
  var PRIMARY_KEY = "tinyai:v1:skills";
  var ChromeSkillStore = class {
    constructor(storage) {
      this.storage = storage;
    }
    storage;
    async list() {
      const stored = await this.storage.get(PRIMARY_KEY);
      const merged = /* @__PURE__ */ new Map();
      for (const key of [PRIMARY_KEY]) {
        const values = stored[key];
        if (!Array.isArray(values)) continue;
        for (const value of values) {
          if (!value || typeof value !== "object") continue;
          const item = value;
          const name = string(item.name);
          if (!name) continue;
          merged.set(name, {
            name,
            description: string(item.description),
            whenToUse: string(item.whenToUse) || string(item.when_to_use),
            body: string(item.body)
          });
        }
      }
      return [...merged.values()];
    }
    async upsert(skill) {
      const skills = await this.list();
      const next = [...skills.filter((item) => item.name !== skill.name), { ...skill }];
      await this.save(next);
    }
    async remove(name) {
      await this.save((await this.list()).filter((item) => item.name !== name));
    }
    async save(skills) {
      await this.storage.set({
        [PRIMARY_KEY]: skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          when_to_use: skill.whenToUse ?? "",
          body: skill.body
        }))
      });
    }
  };
  function string(value) {
    return typeof value === "string" ? value.trim() : "";
  }

  // src/adapters/openai-model.ts
  var OpenAIModelTransport = class {
    constructor(options) {
      this.options = options;
      this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    }
    options;
    fetchImpl;
    async *stream(request) {
      let response;
      try {
        response = await this.fetchImpl(this.completionsUrl(), {
          method: "POST",
          headers: this.headers(),
          body: JSON.stringify({
            model: this.options.model,
            messages: request.messages.map(toOpenAIMessage),
            stream: true,
            ...request.tools.length ? { tools: request.tools.map(toOpenAITool) } : {}
          }),
          signal: request.signal
        });
      } catch (error) {
        yield {
          type: "error",
          error: {
            code: request.signal.aborted ? "MODEL_ABORTED" : "MODEL_TRANSPORT_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: !request.signal.aborted
          }
        };
        return;
      }
      if (!response.ok) {
        const body = (await response.text().catch(() => "")).slice(0, 800);
        yield {
          type: "error",
          error: {
            code: `MODEL_HTTP_${response.status}`,
            message: `Model API HTTP ${response.status}: ${body}`,
            retryable: response.status === 408 || response.status === 429 || response.status >= 500,
            details: { status: response.status }
          }
        };
        return;
      }
      if (!response.body) {
        yield {
          type: "error",
          error: {
            code: "MODEL_STREAM_MISSING",
            message: "Model API returned no stream",
            retryable: true
          }
        };
        return;
      }
      const calls = /* @__PURE__ */ new Map();
      let emittedCalls = false;
      let emittedFinish = false;
      let buffer = "";
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          if (request.signal.aborted) {
            await reader.cancel().catch(() => void 0);
            throw new AgentError("MODEL_ABORTED", "Model request was aborted");
          }
          const chunk = await reader.read();
          if (chunk.done) break;
          buffer += decoder.decode(chunk.value, { stream: true });
          const lines = buffer.split(/\r?\n/);
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            const parsed = parseDataLine(line);
            if (parsed === "done") {
              if (!emittedCalls) {
                emittedCalls = true;
                yield* emitToolCalls(calls, request.taskId);
              }
              return;
            }
            if (!parsed) continue;
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;
            const reasoning = reasoningDelta(delta);
            if (reasoning) {
              yield { type: "reasoning_delta", text: reasoning };
            }
            if (typeof delta?.content === "string" && delta.content) {
              yield { type: "text_delta", text: delta.content };
            }
            for (const fragment of delta?.tool_calls ?? []) {
              const index = Number(fragment.index ?? 0);
              const current = calls.get(index) ?? {
                id: String(fragment.id ?? ""),
                name: "",
                arguments: ""
              };
              if (fragment.id) current.id = String(fragment.id);
              if (fragment.function?.name) current.name += String(fragment.function.name);
              if (fragment.function?.arguments) {
                current.arguments += String(fragment.function.arguments);
              }
              calls.set(index, current);
            }
            if (choice?.finish_reason) {
              if (!emittedCalls) {
                emittedCalls = true;
                yield* emitToolCalls(calls, request.taskId);
              }
              if (!emittedFinish) {
                emittedFinish = true;
                yield { type: "finish", reason: String(choice.finish_reason) };
              }
            }
            if (parsed.usage) {
              yield {
                type: "usage",
                inputTokens: Number(parsed.usage.prompt_tokens ?? 0),
                outputTokens: Number(parsed.usage.completion_tokens ?? 0)
              };
            }
          }
        }
        const tail = parseDataLine(buffer);
        if (tail && tail !== "done") {
          const delta = tail.choices?.[0]?.delta;
          const reasoning = reasoningDelta(delta);
          if (reasoning) {
            yield { type: "reasoning_delta", text: reasoning };
          }
          if (typeof delta?.content === "string" && delta.content) {
            yield { type: "text_delta", text: delta.content };
          }
        }
        if (!emittedCalls) yield* emitToolCalls(calls, request.taskId);
        if (!emittedFinish) yield { type: "finish", reason: "stop" };
      } catch (error) {
        if (request.signal.aborted || error instanceof AgentError && error.code === "MODEL_ABORTED") {
          throw error;
        }
        yield {
          type: "error",
          error: {
            code: "MODEL_STREAM_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: true
          }
        };
      } finally {
        reader.releaseLock();
      }
    }
    completionsUrl() {
      return `${this.options.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    }
    headers() {
      const headers = {
        "Content-Type": "application/json",
        ...this.options.headers
      };
      if (this.options.apiKey) headers.Authorization = `Bearer ${this.options.apiKey}`;
      return headers;
    }
  };
  function toOpenAIMessage(message) {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        ...message.toolCalls?.length ? {
          tool_calls: message.toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: { name: call.name, arguments: call.arguments }
          }))
        } : {}
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.callId,
        name: message.name,
        content: message.content
      };
    }
    return { role: message.role, content: message.content };
  }
  function toOpenAITool(tool3) {
    return {
      type: "function",
      function: {
        name: tool3.name,
        description: tool3.description,
        parameters: tool3.parameters
      }
    };
  }
  function reasoningDelta(delta) {
    if (!delta) return "";
    const value = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    return typeof value === "string" ? value : "";
  }
  function parseDataLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return void 0;
    const data = trimmed.slice(5).trim();
    if (!data) return void 0;
    if (data === "[DONE]") return "done";
    try {
      return JSON.parse(data);
    } catch {
      return void 0;
    }
  }
  function* emitToolCalls(fragments, taskId) {
    for (const [index, fragment] of [...fragments.entries()].sort(([a], [b]) => a - b)) {
      const call = {
        id: fragment.id || `${taskId}_tool_${index + 1}`,
        name: fragment.name,
        arguments: fragment.arguments || "{}"
      };
      yield { type: "tool_call", call };
    }
  }

  // src/adapters/subagent-tools.ts
  function createSubagentTools(options) {
    return [
      tool(
        "spawn_agent",
        "Create a child agent from any registered profile and a structured ChildTaskSpec.",
        schema({
          profile: { type: "string" },
          brief: { type: "string" },
          acceptance: { type: "array", items: { type: "string" } },
          contextRefs: { type: "array", items: { type: "string" } },
          contextMode: { type: "string", enum: ["fresh", "fork", "artifacts"] },
          executionMode: {
            type: "string",
            enum: ["foreground", "background", "isolated-worktree", "sandbox"]
          },
          budget: { type: "object" },
          resultSchema: { type: "string" }
        }, ["profile", "brief"]),
        async (input, invocation) => {
          const parent = options.parent(invocation);
          const spec = {
            parentTaskId: parent.taskId,
            profile: requiredString(input, "profile"),
            brief: requiredString(input, "brief"),
            ...Array.isArray(input.acceptance) ? { acceptance: input.acceptance.map(String) } : {},
            ...Array.isArray(input.contextRefs) ? { contextRefs: input.contextRefs.map(String) } : {},
            budget: budgetFrom(input.budget),
            contextMode: stringChoice(input, "contextMode", ["fresh", "fork", "artifacts"]) ?? "fresh",
            executionMode: stringChoice(input, "executionMode", [
              "foreground",
              "background",
              "isolated-worktree",
              "sandbox"
            ]) ?? "foreground",
            ...optionalString(input, "resultSchema") ? { resultSchema: optionalString(input, "resultSchema") } : {}
          };
          return await options.coordinator.spawn(spec, parent);
        }
      ),
      tool(
        "send_message",
        "Send a guided or queued message to a child agent, or resume a terminal child.",
        schema({
          childTaskId: { type: "string" },
          message: { type: "string" },
          delivery: { type: "string", enum: ["guide", "queue"] }
        }, ["childTaskId", "message"]),
        async (input) => {
          await options.coordinator.send(
            requiredString(input, "childTaskId"),
            requiredString(input, "message"),
            stringChoice(input, "delivery", ["guide", "queue"]) ?? "queue"
          );
          return { sent: true };
        }
      ),
      tool(
        "wait_agent",
        "Wait for a child agent and return its structured result.",
        schema({ childTaskId: { type: "string" } }, ["childTaskId"]),
        async (input) => await options.coordinator.wait(
          requiredString(input, "childTaskId")
        )
      ),
      tool(
        "stop_agent",
        "Stop a child agent and all descendants it owns.",
        schema({ childTaskId: { type: "string" } }, ["childTaskId"]),
        async (input) => {
          await options.coordinator.stop(requiredString(input, "childTaskId"));
          return { stopped: true };
        }
      ),
      tool(
        "list_agents",
        "List child agents, optionally scoped to a parent task.",
        schema({ parentTaskId: { type: "string" } }),
        async (input) => options.coordinator.list(optionalString(input, "parentTaskId"))
      )
    ];
  }
  function tool(name, description, parameters, execute) {
    return {
      name,
      description,
      parameters,
      risk: "write",
      effect: "execute",
      capabilities: ["agent:spawn", "agent:manage"],
      executionMode: "sequential",
      replay: "never",
      timeoutMs: 3e5,
      execute: async (input, invocation) => execute(asObject(input), invocation)
    };
  }
  function budgetFrom(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const source = value;
    return {
      ...typeof source.maxTurns === "number" ? { maxTurns: source.maxTurns } : {},
      ...typeof source.maxToolCalls === "number" ? { maxToolCalls: source.maxToolCalls } : {},
      ...typeof source.maxTokens === "number" ? { maxTokens: source.maxTokens } : {},
      ...typeof source.deadlineMs === "number" ? { deadlineMs: source.deadlineMs } : {}
    };
  }
  function schema(properties, required = []) {
    return { type: "object", properties, ...required.length ? { required } : {} };
  }
  function asObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AgentError("TOOL_ARGUMENTS_INVALID", "Tool input must be an object");
    }
    return value;
  }
  function requiredString(input, key) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new AgentError("TOOL_ARGUMENTS_INVALID", `${key} must be a non-empty string`);
    }
    return value;
  }
  function optionalString(input, key) {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value : void 0;
  }
  function stringChoice(input, key, choices) {
    const value = input[key];
    return typeof value === "string" && choices.includes(value) ? value : void 0;
  }

  // src/core/extension-registry.ts
  var sourcePriority = {
    builtin: 0,
    user: 1,
    project: 2,
    plugin: 3
  };
  var ExtensionRegistry = class {
    manifests = /* @__PURE__ */ new Map();
    register(manifest) {
      if (!manifest.id.trim()) throw new AgentError("EXTENSION_ID_INVALID", "Extension id is required");
      if (manifest.source !== "builtin" && manifest.trusted !== true) {
        throw new AgentError(
          "EXTENSION_UNTRUSTED",
          `Extension ${manifest.id} must be explicitly trusted`
        );
      }
      this.manifests.set(manifest.id, cloneManifest(manifest));
    }
    unregister(id) {
      return this.manifests.delete(id);
    }
    skill(name) {
      return this.resolve("skill", name)?.resource;
    }
    command(name) {
      return this.resolve("command", name)?.resource;
    }
    mcpServer(name) {
      return this.resolve("mcp", name)?.resource;
    }
    theme(name) {
      return this.resolve("theme", name)?.resource;
    }
    hooks() {
      return this.sorted().flatMap(
        (manifest) => (manifest.hooks ?? []).map((hook) => ({
          extensionId: manifest.id,
          source: manifest.source,
          hook
        }))
      );
    }
    diagnostics() {
      return this.sorted().map((manifest) => ({
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        source: manifest.source,
        contributions: {
          skill: manifest.skills?.length ?? 0,
          command: manifest.commands?.length ?? 0,
          mcp: manifest.mcpServers?.length ?? 0,
          hook: manifest.hooks?.length ?? 0,
          theme: manifest.themes?.length ?? 0
        }
      }));
    }
    resolve(kind, name) {
      for (const manifest of this.sorted()) {
        const resources = resourcesOf(manifest, kind);
        const resource = resources.find((item) => item.name === name);
        if (resource) {
          return {
            extensionId: manifest.id,
            source: manifest.source,
            resource: structuredClone(resource)
          };
        }
      }
      return void 0;
    }
    sorted() {
      return [...this.manifests.values()].sort(
        (a, b) => sourcePriority[b.source] - sourcePriority[a.source]
      );
    }
  };
  function expandSkill(skill, rawArgs = "") {
    const args = rawArgs.split(/\s+/).filter(Boolean);
    return skill.body.replace(/\$ARGUMENTS/g, rawArgs).replace(/\$(\d+)/g, (_match, index) => args[Number(index) - 1] ?? "");
  }
  function resourcesOf(manifest, kind) {
    if (kind === "skill") return manifest.skills ?? [];
    if (kind === "command") return manifest.commands ?? [];
    if (kind === "mcp") return manifest.mcpServers ?? [];
    if (kind === "hook") return manifest.hooks ?? [];
    return manifest.themes ?? [];
  }
  function cloneManifest(manifest) {
    return {
      ...manifest,
      skills: manifest.skills?.map((item) => structuredClone(item)),
      commands: manifest.commands?.map((item) => structuredClone(item)),
      mcpServers: manifest.mcpServers?.map((item) => structuredClone(item)),
      hooks: manifest.hooks?.map((hook) => ({ ...hook, ...hook.toolNames ? { toolNames: [...hook.toolNames] } : {} })),
      themes: manifest.themes?.map((item) => structuredClone(item))
    };
  }

  // src/adapters/skill-tools.ts
  function createSkillTools(registry, store) {
    const tools = [
      {
        name: "skill",
        description: "Load a declared skill body and expand its arguments.",
        parameters: {
          type: "object",
          properties: {
            skill: { type: "string" },
            args: { type: "string" }
          },
          required: ["skill"]
        },
        risk: "read",
        effect: "read",
        capabilities: ["extension:skills"],
        executionMode: "parallel",
        replay: "safe",
        execute: async (raw) => {
          const input = raw;
          const name = String(input.skill ?? "");
          const skill = registry.skill(name);
          if (!skill) return `Skill "${name}" was not found in the extension registry.`;
          return {
            name: skill.name,
            instructions: expandSkill(skill, String(input.args ?? ""))
          };
        }
      }
    ];
    if (store) {
      tools.push(
        {
          name: "save_skill",
          description: "Create or replace a reusable instruction skill.",
          parameters: {
            type: "object",
            properties: {
              name: { type: "string" },
              description: { type: "string" },
              when_to_use: { type: "string" },
              body: { type: "string" }
            },
            required: ["name", "description", "body"]
          },
          risk: "write",
          effect: "write",
          capabilities: ["extension:skills"],
          executionMode: "sequential",
          replay: "never",
          execute: async (raw) => {
            const input = raw;
            const name = String(input.name ?? "").trim();
            if (!name) throw new Error("Skill name cannot be empty");
            const skill = {
              name,
              description: String(input.description ?? ""),
              whenToUse: String(input.when_to_use ?? ""),
              body: String(input.body ?? "")
            };
            await store.upsert(skill);
            registry.register({
              id: "tinyai.skills",
              name: "tinyai skills",
              version: String(Date.now()),
              source: "builtin",
              skills: await store.list()
            });
            return { saved: name };
          }
        },
        {
          name: "delete_skill",
          description: "Delete a reusable instruction skill.",
          parameters: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"]
          },
          risk: "write",
          effect: "write",
          capabilities: ["extension:skills"],
          executionMode: "sequential",
          replay: "never",
          execute: async (raw) => {
            const name = String(raw.name ?? "");
            await store.remove(name);
            registry.register({
              id: "tinyai.skills",
              name: "tinyai skills",
              version: String(Date.now()),
              source: "builtin",
              skills: await store.list()
            });
            return { deleted: true, name };
          }
        }
      );
    }
    return tools;
  }

  // src/core/hooks.ts
  var HookRunner = class {
    hooks = /* @__PURE__ */ new Map();
    async register(input) {
      const digest2 = await sha256(input.content);
      if (digest2 !== input.expectedDigest.toLowerCase()) {
        throw new AgentError(
          "HOOK_DIGEST_MISMATCH",
          `Hook content digest changed for ${input.definition.name}`
        );
      }
      if (input.source !== "builtin" && input.trusted !== true) {
        throw new AgentError(
          "HOOK_UNTRUSTED",
          `Hook ${input.definition.name} must be explicitly trusted`
        );
      }
      this.hooks.set(hookKey(input.definition), {
        source: input.source,
        sourceId: input.sourceId,
        content: input.content,
        trusted: input.trusted,
        definition: input.definition,
        digest: digest2
      });
    }
    async before(context, signal) {
      let input = cloneJson(context.input);
      let requiresApproval = false;
      let reason;
      for (const registration of this.matching("PreToolUse", context.toolName)) {
        let result;
        try {
          result = await registration.definition.run(
            { ...context, event: "PreToolUse", input },
            signal
          );
        } catch (error) {
          return {
            decision: "deny",
            input,
            reason: `PreToolUse hook ${registration.definition.name} failed: ${error instanceof Error ? error.message : String(error)}`
          };
        }
        if (result.decision === "deny") {
          return { decision: "deny", input, reason: result.reason };
        }
        if (result.decision === "ask") {
          requiresApproval = true;
          reason = result.reason ?? reason;
        }
        if (result.decision === "modifyInput") {
          input = cloneJson(result.input);
          reason = result.reason ?? reason;
        }
      }
      return {
        decision: requiresApproval ? "ask" : "allow",
        input,
        ...reason ? { reason } : {}
      };
    }
    async after(context, result, signal) {
      const records = [];
      for (const registration of this.matching("PostToolUse", context.toolName)) {
        const record = {
          hookName: registration.definition.name,
          hookDigest: registration.digest,
          contexts: [],
          errors: []
        };
        try {
          const outcome = await registration.definition.run(
            { ...context, event: "PostToolUse", result },
            signal
          );
          if (outcome.decision === "context") record.contexts.push(outcome.content);
        } catch (error) {
          record.errors.push(toStructuredError(error, "HOOK_POST_FAILED"));
        }
        records.push(record);
      }
      return records;
    }
    diagnostics() {
      return [...this.hooks.values()].map((registration) => ({
        name: registration.definition.name,
        event: registration.definition.event,
        source: registration.source,
        ...registration.sourceId ? { sourceId: registration.sourceId } : {},
        digest: registration.digest,
        trusted: registration.source === "builtin" || registration.trusted === true
      })).sort((a, b) => a.name.localeCompare(b.name));
    }
    matching(event, toolName) {
      return [...this.hooks.values()].filter(
        (registration) => registration.definition.event === event && (!registration.definition.toolNames?.length || registration.definition.toolNames.includes(toolName))
      );
    }
  };
  async function hookDigest(content) {
    return sha256(content);
  }
  async function sha256(value) {
    const data = new TextEncoder().encode(value);
    const digest2 = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(digest2)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  function hookKey(definition) {
    return `${definition.event}:${definition.name}`;
  }
  function cloneJson(value) {
    return structuredClone(value);
  }

  // src/adapters/declarative-hooks.ts
  async function registerDeclarativeHooks(runner, raw) {
    if (!Array.isArray(raw)) return 0;
    let registered = 0;
    for (const value of raw) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const rule = value;
      if (!rule.name || !["PreToolUse", "PostToolUse"].includes(rule.event) || !["allow", "ask", "deny", "modifyInput", "context"].includes(rule.decision)) {
        continue;
      }
      const source = rule.source ?? "user";
      if (source !== "builtin" && rule.trusted !== true) continue;
      const definition = {
        name: rule.name,
        event: rule.event,
        ...rule.toolNames?.length ? { toolNames: [...rule.toolNames] } : {},
        run: () => hookResult(rule)
      };
      const content = JSON.stringify(rule);
      await runner.register({
        definition,
        source,
        sourceId: rule.sourceId ?? "declarative",
        content,
        expectedDigest: await hookDigest(content),
        trusted: rule.trusted
      });
      registered += 1;
    }
    return registered;
  }
  function hookResult(rule) {
    if (rule.decision === "deny") {
      return { decision: "deny", reason: rule.reason ?? "Denied by declarative hook" };
    }
    if (rule.decision === "ask") return { decision: "ask", ...rule.reason ? { reason: rule.reason } : {} };
    if (rule.decision === "modifyInput" && rule.input !== void 0) {
      return {
        decision: "modifyInput",
        input: structuredClone(rule.input),
        ...rule.reason ? { reason: rule.reason } : {}
      };
    }
    if (rule.decision === "context" && rule.content) {
      return { decision: "context", content: rule.content };
    }
    return { decision: "allow" };
  }

  // src/core/tool-schema.ts
  function parseToolArguments(source) {
    if (!source.trim()) return {};
    let parsed;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new AgentError("TOOL_ARGUMENTS_INVALID", "Tool arguments must be valid JSON", {
        details: { cause: error instanceof Error ? error.message : String(error) }
      });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new AgentError("TOOL_ARGUMENTS_INVALID", "Tool arguments must be a JSON object");
    }
    return parsed;
  }
  function validateNode(schema2, value, path) {
    if (!schema2 || typeof schema2 !== "object" || Array.isArray(schema2)) return;
    const rule = schema2;
    if (Array.isArray(rule.enum) && !rule.enum.some((candidate) => Object.is(candidate, value))) {
      throw new AgentError("TOOL_SCHEMA_INVALID", `${path} must be one of the declared enum values`);
    }
    const type = typeof rule.type === "string" ? rule.type : void 0;
    if (type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new AgentError("TOOL_SCHEMA_INVALID", `${path} must be an object`);
      }
      const object = value;
      const required = Array.isArray(rule.required) ? rule.required.map(String) : [];
      for (const key of required) {
        if (!(key in object)) {
          throw new AgentError("TOOL_SCHEMA_INVALID", `${path}.${key} is required`);
        }
      }
      const properties = rule.properties && typeof rule.properties === "object" && !Array.isArray(rule.properties) ? rule.properties : {};
      for (const [key, child] of Object.entries(properties)) {
        if (key in object) validateNode(child, object[key], `${path}.${key}`);
      }
      return;
    }
    if (type === "array") {
      if (!Array.isArray(value)) {
        throw new AgentError("TOOL_SCHEMA_INVALID", `${path} must be an array`);
      }
      for (let index = 0; index < value.length; index += 1) {
        validateNode(rule.items, value[index], `${path}[${index}]`);
      }
      return;
    }
    if (type === "string" && typeof value !== "string") {
      throw new AgentError("TOOL_SCHEMA_INVALID", `${path} must be a string`);
    }
    if (type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
      throw new AgentError("TOOL_SCHEMA_INVALID", `${path} must be a finite number`);
    }
    if (type === "integer" && (!Number.isInteger(value) || typeof value !== "number")) {
      throw new AgentError("TOOL_SCHEMA_INVALID", `${path} must be an integer`);
    }
    if (type === "boolean" && typeof value !== "boolean") {
      throw new AgentError("TOOL_SCHEMA_INVALID", `${path} must be a boolean`);
    }
  }
  function validateToolInput(schema2, input) {
    validateNode(schema2, input, "arguments");
  }
  function validateJsonValue(schema2, value, path = "value") {
    validateNode(schema2, value, path);
  }

  // src/core/subagent-coordinator.ts
  var SubagentCoordinator = class {
    constructor(options) {
      this.options = options;
    }
    options;
    tasks = /* @__PURE__ */ new Map();
    controllers = /* @__PURE__ */ new Map();
    profiles = /* @__PURE__ */ new Map();
    waits = /* @__PURE__ */ new Map();
    listeners = /* @__PURE__ */ new Set();
    async spawn(spec, parent) {
      const profile = this.options.registry.resolve(spec.profile, parent.permissions);
      this.options.registry.validateChild(spec, {
        depth: parent.depth,
        maxDepth: parent.maxDepth,
        concurrency: parent.concurrency ?? this.runningChildren(spec.parentTaskId)
      });
      const taskId = this.options.ids.next("child_task");
      const normalized = {
        ...spec,
        parentTaskId: spec.parentTaskId || parent.taskId,
        contextRefs: [...spec.contextRefs ?? []],
        budget: { ...spec.budget }
      };
      const created = await this.options.driver.create({
        taskId,
        spec: normalized,
        profile,
        prompt: childPrompt(
          normalized,
          normalized.contextMode === "fork" ? await this.forkContext(normalized.parentTaskId) : void 0
        )
      });
      const record = {
        taskId,
        sessionId: created.sessionId,
        parentTaskId: normalized.parentTaskId,
        profileName: profile.name,
        brief: normalized.brief,
        contextMode: normalized.contextMode,
        executionMode: normalized.executionMode,
        budget: normalized.budget,
        status: "queued",
        createdAt: this.now()
      };
      this.tasks.set(taskId, record);
      this.profiles.set(taskId, profile);
      this.emit(record);
      const completion = this.run(record);
      this.waits.set(taskId, completion);
      if (normalized.executionMode === "foreground" || normalized.executionMode === "isolated-worktree") {
        await completion;
        return this.read(record.taskId);
      }
      return this.read(record.taskId);
    }
    async wait(taskId) {
      const task = this.tasks.get(taskId);
      if (!task) throw new AgentError("CHILD_NOT_FOUND", `Child task not found: ${taskId}`);
      if (task.result) return structuredClone(task.result);
      const pending = this.waits.get(taskId);
      if (!pending) {
        throw new AgentError("CHILD_NOT_RUNNING", `Child task is not running: ${taskId}`);
      }
      return completionCopy(await pending);
    }
    async send(taskId, message, delivery = "queue") {
      const task = this.tasks.get(taskId);
      if (!task) throw new AgentError("CHILD_NOT_FOUND", `Child task not found: ${taskId}`);
      if (task.status === "running" || task.status === "queued") {
        await this.options.driver.send(taskId, message, delivery);
        return;
      }
      if (!this.options.driver.resume) {
        throw new AgentError("CHILD_TERMINAL", `Child task is terminal: ${taskId}`);
      }
      task.status = "queued";
      task.startedAt = this.now();
      task.completedAt = void 0;
      task.result = void 0;
      this.emit(task);
      const result = await this.options.driver.resume(taskId, message);
      this.finish(task, result);
    }
    async stop(taskId, recursive = true) {
      const task = this.tasks.get(taskId);
      if (!task) return;
      if (recursive) {
        for (const child of this.tasks.values()) {
          if (child.parentTaskId === taskId) await this.stop(child.taskId, true);
        }
      }
      if (!isTerminal(task.status)) {
        this.controllers.get(taskId)?.abort();
        await this.options.driver.stop(taskId);
        const cancelled2 = {
          status: "cancelled",
          summary: "Cancelled by parent",
          artifacts: [],
          unresolved: []
        };
        this.finish(task, cancelled2);
      }
    }
    list(parentTaskId) {
      return [...this.tasks.values()].filter((task) => parentTaskId === void 0 || task.parentTaskId === parentTaskId).map((task) => structuredClone(task));
    }
    get(taskId) {
      return this.read(taskId);
    }
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    async dispose() {
      await Promise.all([...this.tasks.keys()].map((taskId) => this.stop(taskId, false)));
      await this.options.driver.dispose?.();
      this.listeners.clear();
      this.profiles.clear();
    }
    run(task) {
      const controller = new AbortController();
      this.controllers.set(task.taskId, controller);
      task.status = "running";
      task.startedAt = this.now();
      this.emit(task);
      return this.options.driver.run(task.taskId, controller.signal).then((result) => {
        const profile = this.profiles.get(task.taskId);
        if (profile?.resultSchema) {
          try {
            validateJsonValue(profile.resultSchema, result.output ?? result.summary, "result");
          } catch (error) {
            const invalid = {
              ...result,
              status: "failed",
              summary: "Child result failed schema validation",
              unresolved: [
                ...result.unresolved,
                error instanceof Error ? error.message : String(error)
              ],
              error: {
                code: "CHILD_RESULT_SCHEMA_INVALID",
                message: error instanceof Error ? error.message : String(error),
                retryable: false
              }
            };
            this.finish(task, invalid);
            return completionCopy(invalid);
          }
        }
        this.finish(task, result);
        return completionCopy(result);
      }).catch((error) => {
        const result = {
          status: controller.signal.aborted ? "cancelled" : "failed",
          summary: controller.signal.aborted ? "Cancelled" : "Child task failed",
          artifacts: [],
          unresolved: [],
          error: {
            code: controller.signal.aborted ? "CHILD_CANCELLED" : "CHILD_FAILED",
            message: error instanceof Error ? error.message : String(error),
            retryable: false
          }
        };
        this.finish(task, result);
        return completionCopy(result);
      }).finally(() => this.controllers.delete(task.taskId));
    }
    finish(task, result) {
      if (isTerminal(task.status)) return;
      task.status = result.status;
      task.completedAt = this.now();
      task.result = completionCopy(result);
      this.emit(task);
    }
    emit(task) {
      const snapshot = structuredClone(task);
      for (const listener of this.listeners) listener(snapshot);
    }
    read(taskId) {
      const task = this.tasks.get(taskId);
      return task ? structuredClone(task) : void 0;
    }
    runningChildren(parentTaskId) {
      return [...this.tasks.values()].filter(
        (task) => task.parentTaskId === parentTaskId && (task.status === "queued" || task.status === "running")
      ).length;
    }
    now() {
      return this.options.now?.() ?? Date.now();
    }
    async forkContext(parentTaskId) {
      if (!this.options.contextProvider) {
        throw new AgentError(
          "CHILD_CONTEXT_UNAVAILABLE",
          "Fork context was requested but no parent context provider is available"
        );
      }
      return this.options.contextProvider(parentTaskId);
    }
  };
  function childPrompt(spec, inherited = []) {
    const lines = [
      "Complete this delegated task independently.",
      "",
      spec.brief,
      "",
      "Return a structured result with a concise summary, evidence, artifacts, unresolved items, and changed files when applicable."
    ];
    if (spec.acceptance?.length) {
      lines.push("", "Acceptance criteria:", ...spec.acceptance.map((item) => `- ${item}`));
    }
    if (spec.contextMode === "artifacts" && spec.contextRefs?.length) {
      lines.push("", "Available context artifact references:", ...spec.contextRefs.map((item) => `- ${item}`));
    }
    if (spec.contextMode === "fresh") {
      lines.push("", "You do not receive the parent conversation. Ask only if the brief is insufficient.");
    } else if (spec.contextMode === "fork" && inherited.length) {
      lines.push("", "Inherited parent conversation (read-only context):");
      for (const message of inherited) {
        lines.push(
          `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`
        );
      }
    }
    return lines.join("\n");
  }
  function completionCopy(result) {
    return structuredClone(result);
  }
  function isTerminal(status) {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  // src/core/trace-recorder.ts
  var TraceRecorder = class {
    constructor(traceId, now = () => Date.now()) {
      this.traceId = traceId;
      this.now = now;
    }
    traceId;
    now;
    spans = [];
    sequence = 0;
    start(name, attributes = {}, parentSpanId) {
      const span = {
        traceId: this.traceId,
        spanId: `span_${++this.sequence}`,
        ...parentSpanId ? { parentSpanId } : {},
        name,
        startedAt: this.now(),
        attributes: { ...attributes }
      };
      this.spans.push(span);
      return { ...span, attributes: { ...span.attributes } };
    }
    end(spanId, attributes = {}, error) {
      const span = this.spans.find((candidate) => candidate.spanId === spanId);
      if (!span) throw new Error(`Trace span not found: ${spanId}`);
      span.endedAt = this.now();
      span.durationMs = span.endedAt - span.startedAt;
      span.attributes = { ...span.attributes, ...attributes };
      if (error) span.error = { ...error };
      return structuredClone(span);
    }
    list() {
      return this.spans.map((span) => structuredClone(span));
    }
    json() {
      return {
        traceId: this.traceId,
        spans: this.list()
      };
    }
  };

  // src/core/ports.ts
  var systemClock = {
    now: () => Date.now(),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle)
  };
  var SequentialIdGenerator = class {
    counters = /* @__PURE__ */ new Map();
    next(prefix) {
      const next = (this.counters.get(prefix) ?? 0) + 1;
      this.counters.set(prefix, next);
      return `${prefix}_${next}`;
    }
    reserve(ids) {
      for (const id of ids) {
        const match = id.match(/^(.+)_(\d+)$/);
        if (!match) continue;
        const prefix = match[1];
        const value = Number(match[2]);
        if (!Number.isSafeInteger(value)) continue;
        this.counters.set(prefix, Math.max(this.counters.get(prefix) ?? 0, value));
      }
    }
  };

  // src/core/policy.ts
  var PlanModeController = class {
    constructor(now = () => Date.now(), initial = "guarded") {
      this.now = now;
      this.snapshot = { mode: initial };
    }
    now;
    snapshot;
    getState() {
      return { ...this.snapshot };
    }
    setMode(mode) {
      if (this.snapshot.mode === "plan" && mode === "build" && !this.snapshot.approvedAt) {
        throw new AgentError("PLAN_NOT_APPROVED", "The current plan must be approved before build mode");
      }
      this.snapshot = mode === "plan" ? { mode } : { ...this.snapshot, mode };
      return this.getState();
    }
    async submitPlan(plan) {
      if (this.snapshot.mode !== "plan") {
        throw new AgentError("PLAN_MODE_REQUIRED", "A plan can only be submitted in plan mode");
      }
      if (!plan.trim()) throw new AgentError("PLAN_EMPTY", "Plan cannot be empty");
      this.snapshot = {
        mode: "plan",
        plan: plan.trim(),
        approvedDigest: await digest(plan.trim())
      };
      return this.getState();
    }
    approvePlan(expectedDigest) {
      if (!this.snapshot.plan || !this.snapshot.approvedDigest) {
        throw new AgentError("PLAN_NOT_SUBMITTED", "No plan is available for approval");
      }
      if (expectedDigest && expectedDigest !== this.snapshot.approvedDigest) {
        throw new AgentError("PLAN_DIGEST_MISMATCH", "The plan changed before approval");
      }
      this.snapshot = {
        ...this.snapshot,
        approvedAt: this.now()
      };
      return this.getState();
    }
    restore(snapshot) {
      const modes = ["plan", "build", "edit", "guarded", "sandbox-auto"];
      if (!modes.includes(snapshot.mode)) {
        throw new AgentError("PLAN_STATE_INVALID", `Unknown permission mode: ${snapshot.mode}`);
      }
      this.snapshot = {
        mode: snapshot.mode,
        ...snapshot.plan ? { plan: snapshot.plan } : {},
        ...snapshot.approvedAt ? { approvedAt: snapshot.approvedAt } : {},
        ...snapshot.approvedDigest ? { approvedDigest: snapshot.approvedDigest } : {}
      };
    }
  };
  var PermissionModeRegistry = class {
    constructor(defaultMode = "guarded", now = () => Date.now()) {
      this.defaultMode = defaultMode;
      this.now = now;
    }
    defaultMode;
    now;
    controllers = /* @__PURE__ */ new Map();
    get(sessionId) {
      const existing = this.controllers.get(sessionId);
      if (existing) return existing;
      const controller = new PlanModeController(this.now, this.defaultMode);
      this.controllers.set(sessionId, controller);
      return controller;
    }
    mode(sessionId) {
      return this.get(sessionId).getState().mode;
    }
    delete(sessionId) {
      this.controllers.delete(sessionId);
    }
    restore(sessionId, snapshot) {
      this.get(sessionId).restore(snapshot);
    }
  };
  var PolicyEngine = class {
    constructor(mode) {
      this.mode = mode;
    }
    mode;
    async evaluate(request, signal) {
      if (signal?.aborted) throw new AgentError("TASK_CANCELLED", "Policy evaluation was cancelled");
      const actionDigest = await digest(JSON.stringify(request));
      const mode = this.mode(request.sessionId);
      if (mode === "plan" && request.effect !== "read") {
        return {
          decision: "deny",
          actionDigest,
          reason: "Plan mode only allows read-only capabilities"
        };
      }
      if (mode === "guarded" || mode === "plan") {
        return {
          decision: request.effect === "read" ? "allow" : "ask",
          actionDigest
        };
      }
      if (mode === "edit") {
        return {
          decision: request.risk === "dangerous" || request.effect === "execute" ? "ask" : "allow",
          actionDigest
        };
      }
      if (mode === "sandbox-auto") {
        return {
          decision: request.effect === "network" ? "ask" : "allow",
          actionDigest
        };
      }
      return {
        decision: request.risk === "dangerous" ? "ask" : "allow",
        actionDigest
      };
    }
  };
  async function digest(value) {
    const bytes = new TextEncoder().encode(value);
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  // src/core/model-gateway.ts
  var ModelGateway = class {
    constructor(options) {
      this.options = options;
      if (options.targets.length === 0) throw new Error("ModelGateway requires at least one target");
    }
    options;
    async *stream(request) {
      let lastError;
      for (const target of this.options.targets) {
        const attempts = Math.max(1, target.attempts ?? 1);
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          if (request.signal.aborted) return;
          let produced = false;
          try {
            for await (const event of target.transport.stream(request)) {
              if (event.type === "error") {
                lastError = event.error;
                if (event.error.retryable && !produced) break;
                yield event;
                return;
              }
              produced = true;
              yield event;
            }
            if (!produced) {
              if (request.signal.aborted) return;
              continue;
            }
            return;
          } catch (error) {
            lastError = {
              code: request.signal.aborted ? "MODEL_ABORTED" : "MODEL_TARGET_FAILED",
              message: error instanceof Error ? error.message : String(error),
              retryable: !request.signal.aborted,
              details: { targetId: target.id, attempt: attempt + 1 }
            };
            if (request.signal.aborted) return;
            if (produced) {
              yield { type: "error", error: lastError };
              return;
            }
          }
          if (attempt + 1 < attempts) {
            await (this.options.delay ?? delay)(Math.min(2e3, 200 * 2 ** attempt), request.signal);
          }
        }
      }
      yield {
        type: "error",
        error: lastError ?? {
          code: "MODEL_NO_TARGET",
          message: "No model target completed the request",
          retryable: false
        }
      };
    }
  };
  function delay(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(resolve, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true }
      );
    });
  }

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
    "When tabs are grouped as the current workspace, use list_tabs / switch_tab only within that group. Never operate on tabs outside the active workspace.",
    "Keep answers concise and in the user's language."
  ].join("\n");
  var chromePromptProfile = {
    id: "chrome-browser",
    build({ profile, skills }) {
      const instructions = profile?.instructions.trim();
      const skillListing = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join("\n");
      return [
        baseSystemPrompt,
        instructions ? `
${instructions}` : "",
        skillListing ? `
Available skills:
${skillListing}` : ""
      ].join("");
    }
  };

  // src/runtime/approval-broker.ts
  var PortApprovalBroker = class {
    constructor(options) {
      this.options = options;
    }
    options;
    ports = /* @__PURE__ */ new Set();
    pending = /* @__PURE__ */ new Map();
    handoffs = /* @__PURE__ */ new Map();
    sequence = 0;
    attach(port) {
      this.ports.add(port);
      return () => this.ports.delete(port);
    }
    detach(port) {
      this.ports.delete(port);
    }
    requestApproval(request, signal) {
      if (this.options.mode === "auto") return Promise.resolve(true);
      if (signal.aborted) return Promise.resolve(false);
      const approvalId = `approval_${++this.sequence}`;
      return new Promise((resolve, reject) => {
        const timeoutMs = this.options.timeoutMs ?? 6e4;
        const abort = () => {
          this.finish(approvalId, false);
          reject(new Error("Approval was cancelled"));
        };
        const timer = setTimeout(() => {
          this.finish(approvalId, false);
          reject(new Error("Approval timed out"));
        }, timeoutMs);
        this.pending.set(approvalId, { request, resolve, reject, timer });
        signal.addEventListener("abort", abort, { once: true });
        for (const port of this.ports) {
          port.postMessage({
            type: "approval_request",
            approvalId,
            sessionId: request.sessionId,
            taskId: request.taskId,
            callId: request.callId,
            toolName: request.toolName,
            risk: request.risk,
            input: request.input
          });
        }
      });
    }
    respond(approvalId, approved) {
      return this.finish(approvalId, approved);
    }
    requestHandoff(reason, context, signal) {
      if (signal.aborted) return Promise.resolve("cancel");
      const handoffId = `handoff_${++this.sequence}`;
      return new Promise((resolve) => {
        const timeoutMs = this.options.timeoutMs ?? 6e4;
        const timer = setTimeout(() => this.finishHandoff(handoffId, "cancel"), timeoutMs);
        this.handoffs.set(handoffId, { resolve, timer });
        const abort = () => this.finishHandoff(handoffId, "cancel");
        signal.addEventListener("abort", abort, { once: true });
        for (const port of this.ports) {
          port.postMessage({
            type: "handoff_request",
            handoffId,
            sessionId: context.sessionId,
            taskId: context.taskId,
            toolName: context.toolName,
            reason
          });
        }
      });
    }
    respondHandoff(handoffId, decision) {
      return this.finishHandoff(handoffId, decision);
    }
    dispose() {
      for (const [approvalId] of this.pending) this.finish(approvalId, false);
      for (const [handoffId] of this.handoffs) this.finishHandoff(handoffId, "cancel");
      this.ports.clear();
    }
    finish(approvalId, approved) {
      const pending = this.pending.get(approvalId);
      if (!pending) return false;
      this.pending.delete(approvalId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(approved);
      return true;
    }
    finishHandoff(handoffId, decision) {
      const pending = this.handoffs.get(handoffId);
      if (!pending) return false;
      this.handoffs.delete(handoffId);
      if (pending.timer) clearTimeout(pending.timer);
      pending.resolve(decision);
      return true;
    }
  };

  // src/core/projection.ts
  function phaseFor(view) {
    if (view.lifecycle === "faulted") return "error";
    if (view.lifecycle === "starting") return "prewarming";
    if (!view.activeTaskId && view.rows.length === 0) return "draft";
    if (view.taskStatus === "running" || view.taskStatus === "queued") return "running";
    if (view.taskStatus === "waiting" || view.pendingApproval) return "waiting";
    if (view.taskStatus === "failed") return "error";
    if (view.taskStatus === "completed" || view.taskStatus === "cancelled") return "completed";
    return "draft";
  }
  function availabilityFor(view) {
    const ready = view.lifecycle === "ready";
    const active = view.taskStatus === "queued" || view.taskStatus === "running" || view.taskStatus === "waiting";
    return {
      canSend: ready,
      canStop: ready && active,
      canApprove: ready && view.pendingApproval,
      canQueue: ready && view.taskStatus === "running"
    };
  }
  function buildProjection(view) {
    const availability = availabilityFor(view);
    const active = view.taskStatus === "queued" || view.taskStatus === "running" || view.taskStatus === "waiting";
    return {
      sessionId: view.sessionId,
      revision: view.revision,
      eventSeq: view.eventSeq,
      logEpoch: view.logEpoch,
      phase: phaseFor(view),
      lifecycle: view.lifecycle,
      taskStatus: view.taskStatus,
      inputRouting: !availability.canSend ? "blocked" : active ? "queue" : "startNow",
      queueLength: view.queueLength,
      ...view.activeTaskId ? { activeTaskId: view.activeTaskId } : {},
      ...view.lastError ? { lastError: view.lastError } : {},
      permissionMode: view.permissionMode,
      ...view.plan ? { plan: { ...view.plan } } : {},
      ...view.children?.length ? { children: view.children.map((child) => ({ ...child })) } : {},
      rows: view.rows.map((row) => ({ ...row })),
      availability
    };
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
        deltas.push({ type: "row.appended", row: { ...row } });
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
        deltas.push({ type: "row.upserted", row: { ...row } });
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
  function cloneProjection(projection) {
    return {
      ...projection,
      ...projection.lastError ? { lastError: { ...projection.lastError } } : {},
      availability: { ...projection.availability },
      ...projection.children ? { children: projection.children.map((child) => ({ ...child })) } : {},
      rows: projection.rows.map((row) => ({ ...row }))
    };
  }

  // src/runtime/runtime-gateway.ts
  var RuntimeGateway = class {
    constructor(createBundle, clock = { now: () => Date.now() }) {
      this.createBundle = createBundle;
      this.clock = clock;
    }
    createBundle;
    clock;
    runtime;
    ports = /* @__PURE__ */ new Set();
    subscriptions = /* @__PURE__ */ new Map();
    connect(port) {
      this.ports.add(port);
      const listeners = /* @__PURE__ */ new Map();
      this.subscriptions.set(port, listeners);
      const onMessage = (message) => void this.handle(port, message);
      const onDisconnect = () => {
        port.onMessage.removeListener(onMessage);
        port.onDisconnect.removeListener(onDisconnect);
        for (const subscription of listeners.values()) subscription.unsubscribe();
        listeners.clear();
        this.subscriptions.delete(port);
        this.ports.delete(port);
        void this.runtime?.then((bundle) => bundle.approval?.detach(port));
      };
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(onDisconnect);
      void this.ensureRuntime().then((bundle) => bundle.approval?.attach(port)).catch(() => {
      });
      return onDisconnect;
    }
    async dispose() {
      for (const listeners of this.subscriptions.values()) {
        for (const subscription of listeners.values()) subscription.unsubscribe();
      }
      this.subscriptions.clear();
      this.ports.clear();
      const bundle = await this.runtime;
      await bundle?.dispose();
      this.runtime = void 0;
    }
    async handle(port, request) {
      const coreRequest = isCoreRuntimeRequest(request) ? request : void 0;
      const requestId = request.requestId ?? (coreRequest?.type === "command" ? coreRequest.command.commandId : `${request.type}_${this.clock.now()}_${Math.random().toString(36).slice(2, 8)}`);
      try {
        const bundle = await this.ensureRuntime();
        if (!coreRequest) {
          if (bundle.extension) {
            const result = await bundle.extension.tryHandle(request);
            if (result.handled) {
              this.reply(port, requestId, result.data);
              return;
            }
          }
          throw new AgentError(
            "RUNTIME_REQUEST_UNSUPPORTED",
            `Unsupported runtime request: ${request.type}`
          );
        }
        const core = coreRequest;
        if (core.type === "hello") {
          port.postMessage({ type: "ready", revision: this.clock.now() });
          return;
        }
        if (core.type === "approval_response") {
          const accepted = bundle.approval?.respond(core.approvalId, core.approved) ?? false;
          this.reply(port, requestId, accepted);
          return;
        }
        if (core.type === "handoff_response") {
          const accepted = bundle.approval?.respondHandoff(core.handoffId, core.decision) ?? false;
          this.reply(port, requestId, accepted);
          return;
        }
        if (core.type === "subscribe") {
          await this.subscribe(port, bundle.runtime, core.sessionId, requestId);
          return;
        }
        if (core.type === "unsubscribe") {
          const subscription = this.subscriptions.get(port)?.get(core.sessionId);
          subscription?.unsubscribe();
          this.subscriptions.get(port)?.delete(core.sessionId);
          this.reply(port, requestId, true);
          return;
        }
        if (core.type === "command") {
          const ack = await bundle.runtime.command(core.command);
          this.reply(port, requestId, ack);
          return;
        }
        if (core.type === "get_projection") {
          this.reply(port, requestId, await bundle.runtime.loadProjection(core.sessionId));
          return;
        }
        if (core.type === "query_command") {
          this.reply(
            port,
            requestId,
            bundle.runtime.queryCommand(core.sessionId, core.commandId) ?? null
          );
          return;
        }
        if (core.type === "stop_session") {
          await bundle.runtime.stop(core.sessionId);
          this.reply(port, requestId, true);
          return;
        }
        if (core.type === "list_sessions") {
          this.reply(port, requestId, await bundle.runtime.listSessions());
          return;
        }
        if (core.type === "clear_history") {
          await bundle.extension?.beforeClearHistory?.();
          const deleted = await bundle.runtime.deleteAllSessions();
          this.reply(port, requestId, { deleted });
          return;
        }
        if (core.type === "delete_session") {
          await bundle.extension?.beforeDeleteSession?.(core.sessionId);
          await bundle.runtime.deleteSession(core.sessionId);
          this.reply(port, requestId, true);
          return;
        }
        if (core.type === "restart_session") {
          await bundle.runtime.restart(core.sessionId);
          this.reply(port, requestId, true);
          return;
        }
        if (core.type === "list_skills") {
          this.reply(port, requestId, await bundle.skills?.() ?? []);
          return;
        }
        if (core.type === "reload_runtime") {
          const current = await this.runtime;
          await current?.dispose();
          this.runtime = void 0;
          this.reply(port, requestId, true);
          return;
        }
        if (core.type === "read_artifact") {
          const metadata = await bundle.artifacts?.metadata(core.artifactId);
          const data = await bundle.artifacts?.read(core.artifactId);
          if (!metadata || !data) {
            throw new AgentError("ARTIFACT_NOT_FOUND", `Artifact not found: ${core.artifactId}`);
          }
          this.reply(port, requestId, {
            metadata,
            dataBase64: bytesToBase642(data)
          });
          return;
        }
        throw new AgentError(
          "RUNTIME_REQUEST_UNSUPPORTED",
          `Unsupported runtime request: ${request.type}`
        );
      } catch (error) {
        port.postMessage({
          type: "response",
          requestId,
          ok: false,
          error: toStructuredError(error, "RUNTIME_REQUEST_FAILED")
        });
      }
    }
    async subscribe(port, runtime, sessionId, requestId) {
      const current = runtime.getProjection(sessionId);
      const listeners = this.subscriptions.get(port) ?? /* @__PURE__ */ new Map();
      this.subscriptions.set(port, listeners);
      const existing = listeners.get(sessionId);
      existing?.unsubscribe();
      const subscription = {
        unsubscribe: () => void 0,
        previous: current
      };
      subscription.unsubscribe = await runtime.subscribe(sessionId, (next) => {
        const frame = createProjectionFrame(subscription.previous, next);
        subscription.previous = next;
        port.postMessage({ type: "projection", frame });
      });
      listeners.set(sessionId, subscription);
      port.postMessage({
        type: "projection",
        frame: this.snapshotFrame(current)
      });
      this.reply(port, requestId, true);
    }
    snapshotFrame(projection) {
      return { type: "snapshot", projection };
    }
    reply(port, requestId, data) {
      const response = {
        type: "response",
        requestId,
        ok: true,
        data
      };
      port.postMessage(response);
    }
    async ensureRuntime() {
      this.runtime ??= this.createBundle().catch((error) => {
        this.runtime = void 0;
        throw error;
      });
      return this.runtime;
    }
  };
  function bytesToBase642(value) {
    let binary = "";
    for (const byte of value) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function isCoreRuntimeRequest(request) {
    return CORE_REQUEST_TYPES.has(request.type);
  }
  var CORE_REQUEST_TYPES = /* @__PURE__ */ new Set([
    "hello",
    "subscribe",
    "unsubscribe",
    "command",
    "get_projection",
    "query_command",
    "stop_session",
    "list_sessions",
    "clear_history",
    "delete_session",
    "restart_session",
    "list_skills",
    "reload_runtime",
    "read_artifact",
    "approval_response",
    "handoff_response"
  ]);

  // src/core/tool-executor.ts
  var ToolExecutor = class {
    constructor(tools, approval, options = {}) {
      this.approval = approval;
      this.options = options;
      this.tools = new Map([...tools].map((tool3) => [tool3.name, tool3]));
    }
    approval;
    options;
    tools;
    descriptors() {
      return [...this.tools.values()].map(({ name, description, parameters }) => ({
        name,
        description,
        parameters
      }));
    }
    has(name) {
      return this.tools.has(name);
    }
    executionMode(name) {
      return this.tools.get(name)?.executionMode ?? "sequential";
    }
    async execute(invocation) {
      const base = { callId: invocation.call.id, name: invocation.call.name };
      const tool3 = this.tools.get(invocation.call.name);
      if (!tool3) {
        return {
          ...base,
          status: "failed",
          error: new AgentError("TOOL_NOT_FOUND", `Unknown tool: ${invocation.call.name}`).toStructured()
        };
      }
      let input;
      try {
        input = parseToolArguments(invocation.call.arguments);
        validateToolInput(tool3.parameters, input);
        this.assertActive(invocation.signal);
      } catch (error) {
        return { ...base, status: "failed", error: toStructuredError(error, "TOOL_VALIDATION_FAILED") };
      }
      let hookRequiresApproval = false;
      if (this.options.hooks) {
        const hook = await this.options.hooks.before(
          {
            sessionId: invocation.sessionId,
            taskId: invocation.taskId,
            callId: invocation.call.id,
            toolName: tool3.name,
            input
          },
          invocation.signal
        );
        if (hook.decision === "deny") {
          return {
            ...base,
            status: "denied",
            error: new AgentError(
              "TOOL_HOOK_DENIED",
              hook.reason ?? `A pre-tool hook denied ${tool3.name}`
            ).toStructured()
          };
        }
        hookRequiresApproval = hook.decision === "ask";
        input = hook.input;
        try {
          validateToolInput(tool3.parameters, input);
        } catch (error) {
          return {
            ...base,
            status: "failed",
            error: toStructuredError(error, "TOOL_HOOK_INPUT_INVALID")
          };
        }
      }
      let policyRequiresApproval = false;
      let actionDigest;
      if (this.options.policy) {
        const decision = await this.options.policy.evaluate(
          {
            sessionId: invocation.sessionId,
            taskId: invocation.taskId,
            callId: invocation.call.id,
            toolName: tool3.name,
            capabilities: [...tool3.capabilities ?? []],
            effect: tool3.effect ?? (tool3.risk === "read" ? "read" : "write"),
            risk: tool3.risk,
            input
          },
          invocation.signal
        );
        actionDigest = decision.actionDigest;
        if (decision.decision === "deny") {
          return {
            ...base,
            status: "denied",
            error: new AgentError(
              "TOOL_POLICY_DENIED",
              decision.reason ?? `${tool3.name} is denied by policy`
            ).toStructured()
          };
        }
        policyRequiresApproval = decision.decision === "ask";
      }
      if (tool3.risk !== "read" && !this.options.policy || hookRequiresApproval || policyRequiresApproval) {
        let approved = false;
        try {
          approved = await this.approval.requestApproval(
            {
              sessionId: invocation.sessionId,
              taskId: invocation.taskId,
              callId: invocation.call.id,
              toolName: tool3.name,
              risk: tool3.risk === "read" ? "write" : tool3.risk,
              input,
              ...actionDigest ? { actionDigest } : {}
            },
            invocation.signal
          );
        } catch (error) {
          return { ...base, status: "failed", error: toStructuredError(error, "TOOL_APPROVAL_FAILED") };
        }
        if (!approved) {
          return {
            ...base,
            status: "denied",
            error: new AgentError("TOOL_DENIED", `User denied ${tool3.name}`).toStructured()
          };
        }
      }
      try {
        const rawOutput = await this.executeWithTimeout(tool3, input, invocation);
        if (tool3.outputSchema) validateToolInput(tool3.outputSchema, rawOutput);
        this.assertActive(invocation.signal);
        const output = await this.artifactize(rawOutput, invocation);
        const result = { ...base, status: "succeeded", output };
        await this.runPostHooks(invocation, input, result);
        return result;
      } catch (error) {
        const result = {
          ...base,
          status: "failed",
          error: toStructuredError(error, "TOOL_EXECUTION_FAILED")
        };
        await this.runPostHooks(invocation, input, result);
        return result;
      }
    }
    assertActive(signal) {
      if (signal.aborted) throw new AgentError("TASK_CANCELLED", "Task was cancelled");
    }
    async executeWithTimeout(tool3, input, invocation) {
      const timeoutMs = tool3.timeoutMs ?? this.options.defaultTimeoutMs ?? 12e4;
      const controller = new AbortController();
      const abort = () => controller.abort();
      invocation.signal.addEventListener("abort", abort, { once: true });
      if (invocation.signal.aborted) controller.abort();
      let timer;
      const timeout = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new AgentError("TOOL_TIMEOUT", `Tool timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([
          tool3.execute(input, { ...invocation, signal: controller.signal }),
          timeout
        ]);
      } finally {
        if (timer !== void 0) clearTimeout(timer);
        invocation.signal.removeEventListener("abort", abort);
      }
    }
    async runPostHooks(invocation, input, result) {
      if (!this.options.hooks) return;
      const records = await this.options.hooks.after(
        {
          sessionId: invocation.sessionId,
          taskId: invocation.taskId,
          callId: invocation.call.id,
          toolName: invocation.call.name,
          input
        },
        result,
        invocation.signal
      );
      this.options.onPostToolUse?.(records);
    }
    async artifactize(output, invocation) {
      if (!this.options.artifacts) return output;
      const serialized = typeof output === "string" ? output : JSON.stringify(output);
      const threshold = this.options.artifacts.thresholdBytes ?? 64e3;
      if (new TextEncoder().encode(serialized).byteLength <= threshold) return output;
      const ref = await this.options.artifacts.store.put({
        name: `${invocation.call.name}-${invocation.call.id}.txt`,
        mimeType: "text/plain; charset=utf-8",
        kind: "text",
        data: new TextEncoder().encode(serialized),
        sessionId: invocation.sessionId,
        taskId: invocation.taskId
      });
      return {
        artifact: {
          artifactId: ref.artifactId,
          name: ref.name,
          mimeType: ref.mimeType,
          bytes: ref.bytes,
          kind: ref.kind
        },
        preview: serialized.slice(0, Math.min(2e3, threshold)),
        truncated: true
      };
    }
  };
  function toolResultText(result) {
    if (result.status === "succeeded") {
      if (result.output === void 0) return "(no output)";
      return typeof result.output === "string" ? result.output : JSON.stringify(result.output);
    }
    return JSON.stringify(result.error ?? new AgentError("TOOL_FAILED", "Tool failed").toStructured());
  }
  function createToolCall(call) {
    return {
      id: call.id,
      name: call.name,
      arguments: call.arguments.trim() || "{}"
    };
  }

  // src/core/tool-registry.ts
  var sourcePriority2 = {
    builtin: 0,
    user: 1,
    project: 2,
    plugin: 3,
    mcp: 4
  };
  var ToolRegistry = class {
    registrations = /* @__PURE__ */ new Map();
    register(registration) {
      const name = registration.definition.name.trim();
      if (!name) throw new AgentError("TOOL_NAME_INVALID", "Tool name cannot be empty");
      const sources2 = this.registrations.get(name) ?? /* @__PURE__ */ new Map();
      sources2.set(registration.source, {
        ...registration,
        definition: { ...registration.definition, name }
      });
      this.registrations.set(name, sources2);
    }
    registerAll(registrations) {
      for (const registration of registrations) this.register(registration);
    }
    remove(name) {
      return this.registrations.delete(name);
    }
    clearSource(source, sourceId) {
      for (const [name, sources2] of this.registrations) {
        const registration = sources2.get(source);
        if (registration && (sourceId === void 0 || registration.sourceId === sourceId)) {
          sources2.delete(source);
          if (sources2.size === 0) this.registrations.delete(name);
        }
      }
    }
    get(name) {
      const registration = this.effective(name);
      return registration?.enabled === false ? void 0 : registration?.definition;
    }
    resolve(selection = {}) {
      const allow = selection.allow ? new Set(selection.allow) : void 0;
      const deny = new Set(selection.deny ?? []);
      const required = selection.capabilities ?? [];
      return [...this.registrations.keys()].map((name) => this.effective(name)).filter((registration) => Boolean(registration)).filter((registration) => registration.enabled !== false).filter(({ definition }) => !allow || allow.has(definition.name)).filter(({ definition }) => !deny.has(definition.name)).filter(({ definition }) => {
        const provided = new Set(definition.capabilities ?? []);
        return required.every((capability) => provided.has(capability));
      }).sort((a, b) => a.definition.name.localeCompare(b.definition.name)).map(({ definition }) => definition);
    }
    diagnostics() {
      return [...this.registrations.keys()].sort().flatMap((name) => {
        const registration = this.effective(name);
        return registration ? [
          {
            name,
            source: registration.source,
            ...registration.sourceId ? { sourceId: registration.sourceId } : {},
            enabled: registration.enabled !== false
          }
        ] : [];
      });
    }
    effective(name) {
      const sources2 = this.registrations.get(name);
      if (!sources2) return void 0;
      return [...sources2.values()].sort(
        (a, b) => sourcePriority2[b.source] - sourcePriority2[a.source]
      )[0];
    }
  };

  // src/core/agent-loop.ts
  var AgentLoop = class {
    constructor(options) {
      this.options = options;
      this.maxSteps = options.maxSteps ?? 60;
    }
    options;
    maxSteps;
    steering = [];
    followUps = [];
    async run(request) {
      const messages = request.messages.map(cloneMessage);
      try {
        for (let turn = 1; turn <= this.maxSteps; turn += 1) {
          this.assertActive(request.signal);
          messages.push(...this.steering.splice(0));
          await request.onEvent?.({ type: "turn_start", taskId: request.taskId, turn });
          const messageId = this.options.ids.next("message");
          await request.onEvent?.({
            type: "message_start",
            taskId: request.taskId,
            messageId,
            role: "assistant"
          });
          let text = "";
          let reasoning = "";
          const calls = [];
          for await (const event of this.options.model.stream({
            sessionId: request.sessionId,
            taskId: request.taskId,
            messages: messages.map(cloneMessage),
            tools: this.options.tools.descriptors(),
            signal: request.signal
          })) {
            this.assertActive(request.signal);
            if (event.type === "text_delta") {
              text += event.text;
              await request.onEvent?.({
                type: "message_update",
                taskId: request.taskId,
                messageId,
                delta: event.text
              });
            } else if (event.type === "reasoning_delta") {
              reasoning += event.text;
              await request.onEvent?.({
                type: "reasoning_update",
                taskId: request.taskId,
                messageId,
                delta: event.text
              });
            } else if (event.type === "tool_call") {
              calls.push(createToolCall(event.call));
            } else if (event.type === "error") {
              throw new AgentError(event.error.code, event.error.message, {
                retryable: event.error.retryable,
                details: event.error.details
              });
            }
          }
          const assistantMessage = {
            role: "assistant",
            content: text,
            ...reasoning ? { reasoning } : {},
            ...calls.length ? { toolCalls: calls } : {}
          };
          messages.push(assistantMessage);
          await request.onEvent?.({
            type: "message_end",
            taskId: request.taskId,
            messageId,
            message: assistantMessage
          });
          if (calls.length === 0) {
            await request.onEvent?.({ type: "turn_end", taskId: request.taskId, turn });
            if (this.steering.length > 0 || this.followUps.length > 0) {
              messages.push(...this.steering.splice(0), ...this.followUps.splice(0));
              continue;
            }
            await request.onEvent?.({ type: "run_end", taskId: request.taskId, status: "completed" });
            return { status: "completed", messages };
          }
          const results = await this.executeTools(calls, request);
          for (let index = 0; index < calls.length; index += 1) {
            const call = calls[index];
            const result = results[index];
            messages.push({
              role: "tool",
              callId: call.id,
              name: call.name,
              content: toolResultText(result)
            });
          }
          await request.onEvent?.({ type: "turn_end", taskId: request.taskId, turn });
        }
        throw new AgentError("AGENT_MAX_STEPS", `Agent exceeded ${this.maxSteps} turns`);
      } catch (error) {
        const status = isAbortError(error) || request.signal.aborted ? "cancelled" : "failed";
        const structured = status === "cancelled" ? new AgentError("TASK_CANCELLED", "Task was cancelled").toStructured() : toStructuredError(error, "AGENT_LOOP_FAILED");
        await request.onEvent?.({ type: "run_end", taskId: request.taskId, status });
        return { status, messages, error: structured };
      }
    }
    assertActive(signal) {
      if (signal.aborted) throw new AgentError("TASK_CANCELLED", "Task was cancelled");
    }
    steer(message) {
      if (message.trim()) this.steering.push({ role: "user", content: message.trim() });
    }
    followUp(message) {
      if (message.trim()) this.followUps.push({ role: "user", content: message.trim() });
    }
    async executeTools(calls, request) {
      const allParallel = calls.every(
        (call) => this.options.tools.executionMode(call.name) === "parallel"
      );
      const execute = async (call) => {
        this.assertActive(request.signal);
        const pending = {
          callId: call.id,
          name: call.name,
          status: "failed"
        };
        await request.onEvent?.({
          type: "tool_execution_start",
          taskId: request.taskId,
          result: pending
        });
        const result = await this.options.tools.execute({
          sessionId: request.sessionId,
          taskId: request.taskId,
          call,
          signal: request.signal
        });
        await request.onEvent?.({
          type: "tool_execution_end",
          taskId: request.taskId,
          result
        });
        return result;
      };
      if (allParallel) return Promise.all(calls.map(execute));
      const results = [];
      for (const call of calls) results.push(await execute(call));
      return results;
    }
  };
  function cloneMessage(message) {
    if (message.role === "assistant") {
      return {
        ...message,
        ...message.toolCalls ? { toolCalls: message.toolCalls.map((call) => ({ ...call })) } : {}
      };
    }
    return { ...message };
  }

  // src/core/command-inbox.ts
  var CommandInbox = class {
    records = /* @__PURE__ */ new Map();
    tail = Promise.resolve();
    restore(acks) {
      for (const ack of acks) {
        if (this.records.has(ack.commandId)) continue;
        this.records.set(ack.commandId, {
          promise: Promise.resolve({ ...ack }),
          ack: { ...ack }
        });
      }
    }
    submit(command, handler) {
      const existing = this.records.get(command.commandId);
      if (existing) {
        return existing.promise.then((ack) => ({
          ...ack,
          status: "duplicate",
          error: {
            code: "COMMAND_DUPLICATE",
            message: `Command already received: ${command.commandId}`,
            retryable: false
          }
        }));
      }
      const record = {
        promise: Promise.resolve(void 0)
      };
      const promise = this.tail.then(() => handler(command)).then((ack) => {
        record.ack = ack;
        return ack;
      });
      record.promise = promise;
      this.tail = promise.then(
        () => void 0,
        () => void 0
      );
      this.records.set(command.commandId, record);
      return promise;
    }
    query(commandId) {
      const ack = this.records.get(commandId)?.ack;
      if (!ack) return void 0;
      return {
        ...ack,
        ...ack.error ? { error: { ...ack.error } } : {}
      };
    }
    async querySettled(commandId) {
      const record = this.records.get(commandId);
      if (!record) return void 0;
      return record.promise.catch(() => void 0);
    }
    snapshot() {
      return [...this.records.values()].flatMap((record) => record.ack ? [record.ack] : []).map((ack) => ({
        ...ack,
        ...ack.error ? { error: { ...ack.error } } : {}
      }));
    }
  };

  // src/core/session-tree.ts
  var SessionTree = class _SessionTree {
    entries = /* @__PURE__ */ new Map();
    activeLeafId;
    sequence = 0;
    constructor(options = {}) {
      this.now = options.now ?? (() => Date.now());
      for (const entry of options.entries ?? []) this.loadEntry(entry);
      this.activeLeafId = options.activeLeafId ?? null;
      if (this.activeLeafId && !this.entries.has(this.activeLeafId)) {
        throw new AgentError(
          "SESSION_LEAF_NOT_FOUND",
          `Active leaf not found: ${this.activeLeafId}`
        );
      }
    }
    now;
    get activeLeaf() {
      return this.activeLeafId;
    }
    append(input) {
      const parentId = input.parentId === void 0 ? this.activeLeafId : input.parentId;
      if (parentId !== null && !this.entries.has(parentId)) {
        throw new AgentError("SESSION_PARENT_NOT_FOUND", `Parent entry not found: ${parentId}`);
      }
      const id = input.id ?? `entry_${++this.sequence}`;
      if (this.entries.has(id)) {
        throw new AgentError("SESSION_ENTRY_DUPLICATE", `Session entry already exists: ${id}`);
      }
      const match = id.match(/^entry_(\d+)$/);
      if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
      const entry = {
        id,
        parentId,
        type: input.type,
        createdAt: input.createdAt ?? this.now(),
        payload: cloneJson2(input.payload)
      };
      this.entries.set(id, entry);
      this.activeLeafId = id;
      return cloneEntry(entry);
    }
    get(id) {
      const entry = this.entries.get(id);
      return entry ? cloneEntry(entry) : void 0;
    }
    selectLeaf(id) {
      if (!this.entries.has(id)) {
        throw new AgentError("SESSION_LEAF_NOT_FOUND", `Session entry not found: ${id}`);
      }
      this.activeLeafId = id;
    }
    branch(entryId) {
      this.selectLeaf(entryId);
      return this.activePath();
    }
    activePath() {
      if (!this.activeLeafId) return [];
      const path = [];
      const seen = /* @__PURE__ */ new Set();
      let currentId = this.activeLeafId;
      while (currentId) {
        if (seen.has(currentId)) {
          throw new AgentError("SESSION_TREE_CYCLE", `Cycle detected at session entry ${currentId}`);
        }
        seen.add(currentId);
        const entry = this.entries.get(currentId);
        if (!entry) {
          throw new AgentError(
            "SESSION_PARENT_NOT_FOUND",
            `Missing parent while resolving path: ${currentId}`
          );
        }
        path.push(entry);
        currentId = entry.parentId;
      }
      return path.reverse().map(cloneEntry);
    }
    context(leafId = this.activeLeafId) {
      const path = this.pathTo(leafId);
      const hidden = /* @__PURE__ */ new Set();
      const replacements = /* @__PURE__ */ new Map();
      for (const entry of path) {
        if (entry.type !== "context_edit") continue;
        const edit = entry.payload;
        for (const id of edit.hideEntryIds ?? []) hidden.add(id);
        for (const [id, value] of Object.entries(edit.replacements ?? {})) {
          replacements.set(id, cloneJson2(value));
        }
      }
      const latestCompactionIndex = findLastIndex(path, (entry) => entry.type === "compaction");
      const latestCompaction = latestCompactionIndex >= 0 ? path[latestCompactionIndex] : void 0;
      let rangeStart = 0;
      const items = [];
      if (latestCompaction) {
        const compaction = latestCompaction.payload;
        const keptIndex = path.findIndex((entry) => entry.id === compaction.firstKeptEntryId);
        if (keptIndex < 0 || keptIndex >= latestCompactionIndex) {
          throw new AgentError(
            "COMPACTION_BOUNDARY_INVALID",
            `Compaction ${latestCompaction.id} references an invalid retained entry`
          );
        }
        items.push({
          sourceEntryId: latestCompaction.id,
          role: "compaction",
          content: compaction.summary
        });
        rangeStart = keptIndex;
      }
      const effectivePath = [];
      for (let index = rangeStart; index < path.length; index += 1) {
        const entry = path[index];
        if (entry.type === "compaction" || entry.type === "context_edit" || entry.type === "model_change") {
          continue;
        }
        if (hidden.has(entry.id)) continue;
        if (entry.type === "message") {
          const message = entry.payload;
          items.push({
            sourceEntryId: entry.id,
            role: message.role,
            content: cloneJson2(replacements.get(entry.id) ?? message.content)
          });
          effectivePath.push(entry);
        } else if (entry.type === "custom") {
          items.push({
            sourceEntryId: entry.id,
            role: "user",
            content: cloneJson2(replacements.get(entry.id) ?? entry.payload)
          });
          effectivePath.push(entry);
        } else if (entry.type === "branch_summary") {
          effectivePath.push(entry);
        }
      }
      const details = latestCompaction ? latestCompaction.payload.details : void 0;
      return {
        leafId,
        items,
        effectivePath,
        ...latestCompaction ? { latestCompactionEntryId: latestCompaction.id } : {},
        readFiles: [...details?.readFiles ?? []],
        modifiedFiles: [...details?.modifiedFiles ?? []],
        ...details?.approvedPlanPath ? { approvedPlanPath: details.approvedPlanPath } : {}
      };
    }
    fork(entryId = this.activeLeafId) {
      if (entryId !== null && !this.entries.has(entryId)) {
        throw new AgentError("SESSION_LEAF_NOT_FOUND", `Session entry not found: ${entryId}`);
      }
      return new _SessionTree({
        entries: [...this.entries.values()].map(cloneEntry),
        activeLeafId: entryId,
        now: this.now
      });
    }
    children(parentId) {
      return [...this.entries.values()].filter((entry) => entry.parentId === parentId).map(cloneEntry);
    }
    rawEntries() {
      return [...this.entries.values()].map(cloneEntry);
    }
    pathTo(leafId) {
      if (!leafId) return [];
      const previous = this.activeLeafId;
      this.activeLeafId = leafId;
      try {
        return this.activePath();
      } finally {
        this.activeLeafId = previous;
      }
    }
    loadEntry(input) {
      if (this.entries.has(input.id)) {
        throw new AgentError("SESSION_ENTRY_DUPLICATE", `Session entry already exists: ${input.id}`);
      }
      this.entries.set(input.id, cloneEntry(input));
      const match = input.id.match(/^entry_(\d+)$/);
      if (match) this.sequence = Math.max(this.sequence, Number(match[1]));
    }
  };
  function findLastIndex(items, predicate) {
    for (let index = items.length - 1; index >= 0; index -= 1) {
      if (predicate(items[index])) return index;
    }
    return -1;
  }
  function cloneEntry(entry) {
    return { ...entry, payload: cloneJson2(entry.payload) };
  }
  function cloneJson2(value) {
    if (Array.isArray(value)) return value.map(cloneJson2);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, child]) => [key, cloneJson2(child)])
      );
    }
    return value;
  }

  // src/core/compaction.ts
  function defaultTokenEstimator(entry) {
    return Math.max(1, Math.ceil(JSON.stringify(entry.payload).length / 4));
  }
  function planCompaction(tree, budget, estimateTokens = defaultTokenEstimator) {
    validateBudget(budget);
    const path = tree.activePath();
    if (path.length < 2) {
      throw new AgentError(
        "COMPACTION_CUTPOINT_UNAVAILABLE",
        "At least two session entries are required for compaction"
      );
    }
    const latestCompactionIndex = lastCompactionIndex(path);
    const candidates = [];
    let tailTokens = 0;
    for (let index = path.length - 1; index >= latestCompactionIndex + 1; index -= 1) {
      const entry = path[index];
      if (entry.type !== "compaction" && entry.type !== "context_edit" && entry.type !== "model_change") {
        tailTokens += estimateTokens(entry);
      }
      if (isSafeCutpoint(entry) && tailTokens >= budget.keepRecentTokens) {
        candidates.push({ index, tailTokens });
      }
    }
    if (candidates.length === 0) {
      throw new AgentError(
        "COMPACTION_CUTPOINT_UNAVAILABLE",
        "No user/assistant/custom/bash boundary preserves the requested recent context"
      );
    }
    const candidate = candidates[0];
    const retained = path.slice(candidate.index);
    return {
      firstKeptEntryId: path[candidate.index].id,
      tokensBefore: totalTokens(path, estimateTokens),
      tokensAfter: candidate.tailTokens,
      retainedEntryIds: retained.map((entry) => entry.id)
    };
  }
  function appendCompaction(tree, request) {
    if (!request.summary.trim()) {
      throw new AgentError("COMPACTION_SUMMARY_EMPTY", "Compaction summary cannot be empty");
    }
    const estimateTokens = request.estimateTokens ?? defaultTokenEstimator;
    const plan = planCompaction(tree, request.budget, estimateTokens);
    const payload = {
      summary: request.summary.trim(),
      firstKeptEntryId: plan.firstKeptEntryId,
      tokensBefore: plan.tokensBefore,
      ...request.usage ? { usage: { ...request.usage } } : {},
      ...request.details ? {
        details: {
          readFiles: [...request.details.readFiles ?? []],
          modifiedFiles: [...request.details.modifiedFiles ?? []],
          ...request.details.approvedPlanPath ? { approvedPlanPath: request.details.approvedPlanPath } : {}
        }
      } : {}
    };
    const parentId = tree.activeLeaf;
    const entry = tree.append({
      type: "compaction",
      parentId,
      payload
    });
    return { entry, plan };
  }
  function isSafeCutpoint(entry) {
    if (entry.type === "custom" || entry.type === "branch_summary") return true;
    if (entry.type !== "message") return false;
    const message = entry.payload;
    return message.role !== "tool";
  }
  function validateBudget(budget) {
    for (const [name, value] of Object.entries(budget)) {
      if (!Number.isFinite(value) || value < 0) {
        throw new AgentError("CONTEXT_BUDGET_INVALID", `Context budget ${name} must be non-negative`);
      }
    }
    if (budget.reserveTokens >= budget.contextWindow) {
      throw new AgentError(
        "CONTEXT_BUDGET_INVALID",
        "reserveTokens must be lower than contextWindow"
      );
    }
    if (budget.keepRecentTokens >= budget.contextWindow) {
      throw new AgentError(
        "CONTEXT_BUDGET_INVALID",
        "keepRecentTokens must be lower than contextWindow"
      );
    }
  }
  function totalTokens(path, estimate) {
    return path.reduce((sum, entry) => sum + estimate(entry), 0);
  }
  function lastCompactionIndex(path) {
    for (let index = path.length - 1; index >= 0; index -= 1) {
      if (path[index].type === "compaction") return index;
    }
    return -1;
  }

  // src/core/context-manager.ts
  function buildModelContext(tree, systemPrompt = "") {
    const messages = [];
    if (systemPrompt.trim()) messages.push({ role: "system", content: systemPrompt });
    const context = tree.context();
    for (const item of context.items) {
      if (item.role === "compaction") {
        messages.push({
          role: "user",
          content: `(Conversation summary)
${stringContent(item.content)}`
        });
        continue;
      }
      const entry = tree.get(item.sourceEntryId);
      if (!entry || entry.type !== "message") {
        if (item.role === "user" || item.role === "assistant" || item.role === "system") {
          messages.push({ role: item.role, content: stringContent(item.content) });
        }
        continue;
      }
      const payload = entry.payload;
      if (payload.role === "tool") {
        messages.push({
          role: "tool",
          callId: payload.toolCallId ?? "unknown_call",
          name: payload.toolName ?? "tool",
          content: stringContent(item.content)
        });
      } else if (payload.role === "assistant") {
        messages.push({
          role: "assistant",
          content: stringContent(item.content),
          ...payload.toolCalls?.length ? { toolCalls: payload.toolCalls.map((call) => ({ ...call })) } : {}
        });
      } else if (payload.role === "user" || payload.role === "system") {
        messages.push({ role: payload.role, content: stringContent(item.content) });
      }
    }
    return messages;
  }
  function stringContent(value) {
    if (typeof value === "string") return value;
    if (value === null || value === void 0) return "";
    return JSON.stringify(value);
  }

  // src/core/event-log.ts
  var EventLog = class {
    constructor(logEpoch, now) {
      this.logEpoch = logEpoch;
      this.now = now;
    }
    logEpoch;
    now;
    events = [];
    append(type, revision, payload) {
      const event = {
        seq: this.events.length + 1,
        type,
        revision,
        occurredAt: this.now(),
        ...payload === void 0 ? {} : { payload }
      };
      this.events.push(event);
      return { ...event };
    }
    get seq() {
      return this.events.length;
    }
    list() {
      return this.events.map((event) => ({ ...event }));
    }
    restore(events) {
      this.events = events.map((event) => ({ ...event }));
    }
  };

  // src/core/state-machines.ts
  var lifecycleTransitions = {
    unloaded: ["starting"],
    starting: ["ready", "faulted"],
    ready: ["stopping", "faulted"],
    stopping: ["unloaded", "faulted"],
    faulted: []
  };
  var taskTransitions = {
    queued: ["running", "cancelled", "failed"],
    running: ["waiting", "paused", "completed", "failed", "cancelled"],
    waiting: ["running", "paused", "completed", "failed", "cancelled"],
    paused: ["queued", "running", "cancelled", "failed"],
    completed: [],
    failed: [],
    cancelled: []
  };
  function canTransitionLifecycle(from, to) {
    return lifecycleTransitions[from].includes(to);
  }
  function assertLifecycleTransition(from, to) {
    if (!canTransitionLifecycle(from, to)) {
      throw new AgentError(
        "LIFECYCLE_TRANSITION_INVALID",
        `Invalid session lifecycle transition: ${from} -> ${to}`
      );
    }
  }
  function canTransitionTask(from, to) {
    return taskTransitions[from].includes(to);
  }
  function isTerminalTaskStatus(status) {
    return status === "completed" || status === "failed" || status === "cancelled";
  }

  // src/core/input-ledger.ts
  var InputLedger = class {
    entries = /* @__PURE__ */ new Map();
    admit(input) {
      if (this.entries.has(input.inputId)) {
        throw new AgentError("INPUT_DUPLICATE", `Input already exists: ${input.inputId}`);
      }
      const entry = { ...input, status: "admitted" };
      this.entries.set(entry.inputId, entry);
      return { ...entry };
    }
    promote(inputId) {
      return this.terminate(inputId, "admitted", "promoted");
    }
    cancel(inputId, reason = "cancelled") {
      return this.terminate(inputId, "admitted", "cancelled", reason);
    }
    discard(inputId, reason = "session_resumed") {
      return this.terminate(inputId, "admitted", "discarded", reason);
    }
    fail(inputId, reason) {
      return this.terminate(inputId, "admitted", "failed", reason);
    }
    get(inputId) {
      const entry = this.entries.get(inputId);
      return entry ? { ...entry } : void 0;
    }
    list() {
      return [...this.entries.values()].map((entry) => ({ ...entry }));
    }
    restore(entries) {
      this.entries.clear();
      for (const entry of entries) this.entries.set(entry.inputId, { ...entry });
    }
    terminate(inputId, expected, next, reason) {
      const entry = this.entries.get(inputId);
      if (!entry) throw new AgentError("INPUT_NOT_FOUND", `Input not found: ${inputId}`);
      if (entry.status !== expected) {
        throw new AgentError(
          "INPUT_TRANSITION_INVALID",
          `Input ${inputId} cannot transition from ${entry.status} to ${next}`,
          { details: { inputId, current: entry.status, next } }
        );
      }
      const updated = {
        ...entry,
        status: next,
        ...reason === void 0 ? {} : { terminalReason: reason }
      };
      this.entries.set(inputId, updated);
      return { ...updated };
    }
  };

  // src/core/session-lifecycle.ts
  var SessionLifecycleController = class {
    constructor(sessionId, clock, onChange) {
      this.sessionId = sessionId;
      this.clock = clock;
      this.onChange = onChange;
      this.snapshot = {
        sessionId,
        state: "unloaded",
        generation: 0,
        revision: 0
      };
    }
    sessionId;
    clock;
    onChange;
    snapshot;
    operation;
    getState() {
      return { ...this.snapshot };
    }
    async ensureReady(open) {
      if (this.snapshot.state === "ready") return;
      if (this.snapshot.state === "faulted") {
        throw new AgentError("SESSION_FAULTED", `Session is faulted: ${this.sessionId}`);
      }
      if (this.snapshot.state === "starting" && this.operation) {
        await this.operation;
        return;
      }
      if (this.snapshot.state === "stopping") {
        throw new AgentError("SESSION_STOPPING", `Session is stopping: ${this.sessionId}`);
      }
      this.operation = this.start(open);
      await this.operation;
    }
    async stop(close) {
      if (this.snapshot.state === "unloaded") return;
      if (this.snapshot.state === "stopping" && this.operation) {
        await this.operation;
        return;
      }
      if (this.snapshot.state === "starting" && this.operation) {
        try {
          await this.operation;
        } catch {
        }
      }
      if (this.snapshot.state !== "ready") return;
      this.operation = this.stopReady(close);
      await this.operation;
    }
    async restart(close, open) {
      await this.stop(close);
      if (this.snapshot.state === "faulted") {
        throw new AgentError("SESSION_RESTART_BLOCKED", "Cannot restart a faulted session without recovery");
      }
      this.setOperation("restart");
      try {
        await this.ensureReady(open);
      } finally {
        this.clearOperation();
      }
    }
    async start(open) {
      this.transition("starting");
      this.setOperation("ensureReady");
      try {
        await open();
        if (this.snapshot.state !== "starting") return;
        this.transition("ready");
        this.snapshot.generation += 1;
        this.emit();
      } catch (error) {
        this.fault("ensureReady", error);
        throw error;
      } finally {
        this.operation = void 0;
        this.clearOperation();
      }
    }
    async stopReady(close) {
      this.transition("stopping");
      this.setOperation("stop");
      try {
        await close();
        this.transition("unloaded");
      } catch (error) {
        this.fault("stop", error);
        throw error;
      } finally {
        this.operation = void 0;
        this.clearOperation();
      }
    }
    transition(next) {
      assertLifecycleTransition(this.snapshot.state, next);
      this.snapshot = {
        ...this.snapshot,
        state: next,
        revision: this.snapshot.revision + 1
      };
      this.emit();
    }
    fault(operation, error) {
      if (this.snapshot.state === "faulted") return;
      this.snapshot = {
        ...this.snapshot,
        state: "faulted",
        revision: this.snapshot.revision + 1,
        lastError: {
          code: "SESSION_FAULTED",
          message: error instanceof Error ? error.message : String(error),
          retryable: false,
          details: { operation, at: this.clock.now() }
        }
      };
      this.emit();
    }
    setOperation(operation) {
      this.snapshot = { ...this.snapshot, activeOperation: operation };
      this.emit();
    }
    clearOperation() {
      const { activeOperation: _activeOperation, ...rest } = this.snapshot;
      this.snapshot = rest;
      this.emit();
    }
    emit() {
      this.onChange?.({ ...this.snapshot });
    }
  };

  // src/core/task-graph.ts
  var TaskGraph = class {
    constructor(now = () => Date.now(), initial = []) {
      this.now = now;
      for (const task of initial) this.tasks.set(task.taskId, cloneTask(task));
    }
    now;
    tasks = /* @__PURE__ */ new Map();
    sequence = 0;
    create(request) {
      if (this.tasks.has(request.taskId)) {
        throw new AgentError("TASK_DUPLICATE", `Task already exists: ${request.taskId}`);
      }
      if (request.parentTaskId && !this.tasks.has(request.parentTaskId)) {
        throw new AgentError("TASK_PARENT_NOT_FOUND", `Parent task not found: ${request.parentTaskId}`);
      }
      const now = this.now();
      const task = {
        taskId: request.taskId,
        sessionId: request.sessionId,
        ...request.parentTaskId ? { parentTaskId: request.parentTaskId } : {},
        status: "queued",
        revision: 1,
        budget: { ...request.budget ?? {} },
        usage: { turns: 0, toolCalls: 0, tokens: 0 },
        children: [],
        createdAt: now,
        updatedAt: now
      };
      this.tasks.set(task.taskId, task);
      if (task.parentTaskId) {
        const parent = this.tasks.get(task.parentTaskId);
        parent.children.push(task.taskId);
        parent.revision += 1;
        parent.updatedAt = now;
      }
      return cloneTask(task);
    }
    get(taskId) {
      const task = this.tasks.get(taskId);
      return task ? cloneTask(task) : void 0;
    }
    transition(taskId, next, checkpoint) {
      const task = this.required(taskId);
      if (!canTransitionTask(task.status, next)) {
        throw new AgentError(
          "TASK_TRANSITION_INVALID",
          `Invalid task transition: ${task.status} -> ${next}`
        );
      }
      task.status = next;
      task.revision += 1;
      task.updatedAt = this.now();
      if (checkpoint !== void 0) task.checkpoint = structuredClone(checkpoint);
      return cloneTask(task);
    }
    claimLease(taskId, ownerId, ttlMs) {
      const task = this.required(taskId);
      if (isTerminalTaskStatus(task.status)) {
        throw new AgentError("TASK_TERMINAL", `Cannot lease terminal task: ${taskId}`);
      }
      if (task.lease && task.lease.expiresAt > this.now() && task.lease.ownerId !== ownerId) {
        throw new AgentError(
          "TASK_LEASE_HELD",
          `Task lease is held by ${task.lease.ownerId} until ${task.lease.expiresAt}`
        );
      }
      task.lease = {
        ownerId,
        fencingToken: ++this.sequence,
        expiresAt: this.now() + ttlMs
      };
      task.revision += 1;
      task.updatedAt = this.now();
      return { ...task.lease };
    }
    renewLease(taskId, fencingToken, ttlMs) {
      const task = this.required(taskId);
      this.assertFence(task, fencingToken);
      task.lease = {
        ...task.lease,
        expiresAt: this.now() + ttlMs
      };
      task.revision += 1;
      task.updatedAt = this.now();
      return { ...task.lease };
    }
    releaseLease(taskId, fencingToken) {
      const task = this.required(taskId);
      this.assertFence(task, fencingToken);
      delete task.lease;
      task.revision += 1;
      task.updatedAt = this.now();
    }
    assertWrite(taskId, fencingToken) {
      const task = this.required(taskId);
      this.assertFence(task, fencingToken);
    }
    recordUsage(taskId, delta) {
      const task = this.required(taskId);
      task.usage = {
        ...task.usage,
        turns: task.usage.turns + (delta.turns ?? 0),
        toolCalls: task.usage.toolCalls + (delta.toolCalls ?? 0),
        tokens: task.usage.tokens + (delta.tokens ?? 0),
        ...task.usage.startedAt === void 0 ? { startedAt: this.now() } : {}
      };
      task.revision += 1;
      task.updatedAt = this.now();
      if (this.budgetExceeded(task) && !isTerminalTaskStatus(task.status)) {
        task.status = "paused";
      }
      return cloneTask(task);
    }
    cancelTree(taskId, reason = "cancelled") {
      const task = this.required(taskId);
      const cancelled2 = [];
      const visit = (current) => {
        for (const childId of current.children) {
          const child = this.tasks.get(childId);
          if (child) visit(child);
        }
        if (!isTerminalTaskStatus(current.status)) {
          current.status = "cancelled";
          current.revision += 1;
          current.updatedAt = this.now();
          current.checkpoint = { reason };
          cancelled2.push(current.taskId);
        }
      };
      visit(task);
      return cancelled2;
    }
    list() {
      return [...this.tasks.values()].map(cloneTask);
    }
    required(taskId) {
      const task = this.tasks.get(taskId);
      if (!task) throw new AgentError("TASK_NOT_FOUND", `Task not found: ${taskId}`);
      return task;
    }
    assertFence(task, fencingToken) {
      if (!task.lease || task.lease.fencingToken !== fencingToken) {
        throw new AgentError("TASK_LEASE_STALE", `Stale task lease for ${task.taskId}`);
      }
      if (task.lease.expiresAt <= this.now()) {
        throw new AgentError("TASK_LEASE_EXPIRED", `Task lease expired for ${task.taskId}`);
      }
    }
    budgetExceeded(task) {
      return task.budget.maxTurns !== void 0 && task.usage.turns >= task.budget.maxTurns || task.budget.maxToolCalls !== void 0 && task.usage.toolCalls >= task.budget.maxToolCalls || task.budget.maxTokens !== void 0 && task.usage.tokens >= task.budget.maxTokens || task.budget.deadlineMs !== void 0 && task.usage.startedAt !== void 0 && this.now() - task.usage.startedAt >= task.budget.deadlineMs;
    }
  };
  function cloneTask(task) {
    return {
      ...task,
      budget: { ...task.budget },
      usage: { ...task.usage },
      ...task.lease ? { lease: { ...task.lease } } : {},
      ...task.checkpoint !== void 0 ? { checkpoint: structuredClone(task.checkpoint) } : {},
      children: [...task.children]
    };
  }

  // src/core/session-runtime.ts
  var SessionRuntime = class {
    constructor(options) {
      this.options = options;
      this.sessionId = options.sessionId;
      this.clock = options.clock;
      this.ids = options.ids;
      this.logEpoch = options.initialSnapshot?.logEpoch ?? options.logEpoch ?? this.ids.next("epoch");
      this.events = new EventLog(this.logEpoch, () => this.clock.now());
      this.sessionStore = options.sessionStore;
      this.permissionModes = options.permissionModes ?? new PermissionModeRegistry("guarded", () => this.clock.now());
      this.sessionTree = new SessionTree({
        entries: options.initialSnapshot?.sessionEntries ?? [],
        activeLeafId: options.initialSnapshot?.activeLeafId ?? null,
        now: () => this.clock.now()
      });
      this.taskGraph = new TaskGraph(
        () => this.clock.now(),
        options.initialSnapshot?.tasks ?? []
      );
      this.systemPrompt = options.systemPrompt ?? options.initialSnapshot?.messages.find((message) => message.role === "system")?.content ?? "";
      this.lifecycle = new SessionLifecycleController(
        options.sessionId,
        options.clock,
        () => this.touch("lifecycle.changed")
      );
      this.loop = new AgentLoop({
        model: options.model,
        tools: options.tools,
        ids: options.ids,
        maxSteps: options.maxSteps
      });
      if (this.systemPrompt) this.messages.push({ role: "system", content: this.systemPrompt });
      if (options.initialSnapshot) this.restore(options.initialSnapshot);
    }
    options;
    sessionId;
    lifecycle;
    inbox = new CommandInbox();
    ledger = new InputLedger();
    loop;
    clock;
    ids;
    logEpoch;
    events;
    sessionStore;
    sessionTree;
    taskGraph;
    systemPrompt;
    permissionModes;
    queue = [];
    rows = [];
    messages = [];
    listeners = /* @__PURE__ */ new Set();
    idleWaiters = /* @__PURE__ */ new Set();
    children = /* @__PURE__ */ new Map();
    status = "completed";
    revision = 0;
    eventSeq = 0;
    activeTaskId;
    lastError;
    running = false;
    abort;
    persistTail = Promise.resolve();
    persistenceError;
    overflowRetries = /* @__PURE__ */ new Set();
    toolSpans = /* @__PURE__ */ new Map();
    async ensureReady() {
      await this.lifecycle.ensureReady(async () => {
        if (this.options.onOpen) await this.options.onOpen(this.sessionId);
      });
    }
    async command(command) {
      const result = await this.inbox.submit(command, async (current) => {
        if (current.sessionId !== this.sessionId) {
          return this.ack(current, "rejected", "SESSION_MISMATCH", "Command session does not match");
        }
        if (this.lifecycle.getState().state !== "ready") {
          return this.ack(current, "rejected", "SESSION_NOT_READY", "Session is not ready");
        }
        if (current.baseRevision !== void 0 && current.baseRevision !== this.revision) {
          return this.ack(
            current,
            "stale",
            "COMMAND_STALE",
            `Expected revision ${this.revision}, received ${current.baseRevision}`
          );
        }
        if (current.type === "send_input") return this.sendInput(current);
        if (current.type === "stop") return this.stop(current);
        if (current.type === "set_mode") return this.setPermissionMode(current);
        if (current.type === "submit_plan") return this.submitPlan(current);
        if (current.type === "approve_plan") return this.approvePlan(current);
        if (current.type === "compact") return this.compact(current);
        return this.ack(current, "rejected", "COMMAND_UNSUPPORTED", "Unsupported command");
      });
      if (this.sessionStore) {
        this.schedulePersist();
        await this.flushPersistence();
      }
      return result;
    }
    queryCommand(commandId) {
      return this.inbox.query(commandId);
    }
    ownsTask(taskId) {
      return Boolean(this.taskGraph.get(taskId));
    }
    contextMessages() {
      return buildModelContext(this.sessionTree, this.systemPrompt);
    }
    updateChildTask(parentTaskId, child) {
      if (!this.taskGraph.get(parentTaskId) && !this.rows.some((row) => row.productTurnId === parentTaskId)) {
        return false;
      }
      this.children.set(child.taskId, { ...child });
      this.touch("child_task.updated");
      return true;
    }
    view() {
      const mode = this.permissionModes.get(this.sessionId).getState();
      return {
        sessionId: this.sessionId,
        lifecycle: this.lifecycle.getState().state,
        taskStatus: this.status,
        revision: this.revision,
        eventSeq: this.eventSeq,
        logEpoch: this.logEpoch,
        queueLength: this.queue.length,
        ...this.activeTaskId ? { activeTaskId: this.activeTaskId } : {},
        ...this.lastError ? { lastError: { ...this.lastError } } : {},
        permissionMode: mode.mode,
        ...mode.plan || mode.approvedAt ? {
          plan: {
            ...mode.plan ? { text: mode.plan } : {},
            ...mode.approvedAt ? { approvedAt: mode.approvedAt } : {},
            ...mode.approvedDigest ? { approvedDigest: mode.approvedDigest } : {}
          }
        } : {},
        ...this.children.size ? { children: [...this.children.values()].map((child) => ({ ...child })) } : {},
        rows: this.rows.map((row) => ({ ...row })),
        pendingApproval: false,
        ledger: this.ledger.list()
      };
    }
    projection() {
      return buildProjection(this.view());
    }
    eventLog() {
      return this.events.list();
    }
    async flushPersistence() {
      await this.persistTail;
      if (this.persistenceError) {
        throw new AgentError(
          this.persistenceError.code,
          this.persistenceError.message,
          { retryable: this.persistenceError.retryable }
        );
      }
    }
    subscribe(listener) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }
    async waitForIdle() {
      if (!this.running && this.queue.length === 0) return;
      await new Promise((resolve) => this.idleWaiters.add(resolve));
    }
    async stopInstance() {
      await this.lifecycle.stop(async () => {
        this.abort?.abort();
        this.cancelQueued("session_stopped");
        await this.waitForIdle();
        await this.options.onClose?.(this.sessionId);
      });
    }
    async restartInstance() {
      await this.lifecycle.restart(
        async () => {
          this.abort?.abort();
          this.cancelQueued("session_restart");
          await this.waitForIdle();
          await this.options.onClose?.(this.sessionId);
        },
        async () => {
          if (this.options.onOpen) await this.options.onOpen(this.sessionId);
        }
      );
    }
    async sendInput(command) {
      const payload = command.payload;
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) return this.ack(command, "rejected", "INPUT_EMPTY", "Input text cannot be empty");
      const modelText = composeUserInput(text, payload.context);
      if (payload.delivery === "guide" && this.running && this.activeTaskId) {
        return this.guideInput(command, text, modelText);
      }
      const inputId = this.ids.next("input");
      const taskId = this.ids.next("task");
      this.taskGraph.create({
        taskId,
        sessionId: this.sessionId,
        budget: {}
      });
      this.ledger.admit({
        inputId,
        sourceCommandId: command.commandId,
        text,
        delivery: payload.delivery ?? (this.activeTaskId ? "queue" : "startNow"),
        admittedAt: this.clock.now()
      });
      this.rows.push({
        id: this.ids.next("row"),
        entityId: inputId,
        productTurnId: taskId,
        kind: "user",
        text,
        status: "pending"
      });
      this.queue.push({ inputId, commandId: command.commandId, taskId, text, modelText });
      if (!this.activeTaskId) {
        this.activeTaskId = taskId;
        this.status = "queued";
      }
      this.touch("input.admitted");
      try {
        await this.flushPersistence();
      } catch (error) {
        this.ledger.fail(inputId, "persistence_failed");
        this.status = "failed";
        this.lastError = toStructuredError(error, "PERSISTENCE_FAILED");
        const row = this.rows.find((candidate) => candidate.entityId === inputId);
        if (row) row.status = "failed";
        this.touch("persistence.failed");
        return this.ack(
          command,
          "failed",
          "PERSISTENCE_FAILED",
          this.lastError.message
        );
      }
      const ack = this.ack(command, "accepted", void 0, void 0, inputId, taskId);
      queueMicrotask(() => void this.pump());
      return ack;
    }
    async guideInput(command, text, modelText) {
      const inputId = this.ids.next("input");
      this.ledger.admit({
        inputId,
        sourceCommandId: command.commandId,
        text,
        delivery: "guide",
        admittedAt: this.clock.now()
      });
      this.rows.push({
        id: this.ids.next("row"),
        entityId: inputId,
        productTurnId: this.activeTaskId,
        kind: "user",
        text,
        status: "completed"
      });
      this.sessionTree.append({
        type: "message",
        payload: { role: "user", content: modelText }
      });
      this.loop.steer(modelText);
      this.ledger.promote(inputId);
      this.touch("input.steered");
      try {
        await this.flushPersistence();
      } catch (error) {
        this.lastError = toStructuredError(error, "PERSISTENCE_FAILED");
        return this.ack(command, "failed", "PERSISTENCE_FAILED", this.lastError.message, inputId);
      }
      return this.ack(command, "accepted", void 0, void 0, inputId, this.activeTaskId);
    }
    setPermissionMode(command) {
      const payload = command.payload;
      const allowed = ["plan", "build", "edit", "guarded", "sandbox-auto"];
      if (!allowed.includes(payload?.mode)) {
        return this.ack(command, "rejected", "PERMISSION_MODE_INVALID", "Unknown permission mode");
      }
      try {
        this.permissionModes.get(this.sessionId).setMode(payload.mode);
      } catch (error) {
        return this.ack(
          command,
          "rejected",
          error instanceof AgentError ? error.code : "PERMISSION_MODE_REJECTED",
          error instanceof Error ? error.message : String(error)
        );
      }
      this.touch("permission_mode.changed");
      return this.ack(command, "accepted");
    }
    async submitPlan(command) {
      const payload = command.payload;
      try {
        await this.permissionModes.get(this.sessionId).submitPlan(String(payload?.plan ?? ""));
      } catch (error) {
        return this.ack(
          command,
          "rejected",
          error instanceof AgentError ? error.code : "PLAN_REJECTED",
          error instanceof Error ? error.message : String(error)
        );
      }
      this.touch("plan.submitted");
      return this.ack(command, "accepted");
    }
    approvePlan(command) {
      try {
        this.permissionModes.get(this.sessionId).approvePlan();
      } catch (error) {
        return this.ack(
          command,
          "rejected",
          error instanceof AgentError ? error.code : "PLAN_APPROVAL_REJECTED",
          error instanceof Error ? error.message : String(error)
        );
      }
      this.touch("plan.approved");
      return this.ack(command, "accepted");
    }
    async compact(command) {
      if (this.running || this.queue.length > 0) {
        return this.ack(command, "rejected", "SESSION_BUSY", "Cannot compact while a task is running");
      }
      const payload = command.payload;
      const budget = payload.budget ?? {
        contextWindow: 16e3,
        reserveTokens: 2e3,
        keepRecentTokens: 4e3,
        maxOutputTokens: 2e3
      };
      let summary = payload.summary?.trim() ?? "";
      if (!summary) {
        const transcript = buildModelContext(this.sessionTree, "").map((message) => `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`).join("\n\n");
        try {
          for await (const event of this.options.model.stream({
            sessionId: this.sessionId,
            taskId: this.ids.next("compaction_task"),
            messages: [
              {
                role: "system",
                content: "Summarize this conversation for future work. Preserve decisions, facts, URLs, files, code changes, open tasks and verification evidence. Output only the summary."
              },
              { role: "user", content: transcript }
            ],
            tools: [],
            signal: new AbortController().signal
          })) {
            if (event.type === "text_delta") summary += event.text;
            if (event.type === "error") throw new AgentError(event.error.code, event.error.message);
          }
        } catch (error) {
          return this.ack(
            command,
            "failed",
            "COMPACTION_SUMMARY_FAILED",
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      try {
        appendCompaction(this.sessionTree, {
          summary,
          budget,
          details: payload.details
        });
        this.messages.splice(
          0,
          this.messages.length,
          ...buildModelContext(this.sessionTree, this.systemPrompt)
        );
        const activityId = this.ids.next("activity");
        this.rows.push({
          id: activityId,
          entityId: activityId,
          productTurnId: "session_compaction",
          kind: "activity",
          text: "Context compacted",
          status: "completed"
        });
      } catch (error) {
        return this.ack(
          command,
          "rejected",
          error instanceof AgentError ? error.code : "COMPACTION_FAILED",
          error instanceof Error ? error.message : String(error)
        );
      }
      this.touch("session.compacted");
      return this.ack(command, "accepted");
    }
    async generateCompactionSummary() {
      const transcript = buildModelContext(this.sessionTree, "").map(
        (message) => `${message.role}: ${typeof message.content === "string" ? message.content : JSON.stringify(message.content)}`
      ).join("\n\n");
      let summary = "";
      for await (const event of this.options.model.stream({
        sessionId: this.sessionId,
        taskId: this.ids.next("compaction_task"),
        messages: [
          {
            role: "system",
            content: "Summarize this conversation for future work. Preserve decisions, facts, URLs, files, code changes, open tasks and verification evidence. Output only the summary."
          },
          { role: "user", content: transcript }
        ],
        tools: [],
        signal: new AbortController().signal
      })) {
        if (event.type === "text_delta") summary += event.text;
        if (event.type === "error") throw new AgentError(event.error.code, event.error.message);
      }
      if (!summary.trim()) throw new AgentError("COMPACTION_SUMMARY_EMPTY", "Summary was empty");
      return summary;
    }
    isContextOverflow(error) {
      if (!error) return false;
      return /context|token|length|too large|maximum/i.test(`${error.code} ${error.message}`);
    }
    stop(command) {
      const idle = !this.running && this.queue.length === 0;
      if (idle) return this.ack(command, "noop", "TASK_NOT_ACTIVE", "No task is active");
      this.abort?.abort();
      this.cancelQueued("user_stopped");
      this.touch("task.stop_requested");
      return this.ack(command, "accepted");
    }
    async pump() {
      if (this.running || this.lifecycle.getState().state !== "ready") return;
      this.running = true;
      try {
        while (this.queue.length > 0) {
          const item = this.queue.shift();
          this.activeTaskId = item.taskId;
          this.status = this.status === "queued" ? "running" : this.status;
          if (this.status !== "running") this.status = "running";
          if (this.taskGraph.get(item.taskId)?.status === "queued") {
            this.taskGraph.transition(item.taskId, "running");
          }
          this.ledger.promote(item.inputId);
          this.messages.push({ role: "user", content: item.modelText });
          this.sessionTree.append({
            type: "message",
            payload: { role: "user", content: item.modelText }
          });
          this.abort = new AbortController();
          const runSpan = this.options.trace?.start("agent.run", {
            sessionId: this.sessionId,
            taskId: item.taskId
          });
          this.touch("task.started");
          let result = await this.loop.run({
            sessionId: this.sessionId,
            taskId: item.taskId,
            messages: buildModelContext(this.sessionTree, this.systemPrompt),
            signal: this.abort.signal,
            onEvent: (event) => this.onLoopEvent(item.taskId, event)
          });
          if (result.status === "failed" && this.isContextOverflow(result.error) && !this.overflowRetries.has(item.taskId)) {
            this.overflowRetries.add(item.taskId);
            try {
              const summary = await this.generateCompactionSummary();
              appendCompaction(this.sessionTree, {
                summary,
                budget: {
                  contextWindow: 16e3,
                  reserveTokens: 2e3,
                  keepRecentTokens: 1,
                  maxOutputTokens: 2e3
                }
              });
              this.messages.splice(
                0,
                this.messages.length,
                ...buildModelContext(this.sessionTree, this.systemPrompt)
              );
              this.touch("context.overflow_retry");
              result = await this.loop.run({
                sessionId: this.sessionId,
                taskId: item.taskId,
                messages: buildModelContext(this.sessionTree, this.systemPrompt),
                signal: this.abort.signal,
                onEvent: (event) => this.onLoopEvent(item.taskId, event)
              });
            } catch {
            }
          }
          this.messages.splice(0, this.messages.length, ...result.messages);
          if (result.status === "completed") {
            this.status = "completed";
            this.transitionTask(item.taskId, "completed");
            this.lastError = void 0;
            this.setRowsForTask(item.taskId, "completed");
          } else if (result.status === "cancelled") {
            this.status = "cancelled";
            this.transitionTask(item.taskId, "cancelled");
            this.lastError = result.error;
            this.setRowsForTask(item.taskId, "cancelled");
            this.cancelQueued("task_cancelled");
          } else {
            this.status = "failed";
            this.transitionTask(item.taskId, "failed");
            this.lastError = result.error;
            this.setRowsForTask(item.taskId, "failed");
            this.cancelQueued("task_failed");
          }
          if (runSpan) {
            this.options.trace?.end(runSpan.spanId, { status: result.status }, result.error);
          }
          this.activeTaskId = void 0;
          this.abort = void 0;
          this.touch("task.finished");
          if (this.queue.length > 0 && result.status === "completed") {
            this.activeTaskId = this.queue[0].taskId;
            this.status = "queued";
            this.touch("queue.changed");
          }
        }
      } catch (error) {
        this.status = isAbortError(error) ? "cancelled" : "failed";
        this.activeTaskId = void 0;
        this.cancelQueued("runtime_failed");
        this.touch("runtime.failed");
      } finally {
        this.running = false;
        this.abort = void 0;
        this.notifyIdle();
        this.emit();
      }
    }
    async onLoopEvent(taskId, event) {
      if (event.type === "turn_start") {
        const startedAt = this.clock.now();
        this.rows.push({
          id: `activity_${taskId}_${event.turn}`,
          entityId: `activity_${taskId}_${event.turn}`,
          productTurnId: taskId,
          kind: "activity",
          text: "Thinking",
          status: "streaming",
          startedAt
        });
        this.taskGraph.recordUsage(taskId, { turns: 1 });
        this.touch(event.type);
      } else if (event.type === "message_start") {
        this.rows.push({
          id: event.messageId,
          entityId: event.messageId,
          productTurnId: taskId,
          kind: "assistant",
          text: "",
          status: "streaming",
          startedAt: this.clock.now()
        });
        this.touch("message.started");
      } else if (event.type === "reasoning_update") {
        let reasoningRow = this.rows.find(
          (candidate) => candidate.id === `reasoning_${event.messageId}`
        );
        if (!reasoningRow) {
          reasoningRow = {
            id: `reasoning_${event.messageId}`,
            entityId: `reasoning_${event.messageId}`,
            productTurnId: taskId,
            kind: "reasoning",
            text: "",
            status: "streaming",
            startedAt: this.clock.now()
          };
          const assistantIndex = this.rows.findIndex(
            (candidate) => candidate.id === event.messageId
          );
          if (assistantIndex >= 0) this.rows.splice(assistantIndex, 0, reasoningRow);
          else this.rows.push(reasoningRow);
        }
        reasoningRow.text += event.delta;
        this.touch("reasoning.delta");
      } else if (event.type === "message_update") {
        const row = this.rows.find((candidate) => candidate.id === event.messageId);
        if (row) row.text += event.delta;
        this.touch("message.delta");
      } else if (event.type === "message_end") {
        const row = this.rows.find((candidate) => candidate.id === event.messageId);
        if (row) {
          row.text = event.message.role === "assistant" ? event.message.content : row.text;
          row.status = "completed";
          row.completedAt = this.clock.now();
        }
        if (event.message.role === "assistant") {
          const reasoningRow = this.rows.find(
            (candidate) => candidate.id === `reasoning_${event.messageId}`
          );
          if (reasoningRow) {
            reasoningRow.text = event.message.reasoning ?? reasoningRow.text;
            reasoningRow.status = "completed";
            reasoningRow.completedAt = this.clock.now();
          }
          this.sessionTree.append({
            type: "message",
            payload: {
              role: "assistant",
              content: event.message.content,
              ...event.message.reasoning ? { reasoning: event.message.reasoning } : {},
              ...event.message.toolCalls ? {
                toolCallIds: event.message.toolCalls.map((call) => call.id),
                toolCalls: event.message.toolCalls.map((call) => ({ ...call }))
              } : {}
            }
          });
        }
        this.touch("message.finished");
      } else if (event.type === "turn_end") {
        const activity = this.rows.find(
          (row) => row.id === `activity_${taskId}_${event.turn}`
        );
        if (activity) {
          activity.text = "Thinking complete";
          activity.status = "completed";
          activity.completedAt = this.clock.now();
        }
        this.touch(event.type);
      } else if (event.type === "tool_execution_start") {
        this.taskGraph.recordUsage(taskId, { toolCalls: 1 });
        const span = this.options.trace?.start("tool.call", {
          taskId,
          callId: event.result.callId,
          toolName: event.result.name
        });
        if (span) this.toolSpans.set(event.result.callId, span.spanId);
        this.rows.push({
          id: `row_${event.result.callId}`,
          entityId: event.result.callId,
          productTurnId: taskId,
          kind: "tool",
          text: "",
          status: "pending",
          callId: event.result.callId,
          toolName: event.result.name,
          startedAt: this.clock.now()
        });
        this.touch("tool.started");
      } else if (event.type === "tool_execution_end") {
        const row = this.rows.find((candidate) => candidate.callId === event.result.callId);
        if (row) {
          row.status = event.result.status === "succeeded" ? "completed" : event.result.status === "denied" ? "denied" : "failed";
          row.text = event.result.status === "succeeded" ? typeof event.result.output === "string" ? event.result.output : JSON.stringify(event.result.output ?? null) : event.result.error?.message ?? "Tool failed";
          row.completedAt = this.clock.now();
        }
        this.sessionTree.append({
          type: "message",
          payload: {
            role: "tool",
            toolCallId: event.result.callId,
            toolName: event.result.name,
            content: toolResultText(event.result)
          }
        });
        const spanId = this.toolSpans.get(event.result.callId);
        if (spanId) {
          this.options.trace?.end(
            spanId,
            { status: event.result.status },
            event.result.error
          );
          this.toolSpans.delete(event.result.callId);
        }
        this.touch("tool.finished");
      } else {
        if (event.type === "run_end") {
        }
        this.touch(event.type);
      }
    }
    setRowsForTask(taskId, status) {
      for (const row of this.rows) {
        if (row.productTurnId === taskId && (row.status === "pending" || row.status === "streaming")) {
          row.status = status;
          row.completedAt ??= this.clock.now();
        }
      }
    }
    cancelQueued(reason) {
      for (const item of this.queue.splice(0)) {
        this.taskGraph.cancelTree(item.taskId, reason);
        this.ledger.cancel(item.inputId, reason);
        const row = this.rows.find((candidate) => candidate.entityId === item.inputId);
        if (row) row.status = "cancelled";
      }
    }
    ack(command, status, code, message, inputId, taskId) {
      return {
        commandId: command.commandId,
        sessionId: this.sessionId,
        status,
        revision: this.revision,
        ...inputId ? { inputId } : {},
        ...taskId ? { taskId } : {},
        ...code ? {
          error: {
            code,
            message: message ?? code,
            retryable: false
          }
        } : {}
      };
    }
    touch(type) {
      this.revision += 1;
      this.events.append(type, this.revision);
      this.eventSeq = this.events.seq;
      this.emit();
      this.schedulePersist();
    }
    schedulePersist() {
      if (!this.sessionStore) return;
      const snapshot = this.snapshot();
      this.persistTail = this.persistTail.then(async () => {
        try {
          await this.sessionStore.save(snapshot);
          this.persistenceError = void 0;
        } catch (error) {
          this.persistenceError = toStructuredError(error, "PERSISTENCE_FAILED");
        }
      });
    }
    snapshot() {
      return cloneSnapshot({
        schemaVersion: 1,
        sessionId: this.sessionId,
        logEpoch: this.logEpoch,
        revision: this.revision,
        eventSeq: this.eventSeq,
        taskStatus: this.status,
        messages: this.messages,
        rows: this.rows,
        ledger: this.ledger.list(),
        events: this.events.list(),
        commands: this.inbox.snapshot(),
        sessionEntries: this.sessionTree.rawEntries(),
        activeLeafId: this.sessionTree.activeLeaf,
        tasks: this.taskGraph.list(),
        permission: this.permissionModes.get(this.sessionId).getState()
      });
    }
    restore(snapshot) {
      this.options.ids.reserve?.(snapshotIds(snapshot));
      this.messages.splice(0, this.messages.length, ...cloneMessages(snapshot.messages));
      this.rows.splice(0, this.rows.length, ...snapshot.rows.map((row) => ({ ...row })));
      this.ledger.restore(snapshot.ledger);
      this.events.restore(snapshot.events);
      this.inbox.restore(snapshot.commands ?? []);
      if (snapshot.permission) {
        this.permissionModes.restore(this.sessionId, snapshot.permission);
      }
      this.revision = snapshot.revision;
      this.eventSeq = snapshot.eventSeq;
      this.status = snapshot.taskStatus;
      if (!snapshot.sessionEntries?.length && this.messages.length) {
        for (const message of this.messages) {
          if (message.role === "system") continue;
          this.sessionTree.append({
            type: "message",
            payload: messagePayload(message)
          });
        }
      }
      let reconciled = false;
      if (this.status === "queued" || this.status === "running" || this.status === "waiting") {
        this.status = "cancelled";
        reconciled = true;
      }
      for (const task of this.taskGraph.list()) {
        if (task.status === "queued" || task.status === "running" || task.status === "waiting") {
          this.taskGraph.cancelTree(task.taskId, "session_resumed");
          reconciled = true;
        }
      }
      for (const entry of this.ledger.list()) {
        if (entry.status === "admitted") {
          this.ledger.discard(entry.inputId, "session_resumed");
          reconciled = true;
        }
      }
      for (const row of this.rows) {
        if (row.status === "pending" || row.status === "streaming") {
          row.status = "cancelled";
          reconciled = true;
        }
      }
      if (reconciled) this.touch("session.reconciled");
    }
    emit() {
      const projection = this.projection();
      for (const listener of this.listeners) listener(projection);
    }
    transitionTask(taskId, status) {
      const task = this.taskGraph.get(taskId);
      if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
        this.taskGraph.transition(taskId, status);
      }
    }
    notifyIdle() {
      if (this.running || this.queue.length > 0) return;
      const waiters = [...this.idleWaiters];
      this.idleWaiters.clear();
      for (const resolve of waiters) resolve();
    }
  };
  function cloneMessages(messages) {
    return messages.map(
      (message) => message.role === "assistant" && message.toolCalls ? { ...message, toolCalls: message.toolCalls.map((call) => ({ ...call })) } : { ...message }
    );
  }
  function snapshotIds(snapshot) {
    return [
      snapshot.logEpoch,
      ...(snapshot.tasks ?? []).map((task) => task.taskId),
      ...snapshot.rows.flatMap((row) => [
        row.id,
        row.entityId,
        row.productTurnId
      ]),
      ...snapshot.ledger.map((entry) => entry.inputId)
    ];
  }
  function messagePayload(message) {
    if (message.role === "assistant") {
      return {
        role: "assistant",
        content: message.content,
        ...message.toolCalls ? {
          toolCallIds: message.toolCalls.map((call) => call.id),
          toolCalls: message.toolCalls.map((call) => ({ ...call }))
        } : {}
      };
    }
    if (message.role === "tool") {
      return {
        role: "tool",
        content: message.content,
        toolCallId: message.callId,
        toolName: message.name
      };
    }
    return { role: message.role, content: message.content };
  }
  function composeUserInput(text, context) {
    const blocks = [text];
    if (context?.skill) {
      blocks.push(
        `User activated skill "${context.skill.name}".
<skill-loaded name="${context.skill.name}" source="ui">
${context.skill.instructions}
</skill-loaded>`
      );
    }
    if (context?.attachments?.length) {
      const lines = context.attachments.map((attachment) => {
        const header = `- ${attachment.name} (${attachment.type})`;
        return attachment.text ? `${header}
<attachment name="${attachment.name}">
${attachment.text}
</attachment>` : `${header}${attachment.dataBase64 ? " [image/binary omitted from text-only model input]" : ""}`;
      });
      blocks.push(`<attachments>
${lines.join("\n")}
</attachments>`);
    }
    return blocks.filter(Boolean).join("\n\n");
  }

  // src/core/workspace-runtime.ts
  var WorkspaceRuntime = class {
    constructor(options) {
      this.options = options;
    }
    options;
    sessions = /* @__PURE__ */ new Map();
    loading = /* @__PURE__ */ new Map();
    commandTails = /* @__PURE__ */ new Map();
    getSessionView(sessionId) {
      return this.sessions.get(sessionId)?.view();
    }
    getProjection(sessionId) {
      const runtime = this.sessions.get(sessionId);
      if (!runtime) throw new AgentError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      return runtime.projection();
    }
    async loadProjection(sessionId) {
      const runtime = await this.ensureSession(sessionId, false);
      if (!runtime) {
        throw new AgentError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      }
      await runtime.ensureReady();
      return runtime.projection();
    }
    async ensureSessionReady(sessionId) {
      const runtime = await this.ensureSession(sessionId, true);
      if (!runtime) {
        throw new AgentError("SESSION_CREATE_FAILED", `Failed to create session: ${sessionId}`);
      }
      await runtime.ensureReady();
    }
    async hydrateSession(sessionId) {
      const runtime = await this.ensureSession(sessionId, false);
      return runtime?.view();
    }
    command(command) {
      const previous = this.commandTails.get(command.sessionId) ?? Promise.resolve();
      const next = previous.then(() => this.processCommand(command));
      this.commandTails.set(
        command.sessionId,
        next.then(
          () => void 0,
          () => void 0
        )
      );
      return next;
    }
    async processCommand(command) {
      if (command.type === "send_input") await this.ensureSessionReady(command.sessionId);
      const runtime = await this.ensureSession(command.sessionId, false);
      if (!runtime) {
        return {
          commandId: command.commandId,
          sessionId: command.sessionId,
          status: "rejected",
          revision: 0,
          error: {
            code: "SESSION_NOT_FOUND",
            message: `Session not found: ${command.sessionId}`,
            retryable: false
          }
        };
      }
      if (runtime.lifecycle.getState().state !== "ready") {
        await runtime.ensureReady();
      }
      return runtime.command(command);
    }
    waitForSessionIdle(sessionId) {
      const runtime = this.sessions.get(sessionId);
      if (!runtime) return Promise.resolve();
      return runtime.waitForIdle();
    }
    eventLog(sessionId) {
      return this.sessions.get(sessionId)?.eventLog() ?? [];
    }
    queryCommand(sessionId, commandId) {
      return this.sessions.get(sessionId)?.queryCommand(commandId);
    }
    updateChildTask(parentTaskId, child) {
      for (const runtime of this.sessions.values()) {
        if (runtime.updateChildTask(parentTaskId, child)) return true;
      }
      return false;
    }
    contextForTask(taskId) {
      for (const runtime of this.sessions.values()) {
        if (runtime.ownsTask(taskId)) return runtime.contextMessages();
      }
      throw new AgentError("TASK_NOT_FOUND", `Task not found in active sessions: ${taskId}`);
    }
    async subscribe(sessionId, listener) {
      const runtime = await this.ensureSession(sessionId, false);
      if (!runtime) return () => void 0;
      return runtime.subscribe(listener);
    }
    async stop(sessionId) {
      const runtime = this.sessions.get(sessionId);
      if (!runtime) return;
      await runtime.stopInstance();
    }
    async deleteSession(sessionId) {
      const runtime = this.sessions.get(sessionId);
      if (runtime) {
        await runtime.stopInstance();
        await runtime.flushPersistence();
      }
      this.sessions.delete(sessionId);
      await this.options.sessionStore?.remove(sessionId);
    }
    async deleteAllSessions() {
      await Promise.allSettled([...this.loading.values()]);
      const loaded = [...this.sessions.values()];
      await Promise.all(
        loaded.map(async (runtime) => {
          await runtime.stopInstance();
          await runtime.flushPersistence();
        })
      );
      const persisted = await this.options.sessionStore?.list?.() ?? [];
      const count = (/* @__PURE__ */ new Set([
        ...this.sessions.keys(),
        ...persisted.map((session) => session.sessionId)
      ])).size;
      this.sessions.clear();
      this.loading.clear();
      this.commandTails.clear();
      if (this.options.sessionStore?.clear) {
        await this.options.sessionStore.clear();
      } else {
        await Promise.all(
          persisted.map(
            (session) => this.options.sessionStore?.remove(session.sessionId)
          )
        );
      }
      return count;
    }
    async restart(sessionId) {
      const runtime = this.sessions.get(sessionId);
      if (!runtime) throw new AgentError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
      await runtime.restartInstance();
    }
    async flush(sessionId) {
      await this.sessions.get(sessionId)?.flushPersistence();
    }
    async listSessions() {
      const sessions = await this.options.sessionStore?.list?.() ?? [];
      return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    }
    async dispose() {
      await Promise.all(
        [...this.sessions.values()].map(async (session) => {
          await session.stopInstance();
          await session.flushPersistence();
        })
      );
      this.sessions.clear();
      this.loading.clear();
      this.commandTails.clear();
    }
    createRuntime(sessionId, initialSnapshot) {
      const runtime = new SessionRuntime({
        ...this.options,
        sessionId,
        initialSnapshot
      });
      this.sessions.set(sessionId, runtime);
      return runtime;
    }
    async ensureSession(sessionId, createWhenMissing) {
      const existing = this.sessions.get(sessionId);
      if (existing) return existing;
      const pending = this.loading.get(sessionId);
      if (pending) return pending;
      const load = (async () => {
        let initialSnapshot;
        try {
          initialSnapshot = await this.options.sessionStore?.load(sessionId);
        } catch {
          initialSnapshot = void 0;
        }
        if (initialSnapshot) return this.createRuntime(sessionId, initialSnapshot);
        return createWhenMissing ? this.createRuntime(sessionId) : void 0;
      })();
      this.loading.set(sessionId, load);
      try {
        return await load;
      } finally {
        this.loading.delete(sessionId);
      }
    }
  };

  // src/adapters/browser-tools.ts
  function createBrowserTools(browser, dependencies = {}) {
    return [
      tool2(
        "list_tabs",
        "List inspectable Chrome tabs with stable ids, URLs, titles and current-session marker.",
        objectSchema({}),
        "read",
        ["browser:read"],
        async (_input, invocation) => {
          if (dependencies.workspaceTabs) {
            return await dependencies.workspaceTabs.listTabs(
              invocation.sessionId
            );
          }
          const [tabs, current] = await Promise.all([
            browser.listTabs(),
            browser.getWorkingTab(invocation.sessionId)
          ]);
          return tabs.map((tab) => ({ ...tab, current: tab.id === current }));
        }
      ),
      tool2(
        "list_frames",
        "List frames in the working tab, including frameId values usable by snapshot and frame-scoped tools.",
        objectSchema({}),
        "read",
        ["browser:read"],
        async (_input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          if (!browser.listFrames) {
            throw new AgentError("BROWSER_FRAMES_UNSUPPORTED", "Frame inspection is unavailable");
          }
          return await browser.listFrames(tabId);
        }
      ),
      tool2(
        "switch_tab",
        "Make an existing tab the working tab for this session.",
        objectSchema({ tabId: { type: "string" } }, ["tabId"]),
        "write",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = requiredString2(input, "tabId");
          if (dependencies.workspaceTabs) {
            await dependencies.workspaceTabs.switchTab(invocation.sessionId, tabId);
            return { tabId };
          }
          if (dependencies.tabScoped) {
            throw new AgentError(
              "TAB_SCOPED_SESSION",
              "Tabs are isolated conversations and cannot share a working tab."
            );
          }
          await browser.setWorkingTab(invocation.sessionId, tabId);
          return { tabId };
        }
      ),
      tool2(
        "new_tab",
        "Open a new tab and make it the working tab.",
        objectSchema({ url: { type: "string" } }),
        "write",
        ["browser:navigate"],
        async (input, invocation) => {
          if (dependencies.workspaceTabs) {
            const tab2 = await dependencies.workspaceTabs.createTab(
              invocation.sessionId,
              optionalString2(input, "url") ?? "about:blank"
            );
            return tab2;
          }
          if (dependencies.tabScoped) {
            throw new AgentError(
              "TAB_SCOPED_SESSION",
              "Tabs are isolated conversations; use the browser tabs UI to open another tab session."
            );
          }
          const tab = await browser.createTab(optionalString2(input, "url") ?? "about:blank");
          await browser.setWorkingTab(invocation.sessionId, tab.id);
          return tab;
        }
      ),
      tool2(
        "navigate",
        "Navigate the working tab to a URL and wait for readiness.",
        objectSchema({ url: { type: "string" } }, ["url"]),
        "write",
        ["browser:navigate"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          return await browser.navigate(
            tabId,
            requiredString2(input, "url"),
            invocation.signal
          );
        }
      ),
      tool2(
        "snapshot",
        "Capture a compact accessibility snapshot with @eN refs for interactive elements.",
        objectSchema({
          interactive: { type: "boolean" },
          frameId: { type: "string" }
        }),
        "read",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          return await browser.snapshot(tabId, {
            interactiveOnly: optionalBoolean(input, "interactive") === true,
            frameId: optionalString2(input, "frameId"),
            signal: invocation.signal
          });
        }
      ),
      tool2(
        "find",
        "Find accessibility nodes by name substring and return clickable refs where available.",
        objectSchema({
          query: { type: "string" },
          frameId: { type: "string" }
        }, ["query"]),
        "read",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const snapshot = await browser.snapshot(tabId, {
            signal: invocation.signal,
            frameId: optionalString2(input, "frameId")
          });
          const query = requiredString2(input, "query").toLowerCase();
          return snapshot.nodes.filter((node) => node.name.toLowerCase().includes(query)).slice(0, 20);
        }
      ),
      tool2(
        "read_page",
        "Read visible text from the working tab.",
        objectSchema({ maxChars: { type: "integer" }, frameId: { type: "string" } }),
        "read",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const maxChars = optionalNumber(input, "maxChars") ?? 3e4;
          return {
            tabId,
            text: await browser.readText(tabId, maxChars, {
              frameId: optionalString2(input, "frameId"),
              signal: invocation.signal
            })
          };
        }
      ),
      tool2(
        "evaluate",
        "Evaluate JavaScript in the working tab. This is a high-risk capability.",
        objectSchema({
          code: { type: "string" },
          frameId: { type: "string" }
        }, ["code"]),
        "dangerous",
        ["browser:script"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const output = await browser.evaluate(tabId, requiredString2(input, "code"), {
            frameId: optionalString2(input, "frameId"),
            signal: invocation.signal
          });
          return output === void 0 ? null : output;
        }
      ),
      tool2(
        "click",
        "Click an element by @eN snapshot ref or CSS selector.",
        targetSchema(),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          await browser.click(tabId, targetFrom(input));
          return { clicked: true };
        }
      ),
      tool2(
        "mouse_click",
        "Click an element center with real CDP mouse events.",
        targetSchema(),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          return browser.mouseClick(tabId, targetFrom(input));
        }
      ),
      tool2(
        "hover",
        "Move the real mouse over an element to reveal hover content.",
        targetSchema(),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          return browser.hover(tabId, targetFrom(input));
        }
      ),
      tool2(
        "fill",
        "Fill an input, textarea or contentEditable element by ref or selector.",
        {
          ...targetSchema(),
          properties: {
            ref: { type: "string" },
            selector: { type: "string" },
            frameId: { type: "string" },
            value: { type: "string" }
          },
          required: ["value"]
        },
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          await browser.fill(tabId, targetFrom(input), requiredString2(input, "value"));
          return { filled: true };
        }
      ),
      tool2(
        "type_text",
        "Insert text at the currently focused element.",
        objectSchema({ text: { type: "string" } }, ["text"]),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          await browser.cdp(
            tabId,
            "Input.insertText",
            { text: requiredString2(input, "text") },
            invocation.signal
          );
          return { typed: true };
        }
      ),
      tool2(
        "select_option",
        "Select options in a native select control by value or visible label.",
        objectSchema({
          ref: { type: "string" },
          selector: { type: "string" },
          values: { type: "array", items: { type: "string" } }
        }),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const values = Array.isArray(input.values) ? input.values.map(String) : [];
          return await browser.selectOption(tabId, targetFrom(input), values);
        }
      ),
      tool2(
        "drag",
        "Drag one element to another using real mouse events.",
        objectSchema({
          from: { type: "string" },
          to: { type: "string" },
          frameId: { type: "string" }
        }, ["from", "to"]),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const frameId = optionalString2(input, "frameId");
          await browser.drag(
            tabId,
            {
              selector: requiredString2(input, "from"),
              ...frameId ? { frameId } : {}
            },
            {
              selector: requiredString2(input, "to"),
              ...frameId ? { frameId } : {}
            }
          );
          return { dragged: true };
        }
      ),
      tool2(
        "scroll",
        "Scroll the page by one viewport, to an edge, selector or text target.",
        objectSchema({
          direction: { type: "string", enum: ["up", "down"] },
          to: { type: "string", enum: ["top", "bottom"] },
          selector: { type: "string" },
          text: { type: "string" },
          frameId: { type: "string" }
        }),
        "read",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const to = optionalString2(input, "to");
          const direction = optionalString2(input, "direction");
          return await browser.scroll(tabId, {
            ...to === "top" || to === "bottom" ? { to } : {},
            ...direction === "up" || direction === "down" ? { direction } : {},
            ...optionalString2(input, "selector") ? { selector: optionalString2(input, "selector") } : {},
            ...optionalString2(input, "text") ? { text: optionalString2(input, "text") } : {},
            ...optionalString2(input, "frameId") ? { frameId: optionalString2(input, "frameId") } : {},
            signal: invocation.signal
          });
        }
      ),
      tool2(
        "send_keys",
        "Dispatch a keyboard key such as Enter, Tab or Escape.",
        objectSchema({ keys: { type: "string" } }, ["keys"]),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const keys = requiredString2(input, "keys").split(/\s+/).filter(Boolean);
          for (const key of keys) await sendKey(browser, tabId, key, invocation.signal);
          return { sent: keys };
        }
      ),
      tool2(
        "wait",
        "Wait for text, text disappearance or a selector in the working tab.",
        objectSchema({
          text: { type: "string" },
          text_gone: { type: "string" },
          selector: { type: "string" },
          timeout_ms: { type: "integer" },
          frameId: { type: "string" }
        }),
        "read",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          return {
            met: await browser.waitFor(
              tabId,
              {
                text: optionalString2(input, "text"),
                textGone: optionalString2(input, "text_gone"),
                selector: optionalString2(input, "selector"),
                timeoutMs: optionalNumber(input, "timeout_ms")
              },
              invocation.signal,
              { frameId: optionalString2(input, "frameId") }
            )
          };
        }
      ),
      tool2(
        "screenshot",
        "Capture the working tab viewport as a PNG data URL.",
        objectSchema({ format: { type: "string", enum: ["png", "jpeg"] } }),
        "read",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const format = optionalString2(input, "format") === "jpeg" ? "jpeg" : "png";
          return await browser.screenshot(tabId, format);
        }
      ),
      tool2(
        "upload",
        "Place base64 files into a page file input.",
        objectSchema({
          ref: { type: "string" },
          selector: { type: "string" },
          files: { type: "array", items: { type: "object" } }
        }, ["files"]),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const files = requiredArray(input, "files").map((entry) => {
            const file = isObject(entry);
            return {
              name: requiredString2(file, "name"),
              type: optionalString2(file, "type") ?? "application/octet-stream",
              base64: requiredString2(file, "base64")
            };
          });
          const target = optionalString2(input, "ref") || optionalString2(input, "selector") ? targetFrom(input) : void 0;
          return { uploaded: await browser.upload(tabId, target, files) };
        }
      ),
      tool2(
        "save_as_pdf",
        "Render the current page as PDF and save it through the configured download port.",
        objectSchema({
          paper_format: { type: "string", enum: ["letter", "legal", "a4", "a3", "tabloid"] },
          landscape: { type: "boolean" },
          scale: { type: "number" },
          print_background: { type: "boolean" },
          file_name: { type: "string" }
        }),
        "write",
        ["browser:read"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const result = await browser.printToPdf(tabId, {
            paperFormat: enumValue(input, "paper_format", ["letter", "legal", "a4", "a3", "tabloid"]),
            landscape: optionalBoolean(input, "landscape"),
            scale: optionalNumber(input, "scale"),
            printBackground: optionalBoolean(input, "print_background")
          });
          const name = `${(optionalString2(input, "file_name") ?? "page").replace(/\.pdf$/i, "").replace(/[\\/:*?"<>|]+/g, "-")}.pdf`;
          if (dependencies.download) {
            await dependencies.download(name, "application/pdf", result.dataBase64);
            return { saved: name, bytes: result.bytes };
          }
          return {
            fileName: name,
            bytes: result.bytes,
            dataBase64: result.dataBase64
          };
        }
      ),
      tool2(
        "dialog",
        "Inspect, accept or dismiss a blocking JavaScript dialog.",
        objectSchema({
          action: { type: "string", enum: ["status", "accept", "dismiss"] },
          text: { type: "string" }
        }, ["action"]),
        "write",
        ["browser:interact"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const action = requiredString2(input, "action");
          if (action !== "status" && action !== "accept" && action !== "dismiss") {
            throw new AgentError("TOOL_ARGUMENTS_INVALID", "dialog.action is invalid");
          }
          return await browser.dialog(tabId, action, optionalString2(input, "text"));
        }
      ),
      tool2(
        "network",
        "Start, stop, list or read captured network requests.",
        objectSchema({
          cmd: { type: "string", enum: ["start", "stop", "list", "detail"] },
          filter: { type: "string" },
          requestId: { type: "string" }
        }, ["cmd"]),
        "dangerous",
        ["browser:network"],
        async (input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          const cmd = requiredString2(input, "cmd");
          if (cmd === "detail") {
            return await browser.network(tabId, {
              cmd: "detail",
              requestId: requiredString2(input, "requestId")
            });
          }
          if (cmd !== "start" && cmd !== "stop" && cmd !== "list") {
            throw new AgentError("TOOL_ARGUMENTS_INVALID", "network.cmd is invalid");
          }
          return await browser.network(tabId, {
            cmd,
            filter: optionalString2(input, "filter")
          });
        }
      ),
      tool2(
        "close_tab",
        "Close the working tab and clear the session binding.",
        objectSchema({}),
        "write",
        ["browser:interact"],
        async (_input, invocation) => {
          const tabId = await workingTab(browser, invocation.sessionId);
          await browser.removeTab(tabId);
          return { closed: tabId };
        }
      ),
      tool2(
        "find_tab",
        "Find an inspectable tab by URL/domain and make it the working tab.",
        objectSchema({ url: { type: "string" } }, ["url"]),
        "write",
        ["browser:read"],
        async (input, invocation) => {
          const needle = requiredString2(input, "url").toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
          const tab = (await browser.listTabs()).find((candidate) => {
            const value = String(candidate.url ?? "").toLowerCase();
            const domain = value.replace(/^https?:\/\//, "").split("/")[0];
            return value.includes(needle) || domain.includes(needle);
          });
          if (!tab) throw new AgentError("BROWSER_TAB_NOT_FOUND", `No tab matches ${needle}`);
          await browser.setWorkingTab(invocation.sessionId, tab.id);
          return tab;
        }
      ),
      tool2(
        "close_session",
        "Close browser resources owned by this task session.",
        objectSchema({}),
        "write",
        ["browser:interact"],
        async (_input, invocation) => {
          const report = await browser.closeSessionTabs(invocation.sessionId);
          return report;
        }
      ),
      tool2(
        "await_user_action",
        "Pause for a manual login, captcha or confirmation, then continue after explicit user action.",
        objectSchema({ reason: { type: "string" } }, ["reason"]),
        "read",
        ["browser:interact"],
        async (input, invocation) => {
          if (!dependencies.handoff) {
            throw new AgentError(
              "HANDOFF_UNAVAILABLE",
              "No user handoff channel is available"
            );
          }
          const result = await dependencies.handoff.requestHandoff(
            requiredString2(input, "reason"),
            {
              sessionId: invocation.sessionId,
              taskId: invocation.taskId,
              toolName: "await_user_action"
            },
            invocation.signal
          );
          return {
            continued: result === "continue",
            instruction: result === "continue" ? "Verify the page state before continuing." : "The user cancelled; explain why the action is required."
          };
        }
      )
    ];
  }
  function tool2(name, description, parameters, risk, capabilities, execute) {
    return {
      name,
      description,
      parameters,
      risk,
      capabilities,
      effect: name === "network" ? "network" : name === "evaluate" ? "execute" : risk === "read" ? "read" : "write",
      executionMode: "sequential",
      replay: risk === "read" ? "safe" : "never",
      execute: async (input, invocation) => execute(isObject(input), invocation)
    };
  }
  async function workingTab(browser, sessionId) {
    const current = await browser.getWorkingTab(sessionId);
    if (current) return current;
    return (await browser.ensureTaskGroup(sessionId)).tabId;
  }
  function isObject(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AgentError("TOOL_ARGUMENTS_INVALID", "Tool input must be an object");
    }
    return value;
  }
  function requiredString2(input, key) {
    const value = input[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new AgentError("TOOL_ARGUMENTS_INVALID", `${key} must be a non-empty string`);
    }
    return value;
  }
  function optionalString2(input, key) {
    const value = input[key];
    return typeof value === "string" && value.trim() ? value : void 0;
  }
  function optionalNumber(input, key) {
    return typeof input[key] === "number" ? input[key] : void 0;
  }
  function optionalBoolean(input, key) {
    return typeof input[key] === "boolean" ? input[key] : void 0;
  }
  function requiredArray(input, key) {
    const value = input[key];
    if (!Array.isArray(value)) throw new AgentError("TOOL_ARGUMENTS_INVALID", `${key} must be an array`);
    return value;
  }
  function enumValue(input, key, values) {
    const value = input[key];
    return typeof value === "string" && values.includes(value) ? value : void 0;
  }
  function targetFrom(input) {
    const ref = optionalString2(input, "ref");
    const selector = optionalString2(input, "selector");
    const frameId = optionalString2(input, "frameId");
    if (!ref && !selector) {
      throw new AgentError("BROWSER_TARGET_INVALID", "A ref or selector is required");
    }
    return {
      ...ref ? { ref } : {},
      ...selector ? { selector } : {},
      ...frameId ? { frameId } : {}
    };
  }
  function targetSchema() {
    return objectSchema({
      ref: { type: "string" },
      selector: { type: "string" },
      frameId: { type: "string" }
    });
  }
  function objectSchema(properties, required = []) {
    return { type: "object", properties, ...required.length ? { required } : {} };
  }
  async function sendKey(browser, tabId, key, signal) {
    const known = {
      Enter: { code: "Enter", vk: 13, text: "\r" },
      Tab: { code: "Tab", vk: 9 },
      Escape: { code: "Escape", vk: 27 },
      Backspace: { code: "Backspace", vk: 8 },
      ArrowUp: { code: "ArrowUp", vk: 38 },
      ArrowDown: { code: "ArrowDown", vk: 40 }
    };
    const spec = known[key];
    if (!spec) throw new AgentError("BROWSER_KEY_UNSUPPORTED", `Unsupported key: ${key}`);
    await browser.cdp(
      tabId,
      "Input.dispatchKeyEvent",
      { type: "keyDown", key, code: spec.code, windowsVirtualKeyCode: spec.vk, ...spec.text ? { text: spec.text } : {} },
      signal
    );
    await browser.cdp(
      tabId,
      "Input.dispatchKeyEvent",
      { type: "keyUp", key, code: spec.code, windowsVirtualKeyCode: spec.vk },
      signal
    );
  }

  // src/adapters/browser-tool-pack.ts
  function createBrowserToolPack(browser, dependencies = {}) {
    return {
      id: "browser",
      register() {
        return createBrowserTools(browser, dependencies).map((definition) => ({
          definition,
          source: "builtin",
          sourceId: "browser"
        }));
      }
    };
  }

  // src/adapters/browser-workspace-factory.ts
  function createBrowserWorkspace(options) {
    const permissionModes = options.permissionModes ?? new PermissionModeRegistry("guarded", () => options.clock.now());
    const registry = new ToolRegistry();
    const browserPack = createBrowserToolPack(options.browser, {
      download: options.download,
      handoff: options.handoff,
      tabScoped: options.tabScoped,
      workspaceTabs: options.workspaceTabs
    });
    registry.registerAll(
      browserPack.register({
        approval: options.approval,
        permissions: permissionModes,
        ...options.artifactStore ? { artifacts: options.artifactStore } : {}
      })
    );
    registry.registerAll(options.additionalTools ?? []);
    const selected = registry.resolve(options.toolSelection ?? {});
    const tools = new ToolExecutor(selected, options.approval, {
      defaultTimeoutMs: options.defaultToolTimeoutMs,
      policy: new PolicyEngine((sessionId) => permissionModes.mode(sessionId)),
      artifacts: options.artifactStore ? {
        store: options.artifactStore,
        thresholdBytes: options.artifactThresholdBytes
      } : void 0,
      hooks: options.hooks
    });
    const runtimeOptions = {
      model: options.model,
      tools,
      clock: options.clock,
      ids: options.ids,
      sessionStore: options.sessionStore,
      permissionModes,
      trace: options.trace,
      maxSteps: options.maxSteps,
      systemPrompt: options.systemPrompt,
      onClose: async (sessionId) => {
        const report = await options.browser.closeSessionTabs(sessionId);
        if (report.errors.length > 0) {
          throw new AgentError(
            "BROWSER_SESSION_CLEANUP_FAILED",
            report.errors.map((error) => `${error.code}: ${error.message}`).join("; "),
            { details: report.errors }
          );
        }
      }
    };
    const runtime = new WorkspaceRuntime(runtimeOptions);
    return {
      runtime,
      tools,
      registry,
      async dispose() {
        await runtime.dispose();
        const disposable = options.browser;
        disposable.dispose?.();
      }
    };
  }

  // src/core/agent-profile.ts
  var sourcePriority3 = {
    builtin: 0,
    user: 1,
    project: 2,
    plugin: 3
  };
  var AgentProfileRegistry = class {
    entries = /* @__PURE__ */ new Map();
    revision = 0;
    register(profile, sourceId) {
      validateProfile(profile);
      const profiles = this.entries.get(profile.name) ?? /* @__PURE__ */ new Map();
      profiles.set(profile.source, {
        profile: cloneProfile(profile),
        ...sourceId ? { sourceId } : {}
      });
      this.entries.set(profile.name, profiles);
      this.revision += 1;
    }
    registerAll(profiles) {
      for (const profile of profiles) this.register(profile, profile.sourceId);
    }
    unregister(name, source) {
      if (!source) {
        const removed2 = this.entries.delete(name);
        if (removed2) this.revision += 1;
        return removed2;
      }
      const profiles = this.entries.get(name);
      const removed = profiles?.delete(source) ?? false;
      if (profiles?.size === 0) this.entries.delete(name);
      if (removed) this.revision += 1;
      return removed;
    }
    get(name) {
      const entry = this.effective(name);
      return entry ? cloneProfile(entry.profile) : void 0;
    }
    resolve(name, parentPermissions) {
      const entry = this.effective(name);
      if (!entry) {
        throw new AgentError("PROFILE_NOT_FOUND", `Agent profile not found: ${name}`);
      }
      const profile = cloneProfile(entry.profile);
      const deniedCapabilities = [
        .../* @__PURE__ */ new Set([
          ...parentPermissions.deniedCapabilities ?? [],
          ...profile.permissions.deniedCapabilities ?? []
        ])
      ];
      const deniedTools = [
        .../* @__PURE__ */ new Set([
          ...parentPermissions.deniedTools ?? [],
          ...profile.permissions.deniedTools ?? []
        ])
      ];
      const capabilities = intersection(
        parentPermissions.capabilities,
        profile.permissions.capabilities
      ).filter((capability) => !deniedCapabilities.includes(capability));
      const effects = intersection(parentPermissions.effects, profile.permissions.effects);
      return {
        ...profile,
        requestedName: name,
        registryRevision: this.revision,
        effectivePermissions: {
          capabilities,
          effects,
          deniedCapabilities,
          deniedTools
        }
      };
    }
    validateChild(spec, parent) {
      const entry = this.effective(spec.profile);
      if (!entry) {
        throw new AgentError("PROFILE_NOT_FOUND", `Agent profile not found: ${spec.profile}`);
      }
      const profile = entry.profile;
      if (!spec.brief.trim()) {
        throw new AgentError("CHILD_BRIEF_EMPTY", "Child task brief cannot be empty");
      }
      if (parent.depth >= parent.maxDepth || parent.depth >= profile.maxDepth) {
        throw new AgentError(
          "CHILD_DEPTH_EXCEEDED",
          `Child depth exceeds the allowed maximum at depth ${parent.depth}`
        );
      }
      if (parent.concurrency >= profile.maxConcurrency) {
        throw new AgentError(
          "CHILD_CONCURRENCY_EXCEEDED",
          `Profile ${profile.name} allows at most ${profile.maxConcurrency} concurrent children`
        );
      }
      if (!profile.execution.allowedModes.includes(spec.executionMode)) {
        throw new AgentError(
          "CHILD_EXECUTION_MODE_DENIED",
          `Profile ${profile.name} does not allow execution mode ${spec.executionMode}`
        );
      }
      for (const [name, value] of Object.entries(spec.budget)) {
        if (value !== void 0 && (!Number.isFinite(value) || value <= 0)) {
          throw new AgentError("CHILD_BUDGET_INVALID", `Budget ${name} must be positive`);
        }
      }
      return {
        ...cloneProfile(profile),
        requestedName: spec.profile,
        registryRevision: this.revision,
        effectivePermissions: {
          capabilities: [...profile.permissions.capabilities],
          effects: [...profile.permissions.effects],
          deniedCapabilities: [...profile.permissions.deniedCapabilities ?? []],
          deniedTools: [...profile.permissions.deniedTools ?? []]
        }
      };
    }
    diagnostics() {
      return [...this.entries.entries()].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, profiles]) => {
        const effective = this.effective(name);
        return [...profiles.values()].map((entry) => ({
          name,
          source: entry.profile.source,
          ...entry.sourceId ? { sourceId: entry.sourceId } : {},
          effective: entry === effective
        }));
      });
    }
    effective(name) {
      const profiles = this.entries.get(name);
      if (!profiles) return void 0;
      return [...profiles.values()].sort(
        (a, b) => sourcePriority3[b.profile.source] - sourcePriority3[a.profile.source]
      )[0];
    }
  };
  function validateProfile(profile) {
    if (!profile.name.trim()) {
      throw new AgentError("PROFILE_NAME_INVALID", "Profile name cannot be empty");
    }
    if (!Number.isInteger(profile.maxDepth) || profile.maxDepth < 0) {
      throw new AgentError("PROFILE_DEPTH_INVALID", "Profile maxDepth must be a non-negative integer");
    }
    if (!Number.isInteger(profile.maxConcurrency) || profile.maxConcurrency < 0) {
      throw new AgentError(
        "PROFILE_CONCURRENCY_INVALID",
        "Profile maxConcurrency must be a non-negative integer"
      );
    }
    if (!profile.execution.allowedModes.includes(profile.execution.defaultMode)) {
      throw new AgentError(
        "PROFILE_EXECUTION_INVALID",
        "Profile default execution mode must be allowed"
      );
    }
  }
  function cloneProfile(profile) {
    return {
      ...profile,
      skills: [...profile.skills],
      tools: {
        ...profile.tools.allow ? { allow: [...profile.tools.allow] } : {},
        ...profile.tools.deny ? { deny: [...profile.tools.deny] } : {}
      },
      mcpServers: [...profile.mcpServers],
      ...profile.model ? { model: { ...profile.model } } : {},
      permissions: {
        capabilities: [...profile.permissions.capabilities],
        effects: [...profile.permissions.effects],
        ...profile.permissions.deniedCapabilities ? { deniedCapabilities: [...profile.permissions.deniedCapabilities] } : {},
        ...profile.permissions.deniedTools ? { deniedTools: [...profile.permissions.deniedTools] } : {}
      },
      execution: {
        defaultMode: profile.execution.defaultMode,
        allowedModes: [...profile.execution.allowedModes]
      },
      ...profile.resultSchema ? { resultSchema: { ...profile.resultSchema } } : {}
    };
  }
  function intersection(left, right) {
    const allowed = new Set(right);
    return [...new Set(left)].filter((value) => allowed.has(value));
  }

  // src/runtime/profile-loader.ts
  var sources = ["builtin", "user", "project", "plugin"];
  function loadAgentProfiles(raw) {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value;
      if (typeof item.name !== "string" || !item.name.trim()) return [];
      const source = sources.includes(item.source) ? item.source : "user";
      return [
        {
          name: item.name.trim(),
          displayName: stringValue(item.displayName) || item.name,
          description: stringValue(item.description),
          instructions: stringValue(item.instructions),
          source,
          ...stringValue(item.sourceId) ? { sourceId: stringValue(item.sourceId) } : {},
          skills: stringArray(item.skills),
          tools: {
            ...Array.isArray(item.allowTools) ? { allow: stringArray(item.allowTools) } : {},
            ...Array.isArray(item.denyTools) ? { deny: stringArray(item.denyTools) } : {}
          },
          mcpServers: stringArray(item.mcpServers),
          permissions: {
            capabilities: stringArray(item.capabilities),
            effects: ["read", "write", "execute", "network"].filter(
              (effect) => stringArray(item.effects).includes(effect)
            ),
            deniedCapabilities: stringArray(item.deniedCapabilities),
            deniedTools: stringArray(item.deniedTools)
          },
          contextMode: item.contextMode === "fork" || item.contextMode === "artifacts" ? item.contextMode : "fresh",
          execution: {
            defaultMode: item.executionMode === "background" || item.executionMode === "isolated-worktree" || item.executionMode === "sandbox" ? item.executionMode : "foreground",
            allowedModes: stringArray(item.allowedModes).length > 0 ? stringArray(item.allowedModes).filter(
              (mode) => ["foreground", "background", "isolated-worktree", "sandbox"].includes(mode)
            ) : ["foreground", "background"]
          },
          ...item.resultSchema && typeof item.resultSchema === "object" && !Array.isArray(item.resultSchema) ? { resultSchema: structuredClone(item.resultSchema) } : {},
          maxDepth: positiveInteger(item.maxDepth, 1),
          maxConcurrency: positiveInteger(item.maxConcurrency, 1)
        }
      ];
    });
  }
  function createDefaultProfileRegistry(extra = []) {
    const registry = new AgentProfileRegistry();
    registry.register(
      {
        name: "general",
        displayName: "General browser worker",
        description: "A generic browser task worker with no role-specific assumptions.",
        instructions: "Work only from the delegated brief. Use browser tools to observe before acting. Return concise evidence and unresolved items.",
        source: "builtin",
        skills: [],
        tools: {},
        mcpServers: [],
        permissions: {
          capabilities: [
            "browser:read",
            "browser:navigate",
            "browser:interact",
            "browser:script",
            "browser:network",
            "extension:skills",
            "mcp:call"
          ],
          effects: ["read", "write", "execute", "network"]
        },
        contextMode: "fresh",
        execution: {
          defaultMode: "foreground",
          allowedModes: ["foreground", "background"]
        },
        maxDepth: 2,
        maxConcurrency: 2
      },
      "tinyai"
    );
    for (const profile of extra) registry.register(profile, profile.sourceId);
    return registry;
  }
  function stringValue(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function stringArray(value) {
    return Array.isArray(value) ? value.map(String).filter(Boolean) : [];
  }
  function positiveInteger(value, fallback) {
    return Number.isInteger(value) && Number(value) >= 0 ? Number(value) : fallback;
  }

  // src/runtime/workspace-subagent-driver.ts
  var WorkspaceSubagentDriver = class {
    constructor(options) {
      this.options = options;
    }
    options;
    children = /* @__PURE__ */ new Map();
    async create(request) {
      const sessionId = this.options.ids.next("child_session");
      const runtime = await this.options.createRuntime({
        taskId: request.taskId,
        sessionId,
        spec: request.spec,
        profile: request.profile
      });
      this.children.set(request.taskId, {
        taskId: request.taskId,
        sessionId,
        spec: request.spec,
        profile: request.profile,
        runtime
      });
      this.prompts.set(request.taskId, request.prompt);
      return { sessionId };
    }
    async run(taskId, signal) {
      const child = this.child(taskId);
      const prompt = this.prompts.get(taskId);
      if (!prompt) throw new Error(`Child prompt missing: ${taskId}`);
      if (signal.aborted) return cancelled();
      const ack = await child.runtime.command(
        this.command(child, `child_command_${this.options.ids.next("sequence")}`, prompt)
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") {
        return failed(ack);
      }
      const abort = () => {
        void child.runtime.command(this.stopCommand(child));
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        await child.runtime.waitForSessionIdle(child.sessionId);
      } finally {
        signal.removeEventListener("abort", abort);
      }
      return resultFromProjection(child.runtime.getProjection(child.sessionId), signal.aborted);
    }
    async send(taskId, message, delivery) {
      const child = this.child(taskId);
      const ack = await child.runtime.command({
        ...this.command(child, `child_message_${this.options.ids.next("sequence")}`, message),
        payload: { text: message, delivery }
      });
      if (ack.status !== "accepted" && ack.status !== "duplicate") throw ackError(ack);
    }
    async stop(taskId) {
      const child = this.child(taskId);
      await child.runtime.command(this.stopCommand(child));
    }
    projection(taskId) {
      const child = this.children.get(taskId);
      if (!child) return void 0;
      try {
        return child.runtime.getProjection(child.sessionId);
      } catch {
        return void 0;
      }
    }
    async resume(taskId, message) {
      const child = this.child(taskId);
      const ack = await child.runtime.command(
        this.command(child, `child_resume_${this.options.ids.next("sequence")}`, message)
      );
      if (ack.status !== "accepted" && ack.status !== "duplicate") return failed(ack);
      await child.runtime.waitForSessionIdle(child.sessionId);
      return resultFromProjection(child.runtime.getProjection(child.sessionId), false);
    }
    async dispose() {
      await Promise.all([...this.children.values()].map((child) => child.runtime.dispose()));
      this.children.clear();
      this.prompts.clear();
    }
    setPrompt(taskId, prompt) {
      this.prompts.set(taskId, prompt);
    }
    prompts = /* @__PURE__ */ new Map();
    child(taskId) {
      const child = this.children.get(taskId);
      if (!child) throw new Error(`Child runtime not found: ${taskId}`);
      return child;
    }
    command(child, commandId, text) {
      return {
        commandId,
        clientId: "subagent-coordinator",
        sessionId: child.sessionId,
        type: "send_input",
        payload: { text },
        issuedAt: this.options.now?.() ?? Date.now()
      };
    }
    stopCommand(child) {
      return {
        commandId: `child_stop_${this.options.ids.next("sequence")}`,
        clientId: "subagent-coordinator",
        sessionId: child.sessionId,
        type: "stop",
        payload: { reason: "parent_cancelled" },
        issuedAt: this.options.now?.() ?? Date.now()
      };
    }
  };
  function resultFromProjection(projection, aborted) {
    const assistant = [...projection.rows].reverse().find((row) => row.kind === "assistant");
    const status = aborted ? "cancelled" : projection.taskStatus === "completed" ? "completed" : projection.taskStatus === "cancelled" ? "cancelled" : "failed";
    return {
      status,
      summary: assistant?.text || projection.lastError?.message || projection.taskStatus,
      output: {
        sessionId: projection.sessionId,
        rows: projection.rows
      },
      artifacts: [],
      unresolved: status === "completed" ? [] : [projection.lastError?.message ?? status],
      ...projection.lastError ? { error: projection.lastError } : {}
    };
  }
  function failed(ack) {
    return {
      status: "failed",
      summary: ack.error?.message ?? `Child command ${ack.status}`,
      artifacts: [],
      unresolved: [ack.error?.message ?? ack.status],
      ...ack.error ? { error: ack.error } : {}
    };
  }
  function cancelled() {
    return {
      status: "cancelled",
      summary: "Cancelled",
      artifacts: [],
      unresolved: []
    };
  }
  function ackError(ack) {
    return Object.assign(new Error(ack.error?.message ?? `Child command ${ack.status}`), {
      name: ack.error?.code ?? "CHILD_COMMAND_REJECTED"
    });
  }

  // src/adapters/chrome-workspace-session-registry.ts
  var DEFAULT_STORAGE_KEY = "tinyai:tab-sessions:v1";
  var TabSessionRegistry = class {
    constructor(options) {
      this.options = options;
      this.storageKey = options.storageKey ?? DEFAULT_STORAGE_KEY;
      this.now = options.now ?? Date.now;
      this.createSessionId = options.createSessionId ?? (() => `session_${crypto.randomUUID()}`);
    }
    options;
    bindings = /* @__PURE__ */ new Map();
    storageKey;
    now;
    createSessionId;
    loaded;
    tail = Promise.resolve();
    resolve(context) {
      return this.serialized(async () => {
        await this.ensureLoaded();
        const target = await this.options.browser.getTab(context.tabId);
        if (!target) {
          const key = tabKey(context);
          if (this.bindings.get(key)?.scope === "tab") {
            this.bindings.delete(key);
            await this.persist();
          }
          throw new AgentError(
            "BROWSER_TAB_NOT_FOUND",
            `Tab not found: ${context.tabId}`
          );
        }
        const existing = this.bindings.get(tabKey(context));
        if (existing) {
          if (existing.scope === "group" && existing.groupId !== void 0 && existing.memberTabIds.length > 0) {
            const members = (await this.options.browser.listTabs()).filter(
              (tab) => tab.windowId === existing.windowId && tab.groupId === existing.groupId
            ).map((tab) => tab.id);
            if (members.length > 0 && !members.some((tabId) => existing.memberTabIds.includes(tabId))) {
              this.bindings.delete(tabKey(context));
            }
          }
        }
        const currentBinding = this.bindings.get(tabKey(context));
        if (currentBinding) {
          const session = await this.options.runtime.hydrateSession(currentBinding.sessionId);
          if (session) {
            await this.options.runtime.ensureSessionReady(currentBinding.sessionId);
            await this.options.browser.setWorkingTab(currentBinding.sessionId, context.tabId, {
              activate: false
            });
            return this.refreshBinding(currentBinding, context);
          }
          this.bindings.delete(tabKey(context));
        }
        if (context.groupId !== void 0 && context.groupId >= 0) {
          const promoted = this.bindings.get(
            tabKey({ windowId: context.windowId, tabId: context.tabId })
          );
          if (promoted) {
            this.bindings.delete(
              tabKey({ windowId: context.windowId, tabId: context.tabId })
            );
            return this.bindLocked(context, promoted.sessionId);
          }
        }
        return this.createLocked(context);
      });
    }
    create(context) {
      return this.serialized(async () => {
        await this.ensureLoaded();
        return this.createLocked(context);
      });
    }
    bind(context, sessionId) {
      return this.serialized(async () => {
        await this.ensureLoaded();
        const session = await this.options.runtime.hydrateSession(sessionId);
        if (!session) {
          throw new AgentError(
            "SESSION_NOT_FOUND",
            `Session not found: ${sessionId}`
          );
        }
        return this.bindLocked(context, sessionId);
      });
    }
    forget(context) {
      return this.serialized(async () => {
        await this.ensureLoaded();
        let changed = this.bindings.delete(
          tabKey({ windowId: context.windowId, tabId: context.tabId })
        );
        const tabs = await this.options.browser.listTabs();
        for (const [key, binding] of this.bindings) {
          if (binding.scope !== "group" || binding.windowId !== context.windowId) {
            continue;
          }
          const members = tabs.filter(
            (tab) => tab.windowId === binding.windowId && tab.groupId === binding.groupId
          );
          if (members.length === 0) {
            this.bindings.delete(key);
            changed = true;
          } else {
            binding.memberTabIds = members.map((tab) => tab.id);
            if (!binding.memberTabIds.includes(binding.activeTabId)) {
              binding.activeTabId = binding.memberTabIds[0];
            }
            binding.updatedAt = this.now();
            changed = true;
          }
        }
        if (changed) await this.persist();
      });
    }
    releaseSession(sessionId) {
      return this.serialized(async () => {
        await this.ensureLoaded();
        let changed = false;
        for (const [key, binding] of this.bindings) {
          if (binding.sessionId !== sessionId) continue;
          this.bindings.delete(key);
          changed = true;
        }
        await this.options.browser.releaseSession?.(sessionId);
        if (changed) await this.persist();
      });
    }
    clear() {
      return this.serialized(async () => {
        await this.ensureLoaded();
        const sessionIds = new Set(
          [...this.bindings.values()].map((binding) => binding.sessionId)
        );
        await Promise.all(
          [...sessionIds].map(
            (sessionId) => this.options.browser.releaseSession?.(sessionId)
          )
        );
        this.bindings.clear();
        await this.options.storage?.remove?.(this.storageKey);
      });
    }
    async list() {
      await this.ensureLoaded();
      return [...this.bindings.values()].map((binding) => ({ ...binding }));
    }
    async createTab(sessionId, url = "about:blank") {
      return this.serialized(async () => {
        await this.ensureLoaded();
        const existing = [...this.bindings.values()].find(
          (binding2) => binding2.sessionId === sessionId
        );
        if (!existing) {
          throw new AgentError(
            "WORKSPACE_NOT_FOUND",
            `No browser workspace is bound to session ${sessionId}`
          );
        }
        const tab = await this.options.browser.createTab(url, { active: false });
        const group = await this.options.browser.addTabToSession?.(
          sessionId,
          tab.id,
          { owned: true }
        );
        if (!group) {
          throw new AgentError(
            "WORKSPACE_GROUP_UNAVAILABLE",
            "The browser adapter cannot add tabs to a workspace"
          );
        }
        const tabs = await this.options.browser.listSessionTabs?.(sessionId) ?? [tab];
        this.removeBindings(sessionId);
        const binding = {
          scope: "group",
          windowId: group.groupId !== void 0 ? tab.windowId ?? existing.windowId : existing.windowId,
          ...group.groupId !== void 0 ? { groupId: group.groupId } : {},
          activeTabId: tab.id,
          memberTabIds: tabs.map((item) => item.id),
          sessionId,
          updatedAt: this.now()
        };
        this.bindings.set(tabKeyFromBinding(binding), binding);
        await this.persist();
        await this.options.browser.setWorkingTab(sessionId, tab.id, {
          activate: true
        });
        return {
          ...tab,
          active: true,
          ...group.groupId !== void 0 ? { groupId: group.groupId } : {}
        };
      });
    }
    async switchTab(sessionId, tabId) {
      return this.serialized(async () => {
        await this.ensureLoaded();
        await this.options.browser.assertSessionTab?.(sessionId, tabId);
        await this.options.browser.setWorkingTab(sessionId, tabId, {
          activate: true
        });
        const binding = [...this.bindings.values()].find(
          (item) => item.sessionId === sessionId
        );
        if (binding) {
          binding.activeTabId = tabId;
          binding.updatedAt = this.now();
          await this.persist();
        }
      });
    }
    async listTabs(sessionId) {
      await this.ensureLoaded();
      return await this.options.browser.listSessionTabs?.(sessionId) ?? [];
    }
    async createLocked(context) {
      return this.bindLocked(context, this.createSessionId());
    }
    async bindLocked(context, sessionId) {
      const key = tabKey(context);
      for (const [existingKey, binding2] of this.bindings) {
        if (existingKey !== key && binding2.sessionId === sessionId) {
          this.bindings.delete(existingKey);
        }
      }
      await this.options.runtime.ensureSessionReady(sessionId);
      await this.options.browser.setWorkingTab(sessionId, context.tabId, {
        activate: false
      });
      const groupTabs = context.groupId !== void 0 && context.groupId >= 0 ? await this.options.browser.listTabs() : [];
      const binding = {
        scope: context.groupId !== void 0 && context.groupId >= 0 ? "group" : "tab",
        windowId: context.windowId,
        ...context.groupId !== void 0 && context.groupId >= 0 ? { groupId: context.groupId } : {},
        activeTabId: context.tabId,
        memberTabIds: context.groupId !== void 0 && context.groupId >= 0 ? groupTabs.filter(
          (tab) => tab.windowId === context.windowId && tab.groupId === context.groupId
        ).map((tab) => tab.id) : [context.tabId],
        sessionId,
        updatedAt: this.now()
      };
      this.bindings.set(key, binding);
      await this.persist();
      return { ...binding };
    }
    async ensureLoaded() {
      this.loaded ??= this.load();
      await this.loaded;
    }
    async refreshBinding(binding, context) {
      binding.activeTabId = context.tabId;
      binding.updatedAt = this.now();
      if (binding.scope === "group" && binding.groupId !== void 0) {
        const tabs = await this.options.browser.listTabs();
        binding.memberTabIds = tabs.filter(
          (tab) => tab.windowId === binding.windowId && tab.groupId === binding.groupId
        ).map((tab) => tab.id);
      }
      await this.persist();
      return {
        ...binding,
        memberTabIds: [...binding.memberTabIds]
      };
    }
    async load() {
      if (!this.options.storage) return;
      const stored = await this.options.storage.get(this.storageKey);
      const raw = stored[this.storageKey];
      if (!Array.isArray(raw)) return;
      for (const value of raw) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const item = value;
        const windowId = Number(item.windowId);
        const groupId = Number(item.groupId);
        const tabId = typeof item.activeTabId === "string" ? item.activeTabId : typeof item.tabId === "string" ? item.tabId : "";
        const sessionId = typeof item.sessionId === "string" ? item.sessionId : "";
        if (!Number.isFinite(windowId) || !tabId || !sessionId) continue;
        const scopedGroupId = Number.isFinite(groupId) && groupId >= 0 ? groupId : void 0;
        const context = { windowId, tabId, ...scopedGroupId !== void 0 ? { groupId: scopedGroupId } : {} };
        this.bindings.set(tabKey(context), {
          scope: scopedGroupId !== void 0 ? "group" : "tab",
          windowId,
          ...scopedGroupId !== void 0 ? { groupId: scopedGroupId } : {},
          activeTabId: tabId,
          memberTabIds: Array.isArray(item.memberTabIds) ? item.memberTabIds.map(String) : [tabId],
          sessionId,
          updatedAt: Number(item.updatedAt ?? this.now())
        });
      }
    }
    async persist() {
      if (!this.options.storage) return;
      await this.options.storage.set({
        [this.storageKey]: [...this.bindings.values()].map((binding) => ({
          ...binding
        }))
      });
    }
    removeBindings(sessionId) {
      for (const [key, binding] of this.bindings) {
        if (binding.sessionId === sessionId) this.bindings.delete(key);
      }
    }
    serialized(operation) {
      const next = this.tail.then(operation, operation);
      this.tail = next.then(
        () => void 0,
        () => void 0
      );
      return next;
    }
  };
  function tabKey(context) {
    return context.groupId !== void 0 && context.groupId >= 0 ? `group:${context.windowId}:${context.groupId}` : `tab:${context.windowId}:${context.tabId}`;
  }
  function tabKeyFromBinding(binding) {
    return binding.scope === "group" && binding.groupId !== void 0 ? `group:${binding.windowId}:${binding.groupId}` : `tab:${binding.windowId}:${binding.activeTabId}`;
  }

  // src/adapters/chrome-runtime-extension.ts
  var ChromeRuntimeExtension = class {
    constructor(runtime, tabs, browser, chromeApi) {
      this.runtime = runtime;
      this.tabs = tabs;
      this.browser = browser;
      this.chromeApi = chromeApi;
      this.chromeApi.tabs.onRemoved.addListener(this.onTabRemoved);
    }
    runtime;
    tabs;
    browser;
    chromeApi;
    onTabRemoved = (tabId, info) => {
      void this.tabs.forget({
        windowId: info.windowId,
        tabId: String(tabId)
      });
    };
    async tryHandle(request) {
      if (request.type === "list_tabs") {
        return { handled: true, data: await this.browser.listTabs() };
      }
      if (request.type === "select_tab") {
        await this.browser.setWorkingTab(
          requiredString3(request, "sessionId"),
          requiredString3(request, "tabId")
        );
        return { handled: true, data: true };
      }
      if (request.type === "resolve_tab_session") {
        return this.activate(request, "resolve");
      }
      if (request.type === "create_tab_session") {
        return this.activate(request, "create");
      }
      if (request.type === "bind_tab_session") {
        const binding = await this.tabs.bind(
          activationContext(request),
          requiredString3(request, "sessionId")
        );
        return {
          handled: true,
          data: {
            ...binding,
            projection: await this.runtime.loadProjection(binding.sessionId)
          }
        };
      }
      if (request.type === "forget_tab_session") {
        await this.tabs.forget(activationContext(request));
        return { handled: true, data: true };
      }
      return { handled: false };
    }
    async beforeDeleteSession(sessionId) {
      await this.tabs.releaseSession(sessionId);
    }
    async beforeClearHistory() {
      await this.tabs.clear();
    }
    dispose() {
      this.chromeApi.tabs.onRemoved.removeListener(this.onTabRemoved);
    }
    async activate(request, mode) {
      const context = activationContext(request);
      const binding = mode === "resolve" ? await this.tabs.resolve(context) : await this.tabs.create(context);
      return {
        handled: true,
        data: {
          ...binding,
          projection: await this.runtime.loadProjection(binding.sessionId)
        }
      };
    }
  };
  function activationContext(request) {
    const windowId = Number(request.windowId);
    const tabId = requiredString3(request, "tabId");
    if (!Number.isFinite(windowId)) {
      throw new AgentError("TAB_CONTEXT_INVALID", "A valid windowId is required");
    }
    const groupId = Number(request.groupId);
    return {
      windowId,
      tabId,
      ...Number.isFinite(groupId) && groupId >= 0 ? { groupId } : {}
    };
  }
  function requiredString3(request, key) {
    const value = request[key];
    if (typeof value !== "string" || !value) {
      throw new AgentError(
        "RUNTIME_EXTENSION_INVALID_REQUEST",
        `Missing ${key}`
      );
    }
    return value;
  }

  // src/adapters/legacy-session-importer.ts
  async function importLegacySessions(raw, store, now = Date.now()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return 0;
    const sessions = raw.sessions;
    if (!Array.isArray(sessions)) return 0;
    let imported = 0;
    for (const value of sessions) {
      if (!value || typeof value !== "object") continue;
      const legacy = value;
      const sessionId = legacy.id ? `legacy_${legacy.id}` : `legacy_${now}_${imported}`;
      if (await store.load(sessionId)) continue;
      const snapshot = convertSession(legacy, sessionId, now);
      if (snapshot.rows.length === 0) continue;
      await store.save(snapshot);
      imported += 1;
    }
    return imported;
  }
  function convertSession(legacy, sessionId, now = Date.now()) {
    const updatedAt = finite(legacy.updated) ?? now;
    const rows = [];
    const ledger = [];
    const entries = [];
    let parentId = null;
    let entrySequence = 0;
    const appendEntry = (payload) => {
      const id = `legacy_entry_${++entrySequence}`;
      entries.push({
        id,
        parentId,
        type: "message",
        createdAt: updatedAt,
        payload
      });
      parentId = id;
    };
    for (const message of legacy.messages ?? []) {
      const role = message.role;
      if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") continue;
      const content = stringify(message.content);
      if (role === "assistant") {
        const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
          id: call.id ?? `legacy_call_${index + 1}`,
          name: call.function?.name ?? "unknown",
          arguments: call.function?.arguments ?? "{}"
        }));
        appendEntry({
          role,
          content,
          ...toolCalls.length ? { toolCallIds: toolCalls.map((call) => call.id), toolCalls } : {}
        });
      } else if (role === "tool") {
        appendEntry({
          role,
          content,
          ...message.tool_call_id ? { toolCallId: message.tool_call_id } : {}
        });
      } else {
        appendEntry({ role, content });
      }
    }
    for (const item of legacy.timeline ?? []) {
      const id = item.id ?? `legacy_row_${rows.length + 1}`;
      if (item.kind === "user") {
        rows.push({
          id,
          entityId: id,
          productTurnId: "legacy_turn",
          kind: "user",
          text: item.text ?? "",
          status: "completed"
        });
        ledger.push({
          inputId: `legacy_input_${rows.length}`,
          sourceCommandId: `legacy_command_${rows.length}`,
          status: "promoted",
          delivery: "startNow",
          text: item.text ?? "",
          admittedAt: updatedAt
        });
      } else if (item.kind === "assistant") {
        rows.push({
          id,
          entityId: id,
          productTurnId: "legacy_turn",
          kind: "assistant",
          text: item.text ?? "",
          status: "completed"
        });
      } else if (item.kind === "tool") {
        rows.push({
          id,
          entityId: item.callId ?? id,
          productTurnId: "legacy_turn",
          kind: "tool",
          text: item.result ?? "",
          status: item.state === "denied" ? "denied" : item.state === "error" ? "failed" : "completed",
          ...item.callId ? { callId: item.callId } : {},
          ...item.name ? { toolName: item.name } : {}
        });
      } else if (item.kind === "notice" && item.text) {
        rows.push({
          id,
          entityId: id,
          productTurnId: "legacy_turn",
          kind: "assistant",
          text: item.text,
          status: item.level === "error" ? "failed" : "completed"
        });
      }
    }
    return {
      schemaVersion: 1,
      sessionId,
      logEpoch: `legacy_epoch_${sessionId}`,
      revision: 1,
      eventSeq: 1,
      taskStatus: "completed",
      messages: convertMessages(legacy.messages ?? []),
      rows,
      ledger,
      events: [
        {
          seq: 1,
          type: "legacy.imported",
          revision: 1,
          occurredAt: updatedAt,
          payload: { title: legacy.title ?? "Imported chat" }
        }
      ],
      sessionEntries: entries,
      activeLeafId: parentId,
      tasks: [],
      permission: { mode: "guarded" }
    };
  }
  function convertMessages(messages) {
    const converted = [];
    for (const message of messages) {
      const content = stringify(message.content);
      if (message.role === "system" || message.role === "user") {
        converted.push({ role: message.role, content });
      } else if (message.role === "assistant") {
        const toolCalls = (message.tool_calls ?? []).map((call, index) => ({
          id: call.id ?? `legacy_call_${index + 1}`,
          name: call.function?.name ?? "unknown",
          arguments: call.function?.arguments ?? "{}"
        }));
        converted.push({
          role: "assistant",
          content,
          ...toolCalls.length ? { toolCalls } : {}
        });
      } else if (message.role === "tool") {
        converted.push({
          role: "tool",
          callId: message.tool_call_id ?? "legacy_unknown_call",
          name: "tool",
          content
        });
      }
    }
    return converted;
  }
  function stringify(value) {
    if (typeof value === "string") return value;
    if (value === null || value === void 0) return "";
    return JSON.stringify(value);
  }
  function finite(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : void 0;
  }

  // src/runtime/storage-migration.ts
  var CONFIG_KEY = "tinyai:v2:config";
  var SKILLS_KEY = "tinyai:v1:skills";
  var MIGRATION_KEY = "tinyai:migration:v2";
  var legacyKeys = [
    "clj-agent-config",
    "clj-agent-sessions",
    "clj-agent-skills",
    "agent_skills"
  ];
  async function migrateLegacyStorage(storage, sessions, now = Date.now()) {
    const stored = await storage.get([MIGRATION_KEY, CONFIG_KEY, SKILLS_KEY, ...legacyKeys]);
    if (stored[MIGRATION_KEY] === true) {
      return { migrated: false, importedSessions: 0 };
    }
    const oldConfig = objectValue(stored["clj-agent-config"]);
    if (oldConfig && !stored[CONFIG_KEY]) {
      await storage.set({ [CONFIG_KEY]: oldConfig });
    }
    if (!stored[SKILLS_KEY]) {
      const skills = mergeSkills(
        arrayValue(stored.agent_skills),
        arrayValue(stored["clj-agent-skills"])
      );
      await storage.set({ [SKILLS_KEY]: skills });
    }
    const importedSessions = await importLegacySessions(
      stored["clj-agent-sessions"],
      sessions,
      now
    );
    if (storage.remove) await storage.remove(legacyKeys);
    await storage.set({
      [MIGRATION_KEY]: true,
      "tinyai:migration:legacy-sessions": importedSessions
    });
    return { migrated: true, importedSessions };
  }
  function objectValue(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
  }
  function arrayValue(value) {
    return Array.isArray(value) ? value : [];
  }
  function mergeSkills(original, current) {
    const skills = /* @__PURE__ */ new Map();
    for (const value of [...original, ...current]) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const skill = value;
      const name = typeof skill.name === "string" ? skill.name.trim() : "";
      if (!name) continue;
      skills.set(name, {
        name,
        description: String(skill.description ?? ""),
        when_to_use: String(skill.when_to_use ?? skill.whenToUse ?? ""),
        body: String(skill.body ?? "")
      });
    }
    return [...skills.values()];
  }

  // src/runtime/chrome-runtime.ts
  var KERNEL_PORT_NAME = "tinyai-runtime-v1";
  function parseKernelConfig(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new AgentError("MODEL_NOT_CONFIGURED", "No model configuration was found");
    }
    const config = raw;
    const connections = Array.isArray(config.connections) ? config.connections : [];
    const requested = typeof config.connection === "string" ? config.connection : void 0;
    const connection = connections.find((candidate) => candidate.id === requested) ?? connections[0];
    if (!connection) {
      throw new AgentError(
        "MODEL_NOT_CONFIGURED",
        "Configure an OpenAI-compatible connection before using the kernel runtime"
      );
    }
    const apiKey = stringValue2(connection.apiKey ?? connection["api-key"]);
    const baseUrl = stringValue2(connection.baseUrl ?? connection["base-url"]).replace(/\/+$/, "");
    if (!apiKey || !baseUrl) {
      throw new AgentError(
        "MODEL_CONFIGURATION_INVALID",
        "The selected connection requires both base URL and API key"
      );
    }
    const models = Array.isArray(connection.models) ? connection.models.map(String).filter(Boolean) : [];
    const model = stringValue2(config.model) || models[0] || "deepseek-chat";
    return {
      baseUrl,
      apiKey,
      model,
      approval: config.approval === "auto" ? "auto" : "ask",
      connectionId: stringValue2(connection.id) || "default"
    };
  }
  async function createChromeRuntimeBundle(options = {}) {
    const storage = options.storage ?? chromeLocalStorage();
    const sessionStore = new ChromeSessionStore({
      storage: chromeStorageForSessions(storage)
    });
    await migrateLegacyStorage(storage, sessionStore, systemClock.now());
    const stored = await storage.get(CONFIG_KEY);
    const config = parseKernelConfig(stored[CONFIG_KEY]);
    const profiles = await storage.get("tinyai-agent-profiles");
    const mcpConfig = await storage.get("tinyai-mcp-servers");
    const hookConfig = await storage.get("tinyai-declarative-hooks");
    const approval = new PortApprovalBroker({ mode: config.approval });
    const browser = options.browser ?? options.createBrowser?.() ?? new ChromeBrowserProvider();
    const model = new ModelGateway({
      targets: [
        {
          id: config.connectionId,
          attempts: 2,
          transport: new OpenAIModelTransport({
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            model: config.model
          })
        }
      ]
    });
    const artifactStore = new ChromeArtifactStore(
      storage
    );
    const hooks = new HookRunner();
    await registerDeclarativeHooks(hooks, hookConfig["tinyai-declarative-hooks"]);
    const ids = new SequentialIdGenerator();
    const trace = new TraceRecorder(`trace_${crypto.randomUUID()}`, () => systemClock.now());
    const permissionModes = new PermissionModeRegistry(
      config.approval === "auto" ? "build" : "guarded",
      () => systemClock.now()
    );
    const extensions = new ExtensionRegistry();
    const skillStore = new ChromeSkillStore(storage);
    const initialSkills = await skillStore.list();
    extensions.register({
      id: "tinyai.skills",
      name: "tinyai skills",
      version: "1",
      source: "builtin",
      skills: initialSkills
    });
    const skillTools = createSkillTools(extensions, skillStore);
    const mcpClients = [];
    const mcpTools = [];
    for (const server of parseMcpServers(mcpConfig["tinyai-mcp-servers"])) {
      try {
        const client = new HttpMcpClient(
          new HttpMcpTransport({
            url: server.url,
            headers: server.headers
          }),
          server.name
        );
        await client.initialize();
        mcpTools.push(...await client.definitions());
        mcpClients.push(client);
      } catch (error) {
        console.warn(`tinyai MCP server ${server.name} failed to initialize`, error);
      }
    }
    const registry = createDefaultProfileRegistry(
      loadAgentProfiles(profiles["tinyai-agent-profiles"])
    );
    const rootPermissions = {
      capabilities: [
        "browser:read",
        "browser:navigate",
        "browser:interact",
        "browser:script",
        "browser:network",
        "agent:spawn",
        "agent:manage",
        "extension:skills",
        "mcp:call"
      ],
      effects: ["read", "write", "execute", "network"]
    };
    const subagentDriver = new WorkspaceSubagentDriver({
      ids,
      now: () => systemClock.now(),
      createRuntime: ({ sessionId, spec, profile }) => createBrowserWorkspace({
        model,
        browser,
        sessionStore,
        approval,
        handoff: approval,
        clock: systemClock,
        ids,
        permissionModes,
        artifactStore,
        trace,
        hooks,
        systemPrompt: chromePromptProfile.build({
          profile,
          skills: initialSkills
        }),
        maxSteps: spec.budget.maxTurns,
        toolSelection: {
          allow: profile.tools.allow,
          deny: profile.tools.deny,
          capabilities: profile.effectivePermissions.capabilities
        },
        additionalTools: [
          ...skillTools.map((definition) => ({
            definition,
            source: "builtin",
            sourceId: "skills"
          })),
          ...mcpTools.map((definition) => ({
            definition,
            source: "plugin",
            sourceId: "mcp"
          }))
        ],
        tabScoped: true
      }).runtime
    });
    let mainWorkspace;
    let tabSessions;
    const workspaceTabs = {
      createTab: (sessionId, url) => requireTabSessions().createTab(sessionId, url),
      switchTab: (sessionId, tabId) => requireTabSessions().switchTab(sessionId, tabId),
      listTabs: (sessionId) => requireTabSessions().listTabs(sessionId)
    };
    const requireTabSessions = () => {
      if (!tabSessions) {
        throw new AgentError("WORKSPACE_NOT_READY", "Browser workspace is not initialized");
      }
      return tabSessions;
    };
    const coordinator = new SubagentCoordinator({
      registry,
      driver: subagentDriver,
      ids,
      now: () => systemClock.now(),
      contextProvider: async (parentTaskId) => mainWorkspace.runtime.contextForTask(parentTaskId)
    });
    const subagentTools = createSubagentTools({
      coordinator,
      parent: (invocation) => ({
        taskId: invocation.taskId,
        depth: 0,
        maxDepth: 2,
        permissions: {
          capabilities: [...rootPermissions.capabilities],
          effects: [...rootPermissions.effects]
        }
      })
    });
    mainWorkspace = createBrowserWorkspace({
      model,
      browser,
      sessionStore,
      approval,
      handoff: approval,
      clock: systemClock,
      ids,
      permissionModes,
      artifactStore,
      trace,
      hooks,
      systemPrompt: chromePromptProfile.build({ skills: initialSkills }),
      download: async (name, mime, base64) => {
        await chrome.downloads.download({
          url: `data:${mime};base64,${base64}`,
          filename: name,
          saveAs: false
        });
      },
      additionalTools: [
        ...subagentTools.map((definition) => ({
          definition,
          source: "builtin",
          sourceId: "subagents"
        })),
        ...skillTools.map((definition) => ({
          definition,
          source: "builtin",
          sourceId: "skills"
        })),
        ...mcpTools.map((definition) => ({
          definition,
          source: "plugin",
          sourceId: "mcp"
        }))
      ],
      workspaceTabs
    });
    const unsubscribeChildren = coordinator.subscribe((child) => {
      mainWorkspace.runtime.updateChildTask(child.parentTaskId, {
        taskId: child.taskId,
        sessionId: child.sessionId,
        parentTaskId: child.parentTaskId,
        profileName: child.profileName,
        status: child.status,
        executionMode: child.executionMode,
        ...child.result?.summary ? { summary: child.result.summary } : {},
        ...child.completedAt ? { updatedAt: child.completedAt } : {}
      });
    });
    tabSessions = new TabSessionRegistry({
      runtime: mainWorkspace.runtime,
      browser,
      storage: options.tabSessionStorage
    });
    const extension = new ChromeRuntimeExtension(
      mainWorkspace.runtime,
      tabSessions,
      browser,
      options.chromeApi ?? chrome
    );
    return {
      runtime: mainWorkspace.runtime,
      extension,
      approval,
      skills: () => skillStore.list(),
      artifacts: artifactStore,
      async dispose() {
        await extension.dispose();
        unsubscribeChildren();
        approval.dispose();
        await coordinator.dispose();
        await mainWorkspace.dispose();
        await Promise.all(mcpClients.map((client) => client.close()));
      }
    };
  }
  function installKernelRuntimeGateway(chromeApi = chrome) {
    const gateway = new RuntimeGateway(
      async () => createChromeRuntimeBundle({
        storage: chromeApi.storage.local,
        tabSessionStorage: chromeApi.storage.session,
        chromeApi
      })
    );
    chromeApi.runtime.onConnect.addListener((port) => {
      if (port.name !== KERNEL_PORT_NAME) return;
      gateway.connect(asRuntimePort(port));
      void ensureRuntimeOffscreen(chromeApi);
    });
    return gateway;
  }
  async function ensureRuntimeOffscreen(chromeApi) {
    if (!chromeApi.offscreen) return;
    try {
      const contexts = await chromeApi.runtime.getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [chromeApi.runtime.getURL("offscreen.html")]
      });
      if (contexts.length > 0) return;
      await chromeApi.offscreen.createDocument({
        url: "offscreen.html",
        reasons: ["WORKERS"],
        justification: "Keep the authoritative agent runtime alive while the side panel is closed."
      });
    } catch {
    }
  }
  function asRuntimePort(port) {
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
  function chromeLocalStorage() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) {
      throw new AgentError(
        "CHROME_STORAGE_UNAVAILABLE",
        "chrome.storage.local is unavailable"
      );
    }
    return chrome.storage.local;
  }
  function chromeStorageForSessions(storage) {
    return {
      get: async (keys) => storage.get(keys),
      set: (items) => storage.set(items),
      remove: async (keys) => {
        if (!storage.remove) {
          throw new AgentError(
            "CHROME_STORAGE_UNAVAILABLE",
            "chrome.storage.local.remove is unavailable"
          );
        }
        await storage.remove(keys);
      }
    };
  }
  function stringValue2(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function parseMcpServers(value) {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry;
      const name = stringValue2(item.name);
      const url = stringValue2(item.url);
      if (!name || !/^https?:\/\//.test(url)) return [];
      const headers = item.headers && typeof item.headers === "object" && !Array.isArray(item.headers) ? Object.fromEntries(
        Object.entries(item.headers).map(([key, header]) => [
          key,
          String(header)
        ])
      ) : void 0;
      return [{ name, url, ...headers ? { headers } : {} }];
    });
  }

  // src/background.ts
  function setup() {
    try {
      chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => void 0);
    } catch {
    }
  }
  chrome.action.onClicked.addListener((tab) => {
    try {
      chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => void 0);
    } catch {
    }
  });
  chrome.runtime.onInstalled.addListener(() => setup());
  chrome.runtime.onStartup.addListener(() => setup());
  setup();
  installKernelRuntimeGateway();
})();
