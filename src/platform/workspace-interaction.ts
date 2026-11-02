import type {
  WorkspaceResourceRef,
} from './workspace-resource';

export type WorkspaceOpenMode =
  | 'embedded-preview'
  | 'external-window'
  | 'native-app'
  | 'handoff';

export type WorkspaceExportDestination =
  | 'download'
  | 'host-path'
  | 'share';

export interface WorkspaceOpenCapabilities {
  available: boolean;
  modes: WorkspaceOpenMode[];
  mimeTypes?: string[];
}

export interface WorkspaceExportCapabilities {
  available: boolean;
  destinations: WorkspaceExportDestination[];
}

export interface WorkspaceInteractionCapabilities {
  open: WorkspaceOpenCapabilities;
  export: WorkspaceExportCapabilities;
  verify?: WorkspaceVerifyCapabilities;
}

export interface WorkspaceVerifyCapabilities {
  available: boolean;
  assertions: boolean;
  console: boolean;
  screenshot: boolean;
}

export interface WorkspaceOpenResult {
  mode: WorkspaceOpenMode;
  resource: WorkspaceResourceRef;
  targetId?: string;
}

export interface WorkspaceExportResult {
  artifactId: string;
  displayName: string;
  bytes: number;
  destination: WorkspaceExportDestination;
}

export interface WorkspaceOpenPort {
  capabilities(): Promise<WorkspaceOpenCapabilities>;
  open(
    resource: WorkspaceResourceRef,
    options: {
      intent: 'preview' | 'edit' | 'debug';
      ephemeral: boolean;
    },
    signal?: AbortSignal
  ): Promise<WorkspaceOpenResult>;
  close?(targetId: string): Promise<void>;
}

export interface WorkspaceExportPort {
  capabilities(): Promise<WorkspaceExportCapabilities>;
  export(
    resource: WorkspaceResourceRef,
    signal?: AbortSignal
  ): Promise<WorkspaceExportResult>;
}

export interface WorkspaceApplicationObservation {
  id: string;
  sessionId: string;
  taskId: string;
  workspaceId: string;
  path: string;
  workspaceGeneration: number;
  loaded: boolean;
  consoleErrors: string[];
  assertions: Array<{ name: string; passed: boolean; detail?: string }>;
  screenshotArtifactId?: string;
  createdAt: number;
}

export interface WorkspaceVerificationPort {
  capabilities(): Promise<WorkspaceVerifyCapabilities>;
  verify(
    resource: WorkspaceResourceRef,
    options: {
      assertions?: ReadonlyArray<{ name: string; expression: string }>;
    },
    signal?: AbortSignal
  ): Promise<Omit<
    WorkspaceApplicationObservation,
    'id' | 'sessionId' | 'taskId' | 'createdAt'
  >>;
}

export interface WorkspaceInteractionProvider {
  readonly hostId: string;
  capabilities(): Promise<WorkspaceInteractionCapabilities>;
  open?: WorkspaceOpenPort;
  export?: WorkspaceExportPort;
  verify?: WorkspaceVerificationPort;
}

export const unsupportedWorkspaceOpen = {
  available: false,
  modes: [],
} satisfies WorkspaceOpenCapabilities;

export const unsupportedWorkspaceExport = {
  available: false,
  destinations: [],
} satisfies WorkspaceExportCapabilities;

export const unsupportedWorkspaceVerify = {
  available: false,
  assertions: false,
  console: false,
  screenshot: false,
} satisfies WorkspaceVerifyCapabilities;
