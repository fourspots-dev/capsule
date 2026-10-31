import { describe, expect, it } from 'vitest';
import {
  mapKey,
  ViewStateStore,
  type ViewStateStorage,
} from '../../src/tui';

class Storage implements ViewStateStorage {
  values = new Map<string, unknown>();
  async get(key: string): Promise<unknown> {
    return this.values.get(key);
  }
  async set(key: string, value: unknown): Promise<void> {
    this.values.set(key, structuredClone(value));
  }
}

describe('TUI view state', () => {
  it('persists per-session drafts, attachments, selection and unread positions', async () => {
    const storage = new Storage();
    const first = new ViewStateStore(storage, 'tui:state');
    await first.update('A', {
      draftText: 'draft A',
      attachments: [{ id: 'a1', name: 'a.txt', mimeType: 'text/plain' }],
      scrollAnchor: 'row_10',
      expandedItemIds: ['tool_1'],
      lastSeenEventSeq: 8,
      boardFilter: 'attention',
    });
    await first.update('B', {
      draftText: 'draft B',
      selectionId: 'child_2',
    });
    await first.setActive('A');
    await first.flush();

    const reopened = new ViewStateStore(storage, 'tui:state');
    await reopened.initialize();
    expect(reopened.active).toBe('A');
    expect(await reopened.get('A')).toMatchObject({
      draftText: 'draft A',
      attachments: [{ name: 'a.txt' }],
      scrollAnchor: 'row_10',
      expandedItemIds: ['tool_1'],
      lastSeenEventSeq: 8,
      boardFilter: 'attention',
    });
    expect(await reopened.get('B')).toMatchObject({
      draftText: 'draft B',
      selectionId: 'child_2',
    });
  });
});

describe('TUI keymap', () => {
  it('gives conversation and overlay modes unambiguous actions', () => {
    const conversation = {
      route: { kind: 'conversation' as const },
      focus: 'composer' as const,
      composerEmpty: true,
    };
    expect(mapKey('\r', conversation)).toEqual({ type: 'send' });
    expect(mapKey('\n', conversation)).toEqual({ type: 'newline' });
    expect(mapKey('\x03', conversation)).toEqual({ type: 'stop' });
    expect(mapKey('\x0b', conversation)).toEqual({ type: 'sessions' });
    expect(mapKey('?', conversation)).toEqual({ type: 'help' });
    expect(
      mapKey('\r', {
        route: { kind: 'sessions', query: '' },
        focus: 'overlay',
        composerEmpty: true,
      })
    ).toEqual({ type: 'activate' });
    expect(mapKey('\x1b', conversation)).toEqual({ type: 'back' });
    expect(
      mapKey('?', { ...conversation, composerEmpty: false })
    ).toEqual({ type: 'text', text: '?' });
  });
});
