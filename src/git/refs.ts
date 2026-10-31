import { AgentError } from '../core/errors';
import { decodeText, encodeText } from './binary';
import { assertBranchName } from './path';
import type { GitFileSystem } from './types';

export interface GitHead {
  branch: string | null;
  oid: string | null;
  detached: boolean;
}

export class GitRefStore {
  constructor(
    private readonly fs: GitFileSystem,
    private readonly gitDir = '.git'
  ) {}

  async readHead(): Promise<GitHead> {
    const path = `${this.gitDir}/HEAD`;
    if (!(await this.fs.stat(path))) {
      return { branch: null, oid: null, detached: false };
    }
    const value = decodeText(await this.fs.read(path)).trim();
    if (value.startsWith('ref: ')) {
      const ref = value.slice(5);
      const branch = ref.startsWith('refs/heads/') ? ref.slice(11) : null;
      return {
        branch,
        oid: await this.readRef(ref),
        detached: false,
      };
    }
    if (!/^[0-9a-f]{40}$/i.test(value)) {
      throw new AgentError('GIT_REF_INVALID', `Invalid HEAD: ${value}`);
    }
    return { branch: null, oid: value.toLowerCase(), detached: true };
  }

  async setBranch(branch: string): Promise<void> {
    assertBranchName(branch);
    await this.writeAtomic(
      `${this.gitDir}/HEAD`,
      encodeText(`ref: refs/heads/${branch}\n`)
    );
  }

  async setDetached(oid: string): Promise<void> {
    assertOid(oid);
    await this.writeAtomic(`${this.gitDir}/HEAD`, encodeText(`${oid}\n`));
  }

  async readRef(ref: string): Promise<string | null> {
    const path = `${this.gitDir}/${ref}`;
    const info = await this.fs.stat(path);
    if (info) {
      const value = decodeText(await this.fs.read(path)).trim();
      assertOid(value);
      return value.toLowerCase();
    }
    const packed = await this.readPackedRefs();
    return packed.get(ref) ?? null;
  }

  async writeBranch(branch: string, oid: string): Promise<void> {
    assertBranchName(branch);
    assertOid(oid);
    await this.writeRef(`refs/heads/${branch}`, oid);
  }

  async writeRef(ref: string, oid: string): Promise<void> {
    assertOid(oid);
    const path = `${this.gitDir}/${ref}`;
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent) await this.fs.mkdir(parent, { recursive: true });
    await this.writeAtomic(path, encodeText(`${oid}\n`));
  }

  async deleteBranch(branch: string): Promise<void> {
    assertBranchName(branch);
    const removed = await this.fs.remove(
      `${this.gitDir}/refs/heads/${branch}`
    );
    if (!removed && !(await this.readPackedRefs()).has(`refs/heads/${branch}`)) {
      throw new AgentError('GIT_BRANCH_NOT_FOUND', `Branch not found: ${branch}`);
    }
  }

  async listBranches(): Promise<string[]> {
    const branches = new Set<string>();
    const root = `${this.gitDir}/refs/heads`;
    const entries = (await this.fs.list(root, { recursive: true })).filter(
      (entry) => entry.kind === 'file'
    );
    for (const entry of entries) {
      branches.add(entry.path.slice(root.length + 1));
    }
    for (const ref of (await this.readPackedRefs()).keys()) {
      if (ref.startsWith('refs/heads/')) branches.add(ref.slice(11));
    }
    return [...branches].sort();
  }

  async resolve(revision: string): Promise<string> {
    if (!revision || revision === 'HEAD') {
      const head = await this.readHead();
      if (!head.oid) {
        throw new AgentError('GIT_REVISION_NOT_FOUND', 'HEAD has no commit');
      }
      return head.oid;
    }
    if (/^[0-9a-f]{40}$/i.test(revision)) return revision.toLowerCase();
    if (revision.startsWith('refs/')) {
      const oid = await this.readRef(revision);
      if (oid) return oid;
    }
    assertBranchName(revision);
    const branchOid = await this.readRef(`refs/heads/${revision}`);
    if (branchOid) return branchOid;
    const tagOid = await this.readRef(`refs/tags/${revision}`);
    if (tagOid) return tagOid;
    throw new AgentError(
      'GIT_REVISION_NOT_FOUND',
      `Git revision not found: ${revision}`
    );
  }

  private async readPackedRefs(): Promise<Map<string, string>> {
    const result = new Map<string, string>();
    const path = `${this.gitDir}/packed-refs`;
    if (!(await this.fs.stat(path))) return result;
    for (const line of decodeText(await this.fs.read(path)).split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [oid, ref] = line.trim().split(/\s+/, 2);
      if (oid && ref && /^[0-9a-f]{40}$/i.test(oid)) {
        result.set(ref, oid.toLowerCase());
      }
    }
    return result;
  }

  private async writeAtomic(path: string, data: Uint8Array): Promise<void> {
    const lock = `${path}.lock`;
    if (await this.fs.stat(lock)) {
      throw new AgentError('GIT_REF_LOCKED', `Git ref is locked: ${path}`);
    }
    await this.fs.write(lock, new Uint8Array());
    try {
      await this.fs.write(path, data);
    } finally {
      await this.fs.remove(lock).catch(() => false);
    }
  }
}

function assertOid(oid: string): void {
  if (!/^[0-9a-f]{40}$/i.test(oid)) {
    throw new AgentError('GIT_OBJECT_ID_INVALID', `Invalid object id: ${oid}`);
  }
}
