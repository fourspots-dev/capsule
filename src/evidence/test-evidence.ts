import type { ArtifactInput, ArtifactStore } from '../core/artifact-store';
import type {
  EvidenceRecord,
  EvidenceStatus,
  EvidenceStore,
} from '../core/evidence-store';
import { AgentError } from '../core/errors';
import type { CompletionGuardDecision } from '../core/session-runtime';
import type { JsonValue } from '../core/types';
import { parseTestReport, type TestReport } from '../core/test-report';
import type { VirtualFileSystem } from '../virtual';

export interface ActionTestInput {
  sessionId: string;
  taskId: string;
  action: {
    id: string;
    version: string;
  };
  runner: string;
  result: {
    value: JsonValue;
    status?: 'succeeded' | 'failed' | 'cancelled';
    artifactIds?: readonly string[];
    artifacts?: readonly {
      name: string;
      mimeType: string;
      kind: ArtifactInput['kind'];
      data: Uint8Array;
    }[];
  };
  workspaceGeneration?: number;
  environmentFingerprint?: string;
  vfs?: VirtualFileSystem;
}

export interface TestEvidenceServiceOptions {
  store: EvidenceStore;
  artifacts?: ArtifactStore;
  vfs: VirtualFileSystem;
  environmentFingerprint: string;
  workspaceGeneration: () => number | Promise<number>;
  now?: () => number;
  newId?: () => string;
}

export class TestEvidenceService {
  private readonly now: () => number;
  private readonly newId: () => string;

  constructor(private readonly options: TestEvidenceServiceOptions) {
    this.now = options.now ?? (() => Date.now());
    this.newId =
      options.newId ??
      (() =>
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? `evidence_${crypto.randomUUID()}`
          : `evidence_${this.now()}_${Math.random().toString(36).slice(2)}`);
  }

  async recordActionTest(input: ActionTestInput): Promise<EvidenceRecord> {
    const artifactIds = [...(input.result.artifactIds ?? [])];
    if (input.result.artifacts?.length) {
      if (!this.options.artifacts) {
        throw new AgentError(
          'EVIDENCE_ARTIFACT_STORE_UNAVAILABLE',
          'Test Action returned artifacts but no ArtifactStore is configured'
        );
      }
      for (const attachment of input.result.artifacts) {
        const ref = await this.options.artifacts.put({
          ...attachment,
          sessionId: input.sessionId,
          taskId: input.taskId,
        });
        artifactIds.push(ref.artifactId);
      }
    }
    const parsed = parseTestReport(input.result.value, input.runner);
    let status: EvidenceStatus = 'current';
    let reason: string | undefined;
    let report = parsed.report;
    if (input.result.status === 'failed' || input.result.status === 'cancelled') {
      status = 'failed';
      reason =
        input.result.status === 'cancelled'
          ? 'Test Action was cancelled'
          : 'Test Action failed';
    }
    if (!report) {
      const fallback = fallbackReport(
        input.runner,
        input.result.value,
        input.result.status
      );
      if (fallback) {
        report = fallback;
        if (fallback.failed > 0) {
          status = 'failed';
          reason = 'Validation script failed';
        }
      } else {
        status = 'invalid';
        reason = parsed.error ?? 'Invalid TestReport';
        report = failedSingleCheck(input.runner, reason);
      }
    } else if (report.failed > 0) {
      status = 'failed';
      reason = `${report.failed} test${report.failed === 1 ? '' : 's'} failed`;
    } else if (report.total === 0) {
      status = 'invalid';
      reason = 'Zero tests do not prove completion';
    }
    if (
      status === 'failed' &&
      report.failed > 0 &&
      artifactIds.length === 0
    ) {
      status = 'invalid';
      reason = 'Failed TestReport has no failure Artifact';
    }
    const record: EvidenceRecord = {
      id: this.newId(),
      sessionId: input.sessionId,
      taskId: input.taskId,
      workspaceGeneration:
        input.workspaceGeneration ??
        (await this.options.workspaceGeneration()),
      environmentFingerprint:
        input.environmentFingerprint ??
        this.options.environmentFingerprint,
      action: { ...input.action },
      fileHashes: await workspaceFileHashes(
        input.vfs ?? this.options.vfs
      ),
      report,
      status,
      ...(reason ? { reason } : {}),
      artifactIds: [...new Set(artifactIds)],
      createdAt: this.now(),
    };
    await this.options.store.save(record);
    return structuredClone(record);
  }

