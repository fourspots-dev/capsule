export interface RuntimeExtensionRequest {
  type: string;
  requestId?: string;
  [key: string]: unknown;
}

export type RuntimeExtensionResult =
  | { handled: false }
  | { handled: true; data?: unknown };

export interface RuntimeExtension {
  tryHandle(request: RuntimeExtensionRequest): Promise<RuntimeExtensionResult>;
  beforeDeleteSession?(sessionId: string): Promise<void>;
  beforeClearHistory?(): Promise<void>;
  dispose?(): Promise<void> | void;
}
