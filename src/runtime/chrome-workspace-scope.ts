import { AgentError } from '../core/errors';
import type { HostBridge } from '../host';
import {
  workspaceMimeType,
  workspaceResourceUri,
  type WorkspacePath,
  type WorkspaceResourceDescriptor,
} from '../platform/workspace-resource';
import { ScopedFileSystem, VirtualWorkspace } from '../virtual';

const LEGACY_MIGRATION_KEY = 'tinyai:virtual-workspace:v2:first-scope';

export interface ChromeWorkspaceScopeOptions {
  host: HostBridge;
  legacyWorkspace: VirtualWorkspace;
  now?: () => number;
}

export class ChromeWorkspaceScopeRegistry {
  private readonly scopes = new Map<string, VirtualWorkspace>();
  private migration?: Promise<void>;

  constructor(private readonly options: ChromeWorkspaceScopeOptions) {}

  async get(workspaceId: string): Promise<VirtualWorkspace> {
    assertWorkspaceId(workspaceId);
    const existing = this.scopes.get(workspaceId);
    if (existing) return existing;
    const prefix = `.tinyai/workspaces/${encodeURIComponent(workspaceId)}`;
    const workspace = new VirtualWorkspace({
      host: this.options.host,
      vfs: new ScopedFileSystem(this.options.legacyWorkspace.fs, prefix),
      storageKey: `tinyai:workspace:${workspaceId}`,
      workspaceId,
      now: this.options.now,
    });
    this.scopes.set(workspaceId, workspace);
    await this.adoptLegacyOnce(workspaceId, workspace);
    return workspace;
  }

  async describe(
    workspaceId: string,
    path: WorkspacePath
  ): Promise<WorkspaceResourceDescriptor> {
    const workspace = await this.get(workspaceId);
    const info = await workspace.fs.stat(path);
    if (!info || info.kind !== 'file') {
      throw new AgentError(
        'WORKSPACE_RESOURCE_NOT_FOUND',
        `Workspace resource not found: ${path}`
      );
    }
    return {
      workspaceId,
      path,
      generation: await workspace.generation(),
      resourceUri: workspaceResourceUri(workspaceId, path),
      mimeType: workspaceMimeType(path),
      size: info.size,
      version: info.version,
      openable: true,
      exportable: true,
    };
  }

  async read(workspaceId: string, path: WorkspacePath): Promise<Uint8Array> {
    return (await this.get(workspaceId)).fs.read(path);
  }

  clear(): void {
    this.scopes.clear();
    this.migration = undefined;
  }

  private adoptLegacyOnce(
    workspaceId: string,
    workspace: VirtualWorkspace
  ): Promise<void> {
    this.migration ??= this.migrate(workspaceId, workspace);
    return this.migration;
  }

  private async migrate(
    workspaceId: string,
    workspace: VirtualWorkspace
  ): Promise<void> {
    const storage = this.options.host.storage;
    if (!storage) return;
    const existing = await storage.get(LEGACY_MIGRATION_KEY);
    if (existing) return;
    const entries = await this.options.legacyWorkspace.fs.list('', {
      recursive: true,
    });
    for (const entry of entries) {
      if (entry.kind !== 'file' || entry.path.startsWith('.tinyai/')) continue;
      const data = await this.options.legacyWorkspace.fs.read(entry.path);
      await workspace.fs.write(entry.path, data);
    }
    await storage.set(LEGACY_MIGRATION_KEY, {
      workspaceId,
      migratedAt: this.options.now?.() ?? Date.now(),
    });
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[a-zA-Z0-9._:-]{1,200}$/.test(workspaceId)) {
    throw new AgentError(
      'WORKSPACE_SCOPE_INVALID',
      `Invalid workspace id: ${workspaceId}`
    );
  }
}
