import { describe, expect, it } from 'vitest';
import { NetworkPolicy, isPrivateAddress } from '../../src/core/network-policy';

describe('NetworkPolicy', () => {
  it('allows only https hosts matching exact or subdomain allowlist entries', () => {
    const policy = new NetworkPolicy({
      allowHosts: ['api.example.com', '*.trusted.dev'],
    });
    expect(policy.assert('https://api.example.com/v1')).toBe('api.example.com');
    expect(policy.assert('https://docs.trusted.dev/page')).toBe('docs.trusted.dev');
    expect(policy.evaluate('https://trusted.dev')).toMatchObject({ allowed: false });
    expect(policy.evaluate('https://evil.example.net')).toMatchObject({ allowed: false });
    expect(policy.evaluate('http://api.example.com')).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Scheme'),
    });
  });

  it('rejects private destinations after DNS resolution', () => {
    const policy = new NetworkPolicy({ allowHosts: ['api.example.com'] });
    expect(policy.evaluate('https://api.example.com', ['93.184.216.34'])).toMatchObject({
      allowed: true,
    });
    expect(policy.evaluate('https://api.example.com', ['127.0.0.1'])).toMatchObject({
      allowed: false,
      reason: expect.stringContaining('Private'),
    });
    expect(policy.evaluate('https://api.example.com', ['::ffff:192.168.1.2'])).toMatchObject({
      allowed: false,
    });
  });

  it('covers loopback, link-local, private, CGNAT and multicast IPv4 ranges', () => {
    for (const address of [
      '127.0.0.1',
      '10.1.2.3',
      '169.254.1.1',
      '172.16.5.5',
      '192.168.0.1',
      '100.64.0.1',
      '224.0.0.1',
      '::1',
      'fe80::1',
      'fd00::1',
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    expect(isPrivateAddress('8.8.8.8')).toBe(false);
  });
});
