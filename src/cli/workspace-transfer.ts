import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { HostArtifactStore } from '../adapters/host-artifact-store';
import { HostSessionStore } from '../adapters/host-session-store';
import { PortableGitBackend } from '../git/backend';
import { NodeHostFileSystem } from '../node/host-fs';
import { NodeHostBridge } from '../node/node-host';
import { parseWorkspaceCapsule, serializeWorkspaceCapsule } from '../workspace/codec';
import { WorkspaceContinuityService } from '../workspace/continuity';

interface TransferOptions {
  mode: 'export' | 'import';
  workspace: string;
  stateRoot: string;
  capsule: string;
  environmentId: string;
  replaceProject: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const host = new NodeHostBridge({
    id: `tinyai-${options.mode}-host`,
    projectRoot: options.workspace,
    stateRoot: options.stateRoot,
  });
  const fs = new NodeHostFileSystem(options.workspace);
  const git = new PortableGitBackend(fs);
  const sessions = new HostSessionStore(host.storage);
  const artifacts = new HostArtifactStore(host.storage);
  const continuity = new WorkspaceContinuityService({
    workspaceId: 'tinyai-workspace',
    vfs: fs,
    git,
    sessions,
    artifacts,
    environmentId: options.environmentId,
    hostProfile: 'local-coding',
    agentVersion: '0.3.0',
    newId: () => `capsule_${randomUUID()}`,
    environment: {
      manifestVersion: 1,
      requiredActions: [],
      requiredCapabilities: ['filesystem', 'git'],
    },
  });

  if (options.mode === 'export') {
    const capsule = await continuity.exportCapsule();
    await writeFile(options.capsule, serializeWorkspaceCapsule(capsule));
    process.stdout.write(
      `${JSON.stringify({
        status: 'exported',
        capsule: options.capsule,
        capsuleId: capsule.manifest.capsuleId,
        workspaceId: capsule.manifest.workspaceId,
        sessions: capsule.partitions.agentState.sessions.length,
        artifacts: capsule.partitions.artifacts.records.length,
        rootDigest: capsule.manifest.integrity.rootDigest,
      })}\n`
    );
    return;
  }

  const capsule = await parseWorkspaceCapsule(await readFile(options.capsule));
  const prepared = await continuity.prepareImport(capsule);
  const result = await continuity.commitImport(prepared, {
    replaceProject: options.replaceProject,
  });
  process.stdout.write(`${JSON.stringify({ status: 'imported', ...result })}\n`);
}

function parseArgs(args: string[]): TransferOptions {
  const mode = args[0];
  if (mode !== 'export' && mode !== 'import') {
    usage();
    throw new Error('mode must be export or import');
  }
  const values = new Map<string, string>();
  let replaceProject = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--replace') {
      replaceProject = true;
      continue;
    }
    if (
      arg === '--workspace' ||
      arg === '--state' ||
      arg === '--capsule' ||
      arg === '--environment-id'
    ) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!values.get('--capsule')) throw new Error('--capsule is required');
  const workspace = resolve(values.get('--workspace') ?? process.cwd());
  return {
    mode,
    workspace,
    stateRoot: resolve(values.get('--state') ?? `${workspace}/.tinyai`),
    capsule: resolve(values.get('--capsule')!),
    environmentId:
      values.get('--environment-id') ??
      `local-${process.platform}-${process.arch}`,
    replaceProject,
  };
}

function usage(): void {
  process.stdout.write(
    [
      'Usage:',
      '  tinyai-workspace-transfer export --workspace DIR --capsule FILE [--state DIR] [--environment-id ID]',
      '  tinyai-workspace-transfer import --workspace DIR --capsule FILE [--state DIR] [--environment-id ID] [--replace]',
      '',
    ].join('\n')
  );
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.stack ?? error.message : String(error)}\n`
  );
  process.exitCode = 1;
});
