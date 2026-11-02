import { AgentError, toStructuredError } from '../core/errors';
import type {
  BrowserActionTarget,
  BrowserAxNode,
  BrowserProvider,
  BrowserTabId,
  CloseSessionReport,
  DialogStatus,
  FrameDescriptor,
  PageInfo,
  PageSnapshot,
  PdfResult,
  ScreenshotResult,
  SnapshotOptions,
  TabDescriptor,
  TabGroupRef,
  UploadFile,
} from './browser-provider';
import type { JsonValue } from '../core/types';

export interface ChromeTabsApi {
  query(queryInfo: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]>;
  get(tabId: number): Promise<chrome.tabs.Tab>;
  create(properties: chrome.tabs.CreateProperties): Promise<chrome.tabs.Tab>;
  update(tabId: number, properties: chrome.tabs.UpdateProperties): Promise<chrome.tabs.Tab | undefined>;
  remove(tabIds: number | number[]): Promise<void>;
  group?(options: chrome.tabs.GroupOptions): Promise<number>;
  ungroup?(tabIds: number | number[]): Promise<void>;
}

export interface ChromeDebuggerApi {
  attach(target: chrome.debugger.Debuggee, version: string): Promise<void>;
  detach(target: chrome.debugger.Debuggee): Promise<void>;
  sendCommand(
    target: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): Promise<object | undefined>;
  onEvent: {
    addListener(
      listener: (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: object
      ) => void
    ): void;
    removeListener(
      listener: (
        source: chrome.debugger.Debuggee,
        method: string,
        params?: object
      ) => void
    ): void;
  };
}

export interface ChromeTabGroupsApi {
  update(
    groupId: number,
    properties: chrome.tabGroups.UpdateProperties
  ): Promise<chrome.tabGroups.TabGroup>;
}

export interface ChromeBrowserOptions {
  tabs?: ChromeTabsApi;
  debugger?: ChromeDebuggerApi;
  tabGroups?: ChromeTabGroupsApi;
  clock?: { now(): number; setTimeout(callback: () => void, ms: number): unknown };
}

interface SessionBinding {
  tabId: BrowserTabId;
  groupId?: number;
  ownedTabs: Set<BrowserTabId>;
  attached: Set<BrowserTabId>;
}

interface RefEntry {
  backendNodeId: number;
  role: string;
  name: string;
}

interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  type: string;
  status?: number;
  mimeType?: string;
  finished: boolean;
  failed: boolean;
}

interface NetworkState {
  enabled: boolean;
  entries: Map<string, NetworkEntry>;
  order: string[];
}

const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
]);

const PAPER_SIZES: Record<string, [number, number]> = {
  letter: [8.5, 11],
  legal: [8.5, 14],
  a4: [8.27, 11.69],
  a3: [11.69, 16.54],
  tabloid: [11, 17],
};
const MAX_NETWORK_ENTRIES = 300;

export class ChromeBrowserProvider implements BrowserProvider {
  private readonly tabs: ChromeTabsApi;
  private readonly debuggerApi: ChromeDebuggerApi;
  private readonly tabGroups?: ChromeTabGroupsApi;
  private readonly clock: NonNullable<ChromeBrowserOptions['clock']>;
  private readonly sessions = new Map<string, SessionBinding>();
  private readonly attachedTabs = new Set<BrowserTabId>();
  private readonly refs = new Map<string, Map<string, RefEntry>>();
  private readonly frameContexts = new Map<string, number>();
  private readonly dialogs = new Map<string, Record<string, unknown>>();
  private readonly networkStates = new Map<string, NetworkState>();
  private readonly onDebuggerEvent = (
    source: chrome.debugger.Debuggee,
    method: string,
    params?: object
  ): void => {
    const tabId = String(source.tabId ?? '');
    if (!tabId) return;
    if (method === 'Page.javascriptDialogOpening') {
      this.dialogs.set(tabId, (params ?? {}) as Record<string, unknown>);
    } else if (method === 'Page.javascriptDialogClosed') {
      this.dialogs.delete(tabId);
    } else if (method === 'Network.requestWillBeSent') {
      this.networkRequest(tabId, params as Record<string, any>);
    } else if (method === 'Network.responseReceived') {
      this.networkResponse(tabId, params as Record<string, any>);
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      this.networkFinished(tabId, params as Record<string, any>, method === 'Network.loadingFailed');
    }
  };

  constructor(options: ChromeBrowserOptions = {}) {
    const defaults =
      options.tabs && options.debugger
        ? undefined
        : defaultChromeApis();
    this.tabs = options.tabs ?? defaults!.tabs;
    this.debuggerApi = options.debugger ?? defaults!.debugger;
    this.tabGroups = options.tabGroups ?? defaults?.tabGroups;
    this.clock = options.clock ?? {
      now: () => Date.now(),
      setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
    };
    this.debuggerApi.onEvent.addListener(this.onDebuggerEvent);
  }

  async listTabs(): Promise<TabDescriptor[]> {
    const tabs = await this.tabs.query({});
    return tabs
      .filter((tab) => isInspectable(inspectableUrl(tab)))
      .filter((tab) => tab.id !== undefined)
      .map(toDescriptor);
  }

  async getTab(tabId: BrowserTabId): Promise<TabDescriptor | null> {
    try {
      const tab = await this.tabs.get(Number(tabId));
      return isInspectable(inspectableUrl(tab)) ? toDescriptor(tab) : null;
    } catch {
      return null;
    }
  }

