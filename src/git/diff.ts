export function unifiedGitDiff(
  before: Uint8Array,
  after: Uint8Array,
  path: string
): { patch?: string; status: 'modified' | 'binary' } {
  const beforeText = decodeText(before);
  const afterText = decodeText(after);
  if (beforeText === undefined || afterText === undefined) {
    return { status: 'binary' };
  }
  return {
    patch: buildPatch(beforeText, afterText, path),
    status: 'modified',
  };
}

function buildPatch(before: string, after: string, path: string): string {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  const lines = [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
  ];
  let oldIndex = 0;
  let newIndex = 0;
  for (const [commonOld, commonNew] of commonPairs(oldLines, newLines)) {
    while (oldIndex < commonOld) lines.push(`-${oldLines[oldIndex++]}`);
    while (newIndex < commonNew) lines.push(`+${newLines[newIndex++]}`);
    lines.push(` ${oldLines[oldIndex]}`);
    oldIndex += 1;
    newIndex += 1;
  }
  while (oldIndex < oldLines.length) lines.push(`-${oldLines[oldIndex++]}`);
  while (newIndex < newLines.length) lines.push(`+${newLines[newIndex++]}`);
  return `${lines.join('\n')}\n`;
}

function commonPairs(
  left: string[],
  right: string[]
): Array<[number, number]> {
  const dp = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0)
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      dp[leftIndex][rightIndex] =
        left[leftIndex] === right[rightIndex]
          ? dp[leftIndex + 1][rightIndex + 1] + 1
          : Math.max(
              dp[leftIndex + 1][rightIndex],
              dp[leftIndex][rightIndex + 1]
            );
    }
  }
  const result: Array<[number, number]> = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex] === right[rightIndex]) {
      result.push([leftIndex, rightIndex]);
      leftIndex += 1;
      rightIndex += 1;
    } else if (
      dp[leftIndex + 1][rightIndex] >=
      dp[leftIndex][rightIndex + 1]
    ) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return result;
}

function splitLines(value: string): string[] {
  if (!value) return [];
  const lines = value.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function decodeText(value: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(value);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}
