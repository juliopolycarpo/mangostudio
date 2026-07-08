import { describe, expect, it } from 'bun:test';
import type { McpToolDescriptor } from '@mangostudio/shared/mcp';
import type { McpServerSelect } from '../../../../src/db/types';
import {
  classifyMcpProbeError,
  collectMcpDiagnostics,
  type McpDiagnosticsDeps,
} from '../../../../src/modules/mcp-servers/application/mcp-diagnostics';
import type { McpServerRuntimeConfig } from '../../../../src/services/mcp/types';

function makeRow(overrides: Partial<McpServerSelect> = {}): McpServerSelect {
  return {
    id: 'server-1',
    userId: 'user-1',
    name: 'GitHub',
    slug: 'github',
    transport: 'stdio',
    command: 'uvx',
    argsJson: '[]',
    envJson: '{}',
    url: null,
    enabled: 1,
    timeoutMs: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<McpDiagnosticsDeps> = {}): McpDiagnosticsDeps {
  return {
    resolveCommandOnPath: () => true,
    probeServer: () => Promise.resolve({ ok: true, tools: [] }),
    ...overrides,
  };
}

const tool = (name: string): McpToolDescriptor => ({ name, description: '', inputSchema: {} });

describe('collectMcpDiagnostics', () => {
  it('checks the stdio command on PATH without probing', async () => {
    let probed = false;
    const diag = await collectMcpDiagnostics(
      [makeRow({ command: 'missing-bin' })],
      { probe: false, serverRunning: false },
      makeDeps({
        resolveCommandOnPath: (command) => command !== 'missing-bin',
        probeServer: () => {
          probed = true;
          return Promise.resolve({ ok: true, tools: [] });
        },
      })
    );

    expect(diag.servers[0]).toMatchObject({ commandOnPath: false, transport: 'stdio' });
    expect(diag.servers[0]?.probe).toBeUndefined();
    expect(probed).toBe(false);
  });

  it('leaves commandOnPath null for http servers', async () => {
    const diag = await collectMcpDiagnostics(
      [makeRow({ transport: 'http', command: null, url: 'https://example.test/mcp' })],
      { probe: false, serverRunning: false },
      makeDeps()
    );

    expect(diag.servers[0]?.commandOnPath).toBeNull();
  });

  it('probes enabled servers and surfaces the tool count', async () => {
    const diag = await collectMcpDiagnostics(
      [makeRow()],
      { probe: true, serverRunning: false },
      makeDeps({ probeServer: () => Promise.resolve({ ok: true, tools: [tool('a'), tool('b')] }) })
    );

    expect(diag.servers[0]?.probe).toMatchObject({ ok: true, toolCount: 2 });
  });

  it('skips the probe for disabled servers', async () => {
    let probed = false;
    const diag = await collectMcpDiagnostics(
      [makeRow({ enabled: 0 })],
      { probe: true, serverRunning: false },
      makeDeps({
        probeServer: () => {
          probed = true;
          return Promise.resolve({ ok: true, tools: [] });
        },
      })
    );

    expect(probed).toBe(false);
    expect(diag.servers[0]?.probe).toBeUndefined();
    expect(diag.servers[0]?.enabled).toBe(false);
  });

  it('flags namespaced tool names over the provider cap', async () => {
    const longName = 'x'.repeat(60);
    const diag = await collectMcpDiagnostics(
      [makeRow({ slug: 'github' })],
      { probe: true, serverRunning: false },
      makeDeps({ probeServer: () => Promise.resolve({ ok: true, tools: [tool(longName)] }) })
    );

    // mcp__github__ prefix (13) + 60 chars = 73 > 64.
    expect(diag.servers[0]?.longToolNames).toEqual([`mcp__github__${longName}`]);
  });

  it('carries the typed probe failure reason through', async () => {
    const diag = await collectMcpDiagnostics(
      [makeRow()],
      { probe: true, serverRunning: false },
      makeDeps({
        probeServer: () =>
          Promise.resolve({ ok: false, reason: 'spawn-enoent', detail: 'not found' }),
      })
    );

    expect(diag.servers[0]?.probe).toMatchObject({ ok: false, reason: 'spawn-enoent' });
  });

  it('records the running-server flag for the probe note', async () => {
    const diag = await collectMcpDiagnostics(
      [makeRow()],
      { probe: true, serverRunning: true },
      makeDeps()
    );

    expect(diag.serverRunning).toBe(true);
    expect(diag.probed).toBe(true);
  });

  it('passes the row userId to the probe seam', async () => {
    const captured: Array<{ userId: string; config: McpServerRuntimeConfig }> = [];
    await collectMcpDiagnostics(
      [makeRow({ userId: 'user-42' })],
      { probe: true, serverRunning: false },
      makeDeps({
        probeServer: (userId, config) => {
          captured.push({ userId, config });
          return Promise.resolve({ ok: true, tools: [] });
        },
      })
    );

    expect(captured[0]?.userId).toBe('user-42');
    expect(captured[0]?.config).toMatchObject({ slug: 'github', transport: 'stdio' });
  });
});

describe('classifyMcpProbeError', () => {
  it.each([
    ['spawn uvx ENOENT', 'spawn-enoent'],
    ['connect ECONNREFUSED 127.0.0.1:8080', 'connection-refused'],
    ['HTTP 401 Unauthorized', 'auth'],
    ['server rejected: unsupported protocol version 2020-01-01', 'protocol'],
    ['MCP probe timed out after 10000ms', 'timeout'],
    ['something unexpected happened', 'unreachable'],
  ] as const)('classifies %p as %p', (message, reason) => {
    expect(classifyMcpProbeError(new Error(message)).reason).toBe(reason);
  });
});
