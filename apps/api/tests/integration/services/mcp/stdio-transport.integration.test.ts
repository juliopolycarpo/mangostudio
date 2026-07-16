/**
 * Spawns the stdio fixture with bun to cover process lifecycle: connect,
 * tool calls, spawn env hygiene, and crash-mid-session recovery through the
 * connection manager.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { connectMcpClient } from '../../../../src/services/mcp/client-factory';
import {
  closeAllMcpClients,
  getMcpClient,
  getMcpRuntimeStatus,
} from '../../../../src/services/mcp/connection-manager';
import type { McpServerRuntimeConfig } from '../../../../src/services/mcp/types';

const FIXTURE_PATH = join(import.meta.dir, '../../../support/fixtures/mcp/echo-stdio-server.ts');
const USER_ID = 'stdio-transport-user';

function stdioConfig(id: string, env: Record<string, string> = {}): McpServerRuntimeConfig {
  return {
    id,
    slug: id,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE_PATH],
    env,
    url: null,
    timeoutMs: 10_000,
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await Bun.sleep(25);
  }
}

afterEach(async () => {
  await closeAllMcpClients();
});

describe('mcp stdio transport', () => {
  it('spawns the server, lists tools, and round-trips a tool call', async () => {
    const handle = await connectMcpClient(stdioConfig('spawn-test'), { userId: USER_ID });

    const tools = await handle.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['echo', 'env-keys', 'crash']);

    const result = await handle.callTool('echo', { text: 'spawned' });
    expect(result).toEqual({
      contentText: 'spawned',
      isError: false,
      rawContentKinds: ['text'],
      content: [{ type: 'text', text: 'spawned' }],
    });

    await handle.close();
  });

  it('withholds the parent process env from the child beyond the allowlist', async () => {
    process.env.MCP_TEST_LEAKY_SECRET = 'must-not-leak';
    try {
      const handle = await connectMcpClient(
        stdioConfig('env-test', { MCP_FIXTURE_FLAG: 'forwarded' }),
        { userId: USER_ID }
      );

      const result = await handle.callTool('env-keys', {});
      const childEnvKeys = JSON.parse(result.contentText) as string[];

      expect(childEnvKeys).toContain('MCP_FIXTURE_FLAG');
      expect(childEnvKeys).not.toContain('MCP_TEST_LEAKY_SECRET');
      expect(childEnvKeys).not.toContain('BETTER_AUTH_SECRET');

      await handle.close();
    } finally {
      delete process.env.MCP_TEST_LEAKY_SECRET;
    }
  });

  it('merges write-only stdio env secrets into the child without process inheritance', async () => {
    const handle = await connectMcpClient(stdioConfig('secret-env-test', { PUBLIC_FLAG: 'yes' }), {
      userId: USER_ID,
      resolveSecretEnv: async () => ({ MCP_SECRET_FLAG: 'write-only-value' }),
    });

    const result = await handle.callTool('env-keys', {});
    const childEnvKeys = JSON.parse(result.contentText) as string[];
    expect(childEnvKeys).toContain('PUBLIC_FLAG');
    expect(childEnvKeys).toContain('MCP_SECRET_FLAG');
    expect(result.contentText).not.toContain('write-only-value');

    await handle.close();
  });

  it('recovers from a crash mid-session: status drops, next use reconnects', async () => {
    const config = stdioConfig('crash-test');
    const handle = await getMcpClient(USER_ID, config);
    expect(getMcpRuntimeStatus(USER_ID, config.id).status).toBe('connected');

    await expect(handle.callTool('crash', {})).rejects.toThrow();
    await waitFor(() => getMcpRuntimeStatus(USER_ID, config.id).status === 'disconnected');

    const fresh = await getMcpClient(USER_ID, config);
    const result = await fresh.callTool('echo', { text: 'back online' });

    expect(result.contentText).toBe('back online');
    expect(getMcpRuntimeStatus(USER_ID, config.id).status).toBe('connected');
  });
});
