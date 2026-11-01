import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkExtensionVersion,
  syncExtensionVersion,
} from '../../scripts/extension-version.mjs';

describe('REQ-ENG-008 extension version synchronization', () => {
  it('keeps the checked-in extension manifest at the product version', () => {
    const result = checkExtensionVersion();
    expect(result.errors).toEqual([]);
    expect(result.manifestVersion).toBe(result.version);
  });

  it('syncs a drifted manifest and detects invalid versions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tinyai-extension-version-'));
    try {
      await mkdir(join(root, 'extension'), { recursive: true });
      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ version: '1.2.3' })
      );
      const manifestPath = join(root, 'extension/manifest.json');
      await writeFile(
        manifestPath,
        JSON.stringify({ manifest_version: 3, version: '0.1.0' })
      );
      expect(checkExtensionVersion(root).errors).toContainEqual(
        expect.stringContaining('does not match')
      );
      syncExtensionVersion(root);
      expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toMatchObject({
        manifest_version: 3,
        version: '1.2.3',
      });
      expect(checkExtensionVersion(root).errors).toEqual([]);

      await writeFile(
        join(root, 'package.json'),
        JSON.stringify({ version: 'latest' })
      );
      expect(checkExtensionVersion(root).errors).toContainEqual(
        expect.stringContaining('not A.B.C')
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
