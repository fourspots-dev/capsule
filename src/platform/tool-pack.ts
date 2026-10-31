import type { ToolDefinition } from '../core/types';
import type { ToolRegistration } from '../core/tool-registry';
import type { PermissionModeRegistry } from '../core/policy';
import type { ApprovalPort } from '../core/ports';
import type { ArtifactStore } from '../core/artifact-store';

export interface ToolPackContext {
  approval: ApprovalPort;
  permissions: PermissionModeRegistry;
  artifacts?: ArtifactStore;
}
import {
  CapabilityGraph,
  type CapabilityReport,
} from './capability';

export interface ToolPack {
  id: string;
  register(context: ToolPackContext): ToolRegistration[];
}

export interface ComposableToolPack {
  id: string;
  tools: readonly ToolDefinition[];
  requiredCapabilities?: readonly string[];
  optionalCapabilities?: readonly string[];
  requiresAny?: readonly string[];
}

export interface ToolPackComposition {
  tools: ToolDefinition[];
  activated: string[];
  skipped: Array<{ id: string; reason: string }>;
  capabilities: CapabilityReport;
}

export class ToolPackComposer {
  private readonly packs: ComposableToolPack[] = [];

  register(pack: ComposableToolPack): () => void {
    if (this.packs.some((item) => item.id === pack.id)) {
      throw new Error(`Tool pack is already registered: ${pack.id}`);
    }
    this.packs.push(pack);
    return () => {
      const index = this.packs.findIndex((item) => item === pack);
      if (index >= 0) this.packs.splice(index, 1);
    };
  }

  compose(graph: CapabilityGraph): ToolPackComposition {
    const tools: ToolDefinition[] = [];
    const activated: string[] = [];
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const pack of [...this.packs].sort((left, right) => left.id.localeCompare(right.id))) {
      const missing = (pack.requiredCapabilities ?? []).filter(
        (capability) => !graph.canUse(capability)
      );
      const anyMissing =
        pack.requiresAny?.length &&
        !pack.requiresAny.some((capability) => graph.canUse(capability));
      if (missing.length || anyMissing) {
        skipped.push({
          id: pack.id,
          reason: missing.length
            ? `Missing required capabilities: ${missing.join(', ')}`
            : `None of the alternative capabilities are available: ${(pack.requiresAny ?? []).join(', ')}`,
        });
        continue;
      }
      const names = new Set(tools.map((tool) => tool.name));
      for (const tool of pack.tools) {
        if (names.has(tool.name)) {
          throw new Error(`Duplicate tool name across packs: ${tool.name}`);
        }
        names.add(tool.name);
        tools.push(tool);
      }
      activated.push(pack.id);
    }
    return {
      tools: tools.sort((left, right) => left.name.localeCompare(right.name)),
      activated,
      skipped,
      capabilities: graph.report(),
    };
  }
}
