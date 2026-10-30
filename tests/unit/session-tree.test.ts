import { describe, expect, it } from 'vitest';
import {
  SessionTree,
  appendMessage,
  type SessionMessagePayload,
} from '../../src/core/session-tree';

describe('SessionTree', () => {
  it('keeps raw entries immutable through defensive copies', () => {
    const tree = new SessionTree({ now: () => 10 });
    const message: SessionMessagePayload = {
      role: 'user',
      content: { text: 'original' },
    };
    const appended = appendMessage(tree, message, { id: 'entry_10' });
    (appended.payload as any).content.text = 'mutated';
    expect(tree.get('entry_10')).toMatchObject({
      parentId: null,
      payload: { role: 'user', content: { text: 'original' } },
    });
    expect(tree.append({
      type: 'custom',
      payload: 'next',
    }).id).toBe('entry_11');
  });

  it('supports branches and independent forks without changing the source', () => {
    const tree = new SessionTree();
    const root = appendMessage(tree, { role: 'user', content: 'root' });
    const assistant = appendMessage(tree, { role: 'assistant', content: 'answer' });
    const forked = tree.fork(root.id);
    appendMessage(forked, { role: 'user', content: 'alternate' });

    expect(tree.activeLeaf).toBe(assistant.id);
    expect(tree.activePath().map((entry) => entry.id)).toEqual([root.id, assistant.id]);
    expect(forked.activePath().map((entry) => entry.id)).toHaveLength(2);
    expect(forked.activePath().at(-1)?.payload).toEqual({
      role: 'user',
      content: 'alternate',
    });
    tree.branch(root.id);
    expect(tree.activePath().map((entry) => entry.id)).toEqual([root.id]);
  });

  it('applies context edits to projection while preserving raw payloads', () => {
    const tree = new SessionTree();
    const first = appendMessage(tree, { role: 'user', content: 'secret' });
    const second = appendMessage(tree, { role: 'assistant', content: 'visible' });
    tree.append({
      type: 'context_edit',
      payload: {
        hideEntryIds: [first.id],
        replacements: { [second.id]: 'redacted answer' },
      },
    });

    expect(tree.context().items).toEqual([
      {
        sourceEntryId: second.id,
        role: 'assistant',
        content: 'redacted answer',
      },
    ]);
    expect(tree.get(first.id)?.payload).toEqual({ role: 'user', content: 'secret' });
    expect(tree.get(second.id)?.payload).toEqual({
      role: 'assistant',
      content: 'visible',
    });
  });

  it('rejects missing parents and cyclic imported histories', () => {
    const tree = new SessionTree();
    expect(() =>
      tree.append({ type: 'custom', payload: 'x', parentId: 'missing' })
    ).toThrowError(/Parent entry not found/);

    const cyclic = new SessionTree({
      entries: [
        { id: 'a', parentId: 'b', type: 'custom', createdAt: 1, payload: 'a' },
        { id: 'b', parentId: 'a', type: 'custom', createdAt: 2, payload: 'b' },
      ],
      activeLeafId: 'a',
    });
    expect(() => cyclic.activePath()).toThrowError(/Cycle detected/);
  });
});
