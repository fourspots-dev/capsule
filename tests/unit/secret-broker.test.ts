import { describe, expect, it } from 'vitest';
import { InMemorySecretBroker } from '../../src/core/secret-broker';

describe('InMemorySecretBroker', () => {
  it('scopes secrets to tasks and redacts leased values from logs', () => {
    let now = 10;
    const broker = new InMemorySecretBroker(() => now);
    broker.register('npm-token', 'super-secret', ['task_1']);
    expect(() => broker.issue('task_2', ['npm-token'])).toThrowError(/not scoped/);
    const lease = broker.issue('task_1', ['npm-token'], 20);
    expect(broker.resolve(lease, 'npm-token')).toBe('super-secret');
    expect(broker.redact(lease, 'token=super-secret')).toBe('token=[REDACTED]');
    now = 31;
    expect(() => broker.resolve(lease, 'npm-token')).toThrowError(/expired/);
  });

  it('revokes leases explicitly', () => {
    const broker = new InMemorySecretBroker();
    broker.register('key', 'value', ['task']);
    const lease = broker.issue('task', ['key']);
    expect(broker.revoke(lease.leaseId)).toBe(true);
    expect(() => broker.resolve(lease, 'key')).toThrowError(/invalid or expired/);
  });
});
