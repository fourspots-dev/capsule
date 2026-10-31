import { AgentError } from '../core/errors';
import type { TuiRoute } from './types';

export class RouteController {
  private readonly stack: TuiRoute[];

  constructor(
    initial: TuiRoute = { kind: 'conversation' },
    private readonly maxDepth = 8
  ) {
    this.stack = [initial];
  }

  get current(): TuiRoute {
    return this.stack.at(-1)!;
  }

  get depth(): number {
    return this.stack.length;
  }

  push(route: TuiRoute): TuiRoute {
    if (this.current.kind === route.kind && route.kind !== 'conversation') {
      this.stack[this.stack.length - 1] = route;
      return this.current;
    }
    if (this.stack.length >= this.maxDepth) {
      throw new AgentError('TUI_ROUTE_DEPTH_EXCEEDED', 'TUI navigation stack is full');
    }
    this.stack.push(route);
    return route;
  }

  replace(route: TuiRoute): TuiRoute {
    this.stack[this.stack.length - 1] = route;
    return route;
  }

  back(): TuiRoute {
    if (this.stack.length > 1) this.stack.pop();
    return this.current;
  }

  reset(route: TuiRoute = { kind: 'conversation' }): TuiRoute {
    this.stack.splice(0, this.stack.length, route);
    return route;
  }

  snapshot(): TuiRoute[] {
    return this.stack.map((route) => structuredClone(route));
  }
}
