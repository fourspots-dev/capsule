import { ChromeArtifactStore } from '../../src/adapters/chrome-artifact-store';
import {
  ChromeHostBridge,
  type ChromeStorageArea,
} from '../../src/adapters/chrome-host';
import { ChromeSessionStore } from '../../src/adapters/chrome-session-store';
import { PortableGitBackend } from '../../src/git/backend';
import { VirtualWorkspace } from '../../src/virtual';
import {
  parseWorkspaceCapsuleAuto,
  serializeWorkspaceCapsuleV2,
} from '../../src/workspace/capsule-v2';
import { WorkspaceContinuityService } from '../../src/workspace/continuity';

class MemoryChromeStorage implements ChromeStorageArea {
  private readonly values = new Map<string, unknown>();

  async get(keys: string | string[] | null): Promise<Record<string, unknown>> {
    if (keys === null) {
      return Object.fromEntries(this.values);
    }
    const selected = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(
      selected.flatMap((key) =>
        this.values.has(key) ? [[key, structuredClone(this.values.get(key))]] : []
      )
    );
  }

  async set(items: Record<string, unknown>): Promise<void> {
    for (const [key, value] of Object.entries(items)) {
      this.values.set(key, structuredClone(value));
    }
  }

  async remove(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      this.values.delete(key);
    }
  }
}

async function importAndStage(capsuleBase64: string, environmentId: string) {
  const storage = new MemoryChromeStorage();
  const host = new ChromeHostBridge({
    storage,
    id: 'chrome-capsule-harness',
  });
  const workspace = new VirtualWorkspace({
    host,
    storageKey: 'tinyai:chrome-harness-workspace',
  });
  const git = new PortableGitBackend(workspace.fs);
  const sessions = new ChromeSessionStore({ storage });
  const artifacts = new ChromeArtifactStore(storage);
  const continuity = new WorkspaceContinuityService({
    workspaceId: 'tinyai-browser-workspace',
    vfs: workspace.fs,
    git,
    sessions,
    artifacts,
    environmentId,
    hostProfile: 'browser-agent',
    agentVersion: '0.12.3',
    newId: () => `capsule_${crypto.randomUUID()}`,
    environment: {
      manifestVersion: 1,
      requiredActions: [],
      requiredCapabilities: ['filesystem', 'git', 'storage'],
    },
  });
  const capsule = await parseWorkspaceCapsuleAuto(base64ToBytes(capsuleBase64));
  const prepared = await continuity.prepareImport(capsule);
  const imported = await continuity.commitImport(prepared, {
    replaceProject: true,
  });
  const exported = await continuity.exportCapsule();
  const files: Record<string, { base64: string; mime: string }> = {};
  for (const file of exported.partitions.project.files) {
    files[file.path] = {
      base64: file.dataBase64,
      mime: mimeFor(file.path),
    };
  }
  return {
    imported,
    exportedCapsuleBase64: bytesToBase64(
      await serializeWorkspaceCapsuleV2(exported)
    ),
    sessions: await sessions.list(),
    gitLog: await git.log({ maxCount: 20 }),
    capability: host.descriptor,
    files,
  };
}

function stageGame(
  files: Record<string, { base64: string; mime: string }>
): HTMLIFrameElement {
  const urls = new Map<string, string>();
  for (const [path, file] of Object.entries(files)) {
    urls.set(
      path,
      URL.createObjectURL(
        new Blob([toArrayBuffer(base64ToBytes(file.base64))], {
          type: file.mime,
        })
      )
    );
  }
  const htmlFile = files['index.html'];
  if (!htmlFile) throw new Error('Capsule does not contain index.html');
  let html = new TextDecoder().decode(base64ToBytes(htmlFile.base64));
  html = html.replace(
    /href="([^"]+)"/g,
    (match, path: string) => (urls.has(path) ? `href="${urls.get(path)}"` : match)
  );
  html = html.replace(
    /src="([^"]+)"/g,
    (match, path: string) => (urls.has(path) ? `src="${urls.get(path)}"` : match)
  );
  const iframe = document.createElement('iframe');
  iframe.id = 'tinyai-game-frame';
  iframe.style.cssText = 'width:100vw;height:100vh;border:0;display:block';
  iframe.srcdoc = html;
  document.body.replaceChildren(iframe);
  return iframe;
}

declare global {
  interface Window {
    tinyaiChromeHarness: {
      importAndStage: typeof importAndStage;
      stageGame: typeof stageGame;
    };
  }
}

window.tinyaiChromeHarness = {
  importAndStage,
  stageGame,
};

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    result[index] = binary.charCodeAt(index);
  }
  return result;
}

function bytesToBase64(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function mimeFor(path: string): string {
  if (path.endsWith('.html')) return 'text/html;charset=utf-8';
  if (path.endsWith('.css')) return 'text/css;charset=utf-8';
  if (path.endsWith('.js')) return 'text/javascript;charset=utf-8';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.md')) return 'text/markdown;charset=utf-8';
  if (path.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function toArrayBuffer(data: Uint8Array): ArrayBuffer {
  return data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;
}
