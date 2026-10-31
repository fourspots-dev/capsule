import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('src');
const allowedRoots = [resolve(root, 'core'), resolve(root, 'platform')];
const failures = [];

for (const directory of allowedRoots) {
  for (const file of await files(directory)) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      const specifier = match[1];
      if (!specifier.startsWith('.')) continue;
      const target = resolve(file, '..', specifier);
      if (
        !allowedRoots.some(
          (allowed) => target === allowed || target.startsWith(`${allowed}/`)
        )
      ) {
        failures.push(`${file}: forbidden import ${specifier}`);
      }
      if (/(^|\/)(adapters|sidepanel|chrome)(\/|$)/.test(specifier)) {
        failures.push(`${file}: browser import ${specifier}`);
      }
    }
  }
}

if (failures.length) {
  console.error(failures.join('\n'));
  process.exit(1);
}

console.log('Core boundary check passed');

async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}
