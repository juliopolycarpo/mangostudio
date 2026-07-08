/**
 * Renders the MCP section of `mango doctor`. Delegates the row-by-row diagnosis
 * (PATH checks, the flag-gated probe, tool-name length) to the MCP module, then
 * maps the structured result onto checklist rows. When a MangoStudio server is
 * running, a leading note flags that the probe spawns a second stdio child.
 */

import type { McpServerSelect } from '../db/types';
import {
  collectMcpDiagnostics,
  type McpDiagnosticsDeps,
  type McpDiagnosticsOptions,
  type McpServerDiagnostic,
} from '../modules/mcp-servers/application/mcp-diagnostics';
import { MCP_TOOL_NAME_MAX_LENGTH } from '../services/mcp/tool-naming';
import { type CheckResult, fail, ok, warn } from './doctor-checks';

/**
 * Runs the MCP diagnostics and renders the checklist. `--probe` (carried on
 * `options.probe`) turns on the live connect; without it, stdio PATH checks
 * still run.
 * // Usage: await collectMcpDoctorChecks(rows, { probe, serverRunning })
 */
export async function collectMcpDoctorChecks(
  rows: readonly McpServerSelect[],
  options: McpDiagnosticsOptions,
  deps?: McpDiagnosticsDeps
): Promise<CheckResult[]> {
  const diagnostics = await collectMcpDiagnostics(rows, options, deps);
  const results: CheckResult[] = [];

  // Only worth the note when there is at least one enabled server to probe; a
  // bare `--all` run with no (enabled) servers spawns nothing.
  const probesSomething = diagnostics.servers.some((server) => server.enabled);
  if (diagnostics.probed && diagnostics.serverRunning && probesSomething) {
    results.push(
      warn(
        'MCP probe',
        'a MangoStudio server is running; the probe spawns a second stdio child per server (safe for per-client servers)'
      )
    );
  }

  for (const server of diagnostics.servers) {
    results.push(...renderServer(server));
  }

  return results;
}

function renderServer(server: McpServerDiagnostic): CheckResult[] {
  const label = `MCP ${server.slug}`;
  const state = server.enabled ? 'enabled' : 'disabled';
  const results: CheckResult[] = [ok(label, `${server.transport}, ${state}`)];

  if (server.transport === 'stdio' && server.commandOnPath !== null) {
    const command = server.command ?? '';
    if (server.commandOnPath) {
      results.push(ok(`${label} command`, `${command} resolvable on PATH`));
    } else if (server.enabled) {
      results.push(fail(`${label} command`, `${command} not found on PATH (spawn would ENOENT)`));
    } else {
      // A disabled server is never spawned, so a missing command is not a
      // failure — mirror the skills section, which only warns on disabled-source
      // problems rather than failing the whole run.
      results.push(warn(`${label} command`, `${command} not found on PATH (server disabled)`));
    }
  }

  if (server.probe) {
    results.push(
      server.probe.ok
        ? ok(`${label} probe`, server.probe.detail)
        : fail(`${label} probe`, server.probe.detail)
    );
  }

  if (server.longToolNames.length > 0) {
    results.push(
      warn(
        `${label} tools`,
        `${server.longToolNames.length} tool name(s) exceed ${MCP_TOOL_NAME_MAX_LENGTH} chars and are skipped: ${server.longToolNames.join(', ')}`
      )
    );
  }

  return results;
}
