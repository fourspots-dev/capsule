import {
  plainStyledLine,
  styledLine,
  styledLineWidth,
  styleSpan,
  stripTerminalControls,
  type StyledLine,
  type StyledSpan,
  type TextStyle,
} from './styled';

export function wrapStyledLine(
  line: StyledLine,
  width: number,
  preserveTrailingSpaces = false
): StyledLine[] {
  const maxWidth = Math.max(1, width);
  if (!line.spans.length || styledLineWidth(line) === 0) {
    return [plainStyledLine('')];
  }
  const result: StyledLine[] = [];
  let current: StyledSpan[] = [];
  let currentWidth = 0;
  for (const span of line.spans) {
    for (const char of span.text) {
      const charWidth = charDisplayWidth(char);
      if (currentWidth > 0 && currentWidth + charWidth > maxWidth) {
        result.push({
          spans: preserveTrailingSpaces
            ? current
            : trimTrailingSpaces(current),
        });
        current = [];
        currentWidth = 0;
      }
      current.push({ text: char, style: span.style });
      currentWidth += charWidth;
    }
  }
  if (current.length) {
    result.push({
      spans: preserveTrailingSpaces ? current : trimTrailingSpaces(current),
    });
  }
  return result.length ? result : [plainStyledLine('')];
}

export function indentStyledLine(
  line: StyledLine,
  prefix: string,
  style: TextStyle = {}
): StyledLine {
  return styledLine(styleSpan(prefix, style), ...line.spans);
}

export function renderMarkdown(value: string, width: number): StyledLine[] {
  const lines = stripTerminalControls(value).replace(/\r\n?/g, '\n').split('\n');
  const result: StyledLine[] = [];
  let fenced = false;
  let language = '';
  for (const raw of lines) {
    const fence = /^\s*```([A-Za-z0-9_+-]*)\s*$/.exec(raw);
    if (fence) {
      fenced = !fenced;
      language = fenced ? fence[1].toLowerCase() : '';
      const label = fenced && language ? `  ${language}` : fenced ? '  code' : '  end';
      result.push(plainStyledLine(label, { fg: 'muted', dim: true }));
      continue;
    }
    if (fenced) {
      result.push(...wrapStyledLine(highlightCodeLine(raw, language), Math.max(1, width)));
      continue;
    }
    if (!raw.trim()) {
      result.push(plainStyledLine(''));
      continue;
    }
    const heading = /^(#{1,6})\s+(.+)$/.exec(raw);
    if (heading) {
      result.push(
        ...wrapStyledLine(
          plainStyledLine(heading[2], { fg: 'accent', bold: true }),
          Math.max(1, width)
        )
      );
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(raw);
    if (quote) {
      const prefixWidth = 2;
      const body = inlineSpans(quote[1], { fg: 'muted', italic: true });
      for (const line of wrapStyledLine(body, Math.max(1, width - prefixWidth))) {
        result.push(indentStyledLine(line, '│ ', { fg: 'border' }));
      }
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.+)$/.exec(raw);
    if (bullet) {
      const prefix = `${bullet[1]}• `;
      const prefixWidth = displayWidthLocal(prefix);
      for (const line of wrapStyledLine(
        inlineSpans(bullet[2]),
        Math.max(1, width - prefixWidth)
      )) {
        result.push(indentStyledLine(line, prefix, { fg: 'accent' }));
      }
      continue;
    }
    const numbered = /^(\s*)(\d+[.)])\s+(.+)$/.exec(raw);
    if (numbered) {
      const prefix = `${numbered[1]}${numbered[2]} `;
      const prefixWidth = displayWidthLocal(prefix);
      for (const line of wrapStyledLine(
        inlineSpans(numbered[3]),
        Math.max(1, width - prefixWidth)
      )) {
        result.push(indentStyledLine(line, prefix, { fg: 'accent', bold: true }));
      }
      continue;
    }
    if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(raw)) {
      result.push(plainStyledLine('─'.repeat(Math.max(1, width)), { fg: 'border' }));
      continue;
    }
    if (/^\s*(?:@@|\+\+\+|---)/.test(raw) || /^\s*[+-]/.test(raw)) {
      result.push(
        ...wrapStyledLine(renderDiffLine(raw), Math.max(1, width))
      );
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(raw)) {
      result.push(
        ...wrapStyledLine(
          plainStyledLine(raw.trim(), { fg: 'file' }),
          Math.max(1, width)
        )
      );
      continue;
    }
    result.push(...wrapStyledLine(inlineSpans(raw), Math.max(1, width)));
  }
  return result;
}

export function renderDiffLine(value: string): StyledLine {
  const sanitized = stripTerminalControls(value).replace(/\r\n?/g, '\n');
  if (sanitized.startsWith('+') && !sanitized.startsWith('+++')) {
    return plainStyledLine(sanitized, { fg: 'added' });
  }
  if (sanitized.startsWith('-') && !sanitized.startsWith('---')) {
    return plainStyledLine(sanitized, { fg: 'removed' });
  }
  if (sanitized.startsWith('@@')) {
    return plainStyledLine(sanitized, { fg: 'accent', bold: true });
  }
  if (sanitized.startsWith('+++') || sanitized.startsWith('---')) {
    return plainStyledLine(sanitized, { fg: 'file', bold: true });
  }
  return plainStyledLine(sanitized, { fg: 'muted' });
}

export function renderPlainStructured(
  value: string,
  width: number,
  style: TextStyle = { fg: 'text' }
): StyledLine[] {
  const lines = stripTerminalControls(value).replace(/\r\n?/g, '\n').split('\n');
  return lines.flatMap((line) =>
    wrapStyledLine(plainStyledLine(line, style), Math.max(1, width))
  );
}

export function inlineSpans(
  value: string,
  base: TextStyle = { fg: 'text' }
): StyledLine {
  const spans: StyledSpan[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|_[^_]+_|\*[^*]+\*)/g;
  let cursor = 0;
  for (const match of value.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) spans.push(styleSpan(value.slice(cursor, index), base));
    const token = match[0];
    if (token.startsWith('`')) {
      spans.push(
        styleSpan(token.slice(1, -1), { ...base, fg: 'tool', bold: true })
      );
    } else if (token.startsWith('**') || token.startsWith('__')) {
      spans.push(styleSpan(token.slice(2, -2), { ...base, bold: true }));
    } else {
      spans.push(styleSpan(token.slice(1, -1), { ...base, italic: true }));
    }
    cursor = index + token.length;
  }
  if (cursor < value.length) spans.push(styleSpan(value.slice(cursor), base));
  return { spans };
}

