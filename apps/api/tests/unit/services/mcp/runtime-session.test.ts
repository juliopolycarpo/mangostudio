import { describe, expect, it } from 'bun:test';
import { DEFAULT_MCP_TIMEOUT_MS } from '@mangostudio/runtime';
import {
  RUNTIME_MCP_CALL_GRACE_MS,
  requestDeadline,
} from '../../../../src/services/mcp/runtime-session';

describe('MCP request deadlines compose across the runtime boundary', () => {
  it('always gives the hub more time than the runtime applies to the same call', () => {
    for (const mcpTimeoutMs of [1, 1_000, 30_000, 600_000]) {
      expect(requestDeadline(mcpTimeoutMs)).toBeGreaterThan(mcpTimeoutMs);
    }
  });

  it('falls back to the runtime default plus the grace when the row sets none', () => {
    const expected = DEFAULT_MCP_TIMEOUT_MS + RUNTIME_MCP_CALL_GRACE_MS;
    expect(requestDeadline(null)).toBe(expected);
    expect(requestDeadline(undefined)).toBe(expected);
    // The default the hub assumes has to be the one the runtime actually
    // applies, or an unconfigured server times out on the wrong side.
    expect(requestDeadline(DEFAULT_MCP_TIMEOUT_MS)).toBe(expected);
  });

  it('keeps the grace positive, so the two deadlines can never coincide', () => {
    expect(RUNTIME_MCP_CALL_GRACE_MS).toBeGreaterThan(0);
  });
});
