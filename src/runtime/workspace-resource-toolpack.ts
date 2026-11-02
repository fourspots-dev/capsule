import { AgentError } from '../core/errors';
import type { JsonValue, ToolDefinition } from '../core/types';
import {
  workspaceMimeType,
  workspacePath,
  workspaceResourceRef,
  workspaceResourceUri,
} from '../platform/workspace-resource';
import type {
  WorkspaceApplicationObservation,
  WorkspaceInteractionProvider,
} from '../platform/workspace-interaction';
import type { VirtualWorkspace } from '../virtual';

export interface WorkspaceResourceToolOptions {
  workspace: VirtualWorkspace;
  provider: WorkspaceInteractionProvider;
  recordObservation?: (
    observation: WorkspaceApplicationObservation
  ) => Promise<void> | void;
}

export interface WorkspaceResourceTools {
  tools: ToolDefinition[];
  provider: WorkspaceInteractionProvider;
}

export async function createWorkspaceResourceTools(
  options: WorkspaceResourceToolOptions
): Promise<WorkspaceResourceTools> {
  const capabilities = await options.provider.capabilities();
  const tools: ToolDefinition[] = [
    {
      name: 'get_workspace_info',
      description:
        'Describe the current workspace scope and its virtual path semantics.',
      parameters: { type: 'object', properties: {} },
      risk: 'read',
      effect: 'read',
      capabilities: ['filesystem'],
      async execute() {
        const generation = await options.workspace.generation();
        return {
          workspaceId: options.workspace.workspaceId,
          generation,
          pathSemantics: 'workspace-relative-posix',
          fileSystem: 'virtual',
          hostFilesystem: false,
          open: capabilities.open.available,
          export: capabilities.export.available,
          verify: capabilities.verify?.available === true,
        };
      },
    },
  ];
  if (capabilities.open.available && options.provider.open) {
    tools.push({
      name: 'open_workspace_file',
      description:
        'Open a workspace resource in the active host surface. The path is workspace-relative, never a file:// or host path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          intent: {
            type: 'string',
            enum: ['preview', 'edit', 'debug'],
          },
          ephemeral: { type: 'boolean' },
        },
        required: ['path'],
      },
      risk: 'read',
      effect: 'read',
      capabilities: ['filesystem'],
      async execute(input, invocation) {
        const args = asObject(input);
        const path = workspacePath(requiredString(args, 'path'));
        const generation = await options.workspace.generation();
        const resource = workspaceResourceRef({
          workspaceId: options.workspace.workspaceId,
          path,
          generation,
        });
        const result = await options.provider.open!.open(
          resource,
          {
            intent:
              args.intent === 'edit' || args.intent === 'debug'
                ? args.intent
                : 'preview',
            ephemeral: args.ephemeral !== false,
          },
          invocation.signal
        );
        return {
          ...result,
          path,
          resourceUri: workspaceResourceUri(
            options.workspace.workspaceId,
            path
          ),
        } as unknown as JsonValue;
      },
    });
  }
  if (capabilities.export.available && options.provider.export) {
    tools.push({
      name: 'export_workspace_file',
      description:
        'Export a workspace resource to a host-owned destination. Use this before claiming the file can be opened outside tinyai.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
        },
        required: ['path'],
      },
      risk: 'write',
      effect: 'write',
      capabilities: ['filesystem'],
      async execute(input, invocation) {
        const path = workspacePath(requiredString(asObject(input), 'path'));
        const generation = await options.workspace.generation();
        const info = await options.workspace.fs.stat(path);
        if (!info || info.kind !== 'file') {
          throw new AgentError(
            'WORKSPACE_RESOURCE_NOT_FOUND',
            `Workspace resource not found: ${path}`
          );
        }
        return {
          ...(await options.provider.export!.export(
            workspaceResourceRef({
              workspaceId: options.workspace.workspaceId,
              path,
              generation,
            }),
            invocation.signal
          )),
          path,
          mimeType: workspaceMimeType(path),
        } as unknown as JsonValue;
      },
    });
  }
  if (capabilities.verify?.available && options.provider.verify) {
    tools.push({
      name: 'verify_workspace_file',
      description:
        'Load a workspace resource in an isolated host preview and evaluate optional browser assertions. Opening alone is not application verification.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          assertions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                expression: { type: 'string' },
              },
              required: ['name', 'expression'],
            },
          },
        },
        required: ['path'],
      },
      risk: 'dangerous',
      effect: 'execute',
      capabilities: ['filesystem', 'browser:script'],
      async execute(input, invocation) {
        const args = asObject(input);
        const path = workspacePath(requiredString(args, 'path'));
        const generation = await options.workspace.generation();
        const resource = workspaceResourceRef({
          workspaceId: options.workspace.workspaceId,
          path,
          generation,
        });
        const assertions = Array.isArray(args.assertions)
          ? args.assertions.flatMap((value) => {
              const item = asObject(value);
              return typeof item.name === 'string' &&
                typeof item.expression === 'string'
                ? [{ name: item.name, expression: item.expression }]
                : [];
            })
          : [];
        const observation: WorkspaceApplicationObservation = {
          id: `workspace_observation_${crypto.randomUUID()}`,
          sessionId: invocation.sessionId,
          taskId: invocation.taskId,
          createdAt: Date.now(),
          ...(await options.provider.verify!.verify(
            resource,
            { assertions },
            invocation.signal
          )),
        };
        await options.recordObservation?.(observation);
        return observation as unknown as JsonValue;
      },
    });
  }
  return { tools, provider: options.provider };
}

function requiredString(
  input: Record<string, import('../core/types').JsonValue>,
  key: string
): string {
  const value = input[key];
  if (typeof value !== 'string' || !value) {
    throw new AgentError(
      'TOOL_ARGUMENTS_INVALID',
      `Missing required string: ${key}`
    );
  }
  return value;
}

function asObject(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, JsonValue>)
    : {};
}