  async createTab(url = 'about:blank', options: { active?: boolean } = {}): Promise<TabDescriptor> {
    const tab = await this.tabs.create({
      url: safeUrl(url),
      active: options.active ?? true,
    });
    if (tab.id === undefined) throw new AgentError('BROWSER_TAB_CREATE_FAILED', 'Chrome returned a tab without an id');
    return toDescriptor(tab);
  }

  async activateTab(tabId: BrowserTabId): Promise<void> {
    await this.tabs.update(Number(tabId), { active: true });
  }

  async removeTab(tabId: BrowserTabId): Promise<void> {
    await this.detach(tabId).catch(() => undefined);
    await this.tabs.remove(Number(tabId));
    for (const binding of this.sessions.values()) {
      binding.attached.delete(tabId);
      binding.ownedTabs.delete(tabId);
      if (binding.tabId === tabId) binding.tabId = '';
    }
    this.clearRefs(tabId);
    this.clearFrameContexts(tabId);
    this.dialogs.delete(tabId);
    this.attachedTabs.delete(tabId);
  }

  async ensureTaskGroup(sessionId: string): Promise<TabGroupRef> {
    const existing = this.sessions.get(sessionId);
    if (existing) return this.groupRef(sessionId, existing);

    const selected = (await this.listTabs()).find((tab) => tab.active);
    if (!selected) {
      throw new AgentError(
        'BROWSER_ACTIVE_TAB_UNAVAILABLE',
        'No inspectable active Chrome tab is available'
      );
    }
    const binding: SessionBinding = {
      tabId: selected.id,
      ownedTabs: new Set(),
      attached: new Set(),
    };
    if (selected.groupId !== undefined && selected.groupId >= 0) {
      binding.groupId = selected.groupId;
    } else if (this.tabs.group) {
      try {
        binding.groupId = await this.tabs.group({ tabIds: [Number(selected.id)] });
        await this.tabGroups?.update(binding.groupId, {
          title: tabGroupTitle(selected.title),
          color: 'blue',
        });
      } catch {
        // Grouping is an enhancement; a session remains usable when it is unavailable.
      }
    }
    this.sessions.set(sessionId, binding);
    return this.groupRef(sessionId, binding);
  }

  async setWorkingTab(
    sessionId: string,
    tabId: BrowserTabId,
    options: { activate?: boolean } = {}
  ): Promise<void> {
    const tab = await this.getTab(tabId);
    if (!tab) throw new AgentError('BROWSER_TAB_NOT_FOUND', `Tab not found: ${tabId}`);
    const binding = this.sessions.get(sessionId) ?? {
      tabId,
      ownedTabs: new Set<string>(),
      attached: new Set<string>(),
    };
    binding.tabId = tabId;
    if (tab.groupId !== undefined && tab.groupId >= 0) {
      binding.groupId = tab.groupId;
    }
    this.sessions.set(sessionId, binding);
    if (binding.groupId !== undefined) {
      await this.tabGroups
        ?.update(binding.groupId, { title: tabGroupTitle(tab.title) })
        .catch(() => undefined);
    }
    if (options.activate !== false) await this.activateTab(tabId);
  }

  async getWorkingTab(sessionId: string): Promise<BrowserTabId | null> {
    const binding = this.sessions.get(sessionId);
    if (!binding?.tabId) return null;
    return (await this.getTab(binding.tabId)) ? binding.tabId : null;
  }

  async addTabToSession(
    sessionId: string,
    tabId: BrowserTabId,
    options: { owned?: boolean; baseTabId?: BrowserTabId } = {}
  ): Promise<TabGroupRef> {
    const tab = await this.waitForTab(tabId);
    if (!tab) throw new AgentError('BROWSER_TAB_NOT_FOUND', `Tab not found: ${tabId}`);
    const binding = this.sessions.get(sessionId) ?? {
      tabId: options.baseTabId ?? tabId,
      ownedTabs: new Set<string>(),
      attached: new Set<string>(),
    };
    if (!this.tabs.group) {
      throw new AgentError('BROWSER_GROUP_UNAVAILABLE', 'Chrome tabGroups are unavailable');
    }
    const baseTab =
      binding.tabId === tabId
        ? tab
        : await this.waitForTab(binding.tabId);
    const existingGroup =
      binding.groupId ?? baseTab?.groupId;
    binding.groupId =
      existingGroup !== undefined && existingGroup >= 0
        ? await this.tabs.group({
            groupId: existingGroup,
            tabIds: [Number(tabId)],
          })
        : baseTab
          ? await this.tabs.group({
              tabIds: [Number(baseTab.id), Number(tabId)],
            })
          : await this.tabs.group({
              tabIds: [Number(tabId)],
            });
    binding.tabId = tabId;
    if (options.owned) binding.ownedTabs.add(tabId);
    this.sessions.set(sessionId, binding);
    await this.tabGroups
      ?.update(binding.groupId, { title: tabGroupTitle(tab.title) })
      .catch(() => undefined);
    return this.groupRef(sessionId, binding);
  }

  async listSessionTabs(sessionId: string): Promise<TabDescriptor[]> {
    const binding = this.sessions.get(sessionId);
    if (!binding) return [];
    if (binding.groupId !== undefined) {
      return (await this.listTabs()).filter(
        (tab) => tab.groupId === binding.groupId
      );
    }
    const tab = await this.getTab(binding.tabId);
    return tab ? [tab] : [];
  }

