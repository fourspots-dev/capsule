import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);

export function checkExtensionVersion(root = resolve(dirname(scriptPath), '..')) {
  const packageJson = readJson(resolve(root, 'package.json'));
  const manifest = readJson(resolve(root, 'extension/manifest.json'));
  const errors = [];
  if (!isSemver(packageJson.version)) {
    errors.push(`package.json version is not A.B.C: ${packageJson.version}`);
  }
  if (!isSemver(manifest.version)) {
    errors.push(
      `extension/manifest.json version is not A.B.C: ${manifest.version}`
    );
  }
  if (packageJson.version !== manifest.version) {
    errors.push(
      `extension manifest version ${manifest.version} does not match package.json ${packageJson.version}`
    );
  }
  return {
    errors,
    version: packageJson.version,
    manifestVersion: manifest.version,
  };
}

export function syncExtensionVersion(root = resolve(dirname(scriptPath), '..')) {
  const packagePath = resolve(root, 'package.json');
  const manifestPath = resolve(root, 'extension/manifest.json');
  const packageJson = readJson(packagePath);
  if (!isSemver(packageJson.version)) {
    throw new Error(`package.json version is not A.B.C: ${packageJson.version}`);
  }
  const manifest = readJson(manifestPath);
  if (manifest.version !== packageJson.version) {
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...manifest, version: packageJson.version }, null, 2)}\n`
    );
  }
  return { version: packageJson.version };
}

export function isSemver(value) {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(value));
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(
      `Cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

if (resolve(process.argv[1] ?? '') === scriptPath) {
  const mode = process.argv[2];
  if (mode === 'sync') {
    const result = syncExtensionVersion();
    process.stdout.write(`Extension manifest version: ${result.version}\n`);
  } else if (mode === 'check') {
    const result = checkExtensionVersion();
    if (result.errors.length) {
      process.stderr.write(
        [
          'Extension version check failed:',
          ...result.errors.map((error) => `- ${error}`),
        ].join('\n') + '\n'
      );
      process.exitCode = 1;
    } else {
      process.stdout.write(
        `Extension version OK: ${result.version}\n`
      );
    }
  } else {
    process.stderr.write('Usage: extension-version.mjs <sync|check>\n');
    process.exitCode = 2;
  }
}
