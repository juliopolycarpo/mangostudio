import { describe, expect, it } from 'bun:test';
import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';
import { collectMcpDoctorChecks } from '../../../src/cli/mcp-doctor-checks';
import type { McpServerSelect } from '../../../src/db/types';
import type { McpDiagnosticsDeps } from '../../../src/modules/mcp-servers/application/mcp-diagnostics';

function makeRow(overrides: Partial<McpServerSelect> = {}): McpServerSelect {
  return {
    id: 'server-1',
    userId: 'user-1',
    name: 'GitHub',
    slug: 'github',
    transport: 'stdio',
    environmentId: LOCAL_ENVIRONMENT_ID,
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

function find(results: Awaited<ReturnType<typeof collectMcpDoctorChecks>>, label: string) {
  const row = results.find((result) => result.label === label);
  if (!row) throw new Error(`missing row: ${label}`);
  return row;
}

describe('collectMcpDoctorChecks', () => {
  it('renders a base row and a passing PATH check', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow()],
      { probe: false, serverRunning: false },
      makeDeps()
    );

    expect(find(results, 'MCP github').detail).toBe('stdio, enabled');
    expect(find(results, 'MCP github command').status).toBe('ok');
  });

  it('fails the PATH check when the command is missing on PATH', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow()],
      { probe: false, serverRunning: false },
      makeDeps({ resolveCommandOnPath: () => false })
    );

    const command = find(results, 'MCP github command');
    expect(command.status).toBe('fail');
    expect(command.detail).toContain('not found on PATH');
  });

  it('renders a failing probe with the typed reason detail', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow()],
      { probe: true, serverRunning: false },
      makeDeps({
        probeServer: () =>
          Promise.resolve({
            ok: false,
            reason: 'connection-refused',
            detail: 'connection refused',
          }),
      })
    );

    const probe = find(results, 'MCP github probe');
    expect(probe.status).toBe('fail');
    expect(probe.detail).toBe('connection refused');
  });

  it('warns about overlong tool names', async () => {
    const longName = 'y'.repeat(60);
    const results = await collectMcpDoctorChecks(
      [makeRow()],
      { probe: true, serverRunning: false },
      makeDeps({
        probeServer: () =>
          Promise.resolve({
            ok: true,
            tools: [{ name: longName, description: '', inputSchema: {} }],
          }),
      })
    );

    const tools = find(results, 'MCP github tools');
    expect(tools.status).toBe('warn');
    expect(tools.detail).toContain('exceed 64 chars');
  });

  it('adds a note when a server is running during a probe', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow()],
      { probe: true, serverRunning: true },
      makeDeps()
    );

    expect(find(results, 'MCP probe').detail).toContain('MangoStudio server is running');
  });

  it('fails when an enabled stdio server has no command configured', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow({ command: null })],
      { probe: false, serverRunning: false },
      makeDeps()
    );

    const command = find(results, 'MCP github command');
    expect(command.status).toBe('fail');
    expect(command.detail).toContain('stdio MCP servers require a command');
  });

  it('warns when a disabled stdio server has no command configured', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow({ command: '', enabled: 0 })],
      { probe: false, serverRunning: false },
      makeDeps()
    );

    const command = find(results, 'MCP github command');
    expect(command.status).toBe('warn');
    expect(command.detail).toContain('server disabled');
  });

  it('omits a command row for http servers', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow({ transport: 'http', command: null, url: 'https://example.test/mcp' })],
      { probe: false, serverRunning: false },
      makeDeps()
    );

    expect(results.some((row) => row.label === 'MCP github command')).toBe(false);
  });

  it('does not probe stdio servers with a missing command', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow({ command: '   ' })],
      { probe: true, serverRunning: false },
      makeDeps({
        probeServer: () => Promise.resolve({ ok: true, tools: [] }),
      })
    );

    expect(results.some((row) => row.label === 'MCP github probe')).toBe(false);
    expect(find(results, 'MCP github command').status).toBe('fail');
  });

  it('marks a disabled server without a probe row', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow({ enabled: 0 })],
      { probe: true, serverRunning: false },
      makeDeps()
    );

    expect(find(results, 'MCP github').detail).toBe('stdio, disabled');
    expect(results.some((row) => row.label === 'MCP github probe')).toBe(false);
  });

  it('warns (not fails) when a disabled server command is missing', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow({ enabled: 0 })],
      { probe: false, serverRunning: false },
      makeDeps({ resolveCommandOnPath: () => false })
    );

    const command = find(results, 'MCP github command');
    expect(command.status).toBe('warn');
    expect(command.detail).toContain('server disabled');
  });

  it('omits the running-server note when no enabled server would be probed', async () => {
    const results = await collectMcpDoctorChecks(
      [makeRow({ enabled: 0 })],
      { probe: true, serverRunning: true },
      makeDeps()
    );

    expect(results.some((row) => row.label === 'MCP probe')).toBe(false);
  });
});
