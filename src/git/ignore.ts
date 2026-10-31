import { gitGlobToRegExp } from './glob';

interface IgnoreRule {
  negate: boolean;
  directoryOnly: boolean;
  regex: RegExp;
}

export class GitIgnoreMatcher {
  private readonly rules: IgnoreRule[];

  constructor(lines: readonly string[] = []) {
    this.rules = lines.flatMap((line) => parseRule(line));
  }

  matches(path: string, isDirectory = false): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.regex.test(path)) ignored = !rule.negate;
    }
    return ignored;
  }
}

export function parseGitIgnore(text: string): GitIgnoreMatcher {
  return new GitIgnoreMatcher(text.split(/\r?\n/));
}

function parseRule(input: string): IgnoreRule[] {
  let line = input.trim();
  if (!line || line.startsWith('#')) return [];
  let negate = false;
  if (line.startsWith('!')) {
    negate = true;
    line = line.slice(1);
  } else if (line.startsWith('\\!') || line.startsWith('\\#')) {
    line = line.slice(1);
  }
  const directoryOnly = line.endsWith('/');
  if (directoryOnly) line = `${line.slice(0, -1)}/**`;
  if (line.startsWith('/')) line = line.slice(1);
  const anchored = line.includes('/');
  const pattern = anchored ? line : `**/${line}`;
  const regex = gitGlobToRegExp(pattern);
  return [{ negate, directoryOnly, regex }];
}
