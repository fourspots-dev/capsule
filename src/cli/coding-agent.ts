import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { DockerSandboxProvider } from '../adapters/docker-sandbox';
import { InMemoryApprovalReceiptStore } from '../adapters/host-approval-receipt-store';
import { OpenAIModelTransport } from '../adapters/openai-model';
import { createSandboxTools } from '../adapters/sandbox-tools';
import type { ApprovalPort } from '../core/ports';
import { SequentialIdGenerator, systemClock } from '../core/ports';
import { PermissionModeRegistry, PolicyEngine } from '../core/policy';
import { InMemoryArtifactStore } from '../core/artifact-store';
import { ToolExecutor } from '../core/tool-executor';
import { WorkspaceRuntime } from '../core/workspace-runtime';
import { NodeDockerCommandRunner, NodeDockerPtyRunner } from '../node/docker-runner';
import { Verifier, type VerificationCommand } from '../core/verifier';
import { DockerAllowlistSidecar } from '../node/network-sidecar';
import type { SandboxProvider, WorkspaceLease } from '../core/sandbox-provider';
import { MacOSSeatbeltSandbox } from '../node/macos-sandbox';
import { buildPrompt } from '../prompts';

interface CliOptions {
  workspace: string;
  task: string;
  image?: string;
  verify?: string;
  allowHosts?: string[];
  sandbox?: 'local' | 'docker';
}

const denyApproval: ApprovalPort = {
  requestApproval: async () => false,
};

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const apiKey = process.env.DEEPSEEK_API_KEY ?? process.env.TINYAI_API_KEY;
  if (!apiKey) {
    throw new Error('Set DEEPSEEK_API_KEY or TINYAI_API_KEY');
  }
  const baseUrl =
    process.env.DEEPSEEK_BASE_URL ??
    process.env.TINYAI_BASE_URL ??
    'https://api.deepseek.com/v1';
  const model =
    process.env.DEEPSEEK_MODEL ??
    process.env.TINYAI_MODEL ??
    'deepseek-chat';
  const verification = await verificationCommands(options.workspace, options.verify);
  const sandboxKind =
    options.sandbox ??
    (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')
      ? 'local'
      : 'docker');
  let runningSidecar: Awaited<ReturnType<DockerAllowlistSidecar['start']>> | undefined;
  let sandbox: SandboxProvider;
  if (sandboxKind === 'local') {
    if (options.allowHosts?.length) {
      throw new Error('--allow-host currently requires --sandbox docker');
    }
    sandbox = new MacOSSeatbeltSandbox();
  } else {
    const dockerRunner = new NodeDockerCommandRunner();
    const proxyContext =
      process.env.TINYAI_PROXY_CONTEXT ??
      (existsSync(resolve(__dirname, 'allowlist-proxy'))
        ? resolve(__dirname, 'allowlist-proxy')
        : 'docker/allowlist-proxy');
    const sidecar = options.allowHosts?.length
      ? new DockerAllowlistSidecar({
          runner: dockerRunner,
          contextDir: proxyContext,
        })
      : undefined;
    runningSidecar = sidecar
      ? await sidecar.start({ allowHosts: options.allowHosts! })
      : undefined;
    sandbox = new DockerSandboxProvider({
      runner: dockerRunner,
      ptyRunner: new NodeDockerPtyRunner(),
      image:
        options.image ??
        process.env.TINYAI_SANDBOX_IMAGE ??
        'node:22-bookworm-slim',
      workspaceHostPath: resolve(options.workspace),
      memoryLimit: process.env.TINYAI_SANDBOX_MEMORY ?? '2g',
      cpuLimit: process.env.TINYAI_SANDBOX_CPUS ?? '2',
      pidsLimit: Number(process.env.TINYAI_SANDBOX_PIDS ?? 256),
      ...(runningSidecar
        ? {
            networkName: runningSidecar.networkName,
            containerEnvironment: runningSidecar.environment,
          }
        : {}),
    });
  }
  let lease: WorkspaceLease | undefined;
  let runtime: WorkspaceRuntime | undefined;
  try {
    lease = await sandbox.createWorkspace({
      sessionId: 'coding-cli',
      ...(sandboxKind === 'local' ? { workspaceRoot: resolve(options.workspace) } : {}),
      ttlMs: 2 * 60 * 60 * 1000,
    });
    const activeLease = lease;
    const modes = new PermissionModeRegistry('sandbox-auto', () => Date.now());
    const definitions = createSandboxTools(sandbox, activeLease);
    const projectInstructions = await readProjectInstructions(
      options.workspace
    );
    const tools = new ToolExecutor(definitions, denyApproval, {
      policy: new PolicyEngine((sessionId) => modes.mode(sessionId)),
      approvalReceipts: new InMemoryApprovalReceiptStore(),
      artifacts: {
        store: new InMemoryArtifactStore(),
        thresholdBytes: 64_000,
      },
    });
    runtime = new WorkspaceRuntime({
      model: new OpenAIModelTransport({ baseUrl, apiKey, model }),
      tools,
      clock: systemClock,
      ids: new SequentialIdGenerator(),
      permissionModes: modes,
      systemPromptForMode: (mode) =>
        buildPrompt({
          hostProfile: 'sandbox',
          workspaceProfile: 'legacy',
          mode,
          tools: definitions,
          ...(projectInstructions ? { projectInstructions } : {}),
          runtime: {
            sandboxKind,
          },
        }).fullPrompt,
      maxSteps: Number(process.env.TINYAI_MAX_STEPS ?? 60),
    });
    const ack = await runtime.command({
      commandId: `cli_${Date.now()}`,
      clientId: 'coding-cli',
      sessionId: 'coding-cli',
      type: 'send_input',
      payload: { text: options.task },
      issuedAt: Date.now(),
    });
    if (ack.status !== 'accepted') {
      throw new Error(ack.error?.message ?? `Command ${ack.status}`);
    }
    await runtime.waitForSessionIdle('coding-cli');
    const projection = runtime.getProjection('coding-cli');
    for (const row of projection.rows) {
      if (row.kind === 'tool') {
        process.stderr.write(`[tool:${row.toolName ?? 'unknown'}] ${row.status}\n`);
      }
    }
    const answer = [...projection.rows]
      .reverse()
      .find((row) => row.kind === 'assistant' && row.text.trim())?.text;
    if (answer) process.stdout.write(`${answer}\n`);
    if (projection.taskStatus !== 'completed') {
      throw new Error(projection.lastError?.message ?? `Task ${projection.taskStatus}`);
    }
    const verifier = new Verifier({
      run: async (command, signal) => {
        const result = await sandbox.exec(activeLease, {
          command: command.command,
          args: command.args,
          timeoutMs: command.timeoutMs ?? 120_000,
          signal,
        });
        return {
          exitCode: result.exitCode,
          output: `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`,
          durationMs: result.durationMs,
        };
      },
    });
    const report = await verifier.assertComplete(verification);
    for (const check of report.checks) {
      process.stderr.write(`[verify:${check.name}] ${check.status}\n`);
    }
  } finally {
    await runtime?.dispose();
    if (lease) await sandbox.release(lease).catch(() => undefined);
    await runningSidecar?.close();
  }
}