  async assertSessionTab(sessionId: string, tabId: BrowserTabId): Promise<void> {
    const tabs = await this.listSessionTabs(sessionId);
    if (!tabs.some((tab) => tab.id === tabId)) {
      throw new AgentError(
        'TARGET_OUTSIDE_WORKSPACE',
        `Tab ${tabId} does not belong to session ${sessionId}`
      );
    }
  }

  async closeSessionTabs(sessionId: string): Promise<CloseSessionReport> {
    const binding = this.sessions.get(sessionId);
    if (!binding) {
      return { sessionId, detachedTabs: [], closedTabs: [], errors: [] };
    }
    const detachedTabs: BrowserTabId[] = [];
    const closedTabs: BrowserTabId[] = [];
    const errors: CloseSessionReport['errors'] = [];
    for (const tabId of binding.attached) {
      if (!this.attachedTabs.has(tabId)) continue;
      try {
        await this.detach(tabId);
        detachedTabs.push(tabId);
      } catch (error) {
        errors.push(toStructuredError(error, 'BROWSER_DETACH_FAILED'));
      }
    }
    for (const tabId of binding.ownedTabs) {
      try {
        await this.tabs.remove(Number(tabId));
        closedTabs.push(tabId);
      } catch (error) {
        errors.push(toStructuredError(error, 'BROWSER_TAB_CLOSE_FAILED'));
      }
    }
    this.sessions.delete(sessionId);
    this.refs.clear();
    this.frameContexts.clear();
    return { sessionId, detachedTabs, closedTabs, errors };
  }

  async releaseSession(sessionId: string): Promise<void> {
    const binding = this.sessions.get(sessionId);
    if (!binding) return;
    for (const tabId of binding.attached) {
      await this.detach(tabId).catch(() => undefined);
    }
    const groupedTabs = new Set([binding.tabId, ...binding.ownedTabs].filter(Boolean));
    const sharedGroup =
      binding.groupId !== undefined &&
      [...this.sessions.entries()].some(
        ([otherSession, other]) =>
          otherSession !== sessionId && other.groupId === binding.groupId
      );
    if (this.tabs.ungroup && groupedTabs.size && !sharedGroup) {
      await this.tabs
        .ungroup([...groupedTabs].map(Number))
        .catch(() => undefined);
    }
    this.sessions.delete(sessionId);
  }

  async listFrames(tabId: BrowserTabId): Promise<FrameDescriptor[]> {
    const result = await this.cdp<FrameTreeResponse>(tabId, 'Page.getFrameTree');
    return flattenFrames(result.frameTree);
  }

  async navigate(tabId: BrowserTabId, url: string, signal?: AbortSignal): Promise<PageInfo> {
    assertActive(signal);
    await this.tabs.update(Number(tabId), { url: safeUrl(url) });
    this.clearRefs(tabId);
    this.clearFrameContexts(tabId);
    await this.waitForScript(
      tabId,
      "document.readyState === 'complete'",
      20_000,
      signal
    ).catch(() => false);
    return this.pageInfo(tabId);
  }

  async snapshot(tabId: BrowserTabId, options: SnapshotOptions = {}): Promise<PageSnapshot> {
    assertActive(options.signal);
    await this.cdp(tabId, 'Accessibility.enable', {}, options.signal).catch(() => undefined);
    const result = await this.cdp<{ nodes?: AxNode[] }>(
      tabId,
      'Accessibility.getFullAXTree',
      options.frameId ? { frameId: options.frameId } : {},
      options.signal
    );
    const info = await this.pageInfo(tabId, options.frameId);
    const rendered = this.renderAx(
      tabId,
      options.frameId,
      result.nodes ?? [],
      options.maxChars ?? 12_000,
      options.interactiveOnly ?? false
    );
    return {
      ...info,
      ...(options.frameId ? { frameId: options.frameId } : {}),
      nodes: rendered.nodes,
      text: rendered.text,
      truncated: rendered.truncated,
      capturedAt: this.clock.now(),
    };
  }

  async readText(
    tabId: BrowserTabId,
    maxChars = 30_000,
    options: { frameId?: string; signal?: AbortSignal } = {}
  ): Promise<string> {
    return this.evaluate<string>(
      tabId,
      `String((document.body?.innerText ?? '').slice(0, ${Math.max(1, maxChars)}))`,
      options
    );
  }

