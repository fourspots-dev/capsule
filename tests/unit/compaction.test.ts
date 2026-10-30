import { describe, expect, it } from 'vitest';
import {
  appendCompaction,
  compactionContext,
  needsCompaction,
  planCompaction,
  type ContextBudget,
} from '../../src/core/compaction';
import {
  SessionTree,
  appendMessage,
  type SessionMessagePayload,
} from '../../src/core/session-tree';

const budget: ContextBudget = {
  contextWindow: 100,
  reserveTokens: 10,
  keepRecentTokens: 20,
  maxOutputTokens: 20,
};
const tokens = () => 10;

function user(tree: SessionTree, text: string) {
  return appendMessage(tree, { role: 'user', content: text });
}

function assistant(tree: SessionTree, text: string) {
  return appendMessage(tree, { role: 'assistant', content: text });
}

describe('compaction', () => {
  it('appends a compaction entry and keeps a recent context span', () => {
    const tree = new SessionTree();
    user(tree, 'one');
    assistant(tree, 'two');
    const keptUser = user(tree, 'three');
    assistant(tree, 'four');
    const rawBefore = tree.rawEntries();

    expect(needsCompaction(tree, budget, tokens)).toBe(false);
    const plan = planCompaction(tree, budget, tokens);
    expect(plan).toMatchObject({
      firstKeptEntryId: keptUser.id,
      tokensBefore: 40,
      tokensAfter: 20,
    });

    const result = appendCompaction(tree, {
      summary: 'Summary of one and two',
      budget,
      estimateTokens: tokens,
      usage: { inputTokens: 100, outputTokens: 20 },
      details: { readFiles: ['src/a.ts'], modifiedFiles: ['src/b.ts'] },
    });
    expect(result.entry.type).toBe('compaction');
    expect(compactionContext(result.entry)).toMatchObject({
      summary: 'Summary of one and two',
      firstKeptEntryId: keptUser.id,
      tokensBefore: 40,
    });
    expect(tree.rawEntries().slice(0, rawBefore.length)).toEqual(rawBefore);
    expect(tree.context().items.map((item) => [item.role, item.content])).toEqual([
      ['compaction', 'Summary of one and two'],
      ['user', 'three'],
      ['assistant', 'four'],
    ]);
    expect(tree.context()).toMatchObject({
      readFiles: ['src/a.ts'],
      modifiedFiles: ['src/b.ts'],
    });
  });

  it('does not split a tool call from its tool results', () => {
    const tree = new SessionTree();
    user(tree, 'request');
    appendMessage(tree, {
      role: 'assistant',
      content: 'call',
      toolCallIds: ['call_1'],
    });
    appendMessage(tree, {
      role: 'tool',
      toolCallId: 'call_1',
      content: 'result',
    });
    assistant(tree, 'answer');
    user(tree, 'next request');

    const plan = planCompaction(tree, { ...budget, keepRecentTokens: 30 }, tokens);
    const path = tree.activePath();
    const keptIndex = path.findIndex((entry) => entry.id === plan.firstKeptEntryId);
    expect((path[keptIndex].payload as unknown as SessionMessagePayload).role).toBe('assistant');
    expect(plan.retainedEntryIds).toContain(path[1].id);
    expect(plan.retainedEntryIds).toContain(path[2].id);
  });

  it('accumulates repeated compactions while preserving every raw entry', () => {
    const tree = new SessionTree();
    user(tree, 'one');
    assistant(tree, 'two');
    user(tree, 'three');
    assistant(tree, 'four');
    appendCompaction(tree, {
      summary: 'first summary',
      budget,
      estimateTokens: tokens,
    });
    const afterFirstRawCount = tree.rawEntries().length;
    const nextUser = user(tree, 'five');
    const nextAssistant = assistant(tree, 'six');

    const second = appendCompaction(tree, {
      summary: 'second summary',
      budget,
      estimateTokens: tokens,
    });
    expect(tree.rawEntries()).toHaveLength(afterFirstRawCount + 3);
    expect(tree.context().latestCompactionEntryId).toBe(second.entry.id);
    expect(tree.context().items).toEqual([
      { sourceEntryId: second.entry.id, role: 'compaction', content: 'second summary' },
      { sourceEntryId: nextUser.id, role: 'user', content: 'five' },
      { sourceEntryId: nextAssistant.id, role: 'assistant', content: 'six' },
    ]);
    expect(tree.rawEntries().filter((entry) => entry.type === 'compaction')).toHaveLength(2);
  });

  it('fails explicitly when no safe cut point exists', () => {
    const tree = new SessionTree();
    appendMessage(tree, {
      role: 'tool',
      toolCallId: 'a',
      content: 'a',
    });
    appendMessage(tree, {
      role: 'tool',
      toolCallId: 'b',
      content: 'b',
    });
    expect(() => planCompaction(tree, { ...budget, keepRecentTokens: 10 }, tokens)).toThrowError(
      /No user\/assistant\/custom\/bash boundary/
    );
  });

  it('rejects invalid token budgets and empty summaries', () => {
    const tree = new SessionTree();
    user(tree, 'one');
    assistant(tree, 'two');
    expect(() =>
      planCompaction(tree, { ...budget, reserveTokens: 100 }, tokens)
    ).toThrowError(/reserveTokens must be lower/);
    expect(() =>
      appendCompaction(tree, { summary: ' ', budget, estimateTokens: tokens })
    ).toThrowError(/summary cannot be empty/);
  });
});
