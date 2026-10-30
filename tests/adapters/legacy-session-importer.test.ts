import { describe, expect, it } from 'vitest';
import { importLegacySessions } from '../../src/adapters/legacy-session-importer';
import { InMemorySessionStore } from '../../src/core';

describe('legacy session importer', () => {
  it('converts legacy messages/timeline into a cold-hydratable kernel snapshot', async () => {
    const store = new InMemorySessionStore();
    const imported = await importLegacySessions(
      {
        active: 'old',
        sessions: [
          {
            id: 'old',
            title: 'Old task',
            updated: 10,
            messages: [
              { role: 'system', content: 'system' },
              { role: 'user', content: 'read page' },
              {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { id: 'call_1', function: { name: 'read_page', arguments: '{}' } },
                ],
              },
              { role: 'tool', tool_call_id: 'call_1', content: 'page body' },
              { role: 'assistant', content: 'done' },
            ],
            timeline: [
              { id: 'u', kind: 'user', text: 'read page' },
              { id: 'a', kind: 'assistant', text: 'done' },
              {
                id: 't',
                kind: 'tool',
                name: 'read_page',
                callId: 'call_1',
                state: 'done',
                result: 'page body',
              },
            ],
          },
        ],
      },
      store,
      20
    );
    expect(imported).toBe(1);
    const snapshot = await store.load('legacy_old');
    expect(snapshot).toMatchObject({
      sessionId: 'legacy_old',
      taskStatus: 'completed',
      activeLeafId: 'legacy_entry_5',
    });
    expect(snapshot?.messages).toEqual(
      expect.arrayContaining([
        { role: 'user', content: 'read page' },
        { role: 'tool', callId: 'call_1', name: 'tool', content: 'page body' },
      ])
    );
    expect(snapshot?.rows.map((row) => row.kind)).toEqual(['user', 'assistant', 'tool']);
    expect(snapshot?.ledger[0].status).toBe('promoted');
  });

  it('does not overwrite an already imported session', async () => {
    const store = new InMemorySessionStore();
    const raw = {
      sessions: [
        {
          id: 'same',
          messages: [{ role: 'user', content: 'first' }],
          timeline: [{ kind: 'user', text: 'first' }],
        },
      ],
    };
    expect(await importLegacySessions(raw, store, 1)).toBe(1);
    expect(await importLegacySessions(raw, store, 2)).toBe(0);
  });
});
