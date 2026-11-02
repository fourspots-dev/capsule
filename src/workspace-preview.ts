(() => {
const params = new URLSearchParams(location.search);
const workspaceId = params.get('workspaceId') ?? '';
const path = params.get('path') ?? '';
const statusNode = document.querySelector<HTMLElement>('#status');
const output = document.querySelector<HTMLElement>('#output');

void load();

async function load(): Promise<void> {
  try {
    const response = (await runtimeRequest({
      type: 'read_workspace_resource',
      workspaceId,
      path,
      requestId: `preview_${crypto.randomUUID()}`,
    })) as {
      dataBase64: string;
      mimeType: string;
    };
    const bytes = base64ToBytes(response.dataBase64);
    if (statusNode) statusNode.textContent = path;
    if (response.mimeType.startsWith('text/html') && output) {
      const frame = document.createElement('iframe');
      frame.src = `data:text/html;charset=utf-8;base64,${bytesToBase64(bytes)}`;
      output.replaceChildren(frame);
    } else if (response.mimeType.startsWith('image/') && output) {
      const url = URL.createObjectURL(
        new Blob([blobBytes(bytes)], { type: response.mimeType })
      );
      const image = document.createElement('img');
      image.src = url;
      output.replaceChildren(image);
    } else if (output) {
      output.textContent = new TextDecoder().decode(bytes);
    }
  } catch (error) {
    if (statusNode) statusNode.textContent = 'Preview failed';
    if (output) {
      output.textContent =
        error instanceof Error ? error.message : String(error);
    }
  }
}

function blobBytes(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function bytesToBase64(value: Uint8Array): string {
  let binary = '';
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function runtimeRequest(
  request: Record<string, unknown>
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'tinyai-runtime-v1' });
    const requestId = String(request.requestId);
    const timeout = setTimeout(() => {
      port.disconnect();
      reject(new Error('Preview runtime request timed out'));
    }, 15_000);
    port.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const value = message as {
        type?: string;
        requestId?: string;
        ok?: boolean;
        data?: unknown;
        error?: { message?: string };
      };
      if (value.requestId !== requestId) return;
      clearTimeout(timeout);
      port.disconnect();
      if (value.ok) resolve(value.data);
      else reject(new Error(value.error?.message ?? 'Preview request failed'));
    });
    port.postMessage(request);
  });
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
})();