async function readProjectInstructions(
  workspace: string
): Promise<string | undefined> {
  try {
    const value = await readFile(resolve(workspace, 'AGENTS.md'), 'utf8');
    return value.trim().slice(0, 8000) || undefined;
  } catch {
    return undefined;
  }
}

function parseArgs(args: string[]): CliOptions {
  const values = new Map<string, string>();
  const positional: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (
      arg === '--workspace' ||
      arg === '--task' ||
      arg === '--image' ||
      arg === '--verify' ||
      arg === '--allow-host' ||
      arg === '--sandbox'
    ) {
      const value = args[++index];
      if (!value) throw new Error(`${arg} requires a value`);
      values.set(arg, value);
    } else if (arg === '--help' || arg === '-h') {
      usage();
      process.exit(0);
    } else {
      positional.push(arg);
    }
  }
  const task = values.get('--task') ?? positional.join(' ').trim();
  if (!task) {
    usage();
    throw new Error('A task is required');
  }
  return {
    workspace: values.get('--workspace') ?? process.cwd(),
    task,
    ...(values.get('--image') ? { image: values.get('--image') } : {}),
    ...(values.get('--verify') ? { verify: values.get('--verify') } : {}),
    ...(values.get('--allow-host')
      ? {
          allowHosts: values
            .get('--allow-host')!
            .split(',')
            .map((host) => host.trim())
            .filter(Boolean),
        }
      : {}),
    ...(values.get('--sandbox') === 'local' || values.get('--sandbox') === 'docker'
      ? { sandbox: values.get('--sandbox') as 'local' | 'docker' }
      : {}),
  };
}

async function verificationCommands(
  workspace: string,
  explicit?: string
): Promise<VerificationCommand[]> {
  if (explicit) {
    return [{ name: 'user', command: 'sh', args: ['-lc', explicit] }];
  }
  try {
    const packageJson = JSON.parse(await readFile(resolve(workspace, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const commands: VerificationCommand[] = [];
    if (packageJson.scripts?.typecheck) {
      commands.push({ name: 'typecheck', command: 'npm', args: ['run', 'typecheck'] });
    }
    if (packageJson.scripts?.test) {
      commands.push({ name: 'tests', command: 'npm', args: ['test'] });
    }
    if (commands.length) return commands;
  } catch {
    // Explicit verification is required for projects without package.json.
  }
  throw new Error(
    'No package.json test/typecheck scripts found; pass --verify "command to run"'
  );
}

function usage(): void {
  process.stderr.write(
    'Usage: tinyai-coding-agent --workspace /path/to/project --task "implement and test" [--sandbox local|docker] [--verify "npm test"] [--allow-host registry.npmjs.org]\n'
  );
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
