import { describe, expect, it } from 'bun:test';
import {
  httpRuntimeBaseUrlToWebSocketUrl,
  parseHttpRuntimeBaseUrl,
} from '../../../src/services/runtime-client/http-runtime-url';

describe('http runtime URL guard', () => {
  it('accepts http and https, including private and loopback hosts', () => {
    expect(parseHttpRuntimeBaseUrl('http://127.0.0.1:8787').href).toBe('http://127.0.0.1:8787/');
    expect(parseHttpRuntimeBaseUrl('https://10.0.0.5:443/').protocol).toBe('https:');
    expect(parseHttpRuntimeBaseUrl('http://192.168.1.10:9000').hostname).toBe('192.168.1.10');
  });

  it('rejects non-http schemes', () => {
    expect(() => parseHttpRuntimeBaseUrl('ws://127.0.0.1:8787')).toThrow(/http: or https:/);
    expect(() => parseHttpRuntimeBaseUrl('ftp://example.com')).toThrow(/http: or https:/);
  });

  it('swaps the scheme for the dial URL', () => {
    expect(httpRuntimeBaseUrlToWebSocketUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/');
    expect(httpRuntimeBaseUrlToWebSocketUrl('https://runtime.example/')).toBe(
      'wss://runtime.example/'
    );
  });
});
