import { describe, expect, it } from 'bun:test';
import { validateBaseUrl, UnsafeBaseUrlError } from '../../../src/services/providers/base-url-policy';

describe('base-url-policy', () => {
  it('allows a valid public HTTPS URL', async () => {
    await expect(validateBaseUrl('https://api.openai.com/v1')).resolves.toBeUndefined();
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(validateBaseUrl('ftp://example.com')).rejects.toThrow(UnsafeBaseUrlError);
    await expect(validateBaseUrl('file:///etc/passwd')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects invalid URLs', async () => {
    await expect(validateBaseUrl('not-a-url')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects IPv4 loopback', async () => {
    await expect(validateBaseUrl('http://127.0.0.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
    await expect(validateBaseUrl('http://127.0.0.99/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects RFC1918 private ranges', async () => {
    await expect(validateBaseUrl('http://10.0.0.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
    await expect(validateBaseUrl('http://172.16.0.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
    await expect(validateBaseUrl('http://192.168.1.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects link-local IPv4', async () => {
    await expect(validateBaseUrl('http://169.254.1.1/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects 0.0.0.0', async () => {
    await expect(validateBaseUrl('http://0.0.0.0/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects IPv6 loopback', async () => {
    await expect(validateBaseUrl('http://[::1]/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });

  it('rejects IPv6 link-local', async () => {
    await expect(validateBaseUrl('http://[fe80::1]/v1')).rejects.toThrow(UnsafeBaseUrlError);
  });
});
