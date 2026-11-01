import { open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { mkdir } from 'node:fs/promises';
import {
  encodeWorkspaceCapsuleV2Chunks,
  parseWorkspaceCapsuleAuto,
} from '../workspace';
import type { WorkspaceCapsule } from '../workspace';

export async function writeWorkspaceCapsuleFile(
  path: string,
  capsule: WorkspaceCapsule
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'w');
  try {
    for await (const chunk of encodeWorkspaceCapsuleV2Chunks(capsule)) {
      await handle.write(chunk);
    }
  } finally {
    await handle.close();
  }
}

export async function readWorkspaceCapsuleFile(
  path: string
): Promise<WorkspaceCapsule> {
  return parseWorkspaceCapsuleAuto(await readFile(path));
}
