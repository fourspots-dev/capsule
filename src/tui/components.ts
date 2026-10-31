import {
  padStyledLine,
  plainStyledLine,
  styledLine,
  styledLineWidth,
  styleSpan,
  truncateStyledLine,
  type StyledLine,
  type ThemeToken,
} from './styled';

export interface PanelOptions {
  title: string;
  width: number;
  lines: StyledLine[];
  badge?: string;
  token?: ThemeToken;
  focused?: boolean;
  collapsed?: boolean;
  footer?: string;
  maxHeight?: number;
}

export function renderPanel(options: PanelOptions): StyledLine[] {
  const width = Math.max(8, options.width);
  if (options.collapsed) {
    const marker = '▸';
    const title = [marker, options.title, options.badge].filter(Boolean).join(' ');
    return [
      plainStyledLine(
        `╭─ ${title} ${'─'.repeat(Math.max(0, width - styledTextWidth(`╭─ ${title} `) - 1))}╮`,
        { fg: options.token ?? 'border', dim: true }
      ),
    ].map((line) => truncateStyledLine(line, width));
  }
  const borderToken = options.focused ? 'accent' : options.token ?? 'border';
  const titleStyle = {
    fg: options.focused ? ('accent' as const) : options.token ?? ('border' as const),
    bold: true,
  };
  const suffix = options.badge ? ` · ${options.badge} ` : ' ';
  const topWidth =
    styledTextWidth('╭─ ') +
    styledTextWidth(options.title) +
    styledTextWidth(suffix);
  const top = styledLine(
    styleSpan('╭─ ', { fg: borderToken }),
    styleSpan(options.title, titleStyle),
    styleSpan(suffix, options.badge ? { fg: 'muted' } : {}),
    styleSpan('─'.repeat(Math.max(0, width - topWidth - 1)), { fg: borderToken }),
    styleSpan('╮', { fg: borderToken })
  );
  const innerWidth = Math.max(1, width - 4);
  let body = options.lines.length ? options.lines : [plainStyledLine('', { fg: 'muted' })];
  if (options.maxHeight && body.length > options.maxHeight) {
    body = body.slice(-options.maxHeight);
  }
  const rendered = [
    truncateStyledLine(top, width),
    ...body.map((line) =>
      styledLine(
        styleSpan('│ ', { fg: borderToken }),
        ...padStyledLine(truncateStyledLine(line, innerWidth), innerWidth).spans,
        styleSpan(' │', { fg: borderToken })
      )
    ),
  ];
  if (options.footer) {
    rendered.push(
      styledLine(
        styleSpan('│ ', { fg: borderToken }),
        ...padStyledLine(
          truncateStyledLine(
            plainStyledLine(options.footer, { fg: 'muted', dim: true }),
            innerWidth
          ),
          innerWidth
        ).spans,
        styleSpan(' │', { fg: borderToken })
      )
    );
  }
  rendered.push(
    plainStyledLine(`╰${'─'.repeat(Math.max(0, width - 2))}╯`, {
      fg: borderToken,
    })
  );
  return rendered.map((line) => padStyledLine(line, width));
}

export function renderDivider(width: number, token: ThemeToken = 'border'): StyledLine {
  return plainStyledLine('─'.repeat(Math.max(1, width)), {
    fg: token,
    dim: true,
  });
}

export function blankLine(): StyledLine {
  return plainStyledLine('');
}

function styledTextWidth(value: string): number {
  return styledLineWidth(plainStyledLine(value));
}
