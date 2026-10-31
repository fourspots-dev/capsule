export function buildFrameUpdate(
  previous: readonly string[],
  next: readonly string[],
  force = false
): string {
  const changed =
    force ||
    previous.length !== next.length ||
    previous.some((line, index) => line !== next[index]);
  if (!changed) return '';
  let output = '';
  for (let index = 0; index < next.length; index += 1) {
    if (!force && previous[index] === next[index]) continue;
    output += `\x1b[${index + 1};1H\x1b[2K${next[index]}`;
  }
  return output;
}
