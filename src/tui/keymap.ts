import type { TuiFocus, TuiRoute } from './types';

export type TuiIntent =
  | { type: 'text'; text: string }
  | { type: 'newline' }
  | { type: 'send' }
  | { type: 'activate' }
  | { type: 'stop' }
  | { type: 'exit' }
  | { type: 'sessions' }
  | { type: 'agents' }
  | { type: 'status' }
  | { type: 'review' }
  | { type: 'commands' }
  | { type: 'back' }
  | { type: 'help' }
  | { type: 'up' }
  | { type: 'down' }
  | { type: 'page-up' }
  | { type: 'page-down' }
  | { type: 'backspace' };

export interface KeymapContext {
  route: TuiRoute;
  focus: TuiFocus;
  composerEmpty: boolean;
}

export function mapKey(
  key: string,
  context: KeymapContext
): TuiIntent | undefined {
  if (key === '\x03') return { type: 'stop' };
  if (key === '\x0b') return { type: 'sessions' };
  if (key === '\x07') return { type: 'agents' };
  if (key === '\x09') return { type: 'status' };
  if (key === '\x0f') return { type: 'review' };
  if (key === '\x10') return { type: 'commands' };
  if (key === '\x1b[A' || key === '\x1bOA') return { type: 'up' };
  if (key === '\x1b[B' || key === '\x1bOB') return { type: 'down' };
  if (key === '\x1b[5~') return { type: 'page-up' };
  if (key === '\x1b[6~') return { type: 'page-down' };
  if (key === '\x1b') return { type: 'back' };
  if (key === '\x7f' || key === '\b') return { type: 'backspace' };
  if (key === '\n') return { type: 'newline' };
  if (key === '\r') {
    return context.route.kind === 'conversation'
      ? { type: 'send' }
      : { type: 'activate' };
  }
  if (key === '?' && context.route.kind === 'conversation' && context.composerEmpty) {
    return { type: 'help' };
  }
  if (key.length === 1 && key >= ' ' && key !== '\x7f') {
    return { type: 'text', text: key };
  }
  return undefined;
}
