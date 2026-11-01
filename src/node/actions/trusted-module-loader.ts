import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { AgentError } from '../../core/errors';
import type { HostActionProvider } from '../../platform/host-action';

export interface TrustedActionModuleSpec {
  path: string;
  sha256?: string;
  expectedId?: string;
}

export interface TrustedActionModuleContext {
  id: string;
  modulePath: string;
  workspaceRoot?: string;
}

export interface TrustedActionModuleV1 {
  apiVersion: 1;
  id: string;
  create(
    context: TrustedActionModuleContext
  ): HostActionProvider | Promise<HostActionProvider>;
}

export interface LoadedActionModule {
  id: string;
  path: string;
  sha256: string;
  provider: HostActionProvider;
}

/**
 * Loads only explicitly configured absolute provider modules. Project files are
 * never discovered or imported implicitly.
 */
export class TrustedActionModuleLoader {
  private readonly allowedModules: readonly TrustedActionModuleSpec[];

  constructor(
    options: {
      allowedModules: readonly TrustedActionModuleSpec[];
      workspaceRoot?: string;
    }
  ) {
    this.allowedModules = options.allowedModules.map((module) => {
      if (!isAbsolute(module.path)) {
        throw new AgentError(
          'ACTION_MODULE_NOT_ALLOWED',
          `Action module path must be absolute: ${module.path}`
        );
      }
      return {
        ...module,
        path: resolve(module.path),
        ...(module.sha256
          ? { sha256: module.sha256.toLowerCase() }
          : {}),
      };
    });
    this.workspaceRoot = options.workspaceRoot
      ? resolve(options.workspaceRoot)
      : undefined;
  }

  private readonly workspaceRoot?: string;

  async load(requestedPath: string): Promise<LoadedActionModule> {
    if (!isAbsolute(requestedPath)) {
      throw new AgentError(
        'ACTION_MODULE_NOT_ALLOWED',
        `Action module path must be absolute: ${requestedPath}`
      );
    }
    const resolvedRequested = resolve(requestedPath);
    const spec = this.allowedModules.find(
      (module) => module.path === resolvedRequested
    );
    if (!spec) {
      throw new AgentError(
        'ACTION_MODULE_NOT_ALLOWED',
        `Action module is not allowlisted: ${requestedPath}`
      );
    }
    const canonical = await realpath(resolvedRequested).catch(() => undefined);
    if (!canonical) {
      throw new AgentError(
        'ACTION_MODULE_NOT_FOUND',
        `Action module does not exist: ${requestedPath}`
      );
    }
    const bytes = await readFile(canonical);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (spec.sha256 && spec.sha256 !== sha256) {
      throw new AgentError(
        'ACTION_MODULE_HASH_MISMATCH',
        `Action module hash does not match the trusted manifest: ${requestedPath}`
      );
    }

    let namespace: Record<string, unknown>;
    try {
      namespace = (await import(
        `${pathToFileURL(canonical).href}?tinyaiSha256=${sha256}`
      )) as Record<string, unknown>;
    } catch (error) {
      throw new AgentError(
        'ACTION_MODULE_LOAD_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
    const definition = (namespace.actionModule ?? namespace.default) as
      | Partial<TrustedActionModuleV1>
      | undefined;
    if (
      !definition ||
      definition.apiVersion !== 1 ||
      typeof definition.id !== 'string' ||
      !definition.id.trim() ||
      typeof definition.create !== 'function'
    ) {
      throw new AgentError(
        'ACTION_MODULE_INVALID',
        `Action module must export an apiVersion 1 module with id and create(): ${requestedPath}`
      );
    }
    if (spec.expectedId && definition.id !== spec.expectedId) {
      throw new AgentError(
        'ACTION_MODULE_ID_MISMATCH',
        `Action module id ${definition.id} does not match ${spec.expectedId}`
      );
    }

    let provider: HostActionProvider;
    try {
      provider = await definition.create({
        id: definition.id,
        modulePath: canonical,
        ...(this.workspaceRoot ? { workspaceRoot: this.workspaceRoot } : {}),
      });
    } catch (error) {
      throw new AgentError(
        'ACTION_PROVIDER_INIT_FAILED',
        error instanceof Error ? error.message : String(error)
      );
    }
    if (
      !provider ||
      typeof provider.describe !== 'function' ||
      typeof provider.invoke !== 'function'
    ) {
      throw new AgentError(
        'ACTION_PROVIDER_INVALID',
        `Action module ${definition.id} did not create a valid provider`
      );
    }
    return {
      id: definition.id,
      path: canonical,
      sha256,
      provider,
    };
  }
}
