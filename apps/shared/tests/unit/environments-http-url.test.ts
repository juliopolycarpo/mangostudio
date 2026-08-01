import { describe, expect, it } from 'bun:test';
import {
  httpBaseUrlToWebSocketUrl,
  isPrivateOrLoopbackHostname,
  shouldWarnPlaintextHttpRuntime,
} from '../../src/environments/http-url';

describe('Direct URL helpers', () => {
  it('recognises loopback and RFC1918 hosts', () => {
    expect(isPrivateOrLoopbackHostname('127.0.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHostname('localhost')).toBe(true);
    expect(isPrivateOrLoopbackHostname('10.1.2.3')).toBe(true);
    expect(isPrivateOrLoopbackHostname('172.16.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHostname('192.168.0.1')).toBe(true);
    expect(isPrivateOrLoopbackHostname('8.8.8.8')).toBe(false);
    expect(isPrivateOrLoopbackHostname('example.com')).toBe(false);
  });

  it('warns only for plaintext HTTP to a public host', () => {
    expect(shouldWarnPlaintextHttpRuntime('http://example.com:8787')).toBe(true);
    expect(shouldWarnPlaintextHttpRuntime('http://192.168.1.10:8787')).toBe(false);
    expect(shouldWarnPlaintextHttpRuntime('https://example.com')).toBe(false);
  });

  it('swaps http/https to ws/wss', () => {
    expect(httpBaseUrlToWebSocketUrl('http://127.0.0.1:9')).toBe('ws://127.0.0.1:9/');
    expect(httpBaseUrlToWebSocketUrl('https://host/path')).toBe('wss://host/path');
  });
});
