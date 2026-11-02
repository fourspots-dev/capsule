import type {
  BrowserActionTarget,
  BrowserProvider,
  BrowserTabId,
  UploadFile,
} from './browser-provider';
import { AgentError } from '../core/errors';
import type { HandoffPort } from '../core/ports';
import type { JsonValue, ToolDefinition, ToolInvocation } from '../core/types';

type ObjectInput = Record<string, JsonValue>;

export interface BrowserToolDependencies {
  download?: (name: string, mime: string, base64: string) => Promise<void>;
  handoff?: HandoffPort;
  tabScoped?: boolean;
  workspaceTabs?: WorkspaceTabControl;
}

export interface WorkspaceTabControl {
  createTab(sessionId: string, url?: string): Promise<BrowserTabDescriptor>;
  switchTab(sessionId: string, tabId: string): Promise<void>;
  listTabs(sessionId: string): Promise<BrowserTabDescriptor[]>;
}

type BrowserTabDescriptor = {
  id: string;
  title?: string;
  url?: string;
  active: boolean;
  windowId?: number;
  groupId?: number;
};

export function createBrowserTools(
  browser: BrowserProvider,
  dependencies: BrowserToolDependencies = {}
): ToolDefinition[] {
  return [
    tool(
      'list_tabs',
      'List inspectable Chrome tabs with stable ids, URLs, titles and current-session marker.',
      objectSchema({}),
      'read',
      ['browser:read'],
      async (_input, invocation) => {
        if (dependencies.workspaceTabs) {
          return (await dependencies.workspaceTabs.listTabs(
            invocation.sessionId
          )) as JsonValue;
        }
        const [tabs, current] = await Promise.all([
          browser.listTabs(),
          browser.getWorkingTab(invocation.sessionId),
        ]);
        return tabs.map((tab) => ({ ...tab, current: tab.id === current })) as JsonValue;
      }
    ),
    tool(
      'list_frames',
      'List frames in the working tab, including frameId values usable by snapshot and frame-scoped tools.',
      objectSchema({}),
      'read',
      ['browser:read'],
      async (_input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        if (!browser.listFrames) {
          throw new AgentError('BROWSER_FRAMES_UNSUPPORTED', 'Frame inspection is unavailable');
        }
        return (await browser.listFrames(tabId)) as unknown as JsonValue;
      }
    ),
    tool(
      'switch_tab',
      'Make an existing tab the working tab for this session.',
      objectSchema({ tabId: { type: 'string' } }, ['tabId']),
      'write',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = requiredString(input, 'tabId');
        if (dependencies.workspaceTabs) {
          await dependencies.workspaceTabs.switchTab(invocation.sessionId, tabId);
          return { tabId };
        }
        if (dependencies.tabScoped) {
          throw new AgentError(
            'TAB_SCOPED_SESSION',
            'Tabs are isolated conversations and cannot share a working tab.'
          );
        }
        await browser.setWorkingTab(invocation.sessionId, tabId);
        return { tabId };
      }
    ),
    tool(
      'new_tab',
      'Open a new tab and make it the working tab.',
      objectSchema({ url: { type: 'string' } }),
      'write',
      ['browser:navigate'],
      async (input, invocation) => {
        if (dependencies.workspaceTabs) {
          const tab = await dependencies.workspaceTabs.createTab(
            invocation.sessionId,
            optionalString(input, 'url') ?? 'about:blank'
          );
          return tab as JsonValue;
        }
        if (dependencies.tabScoped) {
          throw new AgentError(
            'TAB_SCOPED_SESSION',
            'Tabs are isolated conversations; use the browser tabs UI to open another tab session.'
          );
        }
        const tab = await browser.createTab(optionalString(input, 'url') ?? 'about:blank');
        await browser.setWorkingTab(invocation.sessionId, tab.id);
        return tab as unknown as JsonValue;
      }
    ),
    tool(
      'navigate',
      'Navigate the working tab to a URL and wait for readiness.',
      objectSchema({ url: { type: 'string' } }, ['url']),
      'write',
      ['browser:navigate'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        return (await browser.navigate(
          tabId,
          requiredString(input, 'url'),
          invocation.signal
        )) as unknown as JsonValue;
      }
    ),
    tool(
      'snapshot',
      'Capture a compact accessibility snapshot with @eN refs for interactive elements.',
      objectSchema({
        interactive: { type: 'boolean' },
        frameId: { type: 'string' },
      }),
      'read',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        return (await browser.snapshot(tabId, {
          interactiveOnly: optionalBoolean(input, 'interactive') === true,
          frameId: optionalString(input, 'frameId'),
          signal: invocation.signal,
        })) as unknown as JsonValue;
      }
    ),
    tool(
      'find',
      'Find accessibility nodes by name substring and return clickable refs where available.',
      objectSchema({
        query: { type: 'string' },
        frameId: { type: 'string' },
      }, ['query']),
      'read',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const snapshot = await browser.snapshot(tabId, {
          signal: invocation.signal,
          frameId: optionalString(input, 'frameId'),
        });
        const query = requiredString(input, 'query').toLowerCase();
        return snapshot.nodes
          .filter((node) => node.name.toLowerCase().includes(query))
          .slice(0, 20) as unknown as JsonValue;
      }
    ),
    tool(
      'read_page',
      'Read visible text from the working tab.',
      objectSchema({ maxChars: { type: 'integer' }, frameId: { type: 'string' } }),
      'read',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const maxChars = optionalNumber(input, 'maxChars') ?? 30_000;
        return {
          tabId,
          text: await browser.readText(tabId, maxChars, {
            frameId: optionalString(input, 'frameId'),
            signal: invocation.signal,
          }),
        };
      }
    ),
    tool(
      'evaluate',
      'Evaluate JavaScript in the working tab. This is a high-risk capability.',
      objectSchema({
        code: { type: 'string' },
        frameId: { type: 'string' },
      }, ['code']),
      'dangerous',
      ['browser:script'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const output = await browser.evaluate(tabId, requiredString(input, 'code'), {
          frameId: optionalString(input, 'frameId'),
          signal: invocation.signal,
        });
        return output === undefined ? null : output;
      }
    ),
    tool(
      'click',
      'Click an element by @eN snapshot ref or CSS selector.',
      targetSchema(),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        await browser.click(tabId, targetFrom(input));
        return { clicked: true };
      }
    ),
    tool(
      'mouse_click',
      'Click an element center with real CDP mouse events.',
      targetSchema(),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        return browser.mouseClick(tabId, targetFrom(input));
      }
    ),
    tool(
      'hover',
      'Move the real mouse over an element to reveal hover content.',
      targetSchema(),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        return browser.hover(tabId, targetFrom(input));
      }
    ),
    tool(
      'fill',
      'Fill an input, textarea or contentEditable element by ref or selector.',
      {
        ...targetSchema(),
        properties: {
          ref: { type: 'string' },
          selector: { type: 'string' },
          frameId: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['value'],
      },
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        await browser.fill(tabId, targetFrom(input), requiredString(input, 'value'));
        return { filled: true };
      }
    ),
    tool(
      'type_text',
      'Insert text at the currently focused element.',
      objectSchema({ text: { type: 'string' } }, ['text']),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        await browser.cdp(
          tabId,
          'Input.insertText',
          { text: requiredString(input, 'text') },
          invocation.signal
        );
        return { typed: true };
      }
    ),
    tool(
      'select_option',
      'Select options in a native select control by value or visible label.',
      objectSchema({
        ref: { type: 'string' },
        selector: { type: 'string' },
        values: { type: 'array', items: { type: 'string' } },
      }),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const values = Array.isArray(input.values) ? input.values.map(String) : [];
        return (await browser.selectOption(tabId, targetFrom(input), values)) as unknown as JsonValue;
      }
    ),
    tool(
      'drag',
      'Drag one element to another using real mouse events.',
      objectSchema({
        from: { type: 'string' },
        to: { type: 'string' },
        frameId: { type: 'string' },
      }, ['from', 'to']),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const frameId = optionalString(input, 'frameId');
        await browser.drag(
          tabId,
          {
            selector: requiredString(input, 'from'),
            ...(frameId ? { frameId } : {}),
          },
          {
            selector: requiredString(input, 'to'),
            ...(frameId ? { frameId } : {}),
          }
        );
        return { dragged: true };
      }
    ),
    tool(
      'scroll',
      'Scroll the page by one viewport, to an edge, selector or text target.',
      objectSchema({
        direction: { type: 'string', enum: ['up', 'down'] },
        to: { type: 'string', enum: ['top', 'bottom'] },
        selector: { type: 'string' },
        text: { type: 'string' },
        frameId: { type: 'string' },
      }),
      'read',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const to = optionalString(input, 'to');
        const direction = optionalString(input, 'direction');
        return (await browser.scroll(tabId, {
          ...(to === 'top' || to === 'bottom' ? { to } : {}),
          ...(direction === 'up' || direction === 'down' ? { direction } : {}),
          ...(optionalString(input, 'selector')
            ? { selector: optionalString(input, 'selector')! }
            : {}),
          ...(optionalString(input, 'text') ? { text: optionalString(input, 'text')! } : {}),
          ...(optionalString(input, 'frameId') ? { frameId: optionalString(input, 'frameId')! } : {}),
          signal: invocation.signal,
        })) as unknown as JsonValue;
      }
    ),
    tool(
      'send_keys',
      'Dispatch a keyboard key such as Enter, Tab or Escape.',
      objectSchema({ keys: { type: 'string' } }, ['keys']),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const keys = requiredString(input, 'keys').split(/\s+/).filter(Boolean);
        for (const key of keys) await sendKey(browser, tabId, key, invocation.signal);
        return { sent: keys };
      }
    ),
    tool(
      'wait',
      'Wait for text, text disappearance or a selector in the working tab.',
      objectSchema({
        text: { type: 'string' },
        text_gone: { type: 'string' },
        selector: { type: 'string' },
        timeout_ms: { type: 'integer' },
        frameId: { type: 'string' },
      }),
      'read',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        return {
          met: await browser.waitFor(
            tabId,
            {
              text: optionalString(input, 'text'),
              textGone: optionalString(input, 'text_gone'),
              selector: optionalString(input, 'selector'),
              timeoutMs: optionalNumber(input, 'timeout_ms'),
            },
            invocation.signal,
            { frameId: optionalString(input, 'frameId') }
          ),
        };
      }
    ),
    tool(
      'screenshot',
      'Capture the working tab viewport as a PNG data URL.',
      objectSchema({ format: { type: 'string', enum: ['png', 'jpeg'] } }),
      'read',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const format = optionalString(input, 'format') === 'jpeg' ? 'jpeg' : 'png';
        return (await browser.screenshot(tabId, format)) as unknown as JsonValue;
      }
    ),
    tool(
      'upload',
      'Place base64 files into a page file input.',
      objectSchema({
        ref: { type: 'string' },
        selector: { type: 'string' },
        files: { type: 'array', items: { type: 'object' } },
      }, ['files']),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const files = requiredArray(input, 'files').map((entry) => {
          const file = isObject(entry);
          return {
            name: requiredString(file, 'name'),
            type: optionalString(file, 'type') ?? 'application/octet-stream',
            base64: requiredString(file, 'base64'),
          } satisfies UploadFile;
        });
        const target =
          optionalString(input, 'ref') || optionalString(input, 'selector')
            ? targetFrom(input)
            : undefined;
        return { uploaded: await browser.upload(tabId, target, files) };
      }
    ),
    tool(
      'save_as_pdf',
      'Render the current page as PDF and save it through the configured download port.',
      objectSchema({
        paper_format: { type: 'string', enum: ['letter', 'legal', 'a4', 'a3', 'tabloid'] },
        landscape: { type: 'boolean' },
        scale: { type: 'number' },
        print_background: { type: 'boolean' },
        file_name: { type: 'string' },
      }),
      'write',
      ['browser:read'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const result = await browser.printToPdf(tabId, {
          paperFormat: enumValue(input, 'paper_format', ['letter', 'legal', 'a4', 'a3', 'tabloid']),
          landscape: optionalBoolean(input, 'landscape'),
          scale: optionalNumber(input, 'scale'),
          printBackground: optionalBoolean(input, 'print_background'),
        });
        const name = `${(optionalString(input, 'file_name') ?? 'page').replace(/\.pdf$/i, '').replace(/[\\/:*?"<>|]+/g, '-')}.pdf`;
        if (dependencies.download) {
          await dependencies.download(name, 'application/pdf', result.dataBase64);
          return { saved: name, bytes: result.bytes } as unknown as JsonValue;
        }
        return {
          fileName: name,
          bytes: result.bytes,
          dataBase64: result.dataBase64,
        } as unknown as JsonValue;
      }
    ),
    tool(
      'dialog',
      'Inspect, accept or dismiss a blocking JavaScript dialog.',
      objectSchema({
        action: { type: 'string', enum: ['status', 'accept', 'dismiss'] },
        text: { type: 'string' },
      }, ['action']),
      'write',
      ['browser:interact'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const action = requiredString(input, 'action');
        if (action !== 'status' && action !== 'accept' && action !== 'dismiss') {
          throw new AgentError('TOOL_ARGUMENTS_INVALID', 'dialog.action is invalid');
        }
        return (await browser.dialog(tabId, action, optionalString(input, 'text'))) as unknown as JsonValue;
      }
    ),
    tool(
      'network',
      'Start, stop, list or read captured network requests.',
      objectSchema({
        cmd: { type: 'string', enum: ['start', 'stop', 'list', 'detail'] },
        filter: { type: 'string' },
        requestId: { type: 'string' },
      }, ['cmd']),
      'dangerous',
      ['browser:network'],
      async (input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        const cmd = requiredString(input, 'cmd');
        if (cmd === 'detail') {
          return (await browser.network(tabId, {
            cmd: 'detail',
            requestId: requiredString(input, 'requestId'),
          })) as unknown as JsonValue;
        }
        if (cmd !== 'start' && cmd !== 'stop' && cmd !== 'list') {
          throw new AgentError('TOOL_ARGUMENTS_INVALID', 'network.cmd is invalid');
        }
        return (await browser.network(tabId, {
          cmd,
          filter: optionalString(input, 'filter'),
        })) as unknown as JsonValue;
      }
    ),
    tool(
      'close_tab',
      'Close the working tab and clear the session binding.',
      objectSchema({}),
      'write',
      ['browser:interact'],
      async (_input, invocation) => {
        const tabId = await workingTab(browser, invocation.sessionId);
        await browser.removeTab(tabId);
        return { closed: tabId };
      }
    ),
    tool(
      'find_tab',
      'Find an inspectable tab by URL/domain and make it the working tab. Returns found=false when the current workspace has no match.',
      objectSchema({ url: { type: 'string' } }, ['url']),
      'write',
      ['browser:read'],
      async (input, invocation) => {
        const needle = requiredString(input, 'url')
          .toLowerCase()
          .replace(/^https?:\/\//, '')
          .replace(/\/+$/, '');
        const candidates = dependencies.workspaceTabs
          ? await dependencies.workspaceTabs.listTabs(invocation.sessionId)
          : await browser.listTabs();
        const tab = candidates.find((candidate) => {
          const value = String(candidate.url ?? '').toLowerCase();
          const domain = value.replace(/^https?:\/\//, '').split('/')[0];
          return value.includes(needle) || domain.includes(needle);
        });
        if (!tab) return { found: false, query: needle };
        if (dependencies.workspaceTabs) {
          await dependencies.workspaceTabs.switchTab(invocation.sessionId, tab.id);
        } else {
          await browser.setWorkingTab(invocation.sessionId, tab.id);
        }
        return tab as unknown as JsonValue;
      }
    ),
    tool(
      'close_session',
      'Close browser resources owned by this task session.',
      objectSchema({}),
      'write',
      ['browser:interact'],
      async (_input, invocation) => {
        const report = await browser.closeSessionTabs(invocation.sessionId);
        return report as unknown as JsonValue;
      }
    ),
    tool(
      'await_user_action',
      'Pause for a manual login, captcha or confirmation, then continue after explicit user action.',
      objectSchema({ reason: { type: 'string' } }, ['reason']),
      'read',
      ['browser:interact'],
      async (input, invocation) => {
        if (!dependencies.handoff) {
          throw new AgentError(
            'HANDOFF_UNAVAILABLE',
            'No user handoff channel is available'
          );
        }
        const result = await dependencies.handoff.requestHandoff(
          requiredString(input, 'reason'),
          {
            sessionId: invocation.sessionId,
            taskId: invocation.taskId,
            toolName: 'await_user_action',
          },
          invocation.signal
        );
        return {
          continued: result === 'continue',
          instruction:
            result === 'continue'
              ? 'Verify the page state before continuing.'
              : 'The user cancelled; explain why the action is required.',
        };
      }
    ),
  ];
}

