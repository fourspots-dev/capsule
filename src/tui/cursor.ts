interface GraphemeSegmenter {
  segment(value: string): Iterable<{ index: number; segment: string }>;
}

type GraphemeSegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: 'grapheme' }
) => GraphemeSegmenter;

const Segmenter = (
  Intl as unknown as { Segmenter?: GraphemeSegmenterConstructor }
).Segmenter;

export function clampCursor(value: string, offset: number): number {
  if (!Number.isFinite(offset)) return value.length;
  return Math.max(0, Math.min(value.length, Math.trunc(offset)));
}

export function moveCursor(
  value: string,
  offset: number,
  direction: 'left' | 'right' | 'home' | 'end'
): number {
  if (direction === 'home') return 0;
  if (direction === 'end') return value.length;
  const current = clampCursor(value, offset);
  const boundaries = graphemeBoundaries(value);
  if (direction === 'left') {
    const prior = boundaries.filter((boundary) => boundary < current);
    return prior.at(-1) ?? 0;
  }
  return boundaries.find((boundary) => boundary > current) ?? value.length;
}

export function insertAtCursor(
  value: string,
  offset: number,
  insertion: string
): { value: string; cursor: number } {
  const current = clampCursor(value, offset);
  return {
    value: `${value.slice(0, current)}${insertion}${value.slice(current)}`,
    cursor: current + insertion.length,
  };
}

export function deleteBackward(
  value: string,
  offset: number
): { value: string; cursor: number } {
  const current = clampCursor(value, offset);
  if (current === 0) return { value, cursor: 0 };
  const previous = moveCursor(value, current, 'left');
  return {
    value: `${value.slice(0, previous)}${value.slice(current)}`,
    cursor: previous,
  };
}

export function deleteForward(
  value: string,
  offset: number
): { value: string; cursor: number } {
  const current = clampCursor(value, offset);
  if (current >= value.length) return { value, cursor: value.length };
  const next = moveCursor(value, current, 'right');
  return {
    value: `${value.slice(0, current)}${value.slice(next)}`,
    cursor: current,
  };
}

export function graphemeBoundaries(value: string): number[] {
  if (!value) return [0];
  const boundaries = new Set<number>([0, value.length]);
  if (Segmenter) {
    const segmenter = new Segmenter(undefined, { granularity: 'grapheme' });
    for (const segment of segmenter.segment(value)) {
      boundaries.add(segment.index);
      boundaries.add(segment.index + segment.segment.length);
    }
  } else {
    let index = 0;
    for (const char of value) {
      boundaries.add(index);
      index += char.length;
      boundaries.add(index);
    }
  }
  return [...boundaries].sort((left, right) => left - right);
}
