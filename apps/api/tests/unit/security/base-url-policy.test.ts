import { describe, expect, it } from 'bun:test';
import {
  validateBaseUrl,
  UnsafeBaseUrlError,
} from '../../../src/services/providers/base-url-policy';

describe('base-url-policy', () => {
  it('allows a valid public HTTPS URL', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('https://api.openai.com/v1')).resolves.toBeUndefined();
  });

  it('rejects non-http(s) schemes', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('ftp://example.com')).rejects.toThrow(UnsafeBaseUrlError);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('file:///etc/passwd')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects invalid URLs', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('not-a-url')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects IPv4 loopback', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://127.0.0.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://127.0.0.99/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects RFC1918 private ranges', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://10.0.0.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://172.16.0.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://192.168.1.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects link-local IPv4', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://169.254.1.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects 0.0.0.0', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://0.0.0.0/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects IPv6 loopback', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://[::1]/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects IPv6 link-local', async () => {
    // eslint-disable-next-line @typescript-eslint/await-thenable
    await expect(validateBaseUrl('http://[fe80::1]/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });
});