  async evaluate<T = JsonValue>(
    tabId: BrowserTabId,
    expression: string,
    options: { frameId?: string; signal?: AbortSignal } = {}
  ): Promise<T> {
    let contextId = options.frameId
      ? await this.frameContext(tabId, options.frameId)
      : undefined;
    const evaluate = () =>
      this.cdp<any>(
        tabId,
        'Runtime.evaluate',
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
          ...(contextId === undefined ? {} : { contextId }),
        },
        options.signal
      );
    let result: any;
    try {
      result = await evaluate();
    } catch (error) {
      if (
        !options.frameId ||
        !(error instanceof Error) ||
        !error.message.includes('Cannot find context')
      ) {
        throw error;
      }
      this.frameContexts.delete(this.frameKey(tabId, options.frameId));
      contextId = await this.frameContext(tabId, options.frameId);
      result = await evaluate();
    }
    if (result?.exceptionDetails) {
      throw new AgentError(
        'BROWSER_EVALUATION_FAILED',
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          'Page evaluation failed'
      );
    }
    return result?.result?.value as T;
  }


  async click(tabId: BrowserTabId, target: BrowserActionTarget): Promise<void> {
    const objectId = await this.objectId(tabId, target);
    const result = await this.cdp<any>(tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function(){ this.click(); return true; }',
      returnByValue: true,
    });
    throwOnException(result, 'click');
  }

  async mouseClick(
    tabId: BrowserTabId,
    target: BrowserActionTarget
  ): Promise<{ x: number; y: number }> {
    const objectId = await this.objectId(tabId, target);
    const center = await this.boxCenter(tabId, objectId);
    if (!center) throw new AgentError('BROWSER_ELEMENT_NOT_VISIBLE', 'Element has no layout box');
    await this.dispatchMouse(tabId, 'mouseMoved', center[0], center[1]);
    await this.dispatchMouse(tabId, 'mousePressed', center[0], center[1]);
    await this.dispatchMouse(tabId, 'mouseReleased', center[0], center[1]);
    return { x: Math.trunc(center[0]), y: Math.trunc(center[1]) };
  }

  async hover(
    tabId: BrowserTabId,
    target: BrowserActionTarget
  ): Promise<{ x: number; y: number }> {
    const objectId = await this.objectId(tabId, target);
    const center = await this.boxCenter(tabId, objectId);
    if (!center) throw new AgentError('BROWSER_ELEMENT_NOT_VISIBLE', 'Element has no layout box');
    await this.dispatchMouse(tabId, 'mouseMoved', center[0], center[1]);
    return { x: Math.trunc(center[0]), y: Math.trunc(center[1]) };
  }

  async fill(tabId: BrowserTabId, target: BrowserActionTarget, value: string): Promise<void> {
    const objectId = await this.objectId(tabId, target);
    const result = await this.cdp<any>(tabId, 'Runtime.callFunctionOn', {
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
      returnByValue: true,
    });
    throwOnException(result, 'fill');
  }

  async selectOption(
    tabId: BrowserTabId,
    target: BrowserActionTarget,
    values: string[] = []
  ): Promise<{ selected: string[]; options?: Array<{ value: string; label: string }> }> {
    const objectId = await this.objectId(tabId, target);
    const result = await this.cdp<any>(tabId, 'Runtime.callFunctionOn', {
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
      returnByValue: true,
    });
    throwOnException(result, 'select option');
    return result?.result?.value as { selected: string[]; options?: Array<{ value: string; label: string }> };
  }

  async drag(tabId: BrowserTabId, from: BrowserActionTarget, to: BrowserActionTarget): Promise<void> {
    const fromId = await this.objectId(tabId, from);
    const toId = await this.objectId(tabId, to);
    const start = await this.boxCenter(tabId, fromId);
    const end = await this.boxCenter(tabId, toId);
    if (!start || !end) throw new AgentError('BROWSER_ELEMENT_NOT_VISIBLE', 'Drag target has no layout box');
    await this.dispatchMouse(tabId, 'mouseMoved', start[0], start[1]);
    await this.dispatchMouse(tabId, 'mousePressed', start[0], start[1]);
    for (let step = 1; step <= 10; step += 1) {
      await this.cdp(tabId, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: start[0] + ((end[0] - start[0]) * step) / 10,
        y: start[1] + ((end[1] - start[1]) * step) / 10,
        button: 'left',
        buttons: 1,
      });
    }
    await this.dispatchMouse(tabId, 'mouseReleased', end[0], end[1]);
  }

  async scroll(
    tabId: BrowserTabId,
    options: {
      direction?: 'up' | 'down';
      to?: 'top' | 'bottom';
      selector?: string;
      text?: string;
      frameId?: string;
      signal?: AbortSignal;
    }
  ): Promise<{ scrollY: number; atTop: boolean; atBottom: boolean; found: boolean }> {
    return this.evaluate(
      tabId,
      `(() => {
        const root = document.scrollingElement || document.documentElement;
        let found = null;
        if (${JSON.stringify(Boolean(options.text))}) {
          const needle = ${JSON.stringify(options.text ?? '')}.toLowerCase();
          const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
          let node;
          while ((node = walker.nextNode())) {
            if (node.textContent && node.textContent.toLowerCase().includes(needle)) { found = node.parentElement; break; }
          }
        }
        if (${JSON.stringify(Boolean(options.selector))}) found = document.querySelector(${JSON.stringify(options.selector ?? '')});
        if (found) found.scrollIntoView({block: 'center'});
        else if (${JSON.stringify(options.to ?? '')} === 'top') root.scrollTo(0, 0);
        else if (${JSON.stringify(options.to ?? '')} === 'bottom') root.scrollTo(0, root.scrollHeight);
        else root.scrollBy(0, (${JSON.stringify(options.direction ?? 'down')} === 'up' ? -1 : 1) * Math.round(innerHeight * 0.9));
        const y = Math.round(scrollY || root.scrollTop || 0);
        return {scrollY: y, atTop: y <= 1, atBottom: y >= root.scrollHeight - innerHeight - 1, found: !!found};
      })()`,
      { frameId: options.frameId, signal: options.signal }
    );
  }

  async upload(
    tabId: BrowserTabId,
    target: BrowserActionTarget | undefined,
    files: UploadFile[]
  ): Promise<number> {
    const objectId = await this.objectId(
      tabId,
      target ?? { selector: 'input[type=file]' }
    );
    const result = await this.cdp<any>(tabId, 'Runtime.callFunctionOn', {
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
      arguments: [{ value: files as unknown as JsonValue }],
      awaitPromise: true,
      returnByValue: true,
    });
    throwOnException(result, 'upload');
    return Number(result?.result?.value ?? 0);
  }

  async waitFor(
    tabId: BrowserTabId,
    condition: { text?: string; textGone?: string; selector?: string; timeoutMs?: number },
    signal?: AbortSignal,
    options: { frameId?: string } = {}
  ): Promise<boolean> {
    let expression: string;
    if (condition.selector) {
      expression = `(() => { const e = document.querySelector(${JSON.stringify(condition.selector)}); if (!e) return false; const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.display !== 'none' && s.visibility !== 'hidden'; })()`;
    } else if (condition.textGone) {
      expression = `!(document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(condition.textGone.toLowerCase())}))`;
    } else if (condition.text) {
      expression = `!!(document.body && document.body.innerText.toLowerCase().includes(${JSON.stringify(condition.text.toLowerCase())}))`;
    } else {
      throw new AgentError('BROWSER_WAIT_INVALID', 'waitFor requires text, textGone, or selector');
    }
    return this.waitForScript(
      tabId,
      expression,
      condition.timeoutMs ?? 10_000,
      signal,
      options.frameId
    );
  }

  async screenshot(tabId: BrowserTabId, format: 'png' | 'jpeg' = 'png'): Promise<ScreenshotResult> {
    const result = await this.cdp<{ data?: string }>(tabId, 'Page.captureScreenshot', { format });
    if (!result.data) throw new AgentError('BROWSER_SCREENSHOT_FAILED', 'CDP returned no screenshot');
    return { dataUrl: `data:image/${format};base64,${result.data}`, format };
  }

  async printToPdf(
    tabId: BrowserTabId,
    options: {
      paperFormat?: 'letter' | 'legal' | 'a4' | 'a3' | 'tabloid';
      landscape?: boolean;
      scale?: number;
      printBackground?: boolean;
    } = {}
  ): Promise<PdfResult> {
    const [width, height] = PAPER_SIZES[options.paperFormat ?? 'letter'];
    const result = await this.cdp<{ data?: string }>(tabId, 'Page.printToPDF', {
      paperWidth: options.landscape ? height : width,
      paperHeight: options.landscape ? width : height,
      landscape: options.landscape ?? false,
      scale: options.scale ?? 1,
      printBackground: options.printBackground ?? true,
    });
    if (!result.data) throw new AgentError('BROWSER_PDF_FAILED', 'CDP returned no PDF');
    return { dataBase64: result.data, bytes: Math.floor((result.data.length * 3) / 4) };
  }

  async dialog(
    tabId: BrowserTabId,
    action: 'status' | 'accept' | 'dismiss',
    text = ''
  ): Promise<DialogStatus | { accepted: boolean }> {
    if (action === 'status') {
      const dialog = this.dialogs.get(tabId);
      return dialog
        ? {
            open: true,
            ...(typeof dialog.message === 'string' ? { message: dialog.message } : {}),
            ...(typeof dialog.type === 'string' ? { type: dialog.type } : {}),
            ...(typeof dialog.defaultPrompt === 'string'
              ? { defaultPrompt: dialog.defaultPrompt }
              : {}),
          }
        : { open: false };
    }
    await this.cdp(tabId, 'Page.handleJavaScriptDialog', {
      accept: action === 'accept',
      ...(text ? { promptText: text } : {}),
    });
    this.dialogs.delete(tabId);
    return { accepted: action === 'accept' };
  }

  async network(
    tabId: BrowserTabId,
    command:
      | { cmd: 'start' | 'stop' | 'list'; filter?: string }
      | { cmd: 'detail'; requestId: string }
  ): Promise<{ entries?: NetworkEntry[]; body?: string } | string> {
    if (command.cmd === 'start') {
      this.networkStates.set(tabId, { enabled: true, entries: new Map(), order: [] });
      await this.cdp(tabId, 'Network.enable');
      return 'Started capturing network requests';
    }
    if (command.cmd === 'stop') {
      const state = this.networkStates.get(tabId);
      if (state) state.enabled = false;
      await this.cdp(tabId, 'Network.disable').catch(() => undefined);
      return 'Stopped capturing network requests';
    }
    if (command.cmd === 'list') {
      const state = this.networkStates.get(tabId);
      const filter = command.filter?.toLowerCase() ?? '';
      const entries = (state?.order ?? [])
        .map((id) => state?.entries.get(id))
        .filter((entry): entry is NetworkEntry => Boolean(entry))
        .filter((entry) => !filter || entry.url.toLowerCase().includes(filter))
        .slice(0, 100);
      return { entries };
    }
    if (command.cmd !== 'detail') {
      throw new AgentError('BROWSER_NETWORK_COMMAND_INVALID', `Unknown network command: ${command.cmd}`);
    }
    const result = await this.cdp<{ body?: string; base64Encoded?: boolean }>(
      tabId,
      'Network.getResponseBody',
      { requestId: command.requestId }
    );
    if (!result.body) return { body: '' };
    return {
      body: result.base64Encoded ? decodeBase64(result.body) : result.body,
    };
  }

  async cdp<T = JsonValue>(
    tabId: BrowserTabId,
    method: string,
    params: Record<string, JsonValue> = {},
    signal?: AbortSignal
  ): Promise<T> {
    assertActive(signal);
    await this.attach(tabId);
    if (this.dialogs.has(tabId) && !method.startsWith('Page.handleJavaScriptDialog')) {
      throw new AgentError(
        'BROWSER_DIALOG_OPEN',
        'The page has an open JavaScript dialog; handle it before issuing other commands'
      );
    }
    assertActive(signal);
    const result = await this.debuggerApi.sendCommand(
      { tabId: Number(tabId) },
      method,
      params
    );
    assertActive(signal);
    return result as T;
  }

  dispose(): void {
    this.debuggerApi.onEvent.removeListener(this.onDebuggerEvent);
    this.sessions.clear();
    this.attachedTabs.clear();
    this.refs.clear();
    this.frameContexts.clear();
    this.dialogs.clear();
  }

  private async attach(tabId: BrowserTabId): Promise<void> {
    if (this.attachedTabs.has(tabId)) return;
    const target = { tabId: Number(tabId) };
    try {
      await this.debuggerApi.attach(target, '1.3');
      await this.debuggerApi.sendCommand(target, 'Page.enable');
    } catch (error) {
      if (!(error instanceof Error) || !/already attached/i.test(error.message)) throw error;
      await this.debuggerApi.sendCommand(target, 'Page.enable').catch(() => undefined);
    }
    this.attachedTabs.add(tabId);
    for (const binding of this.sessions.values()) {
      if (binding.tabId === tabId) binding.attached.add(tabId);
    }
  }

  private async waitForTab(
    tabId: BrowserTabId,
    attempts = 20
  ): Promise<TabDescriptor | null> {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const tab = await this.getTab(tabId);
      if (tab) return tab;
      await new Promise<void>((resolve) =>
        this.clock.setTimeout(resolve, 25)
      );
    }
    return null;
  }

  private async detach(tabId: BrowserTabId): Promise<void> {
    await this.debuggerApi.detach({ tabId: Number(tabId) });
    this.attachedTabs.delete(tabId);
    for (const binding of this.sessions.values()) binding.attached.delete(tabId);
  }

  private async pageInfo(tabId: BrowserTabId, frameId?: string): Promise<PageInfo> {
    const fallback = await this.getTab(tabId);
    const frame = frameId
      ? (await this.listFrames(tabId).catch(() => [])).find(
          (candidate) => candidate.frameId === frameId
        )
      : undefined;
    try {
      const info = await this.evaluate<{ title?: string; url?: string }>(
        tabId,
        '({title: document.title, url: location.href})',
        frameId ? { frameId } : undefined
      );
      return {
        tabId,
        title: String(info?.title ?? fallback?.title ?? ''),
        url: String(info?.url ?? frame?.url ?? fallback?.url ?? ''),
      };
    } catch {
      return {
        tabId,
        title: fallback?.title ?? '',
        url: frame?.url ?? fallback?.url ?? '',
      };
    }
  }

  private renderAx(
    tabId: BrowserTabId,
    frameId: string | undefined,
    source: AxNode[],
    limit: number,
    interactiveOnly: boolean
  ): { nodes: BrowserAxNode[]; text: string; truncated: boolean } {
    const byId = new Map(source.map((node) => [String(node.nodeId), node]));
    const keep = interactiveOnly ? interactiveSubtrees(source) : undefined;
    const refs = new Map<string, RefEntry>();
    this.refs.set(this.frameKey(tabId, frameId), refs);
    const nodes: BrowserAxNode[] = [];
    const lines: string[] = [];
    let used = 0;
    let truncated = false;
    let sequence = 0;
    const walk = (node: AxNode | undefined, depth: number): void => {
      if (!node || truncated) return;
      if (node.ignored) {
        for (const child of node.childIds ?? []) walk(byId.get(String(child)), depth);
        return;
      }
      if (keep && !keep.has(String(node.nodeId))) return;
      const role = axValue(node, 'role');
      const name = axValue(node, 'name').slice(0, 200);
      const value = axValue(node, 'value').slice(0, 200);
      const interactive = INTERACTIVE_ROLES.has(role);
      let ref: string | undefined;
      if (interactive && node.backendDOMNodeId !== undefined) {
        sequence += 1;
        ref = `e${sequence}`;
        refs.set(ref, { backendNodeId: node.backendDOMNodeId, role, name });
      }
      if (role && role !== 'none' && role !== 'generic' && role !== 'InlineTextBox') {
        const rendered = `${role}${name ? ` ${JSON.stringify(name)}` : ''}${value ? ` = ${JSON.stringify(value)}` : ''}${ref ? ` @${ref}` : ''}`;
        nodes.push({ ...(ref ? { ref } : {}), role, name, ...(value ? { value } : {}), depth, interactive });
        lines.push(`${'  '.repeat(depth)}${rendered}`);
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
      text: lines.join('\n') + (truncated ? '\n…(snapshot truncated)' : ''),
      truncated,
    };
  }

  private async objectId(tabId: BrowserTabId, target: BrowserActionTarget): Promise<string> {
    if (target.ref) {
      const entry = this.refs
        .get(this.frameKey(tabId, target.frameId))
        ?.get(target.ref.replace(/^@/, ''));
      if (!entry) {
        throw new AgentError(
          'BROWSER_REF_INVALID',
          `Unknown ref ${target.ref}; take a fresh snapshot before acting`
        );
      }
      const result = await this.cdp<any>(tabId, 'DOM.resolveNode', {
        backendNodeId: entry.backendNodeId,
      });
      if (!result?.object?.objectId) {
        throw new AgentError('BROWSER_REF_INVALID', `Could not resolve ref ${target.ref}`);
      }
      return String(result.object.objectId);
    }
    if (!target.selector) {
      throw new AgentError('BROWSER_TARGET_INVALID', 'A ref or CSS selector is required');
    }
    const result = await this.cdp<any>(tabId, 'Runtime.evaluate', {
      expression: `document.querySelector(${JSON.stringify(target.selector)})`,
      returnByValue: false,
      ...(target.frameId
        ? { contextId: await this.frameContext(tabId, target.frameId) }
        : {}),
    });
    if (!result?.result?.objectId) {
      throw new AgentError('BROWSER_ELEMENT_NOT_FOUND', `Element not found: ${target.selector}`);
    }
    return String(result.result.objectId);
  }

  private async boxCenter(tabId: BrowserTabId, objectId: string): Promise<[number, number] | null> {
    const result = await this.cdp<any>(tabId, 'DOM.getBoxModel', { objectId });
    const quad: number[] = result?.model?.content ?? [];
    if (!quad.length) return null;
    const xs = quad.filter((_, index) => index % 2 === 0);
    const ys = quad.filter((_, index) => index % 2 === 1);
    return [
      xs.reduce((sum, value) => sum + value, 0) / xs.length,
      ys.reduce((sum, value) => sum + value, 0) / ys.length,
    ];
  }

  private async dispatchMouse(
    tabId: BrowserTabId,
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    x: number,
    y: number
  ): Promise<void> {
    await this.cdp(tabId, 'Input.dispatchMouseEvent', {
      type,
      x,
      y,
      ...(type === 'mouseMoved' ? {} : { button: 'left', clickCount: 1 }),
    });
  }

  private async frameContext(tabId: BrowserTabId, frameId: string): Promise<number> {
    const key = this.frameKey(tabId, frameId);
    const cached = this.frameContexts.get(key);
    if (cached !== undefined) return cached;
    const result = await this.cdp<{ executionContextId?: number }>(
      tabId,
      'Page.createIsolatedWorld',
      {
        frameId,
        worldName: `tinyai-frame-${frameId.slice(0, 16)}`,
        grantUniveralAccess: false,
      }
    );
    if (result.executionContextId === undefined) {
      throw new AgentError(
        'BROWSER_FRAME_CONTEXT_FAILED',
        `Could not create an execution context for frame ${frameId}`
      );
    }
    this.frameContexts.set(key, result.executionContextId);
    return result.executionContextId;
  }

  private frameKey(tabId: BrowserTabId, frameId?: string): string {
    return `${tabId}:${frameId ?? 'main'}`;
  }

  private clearRefs(tabId: BrowserTabId): void {
    for (const key of this.refs.keys()) {
      if (key === this.frameKey(tabId) || key.startsWith(`${tabId}:`)) this.refs.delete(key);
    }
  }

  private clearFrameContexts(tabId: BrowserTabId): void {
    for (const key of this.frameContexts.keys()) {
      if (key.startsWith(`${tabId}:`)) this.frameContexts.delete(key);
    }
  }

  private networkRequest(tabId: string, params: Record<string, any>): void {
    const state = this.networkStates.get(tabId);
    if (!state?.enabled) return;
    const requestId = String(params.requestId ?? '');
    const request = params.request ?? {};
    state.order = [...state.order, requestId].slice(-MAX_NETWORK_ENTRIES);
    const retained = new Set(state.order);
    for (const id of state.entries.keys()) {
      if (!retained.has(id)) state.entries.delete(id);
    }
    state.entries.set(requestId, {
      requestId,
      url: String(request.url ?? ''),
      method: String(request.method ?? ''),
      type: String(params.type ?? ''),
      finished: false,
      failed: false,
    });
  }

  private networkResponse(tabId: string, params: Record<string, any>): void {
    const entry = this.networkStates.get(tabId)?.entries.get(String(params.requestId ?? ''));
    if (!entry) return;
    entry.status = Number(params.response?.status ?? 0);
    entry.mimeType = String(params.response?.mimeType ?? '');
  }

  private networkFinished(tabId: string, params: Record<string, any>, failed: boolean): void {
    const entry = this.networkStates.get(tabId)?.entries.get(String(params.requestId ?? ''));
    if (!entry) return;
    entry.finished = true;
    entry.failed = failed;
  }

  private async waitForScript(
    tabId: BrowserTabId,
    expression: string,
    timeoutMs: number,
    signal?: AbortSignal,
    frameId?: string
  ): Promise<boolean> {
    const deadline = this.clock.now() + timeoutMs;
    while (this.clock.now() <= deadline) {
      assertActive(signal);
      try {
        if (await this.evaluate(tabId, expression, { frameId, signal })) return true;
      } catch {
        // Navigation can temporarily destroy the execution context; retry until deadline.
      }
      await new Promise<void>((resolve) => this.clock.setTimeout(resolve, 250));
    }
    return false;
  }

  private groupRef(sessionId: string, binding: SessionBinding): TabGroupRef {
    return {
      sessionId,
      tabId: binding.tabId,
      ...(binding.groupId === undefined ? {} : { groupId: binding.groupId }),
      ownedTabs: [...binding.ownedTabs],
    };
  }
}

interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  childIds?: string[];
  backendDOMNodeId?: number;
  role?: { value?: unknown };
  name?: { value?: unknown };
  value?: { value?: unknown };
}

interface FrameTreeResponse {
  frameTree: FrameTreeNode;
}

interface FrameTreeNode {
  frame: {
    id: string;
    parentId?: string;
    url?: string;
    name?: string;
    securityOrigin?: string;
  };
  childFrames?: FrameTreeNode[];
}

function defaultChromeApis(): {
  tabs: ChromeTabsApi;
  debugger: ChromeDebuggerApi;
  tabGroups?: ChromeTabGroupsApi;
} {
  const runtime = globalThis as typeof globalThis & {
    chrome?: {
      tabs?: ChromeTabsApi;
      debugger?: ChromeDebuggerApi;
      tabGroups?: ChromeTabGroupsApi;
    };
  };
  if (!runtime.chrome?.tabs || !runtime.chrome.debugger) {
    throw new AgentError(
      'CHROME_BROWSER_UNAVAILABLE',
      'Chrome tabs/debugger APIs are unavailable; inject APIs for headless tests'
    );
  }
  return {
    tabs: runtime.chrome.tabs,
    debugger: runtime.chrome.debugger,
    tabGroups: runtime.chrome.tabGroups,
  };
}

