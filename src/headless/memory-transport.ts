import type { RuntimePort } from '../runtime/protocol';

export interface RuntimePortPair {
  client: RuntimePort;
  server: RuntimePort;
  dispose(): void;
}

export function createRuntimePortPair(): RuntimePortPair {
  let clientConnected = true;
  let serverConnected = true;
  const clientMessages = new Set<(message: unknown) => void>();
  const serverMessages = new Set<(message: unknown) => void>();
  const clientDisconnect = new Set<() => void>();
  const serverDisconnect = new Set<() => void>();
  const client: RuntimePort = {
    postMessage: (message) => {
      if (!serverConnected) return;
      queueMicrotask(() => {
        for (const listener of serverMessages) listener(message);
      });
    },
    onMessage: {
      addListener: (listener) => clientMessages.add(listener as (message: unknown) => void),
      removeListener: (listener) =>
        clientMessages.delete(listener as (message: unknown) => void),
    },
    onDisconnect: {
      addListener: (listener) => clientDisconnect.add(listener),
      removeListener: (listener) => clientDisconnect.delete(listener),
    },
  };
  const server: RuntimePort = {
    postMessage: (message) => {
      if (!clientConnected) return;
      queueMicrotask(() => {
        for (const listener of clientMessages) listener(message);
      });
    },
    onMessage: {
      addListener: (listener) => serverMessages.add(listener as (message: unknown) => void),
      removeListener: (listener) =>
        serverMessages.delete(listener as (message: unknown) => void),
    },
    onDisconnect: {
      addListener: (listener) => serverDisconnect.add(listener),
      removeListener: (listener) => serverDisconnect.delete(listener),
    },
  };
  return {
    client,
    server,
    dispose() {
      if (!clientConnected && !serverConnected) return;
      clientConnected = false;
      serverConnected = false;
      for (const listener of clientDisconnect) listener();
      for (const listener of serverDisconnect) listener();
      clientMessages.clear();
      serverMessages.clear();
      clientDisconnect.clear();
      serverDisconnect.clear();
    },
  };
}
