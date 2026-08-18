import { describe, expect, it } from 'bun:test';
import {
  UnsafeBaseUrlError,
  validateBaseUrl,
} from '../../../src/services/providers/core/base-url-policy';
import { ADDRESS_FIXTURES } from '../lib/ip-address.fixtures';

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

  it('rejects IPv6 link-local across the whole /10, not just the fe80 prefix', async () => {
    // fe80::/10 runs to febf::. Matching the text "fe80" covers a sixteenth of
    // the range and lets the rest of it reach an interface-local peer.
    for (const address of ['fe80::1', 'fe81::1', 'febf:ffff::1']) {
      await (expect(validateBaseUrl(`http://[${address}]/v1`)).rejects.toThrow(
        UnsafeBaseUrlError
      ) as unknown as Promise<void>);
    }
  });

  it('rejects IPv6 unique-local addresses', async () => {
    // fc00::/7 is the v6 equivalent of RFC1918 and spans both fc.. and fd..,
    // the half that container and mesh networks actually hand out.
    for (const address of ['fc00::1', 'fd12:3456:789a::1']) {
      await (expect(validateBaseUrl(`http://[${address}]/v1`)).rejects.toThrow(
        UnsafeBaseUrlError
      ) as unknown as Promise<void>);
    }
  });

  it('rejects the IPv6 unspecified address and ignores a scope id', async () => {
    await (expect(validateBaseUrl('http://[::]/v1')).rejects.toThrow(
      UnsafeBaseUrlError
    ) as unknown as Promise<void>);
    await (expect(
      validateBaseUrl('https://mesh.example.test/v1', {
        resolveHostname: resolveHostnameTo({ address: 'fe80::1%eth0', family: 6 }),
      })
    ).rejects.toThrow(UnsafeBaseUrlError) as unknown as Promise<void>);
  });

  it('rejects IPv4-mapped IPv6 whichever way the address is written', async () => {
    // `new URL()` rewrites `[::ffff:127.0.0.1]` as `[::ffff:7f00:1]`, so the
    // dotted form a blocklist is written against is not the form that arrives.
    // Both spellings name the same host and both have to be refused.
    for (const address of [
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
      '::ffff:10.0.0.1',
      '::ffff:c0a8:1',
    ]) {
      await (expect(validateBaseUrl(`http://[${address}]/v1`)).rejects.toThrow(
        UnsafeBaseUrlError
      ) as unknown as Promise<void>);
    }
  });

  it('rejects IPv4-compatible IPv6 and fully expanded loopback', async () => {
    // `::7f00:1` is the deprecated v4-compatible form of 127.0.0.1, and a
    // resolver is free to answer with unabbreviated text.
    for (const address of ['::7f00:1', '::127.0.0.1', '0:0:0:0:0:0:0:1']) {
      await (expect(
        validateBaseUrl('https://mesh.example.test/v1', {
          resolveHostname: resolveHostnameTo({ address, family: 6 }),
        })
      ).rejects.toThrow(UnsafeBaseUrlError) as unknown as Promise<void>);
    }
  });

  it('rejects an IPv6 address it cannot parse rather than treating it as public', async () => {
    for (const address of [
      'not-an-address',
      '1:2:3:4:5:6:7:8:9',
      'fe80::1::2',
      '::ffff:999.1.1.1',
    ]) {
      await (expect(
        validateBaseUrl('https://mesh.example.test/v1', {
          resolveHostname: resolveHostnameTo({ address, family: 6 }),
        })
      ).rejects.toThrow(UnsafeBaseUrlError) as unknown as Promise<void>);
    }
  });

  it('still allows a public IPv4-mapped address', async () => {
    expect(
      await validateBaseUrl('https://[::ffff:104.18.33.45]/v1', {
        resolveHostname: resolveHostnameTo({ address: '::ffff:6812:212d', family: 6 }),
      })
    ).toBeUndefined();
  });

  it('still allows public IPv6 addresses', async () => {
    expect(
      await validateBaseUrl('https://[2606:4700::1111]/v1', {
        resolveHostname: resolveHostnameTo({ address: '2606:4700::1111', family: 6 }),
      })
    ).toBeUndefined();
  });

  it('rejects hostnames that resolve to blocked private addresses', async () => {
    await (expect(
      validateBaseUrl('https://models.example.test/v1', {
        resolveHostname: resolveHostnameTo({ address: '10.1.2.3', family: 4 }),
      })
    ).rejects.toThrow(UnsafeBaseUrlError) as unknown as Promise<void>);
  });

  it.each(ADDRESS_FIXTURES)(
    'enforces the shared private/local table via DNS resolution: $input',
    async ({ input, privateOrLocal }) => {
      const promise = validateBaseUrl('https://mesh.example.test/v1', {
        resolveHostname: resolveHostnameTo({ address: input, family: 6 }),
      });
      if (privateOrLocal) {
        await (expect(promise).rejects.toThrow(UnsafeBaseUrlError) as unknown as Promise<void>);
      } else {
        await (expect(promise).resolves.toBeUndefined() as unknown as Promise<void>);
      }
    }
  );

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