function highlightCodeLine(value: string, language: string): StyledLine {
  if (outputDiff(value)) return renderDiffLine(value);
  const text = stripTerminalControls(value);
  if (!text) return plainStyledLine('');
  const keywordPattern =
    /('[^']*'|"[^"]*"|`[^`]*`|\/\/.*$|#.*$|\b(?:const|let|var|function|class|return|if|else|for|of|in|new|async|await|export|import|from|throw|try|catch|finally|switch|case|break|continue|interface|type|extends|implements|true|false|null|undefined)\b)/g;
  const spans: StyledSpan[] = [];
  let cursor = 0;
  for (const match of text.matchAll(keywordPattern)) {
    const index = match.index ?? 0;
    if (index > cursor) {
      spans.push(styleSpan(text.slice(cursor, index), { fg: 'tool' }));
    }
    const token = match[0];
    const style: TextStyle =
      token.startsWith('//') || token.startsWith('#')
        ? { fg: 'muted', italic: true }
        : token.startsWith("'") ||
            token.startsWith('"') ||
            token.startsWith('`')
          ? { fg: 'success' }
          : language === 'json' && /^(true|false|null)$/.test(token)
            ? { fg: 'warning', bold: true }
            : { fg: 'accent', bold: true };
    spans.push(styleSpan(token, style));
    cursor = index + token.length;
  }
  if (cursor < text.length) spans.push(styleSpan(text.slice(cursor), { fg: 'tool' }));
  return { spans: spans.length ? spans : [styleSpan(text, { fg: 'tool' })] };
}

function outputDiff(value: string): boolean {
  return (
    (value.startsWith('+') && !value.startsWith('+++')) ||
    (value.startsWith('-') && !value.startsWith('---')) ||
    value.startsWith('@@')
  );
}

function trimTrailingSpaces(spans: StyledSpan[]): StyledSpan[] {
  const result = spans.map((span) => ({ ...span, style: { ...span.style } }));
  while (result.length && !result.at(-1)!.text.trimEnd()) {
    result.pop();
  }
  if (result.length) {
    const last = result.at(-1)!;
    last.text = last.text.trimEnd();
  }
  return result.filter((span) => span.text.length > 0);
}

function charDisplayWidth(char: string): number {
  return displayWidthLocal(char);
}

function displayWidthLocal(value: string): number {
  let width = 0;
  for (const char of value) {
    if (/[\u0300-\u036f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/u.test(char)) continue;
    width +=
      /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u.test(
        char
      )
        ? 2
        : 1;
  }
  return width;
}
