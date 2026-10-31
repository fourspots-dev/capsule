import { AgentError } from '../core/errors';
import type { JsonValue } from '../core/types';
import {
  bytesToBase64,
  base64ToBytes,
  decodeText,
  encodeText,
  sha1Hex,
} from './binary';
import {
  indexEntryFromFile,
  readGitIndex,
  writeGitIndex,
} from './index-file';
import { parseGitIgnore } from './ignore';
import { unifiedGitDiff } from './diff';
import { GitObjectStore, encodeCommit, encodeTree, parseCommit } from './objects';
import { assertBranchName, normalizeGitPath } from './path';
import { GitRefStore } from './refs';
import type {
  GitBackend,
  GitBackendDescriptor,
  GitCommitInfo,
  GitCommitInput,
  GitCommitResult,
  GitDiff,
  GitDiffFile,
  GitFileInfo,
  GitFileSystem,
  GitIndexEntry,
  GitObject,
  GitRepositoryInfo,
  GitSignature,
  GitStatus,
  GitStatusEntry,
  GitTreeEntry,
} from './types';

interface PortableGitOptions {
  gitDir?: string;
  now?: () => number;
  defaultAuthor?: Partial<GitSignature>;
  maxDiffBytes?: number;
}

interface TreeFile {
  path: string;
  mode: number;
  oid: string;
}

export class PortableGitBackend implements GitBackend {
  readonly descriptor: GitBackendDescriptor = {
    kind: 'portable',
    version: '1.0.0',
    limitations: [
      'sha1-only',
      'local-commands-only',
      'no-merge-or-rebase',
      'no-hooks-or-filters',
      'no-recursive-submodules',
      'no-lfs-download',
    ],
  };
  private readonly gitDir: string;
  private readonly now: () => number;
  private readonly maxDiffBytes: number;
  private readonly objects: GitObjectStore;
  private readonly refs: GitRefStore;

  constructor(
    private readonly fs: GitFileSystem,
    private readonly options: PortableGitOptions = {}
  ) {
    this.gitDir = options.gitDir ?? '.git';
    this.now = options.now ?? (() => Date.now());
    this.maxDiffBytes = options.maxDiffBytes ?? 2_000_000;
    this.objects = new GitObjectStore(fs, this.gitDir);
    this.refs = new GitRefStore(fs, this.gitDir);
  }

  async init(options: { initialBranch?: string } = {}): Promise<GitRepositoryInfo> {
    if (await this.repository()) {
      throw new AgentError('GIT_REPOSITORY_EXISTS', 'Git repository already exists');
    }
    const branch = options.initialBranch?.trim() || 'main';
    assertBranchName(branch);
    await this.fs.mkdir(`${this.gitDir}/objects`, { recursive: true });
    await this.fs.mkdir(`${this.gitDir}/refs/heads`, { recursive: true });
    await this.fs.mkdir(`${this.gitDir}/refs/tags`, { recursive: true });
    await this.refs.setBranch(branch);
    return {
      gitDir: this.gitDir,
      head: null,
      branch,
      objectFormat: 'sha1',
    };
  }

  async repository(): Promise<GitRepositoryInfo | undefined> {
    const headPath = `${this.gitDir}/HEAD`;
    if (!(await this.fs.stat(headPath))) return undefined;
    const head = await this.refs.readHead();
    return {
      gitDir: this.gitDir,
      head: head.oid,
      branch: head.branch,
      objectFormat: 'sha1',
    };
  }