function tool(
  name: string,
  description: string,
  parameters: Record<string, JsonValue>,
  risk: ToolDefinition['risk'],
  capabilities: string[],
  execute: (input: ObjectInput, invocation: ToolInvocation) => Promise<JsonValue>
): ToolDefinition {
  return {
    name,
    description,
    parameters,
    risk,
    capabilities,
    effect:
      name === 'network'
        ? 'network'
        : name === 'evaluate'
          ? 'execute'
          : risk === 'read'
            ? 'read'
            : 'write',
    executionMode: 'sequential',
    replay: risk === 'read' ? 'safe' : 'never',
    execute: async (input, invocation) =>
      execute(isObject(input), invocation),
  };
}

async function workingTab(browser: BrowserProvider, sessionId: string): Promise<BrowserTabId> {
  const current = await browser.getWorkingTab(sessionId);
  if (current) return current;
  return (await browser.ensureTaskGroup(sessionId)).tabId;
}

function isObject(value: JsonValue): ObjectInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', 'Tool input must be an object');
  }
  return value;
}

function requiredString(input: ObjectInput, key: string): string {
  const value = input[key];
  if (typeof value !== 'string' || !value.trim()) {
    throw new AgentError('TOOL_ARGUMENTS_INVALID', `${key} must be a non-empty string`);
  }
  return value;
}