function toDescriptor(tab: chrome.tabs.Tab): TabDescriptor {
  const url = inspectableUrl(tab);
  return {
    id: String(tab.id),
    ...(tab.title ? { title: tab.title } : {}),
    ...(url ? { url } : {}),
    active: Boolean(tab.active),
    ...(tab.windowId === undefined ? {} : { windowId: tab.windowId }),
    ...(tab.groupId === undefined || tab.groupId === -1
      ? {}
      : { groupId: tab.groupId }),
  };
}

function tabGroupTitle(title: string | undefined): string {
  const compact = (title ?? '').replace(/\s+/g, ' ').trim();
  return compact ? `tinyai · ${compact.slice(0, 28)}` : 'tinyai';
}

function isInspectable(url: unknown): boolean {
  return /^(https?|file):/.test(String(url ?? '')) || url === 'about:blank';
}

function inspectableUrl(tab: chrome.tabs.Tab): string {
  const url = String(tab.url || tab.pendingUrl || '');
  return isNativeNewTab(url) ? 'about:blank' : url;
}

function isNativeNewTab(url: string): boolean {
  return /^(?:chrome|chrome-search):\/\/(?:newtab(?:\/|$)|new-tab-page(?:\/|$)|local-ntp(?:\/|$))/i.test(
    url
  );
}

