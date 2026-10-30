export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function md(source: string): string {
  const codeBlocks: string[] = [];
  const escaped = escapeHtml(source).replace(
    /```([\w+-]*)\n([\s\S]*?)```/g,
    (_match, language: string, code: string) => {
      const index = codeBlocks.length;
      codeBlocks.push(
        `<div class="wb-rt-codewrap"><pre class="wb-rt-pre"><code class="language-${escapeHtml(language)}">${code.replace(/\n$/, '')}</code></pre><button type="button" class="wb-rt-copy" data-action="copy-code">Copy</button></div>`
      );
      return `\u0000CODE${index}\u0000`;
    }
  );
  let html = renderBlocks(escaped.split('\n')).join('');
  for (const [index, block] of codeBlocks.entries()) {
    html = html.replace(`\u0000CODE${index}\u0000`, block);
  }
  return html;
}

function inline(source: string): string {
  return source
    .replace(/`([^`]+)`/g, '<code class="wb-rt-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(
      /\[([^\]]+)\]\(((?:https?:|#|\/)[^)\s]+)\)/g,
      '<a class="wb-rt-a" href="$2" target="_blank" rel="noreferrer">$1</a>'
    );
}

function renderBlocks(lines: string[]): string[] {
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (/^\u0000CODE\d+\u0000$/.test(line.trim())) {
      output.push(line.trim());
      index += 1;
      continue;
    }
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+/);
    if (heading) {
      const level = heading[1].length;
      output.push(
        `<h${level + 1} class="wb-rt-h${level}">${inline(line.replace(/^#{1,3}\s+/, ''))}</h${level + 1}>`
      );
      index += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*[-*]\s+/, ''))}</li>`);
        index += 1;
      }
      output.push(`<ul class="wb-rt-ul">${items.join('')}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${inline(lines[index].replace(/^\s*\d+\.\s+/, ''))}</li>`);
        index += 1;
      }
      output.push(`<ol class="wb-rt-ol">${items.join('')}</ol>`);
      continue;
    }
    if (line.trim().startsWith('|')) {
      const rows: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith('|')) {
        rows.push(lines[index]);
        index += 1;
      }
      output.push(table(rows) ?? `<p class="wb-rt-p">${inline(rows.join(' '))}</p>`);
      continue;
    }
    if (line.trim().startsWith('&gt;')) {
      output.push(
        `<blockquote class="wb-rt-blockquote">${inline(line.replace(/^\s*&gt;\s?/, ''))}</blockquote>`
      );
      index += 1;
      continue;
    }
    const paragraph: string[] = [];
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^#{1,3}\s+/.test(lines[index]) &&
      !/^\s*[-*]\s+/.test(lines[index]) &&
      !/^\s*\d+\.\s+/.test(lines[index]) &&
      !lines[index].trim().startsWith('|') &&
      !/^\u0000CODE\d+\u0000$/.test(lines[index].trim())
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p class="wb-rt-p">${paragraph.map(inline).join('<br>')}</p>`);
  }
  return output;
}

function table(rows: string[]): string | null {
  if (rows.length < 2 || !/^\s*\|?[\s:|-]+\|?\s*$/.test(rows[1])) return null;
  const cells = (row: string) =>
    row
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim());
  const head = cells(rows[0]);
  const body = rows.slice(2).map(cells);
  return (
    '<div class="wb-rt-tablewrap"><table class="wb-rt-table"><thead><tr>' +
    head.map((cell) => `<th class="wb-rt-th">${inline(cell)}</th>`).join('') +
    '</tr></thead><tbody>' +
    body
      .map((row) => `<tr>${row.map((cell) => `<td class="wb-rt-td">${inline(cell)}</td>`).join('')}</tr>`)
      .join('') +
    '</tbody></table></div>'
  );
}
