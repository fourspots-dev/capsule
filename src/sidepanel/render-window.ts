import type { ProductProjection } from '../core/types';

export const MAX_RENDERED_ROWS = 500;
export const MAX_RENDERED_TEXT = 100_000;
export const STREAM_RENDER_INTERVAL_MS = 50;

export function selectRenderWindow(
  rows: ProductProjection['rows']
): {
  rows: ProductProjection['rows'];
  hiddenCount: number;
} {
  if (rows.length <= MAX_RENDERED_ROWS) {
    return { rows, hiddenCount: 0 };
  }
  return {
    rows: rows.slice(-MAX_RENDERED_ROWS),
    hiddenCount: rows.length - MAX_RENDERED_ROWS,
  };
}

export function excerptText(value: string): string {
  return value.length > MAX_RENDERED_TEXT
    ? `${value.slice(0, MAX_RENDERED_TEXT)}\n\n…(display truncated; export the Capsule or execution log for the full content)`
    : value;
}
