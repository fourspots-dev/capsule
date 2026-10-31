import { chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hook = resolve(root, '.githooks/commit-msg');
chmodSync(hook, 0o755);
const result = spawnSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);
process.stdout.write('Git commit-msg hook installed from .githooks\n');
