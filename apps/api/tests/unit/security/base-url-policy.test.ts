import { describe, expect, it } from 'bun:test';
import {
  UnsafeBaseUrlError,
  validateBaseUrl,
} from '../../../src/services/providers/core/base-url-policy';

function resolveHostnameTo(
  ...results: ReadonlyArray<{ address: string; family: 4 | 6 }>
): (hostname: string) => Promise<ReadonlyArray<{ address: string; family: 4 | 6 }>> {
  return async (_hostname: string) => results;
}

// Bun types Matchers methods as void, but .resolves/.rejects chains are Promises at runtime.
// Cast to Promise<void> where needed to satisfy await-thenable without suppressions.

describe('base-url-policy', () => {
  it('allows a valid public HTTPS URL', async () => {
    expect(
      await validateBaseUrl('https://api.openai.com/v1', {
        resolveHostname: resolveHostnameTo({ address: '104.18.33.45', family: 4 }),
      })
    ).toBeUndefined();
  });

  it('rejects non-http(s) schemes', async () => {
    await (expect(validateBaseUrl('ftp://example.com')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
    await (expect(validateBaseUrl('file:///etc/passwd')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects invalid URLs', async () => {
    await (expect(validateBaseUrl('not-a-url')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects IPv4 loopback', async () => {
    await (expect(validateBaseUrl('http://127.0.0.1/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
    await (expect(validateBaseUrl('http://127.0.0.99/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects RFC1918 private ranges', async () => {
    await (expect(validateBaseUrl('http://10.0.0.1/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
    await (expect(validateBaseUrl('http://172.16.0.1/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
    await (expect(validateBaseUrl('http://192.168.1.1/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects link-local IPv4', async () => {
    await (expect(validateBaseUrl('http://169.254.1.1/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects 0.0.0.0', async () => {
    await (expect(validateBaseUrl('http://0.0.0.0/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects IPv6 loopback', async () => {
    await (expect(validateBaseUrl('http://[::1]/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects IPv6 link-local', async () => {
    await (expect(validateBaseUrl('http://[fe80::1]/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
  });

  it('rejects hostnames that resolve to blocked private addresses', async () => {
    await (expect(
      validateBaseUrl('https://models.example.test/v1', {
        resolveHostname: resolveHostnameTo({ address: '10.1.2.3', family: 4 }),
      })
    ).rejects.toThrow(UnsafeBaseUrlError) as unknown as Promise<void>);
  });

  it('wraps resolver failures with the hostname context', async () => {
    await (expect(
      validateBaseUrl('https://offline.example.test/v1', {
        resolveHostname: () => {
          throw new Error('network unreachable');
        },
      })
    ).rejects.toThrow(
      'DNS resolution failed for hostname "offline.example.test".'
    ) as unknown as Promise<void>);
  });
});