function optionalString(input: ObjectInput, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function optionalNumber(input: ObjectInput, key: string): number | undefined {
  return typeof input[key] === 'number' ? input[key] : undefined;
}

function optionalBoolean(input: ObjectInput, key: string): boolean | undefined {
  return typeof input[key] === 'boolean' ? input[key] : undefined;
}

function requiredArray(input: ObjectInput, key: string): JsonValue[] {
  const value = input[key];
  if (!Array.isArray(value)) throw new AgentError('TOOL_ARGUMENTS_INVALID', `${key} must be an array`);
  return value;
}

function enumValue<T extends string>(
  input: ObjectInput,
  key: string,
  values: readonly T[]
): T | undefined {
  const value = input[key];
  return typeof value === 'string' && values.includes(value as T) ? (value as T) : undefined;
}

function targetFrom(input: ObjectInput): BrowserActionTarget {
  const ref = optionalString(input, 'ref');
  const selector = optionalString(input, 'selector');
  const frameId = optionalString(input, 'frameId');
  if (!ref && !selector) {
    throw new AgentError('BROWSER_TARGET_INVALID', 'A ref or selector is required');
  }
  return {
    ...(ref ? { ref } : {}),
    ...(selector ? { selector } : {}),
    ...(frameId ? { frameId } : {}),
  };
}

function targetSchema(): Record<string, JsonValue> {
  return objectSchema({
    ref: { type: 'string' },
    selector: { type: 'string' },
    frameId: { type: 'string' },
  });
}

function objectSchema(
  properties: Record<string, JsonValue>,
  required: string[] = []
): Record<string, JsonValue> {
  return { type: 'object', properties, ...(required.length ? { required } : {}) };
}

async function sendKey(
  browser: BrowserProvider,
  tabId: BrowserTabId,
  key: string,
  signal: AbortSignal
): Promise<void> {
  const known: Record<string, { code: string; vk: number; text?: string }> = {
    Enter: { code: 'Enter', vk: 13, text: '\r' },
    Tab: { code: 'Tab', vk: 9 },
    Escape: { code: 'Escape', vk: 27 },
    Backspace: { code: 'Backspace', vk: 8 },
    ArrowUp: { code: 'ArrowUp', vk: 38 },
    ArrowDown: { code: 'ArrowDown', vk: 40 },
  };
  const spec = known[key];
  if (!spec) throw new AgentError('BROWSER_KEY_UNSUPPORTED', `Unsupported key: ${key}`);
  await browser.cdp(
    tabId,
    'Input.dispatchKeyEvent',
    { type: 'keyDown', key, code: spec.code, windowsVirtualKeyCode: spec.vk, ...(spec.text ? { text: spec.text } : {}) },
    signal
  );
  await browser.cdp(
    tabId,
    'Input.dispatchKeyEvent',
    { type: 'keyUp', key, code: spec.code, windowsVirtualKeyCode: spec.vk },
    signal
  );
}