  async status(signal?: AbortSignal): Promise<GitStatus> {
    this.assertRepository(await this.repository());
    assertActive(signal);
    const head = await this.refs.readHead();
    const headFiles = head.oid
      ? await this.readTreeFiles(head.oid)
      : new Map<string, TreeFile>();
    const index = await readGitIndex(this.fs, this.gitDir);
    const conflicted = index
      .filter((entry) => entry.stage !== 0)
      .map((entry) => ({
        path: entry.path,
        index: 'conflicted' as const,
        worktree: null,
        staged: true,
        untracked: false,
        ignored: false,
        stage: entry.stage,
      }));
    const indexByIdentity = new Map<string, GitIndexEntry>();
    for (const entry of index) {
      if (entry.stage === 0) indexByIdentity.set(entry.path, entry);
    }
    const staged = compareMaps(headFiles, indexByIdentity);
    const files = (await this.fs.list('', { recursive: true, signal }))
      .filter((entry) => entry.kind === 'file')
      .filter((entry) => !entry.path.startsWith(`${this.gitDir}/`));
    const ignore = await this.loadIgnore();
    const untracked: string[] = [];
    const ignored: string[] = [];
    const worktreeByPath = new Map<string, GitFileInfo>();
    for (const file of files) {
      assertActive(signal);
      if (indexByIdentity.has(file.path)) worktreeByPath.set(file.path, file);
      else if (ignore.matches(file.path, false)) ignored.push(file.path);
      else untracked.push(file.path);
    }
    const unstaged: GitStatusEntry[] = [];
    for (const [path, entry] of indexByIdentity) {
      assertActive(signal);
      const file = worktreeByPath.get(path);
      if (!file) {
        unstaged.push(statusEntry(path, null, 'deleted', false, false, false));
        continue;
      }
      const data = await this.fs.read(path, { signal });
      const oid = await this.objectStoreHash(data);
      const worktreeMode = file.mode & 0o111 ? 0o100755 : 0o100644;
      if (oid !== entry.oid || worktreeMode !== entry.mode) {
        unstaged.push(statusEntry(path, null, 'modified', false, false, false));
      }
    }
    const stagedWithRenames = staged;
    const unstagedWithRenames = unstaged;
    const clean =
      !stagedWithRenames.length &&
      !unstagedWithRenames.length &&
      !untracked.length &&
      !conflicted.length;
    return {
      branch: head.branch,
      head: head.oid,
      detached: head.detached,
      clean,
      staged: stagedWithRenames,
      unstaged: unstagedWithRenames,
      untracked: untracked.sort(),
      ignored: ignored.sort(),
      conflicted,
    };
  }

  async add(paths: readonly string[], signal?: AbortSignal): Promise<void> {
    this.assertRepository(await this.repository());
    if (!paths.length) {
      throw new AgentError('GIT_PATH_INVALID', 'At least one path is required');
    }
    const index = await readGitIndex(this.fs, this.gitDir);
    const indexByPath = new Map(index.filter((entry) => entry.stage === 0).map((entry) => [entry.path, entry]));
    const selected = new Set<string>();
    for (const input of paths) {
      assertActive(signal);
      if (!input.trim() || input.trim() === '.') {
        for (const file of await this.fs.list('', { recursive: true, signal })) {
          if (
            file.kind === 'file' &&
            !file.path.startsWith(`${this.gitDir}/`)
          ) {
            selected.add(file.path);
          }
        }
        continue;
      }
      const path = normalizeGitPath(input);
      const info = await this.fs.stat(path, signal);
      if (!info) {
        for (const existing of [...indexByPath.keys()]) {
          if (existing === path || existing.startsWith(`${path}/`)) {
            indexByPath.delete(existing);
          }
        }
        continue;
      }
      if (info.kind === 'file') selected.add(path);
      else {
        const nested = await this.fs.list(path, { recursive: true, signal });
        for (const file of nested) {
          if (
            file.kind === 'file' &&
            !file.path.startsWith(`${this.gitDir}/`)
          ) {
            selected.add(file.path);
          }
        }
      }
    }
    for (const path of selected) {
      assertActive(signal);
      const file = await this.fs.stat(path, signal);
      if (!file || file.kind !== 'file') continue;
      const data = await this.fs.read(path, { signal });
      const oid = await this.objects.writeObject('blob', data);
      indexByPath.set(path, indexEntryFromFile(file, oid));
    }
    await writeGitIndex(
      this.fs,
      [...indexByPath.values()].filter((entry) => entry.stage === 0),
      this.gitDir
    );
  }

