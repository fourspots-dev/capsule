import { resolve } from 'node:path';
import type { DockerCommandRunner } from '../adapters/docker-sandbox';
import { AgentError } from '../core/errors';

export interface DockerSidecarOptions {
  runner: DockerCommandRunner;
  image?: string;
  contextDir: string;
  ids?: { next(prefix: string): string };
  proxyPort?: number;
}

export interface RunningDockerSidecar {
  networkName: string;
  proxyUrl: string;
  environment: Record<string, string>;
  close(): Promise<void>;
}

export class DockerAllowlistSidecar {
  private readonly image: string;
  private readonly ids: { next(prefix: string): string };
  private readonly proxyPort: number;

  constructor(private readonly options: DockerSidecarOptions) {
    this.image = options.image ?? 'tinyai-allowlist-proxy:local';
    let sequence = 0;
    this.ids = options.ids ?? { next: (prefix) => `${prefix}_${++sequence}` };
    this.proxyPort = options.proxyPort ?? 8080;
  }

  async start(request: {
    allowHosts: string[];
    allowPrivateNetworks?: boolean;
    allowHttp?: boolean;
  }): Promise<RunningDockerSidecar> {
    if (request.allowHosts.length === 0) {
      throw new AgentError('PROXY_ALLOWLIST_EMPTY', 'At least one allowed host is required');
    }
    const suffix = this.ids.next('net');
    const networkName = `tinyai-internal-${suffix}`;
    const containerName = `tinyai-proxy-${suffix}`;
    const contextDir = resolve(this.options.contextDir);
    await this.expect(
      ['build', '-t', this.image, '-f', resolve(contextDir, 'Dockerfile'), contextDir],
      'SIDECAR_BUILD_FAILED'
    );
    await this.expect(
      ['network', 'create', '--internal', networkName],
      'SIDECAR_NETWORK_FAILED'
    );
    try {
      await this.expect(
        [
          'run',
          '-d',
          '--rm',
          '--name',
          containerName,
          '--network',
          networkName,
          '--network',
          'bridge',
          '--env',
          `TINYAI_ALLOW_HOSTS=${request.allowHosts.join(',')}`,
          '--env',
          `TINYAI_ALLOW_PRIVATE=${request.allowPrivateNetworks === true}`,
          '--env',
          `TINYAI_ALLOW_HTTP=${request.allowHttp !== false}`,
          '--env',
          `TINYAI_PROXY_PORT=${this.proxyPort}`,
          this.image,
        ],
        'SIDECAR_START_FAILED'
      );
      const ip = (
        await this.expect(
          [
            'inspect',
            '-f',
            `{{(index .NetworkSettings.Networks "${networkName}").IPAddress}}`,
            containerName,
          ],
          'SIDECAR_INSPECT_FAILED'
        )
      ).stdout.trim();
      if (!ip) throw new AgentError('SIDECAR_IP_MISSING', 'Proxy sidecar has no internal IP');
      const proxyUrl = `http://${ip}:${this.proxyPort}`;
      return {
        networkName,
        proxyUrl,
        environment: {
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          NO_PROXY: '127.0.0.1,localhost',
        },
        close: async () => {
          await this.options.runner
            .run({ args: ['rm', '-f', containerName], timeoutMs: 30_000 })
            .catch(() => undefined);
          await this.options.runner
            .run({ args: ['network', 'rm', networkName], timeoutMs: 30_000 })
            .catch(() => undefined);
        },
      };
    } catch (error) {
      await this.options.runner
        .run({ args: ['rm', '-f', containerName], timeoutMs: 30_000 })
        .catch(() => undefined);
      await this.options.runner
        .run({ args: ['network', 'rm', networkName], timeoutMs: 30_000 })
        .catch(() => undefined);
      throw error;
    }
  }

  private async expect(args: string[], code: string) {
    const result = await this.options.runner.run({ args, timeoutMs: 120_000 });
    if (result.exitCode !== 0) {
      throw new AgentError(code, result.stderr.trim() || `docker ${args[0]} failed`, {
        details: { exitCode: result.exitCode },
      });
    }
    return result;
  }
}
