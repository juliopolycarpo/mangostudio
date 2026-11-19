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
import { type CheckResult, keyedCheck } from './doctor-checks';

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
    results.push(keyedCheck('warn', 'mcp.label.probeNote', 'mcp.detail.probeNote'));
  }

  for (const server of diagnostics.servers) {
    results.push(...renderServer(server));
  }

  return results;
}

function renderServer(server: McpServerDiagnostic): CheckResult[] {
  const slug = { slug: server.slug };
  const results: CheckResult[] = [
    keyedCheck(
      'ok',
      'mcp.label.server',
      server.enabled ? 'mcp.detail.serverEnabled' : 'mcp.detail.serverDisabled',
      { ...slug, transport: server.transport }
    ),
  ];

  const commandCheck = renderCommandCheck(server);
  if (commandCheck) {
    results.push(commandCheck);
  }

  if (server.probe) {
    // The probe's own outcome sentence comes from the MCP module in English;
    // it travels as a param, as the auth-secret sentence does for the core checks.
    results.push(
      keyedCheck(server.probe.ok ? 'ok' : 'fail', 'mcp.label.probe', 'mcp.detail.probeResult', {
        ...slug,
        result: server.probe.detail,
      })
    );
  }

  if (server.longToolNames.length > 0) {
    results.push(
      keyedCheck('warn', 'mcp.label.tools', 'mcp.detail.longToolNames', {
        ...slug,
        count: server.longToolNames.length,
        max: MCP_TOOL_NAME_MAX_LENGTH,
        names: server.longToolNames.join(', '),
      })
    );
  }

  return results;
}

function renderCommandCheck(server: McpServerDiagnostic): CheckResult | null {
  const label = 'mcp.label.command';
  const slug = { slug: server.slug };
  // Only the sentences that name the command receive it.
  const named = { ...slug, command: server.command ?? '' };

  switch (server.commandPathStatus) {
    case 'not_applicable':
      return null;
    case 'missing':
      return server.enabled
        ? keyedCheck('fail', label, 'mcp.detail.commandMissing', slug)
        : keyedCheck('warn', label, 'mcp.detail.commandMissingDisabled', slug);
    case 'found':
      return keyedCheck('ok', label, 'mcp.detail.commandFound', named);
    case 'not_found':
      if (server.enabled) {
        return keyedCheck('fail', label, 'mcp.detail.commandNotFound', named);
      }
      // A disabled server is never spawned, so a missing command is not a
      // failure — mirror the skills section, which only warns on disabled-source
      // problems rather than failing the whole run.
      return keyedCheck('warn', label, 'mcp.detail.commandNotFoundDisabled', named);
    default: {
      // Exhaustiveness guard: a new McpCommandPathStatus member must be handled
      // above, or renderServer would silently drop the command row.
      const unexpected: never = server.commandPathStatus;
      throw new Error(`Unhandled MCP command path status: ${String(unexpected)}`);
    }
  }
}
