import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const root = resolve(import.meta.dirname, '..');
const stagingRoot = await mkdtemp(join(tmpdir(), 'tinyai-package-'));
const stagedExtension = join(stagingRoot, 'extension');

try {
  await mkdir(resolve(root, 'dist'), { recursive: true });
  await cp(resolve(root, 'extension'), stagedExtension, { recursive: true });
  await rm(resolve(root, 'dist/tinyai-extension.zip'), { force: true });
  await run('zip', ['-qr', resolve(root, 'dist/tinyai-extension.zip'), 'extension'], stagingRoot);
  process.stdout.write('dist/tinyai-extension.zip\n');
} finally {
  await rm(stagingRoot, { recursive: true, force: true });
}

function run(command, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolveRun();
      else reject(new Error(`${command} exited with code ${code}`));
    });
  });
}
