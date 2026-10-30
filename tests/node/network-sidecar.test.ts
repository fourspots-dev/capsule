import { describe, expect, it } from 'vitest';
import type {
  DockerCommandRequest,
  DockerCommandResult,
  DockerCommandRunner,
} from '../../src/adapters/docker-sandbox';
import { DockerAllowlistSidecar } from '../../src/node/network-sidecar';

class FakeRunner implements DockerCommandRunner {
  readonly calls: string[][] = [];
  async run(request: DockerCommandRequest): Promise<DockerCommandResult> {
    this.calls.push(request.args);
    return {
      exitCode: 0,
      stdout: request.args[0] === 'inspect' ? '192.0.2.10\n' : '',
      stderr: '',
      durationMs: 1,
    };
  }
}

describe('DockerAllowlistSidecar', () => {
  it('builds a proxy image and places it on both external and internal networks', async () => {
    const runner = new FakeRunner();
    const sidecar = new DockerAllowlistSidecar({
      runner,
      contextDir: '/repo/docker/allowlist-proxy',
      ids: { next: (prefix) => `${prefix}_1` },
    });
    const running = await sidecar.start({
      allowHosts: ['registry.npmjs.org', '*.github.com'],
    });
    expect(running).toMatchObject({
      networkName: 'tinyai-internal-net_1',
      proxyUrl: 'http://192.0.2.10:8080',
      environment: {
        HTTP_PROXY: 'http://192.0.2.10:8080',
        HTTPS_PROXY: 'http://192.0.2.10:8080',
      },
    });
    expect(runner.calls.find((call) => call[0] === 'run')).toEqual(
      expect.arrayContaining([
        '--network',
        'tinyai-internal-net_1',
        '--network',
        'bridge',
        'TINYAI_ALLOW_HOSTS=registry.npmjs.org,*.github.com',
      ])
    );
    await running.close();
    expect(runner.calls).toEqual(
      expect.arrayContaining([
        ['rm', '-f', 'tinyai-proxy-net_1'],
        ['network', 'rm', 'tinyai-internal-net_1'],
      ])
    );
  });
});
