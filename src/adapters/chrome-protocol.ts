import type { RuntimeRequest } from '../runtime/protocol';

export type ChromeExtensionRequest =
  | { type: 'list_tabs'; requestId?: string }
  | {
      type: 'select_tab';
      sessionId: string;
      tabId: string;
      requestId?: string;
    }
  | {
      type: 'resolve_tab_session';
      windowId: number;
      tabId: string;
      groupId?: number;
      requestId?: string;
    }
  | {
      type: 'create_tab_session';
      windowId: number;
      tabId: string;
      groupId?: number;
      requestId?: string;
    }
  | {
      type: 'bind_tab_session';
      windowId: number;
      tabId: string;
      groupId?: number;
      sessionId: string;
      requestId?: string;
    }
  | {
      type: 'forget_tab_session';
      windowId: number;
      tabId: string;
      groupId?: number;
      requestId?: string;
    };

export type ChromeRuntimeRequest = RuntimeRequest | ChromeExtensionRequest;
