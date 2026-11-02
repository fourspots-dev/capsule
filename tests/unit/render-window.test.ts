import { describe, expect, it } from 'vitest';
import {
  MAX_RENDERED_ROWS,
  MAX_RENDERED_TEXT,
  excerptText,
  selectRenderWindow,
} from '../../src/sidepanel/render-window';

describe('REQ-PERF-001 Side Panel render window', () => {
  it('keeps only a bounded recent row window', () => {
    const rows = Array.from({ length: MAX_RENDERED_ROWS + 25 }, (_, index) => ({
      id: `row_${index}`,
      entityId: `entity_${index}`,
      productTurnId: 'task',
      kind: 'assistant' as const,
      text: String(index),
      status: 'completed' as const,
    }));
    const selected = selectRenderWindow(rows);
    expect(selected.rows).toHaveLength(MAX_RENDERED_ROWS);
    expect(selected.rows[0].id).toBe('row_25');
    expect(selected.hiddenCount).toBe(25);
  });

  it('bounds large visible message text', () => {
    const text = 'x'.repeat(MAX_RENDERED_TEXT + 1);
    expect(excerptText(text)).toContain('display truncated');
    expect(excerptText(text).length).toBeLessThan(MAX_RENDERED_TEXT + 150);
  });
});