  async refresh(record: EvidenceRecord): Promise<EvidenceRecord> {
    let status: EvidenceStatus =
      record.status === 'failed' ? 'failed' : record.status;
    let reason = record.reason;
    if (
      status === 'current' &&
      record.workspaceGeneration !==
        (await this.options.workspaceGeneration())
    ) {
      status = 'stale';
      reason = 'Workspace generation changed';
    }
    if (
      status === 'current' &&
      record.environmentFingerprint !==
        this.options.environmentFingerprint
    ) {
      status = 'stale';
      reason = 'Environment fingerprint changed';
    }
    if (status === 'current') {
      for (const [path, expected] of Object.entries(record.fileHashes)) {
        const info = await this.options.vfs.stat(path);
        if (!info || info.kind !== 'file') {
          status = 'stale';
          reason = `Evidence file disappeared: ${path}`;
          break;
        }
        const actual = await sha256Hex(await this.options.vfs.read(path));
        if (actual !== expected) {
          status = 'stale';
          reason = `Evidence file changed: ${path}`;
          break;
        }
      }
    }
    const refreshed = {
      ...record,
      status,
      ...(reason ? { reason } : {}),
    };
    await this.options.store.save(refreshed);
    return structuredClone(refreshed);
  }
}

export interface TestEvidenceGuardOptions {
  service: TestEvidenceService;
  store: EvidenceStore;
  actionVersions?: (actionId: string) => Promise<string | undefined>;
}

export function createTestEvidenceCompletionGuard(
  options: TestEvidenceGuardOptions
): (context: {
  sessionId: string;
  taskId: string;
  view: {
    rows: readonly {
      kind: string;
      status: string;
      toolName?: string;
      completedAt?: number;
    }[];
  };
}) => Promise<CompletionGuardDecision> {
  return async ({ sessionId, taskId, view }) => {
    const lastWrite = latestWrite(view.rows);
    if (lastWrite === undefined) return { ok: true };
    const records = await options.store.list({ sessionId, taskId });
    const latest = records.at(-1);
    if (!latest) {
      return {
        ok: false,
        reason: 'No TestEvidence exists for the current task',
      };
    }
    const refreshed = await options.service.refresh(latest);
    if (refreshed.status !== 'current') {
      return {
        ok: false,
        reason: `Latest TestEvidence is ${refreshed.status}: ${
          refreshed.reason ?? 'verification failed'
        }`,
      };
    }
    if (!refreshed.report || refreshed.report.total <= 0) {
      return {
        ok: false,
        reason: 'TestEvidence contains zero tests',
      };
    }
    if (refreshed.report.failed > 0) {
      return {
        ok: false,
        reason: 'TestEvidence contains failed tests',
      };
    }
    if (options.actionVersions) {
      const currentVersion = await options.actionVersions(
        refreshed.action.id
      );
      if (currentVersion !== refreshed.action.version) {
        return {
          ok: false,
          reason: 'Action version changed after TestEvidence was recorded',
        };
      }
    }
    if (refreshed.createdAt < lastWrite) {
      return {
        ok: false,
        reason: 'Workspace changed after TestEvidence was recorded',
      };
    }
    return { ok: true };
  };
}

export async function workspaceFileHashes(
  vfs: VirtualFileSystem
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};
  for (const entry of await vfs.list('', { recursive: true })) {
    if (entry.kind !== 'file') continue;
    if (
      entry.path === '.git' ||
      entry.path.startsWith('.git/') ||
      entry.path === '.tinyai' ||
      entry.path.startsWith('.tinyai/')
    ) {
      continue;
    }
    hashes[entry.path] = await sha256Hex(await vfs.read(entry.path));
  }
  return hashes;
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function failedSingleCheck(runner: string, reason: string): TestReport {
  return {
    schemaVersion: 1,
    runner,
    total: 1,
    passed: 0,
    failed: 1,
    skipped: 0,
    failures: [{ name: runner, message: reason }],
  };
}

function fallbackReport(
  runner: string,
  value: JsonValue,
  status: 'succeeded' | 'failed' | 'cancelled' | undefined
): TestReport | undefined {
  if (status === 'cancelled') return undefined;
  const explicitPassed =
    value && typeof value === 'object' && !Array.isArray(value)
      ? value.passed
      : undefined;
  if (typeof explicitPassed !== 'boolean' && status !== 'succeeded' && status !== 'failed') {
    return undefined;
  }
  const passed = status !== 'failed' && explicitPassed !== false;
  return {
    schemaVersion: 1,
    runner,
    total: 1,
    passed: passed ? 1 : 0,
    failed: passed ? 0 : 1,
    skipped: 0,
    failures: passed
      ? []
      : [{ name: runner, message: 'Validation script failed' }],
  };
}

function latestWrite(
  rows: readonly {
    kind: string;
    status: string;
    toolName?: string;
    completedAt?: number;
  }[]
): number | undefined {
  const writeTools = new Set([
    'write_file',
    'replace_in_file',
    'append_file',
    'apply_patch',
    'apply_unified_diff',
    'delete_file',
    'git_add',
    'git_commit',
    'git_checkout',
    'git_branch',
  ]);
  return rows
    .filter(
      (row) =>
        row.kind === 'tool' &&
        row.status === 'completed' &&
        writeTools.has(row.toolName ?? '')
    )
    .reduce<number | undefined>(
      (latest, row) =>
        row.completedAt === undefined
          ? latest
          : Math.max(latest ?? 0, row.completedAt),
      undefined
    );
}
