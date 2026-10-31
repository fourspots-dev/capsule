import type { PermissionModeRegistry } from '../core/policy';
import type { ToolRegistration } from '../core/tool-registry';
import type { ApprovalPort } from '../core/ports';
import type { ArtifactStore } from '../core/artifact-store';

export interface ToolPackContext {
  approval: ApprovalPort;
  permissions: PermissionModeRegistry;
  artifacts?: ArtifactStore;
}

export interface ToolPack {
  id: string;
  register(context: ToolPackContext): ToolRegistration[];
}
