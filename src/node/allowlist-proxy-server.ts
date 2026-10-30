import { AllowlistProxy } from './allowlist-proxy';

async function main(): Promise<void> {
  const allowHosts = (process.env.TINYAI_ALLOW_HOSTS ?? '')
    .split(',')
    .map((host) => host.trim())
    .filter(Boolean);
  if (allowHosts.length === 0) {
    throw new Error('TINYAI_ALLOW_HOSTS must contain at least one host');
  }

  const proxy = new AllowlistProxy({
    host: '0.0.0.0',
    port: Number(process.env.TINYAI_PROXY_PORT ?? 8080),
    allowHosts,
    allowPrivateNetworks: process.env.TINYAI_ALLOW_PRIVATE === 'true',
    allowHttp: process.env.TINYAI_ALLOW_HTTP !== 'false',
  });

  const port = await proxy.start();
  process.stdout.write(`tinyai allowlist proxy listening on ${port}\n`);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void proxy.close().finally(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
