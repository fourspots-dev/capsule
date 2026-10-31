import type {
  HostActionContext,
  HostActionDescriptor,
  HostActionResult,
  HostActionProvider,
} from '../platform/host-action';
import type { JsonValue } from '../core/types';

export interface ConfiguredAction {
  descriptor: HostActionDescriptor;
  invoke(
    input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult | JsonValue>;
}

export class ConfiguredActionProvider implements HostActionProvider {
  private readonly actions: Map<string, ConfiguredAction>;

  constructor(actions: readonly ConfiguredAction[]) {
    this.actions = new Map();
    for (const action of actions) {
      if (this.actions.has(action.descriptor.id)) {
        throw new Error(`Duplicate configured action: ${action.descriptor.id}`);
      }
      this.actions.set(action.descriptor.id, action);
    }
  }

  async describe(): Promise<readonly HostActionDescriptor[]> {
    return [...this.actions.values()].map((action) => action.descriptor);
  }

  async invoke(
    actionId: string,
    input: JsonValue,
    context: HostActionContext
  ): Promise<HostActionResult | JsonValue> {
    const action = this.actions.get(actionId);
    if (!action) throw new Error(`Configured action not found: ${actionId}`);
    return action.invoke(input, context);
  }
}
