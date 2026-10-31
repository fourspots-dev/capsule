import { displayWidth } from './text';

export type ThemeToken =
  | 'text'
  | 'muted'
  | 'accent'
  | 'reasoning'
  | 'tool'
  | 'success'
  | 'warning'
  | 'error'
  | 'added'
  | 'removed'
  | 'file'
  | 'border'
  | 'selection';

export type ColorDepth = 'truecolor' | 'ansi256' | 'ansi16' | 'none';
export type TuiTheme = 'dark' | 'light' | 'mono';

export interface TextStyle {
  fg?: ThemeToken;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export interface StyledSpan {
  text: string;
  style: TextStyle;
}

export interface StyledLine {
  spans: StyledSpan[];
}

export interface ThemeOptions {
  theme: TuiTheme;
  depth: ColorDepth;
}

type Rgb = readonly [number, number, number];
type Palette = Record<ThemeToken, Rgb>;

const darkPalette: Palette = {
  text: [230, 232, 239],
  muted: [140, 147, 165],
  accent: [122, 162, 247],
  reasoning: [187, 154, 247],
  tool: [125, 207, 255],
  success: [158, 206, 106],
  warning: [224, 175, 104],
  error: [247, 118, 142],
  added: [158, 206, 106],
  removed: [247, 118, 142],
  file: [224, 175, 104],
  border: [75, 82, 109],
  selection: [122, 162, 247],
};

const lightPalette: Palette = {
  text: [36, 37, 43],
  muted: [111, 113, 121],
  accent: [61, 90, 241],
  reasoning: [122, 61, 184],
  tool: [11, 114, 133],
  success: [39, 125, 50],
  warning: [176, 96, 0],
  error: [194, 46, 54],
  added: [33, 135, 57],
  removed: [194, 46, 54],
  file: [156, 101, 0],
  border: [181, 184, 194],
  selection: [61, 90, 241],
};

const ansi256Index: Record<ThemeToken, number> = {
  text: 252,
  muted: 245,
  accent: 69,
  reasoning: 141,
  tool: 81,
  success: 113,
  warning: 179,
  error: 204,
  added: 113,
  removed: 204,
  file: 179,
  border: 240,
  selection: 69,
};

const ansi16Code: Record<ThemeToken, number> = {
  text: 37,
  muted: 90,
  accent: 94,
  reasoning: 95,
  tool: 96,
  success: 92,
  warning: 93,
  error: 91,
  added: 92,
  removed: 91,
  file: 93,
  border: 90,
  selection: 94,
};

export function detectThemeOptions(
  env: NodeJS.ProcessEnv = process.env,
  interactive = Boolean(process.stdout?.isTTY)
): ThemeOptions {
  const selected = env.TINYAI_THEME?.toLowerCase();
  const theme: TuiTheme =
    selected === 'light' || selected === 'mono' ? selected : 'dark';
  if (theme === 'mono' || env.NO_COLOR !== undefined || !interactive || env.TERM === 'dumb') {
    return { theme, depth: 'none' };
  }
  if (/truecolor|24bit/i.test(env.COLORTERM ?? '')) {
    return { theme, depth: 'truecolor' };
  }
  if (/256color/i.test(env.TERM ?? '')) {
    return { theme, depth: 'ansi256' };
  }
  return { theme, depth: 'ansi16' };
}

export function styleSpan(text: string, style: TextStyle = {}): StyledSpan {
  return { text: sanitizeLineText(text), style };
}

export function styledLine(...spans: StyledSpan[]): StyledLine {
  return {
    spans: spans
      .filter((span) => span.text.length > 0)
      .map((span) => ({
        text: sanitizeLineText(span.text),
        style: { ...span.style },
      })),
  };
}

export function plainStyledLine(text: string, style: TextStyle = {}): StyledLine {
  return styledLine(styleSpan(text, style));
}

export function styledLineText(line: StyledLine): string {
  return line.spans.map((span) => span.text).join('');
}

export function styledLineWidth(line: StyledLine): number {
  return line.spans.reduce((total, span) => total + displayWidth(span.text), 0);
}

export function truncateStyledLine(line: StyledLine, width: number): StyledLine {
  if (width <= 0) return { spans: [] };
  if (styledLineWidth(line) <= width) return cloneLine(line);
  if (width === 1) {
    const style = line.spans[0]?.style ?? {};
    return plainStyledLine('…', style);
  }
  const target = width - 1;
  const spans: StyledSpan[] = [];
  let used = 0;
  for (const span of line.spans) {
    let text = '';
    for (const char of span.text) {
      const charWidth = displayWidth(char);
      if (used + charWidth > target) break;
      text += char;
      used += charWidth;
    }
    if (text) spans.push({ text, style: { ...span.style } });
    if (used >= target) break;
  }
  spans.push({ text: '…', style: line.spans[0]?.style ?? {} });
  return { spans };
}

export function padStyledLine(line: StyledLine, width: number): StyledLine {
  const clipped = truncateStyledLine(line, width);
  const padding = Math.max(0, width - styledLineWidth(clipped));
  if (!padding) return clipped;
  return {
    spans: [...clipped.spans, { text: ' '.repeat(padding), style: {} }],
  };
}

export function joinStyledLines(
  lines: readonly StyledLine[],
  separator: StyledLine = plainStyledLine('')
): StyledLine {
  const spans: StyledSpan[] = [];
  lines.forEach((line, index) => {
    if (index) spans.push(...separator.spans);
    spans.push(...line.spans);
  });
  return { spans };
}

export function renderAnsiLine(
  line: StyledLine,
  width: number,
  options: ThemeOptions
): string {
  const padded = padStyledLine(line, width);
  if (options.depth === 'none') return styledLineText(padded);
  let output = '';
  let active = '';
  for (const span of padded.spans) {
    const code = styleCode(span.style, options);
    if (code !== active) {
      if (code) output += `\x1b[${code}m`;
      else if (active) output += '\x1b[0m';
      active = code;
    }
    output += span.text;
  }
  return active ? `${output}\x1b[0m` : output;
}

export function stripTerminalControls(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b./gs, '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

function sanitizeLineText(value: string): string {
  return stripTerminalControls(value).replace(/\t/g, '  ').replace(/\n/g, ' ');
}

function cloneLine(line: StyledLine): StyledLine {
  return { spans: line.spans.map((span) => ({ ...span, style: { ...span.style } })) };
}

function styleCode(style: TextStyle, options: ThemeOptions): string {
  if (options.depth === 'none' || !hasStyle(style)) return '';
  const codes: string[] = [];
  if (style.bold) codes.push('1');
  if (style.dim) codes.push('2');
  if (style.italic) codes.push('3');
  if (style.underline) codes.push('4');
  if (style.inverse) codes.push('7');
  if (style.fg) {
    if (options.depth === 'truecolor') {
      const [red, green, blue] = paletteFor(options.theme)[style.fg];
      codes.push(`38;2;${red};${green};${blue}`);
    } else if (options.depth === 'ansi256') {
      codes.push(`38;5;${ansi256Index[style.fg]}`);
    } else {
      codes.push(String(ansi16Code[style.fg]));
    }
  }
  return codes.join(';');
}

function hasStyle(style: TextStyle): boolean {
  return Boolean(
    style.fg ||
      style.bold ||
      style.dim ||
      style.italic ||
      style.underline ||
      style.inverse
  );
}

function paletteFor(theme: TuiTheme): Palette {
  if (theme === 'mono') {
    return {
      text: [230, 232, 239],
      muted: [140, 147, 165],
      accent: [122, 162, 247],
      reasoning: [187, 154, 247],
      tool: [125, 207, 255],
      success: [158, 206, 106],
      warning: [224, 175, 104],
      error: [247, 118, 142],
      added: [158, 206, 106],
      removed: [247, 118, 142],
      file: [224, 175, 104],
      border: [75, 82, 109],
      selection: [122, 162, 247],
    };
  }
  return theme === 'light' ? lightPalette : darkPalette;
}