  async commit(
    input: GitCommitInput,
    signal?: AbortSignal
  ): Promise<GitCommitResult> {
    this.assertRepository(await this.repository());
    const message = input.message.trim();
    if (!message) {
      throw new AgentError('GIT_COMMIT_MESSAGE_REQUIRED', 'Commit message is required');
    }
    const index = await readGitIndex(this.fs, this.gitDir);
    if (index.some((entry) => entry.stage !== 0)) {
      throw new AgentError('GIT_INDEX_CONFLICTED', 'Cannot commit unresolved index entries');
    }
    assertActive(signal);
    const tree = await this.writeTreeFromIndex(index);
    const head = await this.refs.readHead();
    if (!input.allowEmpty && head.oid) {
      const parent = await this.readCommit(head.oid);
      if (parent.tree === tree) {
        throw new AgentError('GIT_EMPTY_COMMIT', 'No staged changes to commit');
      }
    }
    const now = this.now();
    const author = mergeSignature(this.options.defaultAuthor, input.author, now);
    const committer = mergeSignature(this.options.defaultAuthor, input.committer, now);
    const data = encodeCommit({
      tree,
      parents: head.oid ? [head.oid] : [],
      authorName: author.name,
      authorEmail: author.email,
      authorTimestamp: author.timestamp,
      authorTimezone: author.timezone,
      committerName: committer.name,
      committerEmail: committer.email,
      committerTimestamp: committer.timestamp,
      committerTimezone: committer.timezone,
      message,
    });
    const oid = await this.objects.writeObject('commit', data);
    if (head.branch) await this.refs.writeBranch(head.branch, oid);
    else await this.refs.setDetached(oid);
    return {
      oid,
      tree,
      ...(head.oid ? { parent: head.oid } : {}),
      branch: head.branch,
    };
  }

  async log(
    options: { maxCount?: number; revision?: string } = {},
    signal?: AbortSignal
  ): Promise<GitCommitInfo[]> {
    this.assertRepository(await this.repository());
    let oid: string;
    try {
      oid = await this.refs.resolve(options.revision ?? 'HEAD');
    } catch (error) {
      if (!options.revision && (error as AgentError).code === 'GIT_REVISION_NOT_FOUND') {
        return [];
      }
      throw error;
    }
    const result: GitCommitInfo[] = [];
    const seen = new Set<string>();
    const queue = [oid];
    while (queue.length && result.length < (options.maxCount ?? 100)) {
      assertActive(signal);
      const next = queue.shift()!;
      if (seen.has(next)) continue;
      seen.add(next);
      const commit = await this.readCommit(next);
      result.push({ oid: next, ...commit });
      queue.unshift(...commit.parents);
    }
    return result;
  }

  async show(revision: string, signal?: AbortSignal): Promise<JsonValue> {
    assertActive(signal);
    const oid = await this.refs.resolve(revision);
    const object = await this.objects.readObject(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(oid, object.data);
      return {
        type: 'commit',
        oid,
        tree: commit.tree,
        parents: commit.parents,
        author: commit.author,
        committer: commit.committer,
        message: commit.message,
      };
    }
    if (object.type === 'tree') {
      return {
        type: 'tree',
        oid,
        entries: (await this.objects.readTree(oid)).map((entry) => ({ ...entry })),
      };
    }
    if (object.type === 'blob') {
      const text = decodeTextStrict(object.data);
      return text === undefined
        ? { type: 'blob', oid, bytes: object.data.byteLength, dataBase64: bytesToBase64(object.data) }
        : { type: 'blob', oid, bytes: object.data.byteLength, text };
    }
    return { type: 'tag', oid, data: decodeText(object.data) };
  }

