export const DEBUG_SERVICE_KEY = 'tinyai-debug-service';

export interface DebugServiceConfig {
  enabled: boolean;
  endpoint: string;
  token?: string;
}

export function parseDebugServiceConfig(
  value: unknown
): DebugServiceConfig | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const raw = value as Record<string, unknown>;
  const endpoint = normalizeEndpoint(raw.endpoint);
  if (!endpoint) return undefined;
  return {
    enabled: raw.enabled !== false,
    endpoint,
    ...(typeof raw.token === 'string' && raw.token
      ? { token: raw.token }
      : {}),
  };
}

export function normalizeEndpoint(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (
      url.protocol === 'http:' &&
      !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    ) {
      return undefined;
    }
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return undefined;
  }
}

export async function testDebugService(
  config: Pick<DebugServiceConfig, 'endpoint' | 'token'>,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (!config.token) {
    throw new Error('Pairing Token is required');
  }
  const response = await fetchImpl(`${config.endpoint}/healthz`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (!response.ok) {
    throw new Error(`Debug Service health check failed: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as {
    ok?: unknown;
    service?: unknown;
  };
  if (payload.ok !== true || payload.service !== 'tinyai-debug-hub') {
    throw new Error('Endpoint is not a compatible tinyai Debug Hub');
  }
  const authenticated = await fetchImpl(`${config.endpoint}/v1/sessions`, {
    headers: { Authorization: `Bearer ${config.token}` },
  });
  if (authenticated.status === 401) {
    throw new Error('Debug Service rejected the Pairing Token');
  }
  if (!authenticated.ok) {
    throw new Error(
      `Debug Service authentication check failed: HTTP ${authenticated.status}`
    );
  }
}
