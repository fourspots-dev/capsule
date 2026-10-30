import { AgentError } from './errors';

export interface SecretLease {
  leaseId: string;
  taskId: string;
  secretIds: string[];
  expiresAt: number;
}

interface SecretRecord {
  value: string;
  allowedTaskIds: Set<string>;
}

export class InMemorySecretBroker {
  private readonly secrets = new Map<string, SecretRecord>();
  private readonly leases = new Map<string, SecretLease>();
  private sequence = 0;

  constructor(private readonly now: () => number = () => Date.now()) {}

  register(secretId: string, value: string, allowedTaskIds: string[]): void {
    if (!secretId.trim() || !value) {
      throw new AgentError('SECRET_INVALID', 'Secret id and value are required');
    }
    this.secrets.set(secretId, {
      value,
      allowedTaskIds: new Set(allowedTaskIds),
    });
  }

  issue(taskId: string, secretIds: string[], ttlMs = 300_000): SecretLease {
    for (const secretId of secretIds) {
      const secret = this.secrets.get(secretId);
      if (!secret) throw new AgentError('SECRET_NOT_FOUND', `Secret not found: ${secretId}`);
      if (!secret.allowedTaskIds.has(taskId)) {
        throw new AgentError('SECRET_DENIED', `Secret ${secretId} is not scoped to task ${taskId}`);
      }
    }
    const lease: SecretLease = {
      leaseId: `secret_lease_${++this.sequence}`,
      taskId,
      secretIds: [...secretIds],
      expiresAt: this.now() + ttlMs,
    };
    this.leases.set(lease.leaseId, lease);
    return { ...lease, secretIds: [...lease.secretIds] };
  }

  resolve(lease: SecretLease, secretId: string): string {
    const current = this.leases.get(lease.leaseId);
    if (!current || current.expiresAt <= this.now()) {
      throw new AgentError('SECRET_LEASE_INVALID', 'Secret lease is invalid or expired');
    }
    if (!current.secretIds.includes(secretId)) {
      throw new AgentError('SECRET_DENIED', `Secret ${secretId} is not in this lease`);
    }
    const secret = this.secrets.get(secretId);
    if (!secret) throw new AgentError('SECRET_NOT_FOUND', `Secret not found: ${secretId}`);
    return secret.value;
  }

  redact(lease: SecretLease, text: string): string {
    let redacted = text;
    for (const secretId of lease.secretIds) {
      const value = this.resolve(lease, secretId);
      redacted = redacted.split(value).join('[REDACTED]');
    }
    return redacted;
  }

  revoke(leaseId: string): boolean {
    return this.leases.delete(leaseId);
  }
}