  async diff(
    options: { from?: string; to?: string; staged?: boolean } = {},
    signal?: AbortSignal
  ): Promise<GitDiff> {
    const head = await this.refs.readHead();
    const index = await readGitIndex(this.fs, this.gitDir);
    const indexMap = new Map(
      index
        .filter((entry) => entry.stage === 0)
        .map((entry) => [entry.path, { mode: entry.mode, oid: entry.oid }])
    );
    const fromId = options.from ?? head.oid ?? 'empty';
    const from = options.from
      ? await this.readTreeFiles(await this.refs.resolve(options.from))
      : head.oid
        ? await this.readTreeFiles(head.oid)
        : new Map<string, TreeFile>();
    const to = options.staged
      ? indexMap
      : await this.worktreeFiles(signal);
    const toId = options.to ?? (options.staged ? 'index' : 'worktree');
    const paths = [...new Set([...from.keys(), ...to.keys()])].sort();
    const files: GitDiffFile[] = [];
    for (const path of paths) {
      assertActive(signal);
      const before = from.get(path);
      const after = to.get(path);
      if (before?.oid === after?.oid && before?.mode === after?.mode) continue;
      const beforeData = before ? await this.objects.readBlob(before.oid) : new Uint8Array();
      const afterData = after
        ? options.staged
          ? await this.objects.readBlob(after.oid)
          : (await this.fs.stat(path, signal))
            ? await this.fs.read(path, { signal })
            : new Uint8Array()
        : new Uint8Array();
      const patch = unifiedGitDiff(beforeData, afterData, path);
      files.push({
        path,
        status: !before ? 'added' : !after ? 'deleted' : patch.patch ? 'modified' : 'binary',
        ...(patch.patch ? { patch: patch.patch } : {}),
        ...(patch.status === 'binary' ? { binary: true } : {}),
      });
    }
    return { from: fromId, to: toId, files };
  }

  async branches(): Promise<{ current: string | null; names: string[] }> {
    const head = await this.refs.readHead();
    return { current: head.branch, names: await this.refs.listBranches() };
  }

  async createBranch(name: string): Promise<void> {
    assertBranchName(name);
    const head = await this.refs.readHead();
    if (!head.oid) {
      throw new AgentError('GIT_HEAD_UNBORN', 'Cannot create branch before first commit');
    }
    if ((await this.refs.listBranches()).includes(name)) {
      throw new AgentError('GIT_BRANCH_EXISTS', `Branch already exists: ${name}`);
    }
    await this.refs.writeBranch(name, head.oid);
  }

  async deleteBranch(name: string): Promise<void> {
    const head = await this.refs.readHead();
    if (head.branch === name) {
      throw new AgentError('GIT_BRANCH_CURRENT', 'Cannot delete the current branch');
    }
    await this.refs.deleteBranch(name);
  }

  async checkout(target: string, signal?: AbortSignal): Promise<void> {
    const status = await this.status(signal);
    if (status.staged.length || status.unstaged.length || status.conflicted.length) {
      throw new AgentError(
        'GIT_CHECKOUT_DIRTY',
        'Cannot checkout with staged or unstaged tracked changes'
      );
    }
    const branches = await this.refs.listBranches();
    const branch = branches.includes(target) ? target : null;
    const oid = await this.refs.resolve(target);
    const targetFiles = await this.readTreeFiles(oid);
    const untracked = new Set(status.untracked);
    for (const path of targetFiles.keys()) {
      if (untracked.has(path)) {
        throw new AgentError(
          'GIT_CHECKOUT_UNTRACKED',
          `Checkout would overwrite untracked file: ${path}`
        );
      }
    }
    const currentIndex = await readGitIndex(this.fs, this.gitDir);
    const currentPaths = new Set(currentIndex.map((entry) => entry.path));
    for (const path of currentPaths) {
      assertActive(signal);
      if (!targetFiles.has(path)) await this.fs.remove(path);
    }
    const entries: GitIndexEntry[] = [];
    for (const file of targetFiles.values()) {
      assertActive(signal);
      const data = await this.objects.readBlob(file.oid);
      const parent = file.path.slice(0, file.path.lastIndexOf('/'));
      if (parent) await this.fs.mkdir(parent, { recursive: true });
      const info = await this.fs.write(file.path, data, { mode: file.mode });
      entries.push(indexEntryFromFile(info, file.oid));
    }
    await writeGitIndex(this.fs, entries, this.gitDir);
    if (branch) await this.refs.setBranch(branch);
    else await this.refs.setDetached(oid);
  }

  async revParse(revision: string): Promise<string> {
    return this.refs.resolve(revision);
  }

