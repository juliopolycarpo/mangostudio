import { describe, expect, it } from 'bun:test';
import {
  assertTransportInvariants,
  isValidMcpServerSlug,
  McpServerError,
} from '../../../../src/modules/mcp-servers/domain/mcp-server';

describe('isValidMcpServerSlug', () => {
  it('accepts lowercase kebab-case slugs', () => {
    expect(isValidMcpServerSlug('github')).toBe(true);
    expect(isValidMcpServerSlug('github-tools-2')).toBe(true);
    expect(isValidMcpServerSlug('a')).toBe(true);
  });

  it('rejects malformed slugs', () => {
    expect(isValidMcpServerSlug('')).toBe(false);
    expect(isValidMcpServerSlug('GitHub')).toBe(false);
    expect(isValidMcpServerSlug('-leading')).toBe(false);
    expect(isValidMcpServerSlug('trailing-')).toBe(false);
    expect(isValidMcpServerSlug('double--dash')).toBe(false);
    expect(isValidMcpServerSlug('under_score')).toBe(false);
    expect(isValidMcpServerSlug(`${'a'.repeat(65)}`)).toBe(false);
  });
});

describe('assertTransportInvariants', () => {
  it('accepts a stdio server with a command', () => {
    expect(() =>
      assertTransportInvariants({ transport: 'stdio', command: 'bun', url: null })
    ).not.toThrow();
  });

  it('rejects a stdio server without a command', () => {
    for (const command of [null, '', '   ']) {
      let caught: unknown;
      try {
        assertTransportInvariants({ transport: 'stdio', command, url: null });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(McpServerError);
      expect(caught).toMatchObject({ status: 422, code: 'VALIDATION' });
    }
  });

  it('accepts an http server with an http(s) URL', () => {
    expect(() =>
      assertTransportInvariants({
        transport: 'http',
        command: null,
        url: 'http://localhost:3000/mcp',
      })
    ).not.toThrow();
    expect(() =>
      assertTransportInvariants({
        transport: 'http',
        command: null,
        url: 'https://mcp.example.com',
      })
    ).not.toThrow();
  });

  it('rejects an http server with a missing or non-http URL', () => {
    for (const url of [null, '', 'not a url', 'ftp://example.com', 'file:///etc/passwd']) {
      let caught: unknown;
      try {
        assertTransportInvariants({ transport: 'http', command: null, url });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(McpServerError);
      expect(caught).toMatchObject({ status: 422, code: 'VALIDATION' });
    }
  });
});
