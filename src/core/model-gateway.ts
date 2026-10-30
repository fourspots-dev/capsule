import type { ModelTransport } from './ports';
import type { ModelEvent, ModelRequest, StructuredError } from './types';

export interface ModelTarget {
  id: string;
  transport: ModelTransport;
  attempts?: number;
}

export interface ModelGatewayOptions {
  targets: ModelTarget[];
  delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export class ModelGateway implements ModelTransport {
  constructor(private readonly options: ModelGatewayOptions) {
    if (options.targets.length === 0) throw new Error('ModelGateway requires at least one target');
  }

  async *stream(request: ModelRequest): AsyncIterable<ModelEvent> {
    let lastError: StructuredError | undefined;
    for (const target of this.options.targets) {
      const attempts = Math.max(1, target.attempts ?? 1);
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        if (request.signal.aborted) return;
        let produced = false;
        try {
          for await (const event of target.transport.stream(request)) {
            if (event.type === 'error') {
              lastError = event.error;
              if (event.error.retryable && !produced) break;
              yield event;
              return;
            }
            produced = true;
            yield event;
          }
          if (!produced) {
            if (request.signal.aborted) return;
            continue;
          }
          return;
        } catch (error) {
          lastError = {
            code: request.signal.aborted ? 'MODEL_ABORTED' : 'MODEL_TARGET_FAILED',
            message: error instanceof Error ? error.message : String(error),
            retryable: !request.signal.aborted,
            details: { targetId: target.id, attempt: attempt + 1 },
          };
          if (request.signal.aborted) return;
          if (produced) {
            yield { type: 'error', error: lastError };
            return;
          }
        }
        if (attempt + 1 < attempts) {
          await (this.options.delay ?? delay)(Math.min(2_000, 200 * 2 ** attempt), request.signal);
        }
      }
    }
    yield {
      type: 'error',
      error: lastError ?? {
        code: 'MODEL_NO_TARGET',
        message: 'No model target completed the request',
        retryable: false,
      },
    };
  }
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
