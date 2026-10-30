import { AgentError } from './errors';

export interface NetworkPolicyOptions {
  allowHosts: string[];
  allowPrivateNetworks?: boolean;
  allowHttp?: boolean;
  maxRedirects?: number;
}

export interface NetworkDecision {
  allowed: boolean;
  host: string;
  reason?: string;
}

export class NetworkPolicy {
  private readonly allowHosts: string[];
  private readonly allowPrivateNetworks: boolean;
  private readonly allowHttp: boolean;

  constructor(options: NetworkPolicyOptions) {
    this.allowHosts = options.allowHosts.map(normalizeHost).filter(Boolean);
    this.allowPrivateNetworks = options.allowPrivateNetworks ?? false;
    this.allowHttp = options.allowHttp ?? false;
  }

  evaluate(rawUrl: string, resolvedIps: string[] = []): NetworkDecision {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new AgentError('NETWORK_URL_INVALID', `Invalid URL: ${rawUrl}`);
    }
    if (url.protocol !== 'https:' && !(this.allowHttp && url.protocol === 'http:')) {
      return { allowed: false, host: url.hostname, reason: `Scheme ${url.protocol} is denied` };
    }
    if (url.username || url.password) {
      return { allowed: false, host: url.hostname, reason: 'URL credentials are not allowed' };
    }
    const host = normalizeHost(url.hostname);
    if (!this.hostAllowed(host)) {
      return { allowed: false, host, reason: `Host ${host} is not in the allowlist` };
    }
    if (!this.allowPrivateNetworks) {
      const addresses = [...resolvedIps, ...(isIpAddress(host) ? [host] : [])];
      if (addresses.some(isPrivateAddress)) {
        return {
          allowed: false,
          host,
          reason: 'Private, loopback and link-local addresses are denied',
        };
      }
    }
    return { allowed: true, host };
  }

  assert(rawUrl: string, resolvedIps: string[] = []): string {
    const decision = this.evaluate(rawUrl, resolvedIps);
    if (!decision.allowed) {
      throw new AgentError('NETWORK_DENIED', decision.reason ?? 'Network request denied', {
        details: { host: decision.host },
      });
    }
    return decision.host;
  }

  private hostAllowed(host: string): boolean {
    return this.allowHosts.some((allowed) => {
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1);
        return host.endsWith(suffix) && host !== suffix.slice(1);
      }
      return host === allowed;
    });
  }
}

export function isPrivateAddress(value: string): boolean {
  const address = value.toLowerCase().replace(/^\[|\]$/g, '');
  if (address === '::1' || address === '0:0:0:0:0:0:0:1') return true;
  if (address.startsWith('fe80:') || address.startsWith('fc') || address.startsWith('fd')) {
    return true;
  }
  const ipv4 = address.startsWith('::ffff:') ? address.slice(7) : address;
  const parts = ipv4.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':');
}

function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}
