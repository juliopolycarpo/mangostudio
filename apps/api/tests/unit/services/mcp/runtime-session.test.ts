import { afterEach, describe, expect, it } from 'bun:test';

import { RemoteError, RESERVED_ERROR_CODES } from '@mangostudio/protocol';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { DEFAULT_MCP_TIMEOUT_MS } from '@mangostudio/shared/mcp';

import {
  connectMcpClient,
  requestDeadline,
  RUNTIME_MCP_CALL_GRACE_MS,
} from '../../../../src/services/mcp/runtime-session';
import type { McpServerRuntimeConfig } from '../../../../src/services/mcp/types';
import {
  RuntimeConnectionManager,
  setRuntimeConnectionManagerForTests,
} from '../../../../src/services/runtime-client/runtime-connection-manager';

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

describe('MCP status text when the environment cannot be reached', () => {
  afterEach(() => setRuntimeConnectionManagerForTests(undefined));

  it('serves the fixed text, not the connect diagnostic', async () => {
    const manager = new RuntimeConnectionManager({
      resolveEnvironment: (userId) =>
        Promise.resolve({
          id: LOCAL_ENVIRONMENT_ID,
          userId,
          name: 'Local',
          transportKind: 'in-process' as const,
          config: {},
          enabled: true,
        }),
      connectors: {
        'in-process': () =>
          Promise.reject(
            new RemoteError(RESERVED_ERROR_CODES.UNAVAILABLE, 'searched /home/alice/bin')
          ),
      },
    });
    setRuntimeConnectionManagerForTests(manager);
    // The connect fails at the first await, before any other field is read.
    const config = { slug: 'docs', environmentId: LOCAL_ENVIRONMENT_ID } as McpServerRuntimeConfig;

    const failure = await connectMcpClient(config, { userId: 'mcp-user' }).then(
      () => null,
      (error: unknown) => error
    );
    await manager.closeAll();

    const message = failure instanceof Error ? failure.message : String(failure);
    expect(
      message,
      `(MCP status): expected the fixed text without the hub path | received: ${message}`
    ).toBe(
      'MCP server "docs" runs on environment "local", which is unavailable: The environment could not be started.'
    );
  });
});