  async exportRepository(): Promise<Uint8Array> {
    const entries = await this.fs.list(this.gitDir, { recursive: true });
    const files = [];
    for (const entry of entries) {
      if (entry.kind !== 'file') continue;
      files.push({
        path: entry.path.slice(this.gitDir.length + 1),
        dataBase64: bytesToBase64(await this.fs.read(entry.path)),
        mode: entry.mode,
      });
    }
    return encodeText(
      JSON.stringify({
        format: 'tinyai.git.repository',
        schemaVersion: 1,
        files,
      })
    );
  }

  async importRepository(data: Uint8Array, signal?: AbortSignal): Promise<void> {
    let parsed: {
      format?: string;
      schemaVersion?: number;
      files?: Array<{ path?: string; dataBase64?: string; mode?: number }>;
    };
    try {
      parsed = JSON.parse(decodeText(data)) as typeof parsed;
    } catch {
      throw new AgentError('GIT_REPOSITORY_INVALID', 'Repository archive is not valid JSON');
    }
    if (
      parsed.format !== 'tinyai.git.repository' ||
      parsed.schemaVersion !== 1 ||
      !Array.isArray(parsed.files)
    ) {
      throw new AgentError('GIT_REPOSITORY_INVALID', 'Unsupported repository archive');
    }
    for (const file of parsed.files) {
      assertActive(signal);
      if (typeof file.path !== 'string' || typeof file.dataBase64 !== 'string') {
        throw new AgentError('GIT_REPOSITORY_INVALID', 'Invalid repository file entry');
      }
      const path = `.git/${normalizeGitPath(file.path)}`;
      const parent = path.slice(0, path.lastIndexOf('/'));
      if (parent) await this.fs.mkdir(parent, { recursive: true });
      await this.fs.write(path, base64ToBytes(file.dataBase64), {
        ...(file.mode === undefined ? {} : { mode: file.mode }),
      });
    }
  }

  private async readCommit(oid: string): Promise<Omit<GitCommitInfo, 'oid'>> {
    const object = await this.objects.readObject(oid);
    if (object.type !== 'commit') {
      throw new AgentError('GIT_OBJECT_TYPE', `Object ${oid} is not a commit`);
    }
    return parseCommit(oid, object.data);
  }

  private async readTreeFiles(commitOid: string): Promise<Map<string, TreeFile>> {
    const commit = await this.readCommit(commitOid);
    return this.flattenTree(commit.tree, '');
  }

  private async flattenTree(treeOid: string, prefix: string): Promise<Map<string, TreeFile>> {
    const result = new Map<string, TreeFile>();
    for (const entry of await this.objects.readTree(treeOid)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.mode === 0o40000) {
        for (const [child, value] of await this.flattenTree(entry.oid, path)) {
          result.set(child, value);
        }
      } else if (entry.mode === 0o160000) {
        result.set(path, { path, mode: entry.mode, oid: entry.oid });
      } else {
        result.set(path, { path, mode: entry.mode, oid: entry.oid });
      }
    }
    return result;
  }

  private async writeTreeFromIndex(index: readonly GitIndexEntry[]): Promise<string> {
    const root = createTreeNode('');
    for (const entry of index) {
      const parts = entry.path.split('/');
      let node = root;
      for (let indexPart = 0; indexPart < parts.length - 1; indexPart += 1) {
        const name = parts[indexPart];
        let child = node.directories.get(name);
        if (!child) {
          child = createTreeNode(name);
          node.directories.set(name, child);
        }
        node = child;
      }
      node.files.set(parts.at(-1)!, { mode: entry.mode, oid: entry.oid });
    }
    return this.writeTreeNode(root);
  }

  private async writeTreeNode(node: TreeNode): Promise<string> {
    const entries: GitTreeEntry[] = [];
    for (const [name, child] of node.directories) {
      entries.push({ mode: 0o40000, name, oid: await this.writeTreeNode(child) });
    }
    for (const [name, file] of node.files) {
      entries.push({ mode: file.mode, name, oid: file.oid });
    }
    return this.objects.writeObject('tree', encodeTree(entries));
  }

  private async worktreeFiles(signal?: AbortSignal): Promise<Map<string, TreeFile>> {
    const result = new Map<string, TreeFile>();
    for (const file of await this.fs.list('', { recursive: true, signal })) {
      if (file.kind !== 'file' || file.path.startsWith(`${this.gitDir}/`)) continue;
      const data = await this.fs.read(file.path, { signal });
      result.set(file.path, {
        path: file.path,
        mode: file.mode & 0o111 ? 0o100755 : 0o100644,
        oid: await this.objects.hashObject('blob', data),
      });
    }
    return result;
  }

  private async objectStoreHash(data: Uint8Array): Promise<string> {
    return sha1Hex(concatObjectHeader('blob', data));
  }

  private async loadIgnore() {
    const path = '.gitignore';
    if (!(await this.fs.stat(path))) return parseGitIgnore('');
    return parseGitIgnore(decodeText(await this.fs.read(path)));
  }

  private assertRepository(repository: GitRepositoryInfo | undefined): asserts repository is GitRepositoryInfo {
    if (!repository) {
      throw new AgentError('GIT_REPOSITORY_NOT_FOUND', 'Git repository not found');
    }
  }
}