function safeUrl(url: string): string {
  const value = url.trim();
  if (!value) return 'about:blank';
  if (/^file:/i.test(value)) {
    throw new AgentError(
      'BROWSER_FILE_URL_FORBIDDEN',
      'file:// cannot resolve a workspace resource in Chrome. Use open_workspace_file for workspace-relative paths.'
    );
  }
  return /^(https?:|about:blank)/.test(value) ? value : `https://${value}`;
}

function axValue(node: AxNode | undefined, key: 'role' | 'name' | 'value'): string {
  return String(node?.[key]?.value ?? '');
}

function interactiveSubtrees(nodes: AxNode[]): Set<string> {
  const byId = new Map(nodes.map((node) => [String(node.nodeId), node]));
  const memo = new Map<string, boolean>();
  const visit = (id: string, seen: Set<string>): boolean => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return false;
    const node = byId.get(id);
    if (!node) return false;
    const nextSeen = new Set(seen).add(id);
    const result =
      INTERACTIVE_ROLES.has(axValue(node, 'role')) ||
      (node.childIds ?? []).some((child) => visit(String(child), nextSeen));
    memo.set(id, result);
    return result;
  };
  return new Set([...byId.keys()].filter((id) => visit(id, new Set())));
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new AgentError('TASK_CANCELLED', 'Browser operation was cancelled');
}

function flattenFrames(root: FrameTreeNode): FrameDescriptor[] {
  const frames: FrameDescriptor[] = [];
  const visit = (node: FrameTreeNode, parentFrameId?: string): void => {
    frames.push({
      frameId: node.frame.id,
      ...(parentFrameId ? { parentFrameId } : {}),
      ...(node.frame.url ? { url: node.frame.url } : {}),
      ...(node.frame.name ? { name: node.frame.name } : {}),
      ...(node.frame.securityOrigin
        ? { securityOrigin: node.frame.securityOrigin }
        : {}),
      main: frames.length === 0,
    });
    for (const child of node.childFrames ?? []) visit(child, node.frame.id);
  };
  visit(root);
  return frames;
}

function throwOnException(result: any, action: string): void {
  if (result?.exceptionDetails) {
    throw new AgentError(
      'BROWSER_ACTION_FAILED',
      result.exceptionDetails.exception?.description ??
        result.exceptionDetails.text ??
        `${action} failed`
    );
  }
}

function decodeBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}
