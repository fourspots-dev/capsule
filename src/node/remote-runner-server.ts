import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { AgentError } from '../core/errors';
import {
  createWorkspaceBundle,
  parseWorkspaceBundle,
  type WorkspaceBundle,
  type WorkspaceBundleFile,
} from '../virtual';

export interface RemoteRunnerServerOptions {
  token: string;
  allowedCommands: readonly string[];
  tempRoot?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxWorkspaceBytes?: number;
  maxFiles?: number;
}

interface RunnerRequest {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  workspace: WorkspaceBundle;
}

export function createRemoteRunnerHandler(
  options: RemoteRunnerServerOptions
): (request: Request) => Promise<Response> {
  if (!options.token.trim()) throw new Error('Remote runner token is required');
  const allowed = new Set(options.allowedCommands);
  if (!allowed.size) throw new Error('Remote runner command allowlist cannot be empty');
  return async (request) => {
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405);
    }
    if (request.headers.get('authorization') !== `Bearer ${options.token}`) {
      return json({ error: 'unauthorized' }, 401);
    }
    const declaredLength = Number(request.headers.get('content-length') ?? 0);
    if (declaredLength > 50 * 1024 * 1024) {
      return json({ error: 'request too large' }, 413);
    }
    try {
      const body = (await request.json()) as RunnerRequest;
      validateRequest(body, allowed);
      const result = await executeRemote(body, options);
      return json(result, 200);
    } catch (error) {
      const code = error instanceof AgentError ? error.code : 'REMOTE_RUNNER_FAILED';
      const status =
        code === 'REMOTE_COMMAND_DENIED'
          ? 403
          : code === 'REMOTE_REQUEST_INVALID' ||
              code === 'REMOTE_WORKSPACE_LIMIT'
            ? 400
            : code === 'REMOTE_TIMEOUT'
              ? 408
              : 500;
      return json(
        {
          error: error instanceof Error ? error.message : String(error),
          code,
        },
        status
      );
    }
  };
}

async function executeRemote(
  request: RunnerRequest,
  options: RemoteRunnerServerOptions
) {
  const bundle = parseWorkspaceBundle(request.workspace);
  const maxWorkspaceBytes = options.maxWorkspaceBytes ?? 100 * 1024 * 1024;
  const fileCount = bundle.files.length + bundle.directories.length;
  if (fileCount > (options.maxFiles ?? 20_000)) {
    throw new AgentError('REMOTE_WORKSPACE_LIMIT', 'Remote workspace file limit exceeded');
  }
  const totalBytes = bundle.files.reduce(
    (total, file) => total + Buffer.byteLength(file.dataBase64, 'base64'),
    0
  );
  if (totalBytes > maxWorkspaceBytes) {
    throw new AgentError('REMOTE_WORKSPACE_LIMIT', 'Remote workspace size limit exceeded');
  }
  const root = await mkdtemp(join(options.tempRoot ?? tmpdir(), 'tinyai-runner-'));
  try {
    await materialize(root, bundle);
    const cwd = safeWorkingDirectory(root, request.cwd);
    const result = await runCommand(
      request,
      cwd,
      root,
      options.timeoutMs ?? 300_000,
      options.maxOutputBytes ?? 1_000_000
    );
    const workspace = await exportDirectory(root);
    return {
      ...result,
      workspace,
      revision: `remote_${Date.now()}`,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validateRequest(request: RunnerRequest, allowed: Set<string>): void {
  if (
    !request ||
    typeof request !== 'object' ||
    typeof request.command !== 'string' ||
    !Array.isArray(request.args) ||
    request.args.some((arg) => typeof arg !== 'string') ||
    typeof request.cwd !== 'string' ||
    typeof request.stdin !== 'string' ||
    !request.env ||
    typeof request.env !== 'object' ||
    Array.isArray(request.env) ||
    Object.values(request.env).some((value) => typeof value !== 'string') ||
    !request.workspace
  ) {
    throw new AgentError('REMOTE_REQUEST_INVALID', 'Remote runner request is invalid');
  }
  if (!allowed.has(request.command)) {
    throw new AgentError(
      'REMOTE_COMMAND_DENIED',
      `Command is not allowlisted: ${request.command}`
    );
  }
}

async function materialize(root: string, bundle: WorkspaceBundle): Promise<void> {
  for (const directory of bundle.directories) {
    await mkdir(join(root, ...directory.split('/')), { recursive: true });
  }
  for (const file of bundle.files) {
    const path = join(root, ...file.path.split('/'));
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, Buffer.from(file.dataBase64, 'base64'), {
      mode: file.mode,
    });
  }
}

function safeWorkingDirectory(root: string, cwd: string): string {
  const target = resolve(root, ...cwd.replaceAll('\\', '/').split('/').filter(Boolean));
  if (target !== root && !target.startsWith(`${root}/`)) {
    throw new AgentError('REMOTE_REQUEST_INVALID', 'Remote cwd escapes the workspace');
  }
  return target;
}

function runCommand(
  request: RunnerRequest,
  cwd: string,
  root: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(request.command, request.args, {
      cwd,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: join(root, '.home'),
        TMPDIR: join(root, '.tmp'),
        LANG: process.env.LANG ?? 'en_US.UTF-8',
        ...request.env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new AgentError('REMOTE_TIMEOUT', `Remote command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdoutBytes >= maxOutputBytes) return;
      const kept = chunk.subarray(0, maxOutputBytes - stdoutBytes);
      stdout.push(kept);
      stdoutBytes += kept.byteLength;
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrBytes >= maxOutputBytes) return;
      const kept = chunk.subarray(0, maxOutputBytes - stderrBytes);
      stderr.push(kept);
      stderrBytes += kept.byteLength;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveResult({
        exitCode: code ?? 1,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin.end(request.stdin);
  });
}

async function exportDirectory(root: string): Promise<WorkspaceBundle> {
  const files: WorkspaceBundleFile[] = [];
  const directories: string[] = [];
  await walk(root, root, files, directories);
  return createWorkspaceBundle({ files, directories });
}

async function walk(
  root: string,
  current: string,
  files: WorkspaceBundleFile[],
  directories: string[]
): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    if (entry.name === '.home' || entry.name === '.tmp') continue;
    const absolute = join(current, entry.name);
    const path = relative(root, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      directories.push(path);
      await walk(root, absolute, files, directories);
    } else if (entry.isFile()) {
      files.push({
        path,
        dataBase64: (await readFile(absolute)).toString('base64'),
        mode: (await stat(absolute)).mode & 0o777,
      });
    }
  }
}

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