interface TreeNode {
  name: string;
  files: Map<string, { mode: number; oid: string }>;
  directories: Map<string, TreeNode>;
}

function createTreeNode(name: string): TreeNode {
  return { name, files: new Map(), directories: new Map() };
}

function compareMaps(
  before: ReadonlyMap<string, TreeFile>,
  after: ReadonlyMap<string, GitIndexEntry>
): GitStatusEntry[] {
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  const result: GitStatusEntry[] = [];
  const additions: GitIndexEntry[] = [];
  const deletions: TreeFile[] = [];
  for (const path of paths) {
    const old = before.get(path);
    const next = after.get(path);
    if (!old && next) additions.push(next);
    else if (old && !next) deletions.push(old);
    else if (old && next && (old.oid !== next.oid || old.mode !== next.mode)) {
      result.push(statusEntry(path, null, 'modified', true, false, false));
    }
  }
  const pairedDeletes = new Set<string>();
  for (const addition of additions) {
    const deletion = deletions.find(
      (candidate) =>
        candidate.oid === addition.oid && !pairedDeletes.has(candidate.path)
    );
    if (deletion) {
      pairedDeletes.add(deletion.path);
      result.push({
        path: addition.path,
        oldPath: deletion.path,
        index: 'renamed',
        worktree: null,
        staged: true,
        untracked: false,
        ignored: false,
      });
    } else {
      result.push(statusEntry(addition.path, null, 'added', true, false, false));
    }
  }
  for (const deletion of deletions) {
    if (!pairedDeletes.has(deletion.path)) {
      result.push(statusEntry(deletion.path, null, 'deleted', true, false, false));
    }
  }
  return result;
}

function statusEntry(
  path: string,
  oldPath: string | null,
  status: GitStatusEntry['index'],
  staged: boolean,
  untracked: boolean,
  ignored: boolean
): GitStatusEntry {
  return {
    path,
    ...(oldPath ? { oldPath } : {}),
    index: staged ? status : null,
    worktree: staged ? null : status,
    staged,
    untracked,
    ignored,
  };
}

function mergeSignature(
  defaults: Partial<GitSignature> | undefined,
  input: Partial<GitSignature> | undefined,
  now: number
): GitSignature {
  return {
    name: input?.name ?? defaults?.name ?? 'tinyai',
    email: input?.email ?? defaults?.email ?? 'tinyai@localhost',
    timestamp: input?.timestamp ?? defaults?.timestamp ?? Math.floor(now / 1000),
    timezone: input?.timezone ?? defaults?.timezone ?? '+0000',
  };
}

function concatObjectHeader(type: string, data: Uint8Array): Uint8Array {
  const header = encodeText(`${type} ${data.byteLength}\0`);
  const result = new Uint8Array(header.byteLength + data.byteLength);
  result.set(header);
  result.set(data, header.byteLength);
  return result;
}

function decodeTextStrict(data: Uint8Array): string | undefined {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(data);
    return text.includes('\0') ? undefined : text;
  } catch {
    return undefined;
  }
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('Git operation was cancelled');
    error.name = 'AbortError';
    throw error;
  }
}
