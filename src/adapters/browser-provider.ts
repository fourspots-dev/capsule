import type { JsonValue, StructuredError } from '../core/types';

export type BrowserTabId = string;

export interface TabDescriptor {
  id: BrowserTabId;
  title?: string;
  url?: string;
  active: boolean;
  windowId?: number;
  groupId?: number;
}

export interface PageInfo {
  tabId: BrowserTabId;
  title: string;
  url: string;
}

export interface FrameDescriptor {
  frameId: string;
  parentFrameId?: string;
  url?: string;
  name?: string;
  securityOrigin?: string;
  main: boolean;
}

export interface BrowserAxNode {
  ref?: string;
  role: string;
  name: string;
  value?: string;
  depth: number;
  interactive: boolean;
}

export interface PageSnapshot extends PageInfo {
  frameId?: string;
  nodes: BrowserAxNode[];
  text: string;
  truncated: boolean;
  capturedAt: number;
}

export interface SnapshotOptions {
  interactiveOnly?: boolean;
  maxChars?: number;
  frameId?: string;
  signal?: AbortSignal;
}

export interface ScreenshotResult {
  dataUrl: string;
  format: 'png' | 'jpeg';
}

export interface UploadFile {
  name: string;
  type: string;
  base64: string;
}

export interface NetworkEntry {
  requestId: string;
  url: string;
  method: string;
  status?: number;
  mimeType?: string;
  finished: boolean;
  failed: boolean;
}

export interface DialogStatus {
  open: boolean;
  message?: string;
  type?: string;
  defaultPrompt?: string;
}

export interface PdfResult {
  dataBase64: string;
  bytes: number;
}

export interface BrowserActionTarget {
  ref?: string;
  selector?: string;
  frameId?: string;
}

export interface TabGroupRef {
  sessionId: string;
  tabId: BrowserTabId;
  groupId?: number;
  ownedTabs: BrowserTabId[];
}

export interface CloseSessionReport {
  sessionId: string;
  detachedTabs: BrowserTabId[];
  closedTabs: BrowserTabId[];
  errors: StructuredError[];
}

export interface BrowserProvider {
  listTabs(): Promise<TabDescriptor[]>;
  getTab(tabId: BrowserTabId): Promise<TabDescriptor | null>;
  createTab(url?: string, options?: { active?: boolean }): Promise<TabDescriptor>;
  activateTab(tabId: BrowserTabId): Promise<void>;
  removeTab(tabId: BrowserTabId): Promise<void>;

  ensureTaskGroup(sessionId: string): Promise<TabGroupRef>;
  setWorkingTab(
    sessionId: string,
    tabId: BrowserTabId,
    options?: { activate?: boolean }
  ): Promise<void>;
  getWorkingTab(sessionId: string): Promise<BrowserTabId | null>;
  closeSessionTabs(sessionId: string): Promise<CloseSessionReport>;
  releaseSession?(sessionId: string): Promise<void>;
  addTabToSession?(
    sessionId: string,
    tabId: BrowserTabId,
    options?: { owned?: boolean }
  ): Promise<TabGroupRef>;
  listSessionTabs?(sessionId: string): Promise<TabDescriptor[]>;
  assertSessionTab?(sessionId: string, tabId: BrowserTabId): Promise<void>;
  listFrames?(tabId: BrowserTabId): Promise<FrameDescriptor[]>;

  navigate(tabId: BrowserTabId, url: string, signal?: AbortSignal): Promise<PageInfo>;
  snapshot(tabId: BrowserTabId, options?: SnapshotOptions): Promise<PageSnapshot>;
  readText(
    tabId: BrowserTabId,
    maxChars?: number,
    options?: { frameId?: string; signal?: AbortSignal }
  ): Promise<string>;
  evaluate<T = JsonValue>(
    tabId: BrowserTabId,
    expression: string,
    options?: { frameId?: string; signal?: AbortSignal }
  ): Promise<T>;
  click(tabId: BrowserTabId, target: BrowserActionTarget): Promise<void>;
  mouseClick(tabId: BrowserTabId, target: BrowserActionTarget): Promise<{ x: number; y: number }>;
  hover(tabId: BrowserTabId, target: BrowserActionTarget): Promise<{ x: number; y: number }>;
  fill(tabId: BrowserTabId, target: BrowserActionTarget, value: string): Promise<void>;
  selectOption(
    tabId: BrowserTabId,
    target: BrowserActionTarget,
    values?: string[]
  ): Promise<{ selected: string[]; options?: Array<{ value: string; label: string }> }>;
  drag(tabId: BrowserTabId, from: BrowserActionTarget, to: BrowserActionTarget): Promise<void>;
  scroll(
    tabId: BrowserTabId,
    options: {
      direction?: 'up' | 'down';
      to?: 'top' | 'bottom';
      selector?: string;
      text?: string;
      frameId?: string;
      signal?: AbortSignal;
    }
  ): Promise<{ scrollY: number; atTop: boolean; atBottom: boolean; found: boolean }>;
  upload(
    tabId: BrowserTabId,
    target: BrowserActionTarget | undefined,
    files: UploadFile[]
  ): Promise<number>;
  waitFor(
    tabId: BrowserTabId,
    condition: { text?: string; textGone?: string; selector?: string; timeoutMs?: number },
    signal?: AbortSignal,
    options?: { frameId?: string }
  ): Promise<boolean>;
  screenshot(tabId: BrowserTabId, format?: 'png' | 'jpeg'): Promise<ScreenshotResult>;
  printToPdf(
    tabId: BrowserTabId,
    options?: {
      paperFormat?: 'letter' | 'legal' | 'a4' | 'a3' | 'tabloid';
      landscape?: boolean;
      scale?: number;
      printBackground?: boolean;
    }
  ): Promise<PdfResult>;
  dialog(tabId: BrowserTabId, action: 'status' | 'accept' | 'dismiss', text?: string): Promise<DialogStatus | { accepted: boolean }>;
  network(
    tabId: BrowserTabId,
    command:
      | { cmd: 'start' | 'stop' | 'list'; filter?: string }
      | { cmd: 'detail'; requestId: string }
  ): Promise<{ entries?: NetworkEntry[]; body?: string } | string>;
  cdp<T = JsonValue>(
    tabId: BrowserTabId,
    method: string,
    params?: Record<string, JsonValue>,
    signal?: AbortSignal
  ): Promise<T>;
}
