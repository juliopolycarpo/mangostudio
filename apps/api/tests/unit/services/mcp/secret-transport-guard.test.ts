import { describe, expect, it } from 'bun:test';
import {
  assertSecretsMayReachEnvironment,
  McpSecretTransportError,
} from '../../../../src/services/mcp/secret-transport-guard';

function directUrl(baseUrl: string) {
  return { transportKind: 'http' as const, config: { baseUrl } };
}

function refusal(baseUrl: string): McpSecretTransportError {
  try {
    assertSecretsMayReachEnvironment('github', directUrl(baseUrl));
  } catch (error) {
    if (error instanceof McpSecretTransportError) return error;
    throw error;
  }
  throw new Error(`Expected ${baseUrl} to be refused.`);
}

describe('secrets never travel over plaintext to a host off this network', () => {
  it('refuses plaintext http to a public host, naming TLS and the host', () => {
    const error = refusal('http://mcp.example.com:8081/');

    expect(error).toBeInstanceOf(McpSecretTransportError);
    expect(error.host).toBe('mcp.example.com:8081');
    expect(error.message).toContain('https://');
  });

  it('refuses a hostname it cannot prove is local', () => {
    // A bare name may resolve anywhere; refusing is the safe direction when
    // the payload is a credential.
    expect(refusal('http://devbox/').host).toBe('devbox');
  });

  it('allows TLS anywhere', () => {
    expect(() =>
      assertSecretsMayReachEnvironment('github', directUrl('https://mcp.example.com/'))
    ).not.toThrow();
  });

  it('allows plaintext to loopback and private-network addresses', () => {
    for (const baseUrl of [
      'http://localhost:8081/',
      'http://127.0.0.1:8081/',
      'http://[::1]:8081/',
      'http://10.1.2.3:8081/',
      'http://172.16.0.9:8081/',
      'http://172.31.255.254:8081/',
      'http://192.168.1.10:8081/',
      'http://169.254.10.10:8081/',
      'http://[fd00::1]:8081/',
      'http://[fe80::1]:8081/',
    ]) {
      expect(() => assertSecretsMayReachEnvironment('github', directUrl(baseUrl))).not.toThrow();
    }
  });

  it('still refuses public addresses that only look private', () => {
    for (const baseUrl of ['http://172.15.0.1/', 'http://172.32.0.1/', 'http://192.169.1.1/']) {
      expect(refusal(baseUrl)).toBeInstanceOf(McpSecretTransportError);
    }
  });

  it('judges only the transport the hub chose the scheme for', () => {
    // Local, stdio, WSL and ssh never put a credential on an open wire; a
    // dial-in runtime picked its own URL and the hub cannot see past a proxy.
    for (const transportKind of ['in-process', 'stdio', 'wsl', 'ssh', 'websocket'] as const) {
      expect(() =>
        assertSecretsMayReachEnvironment('github', {
          transportKind,
          config: { baseUrl: 'http://mcp.example.com/' },
        })
      ).not.toThrow();
    }
    expect(() => assertSecretsMayReachEnvironment('github', null)).not.toThrow();
  });
});
