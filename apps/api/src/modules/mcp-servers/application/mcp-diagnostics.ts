/**
 * Offline MCP diagnostics for `mango doctor`. MCP servers fail in process- and
 * network-shaped ways — a stdio `command` missing from `PATH`, a refused URL,
 * an auth rejection, a protocol mismatch — and tool names can silently blow the
 * provider 64-char cap. Doctor reports every server row without connecting;
 * the active probe (flag-gated, since it spawns children / hits URLs) reuses
 * the connection manager and force-disposes each session so a CLI run never
 * leaves a lingering child behind.
 */

import type { McpToolDescriptor, McpTransport } from '@mangostudio/shared/mcp';
import type { McpServerSelect } from '../../../db/types';
import { disposeMcpServer, getMcpClient } from '../../../services/mcp/connection-manager';
import { toMcpRuntimeConfig } from '../../../services/mcp/runtime-config';
import { buildMcpToolName, MCP_TOOL_NAME_MAX_LENGTH } from '../../../services/mcp/tool-naming';
import type { McpServerRuntimeConfig } from '../../../services/mcp/types';
import { commandResolvesOnPath } from './command-path';

/** Hard cap on the probe (connect + listTools), matching the test endpoint. */
export const MCP_PROBE_TIMEOUT_MS = 10_000;

/** Typed failure category for a probe, so the reason is greppable, not free text. */
export type McpProbeReason =
  | 'spawn-enoent'
  | 'connection-refused'
  | 'auth'
  | 'protocol'
  | 'timeout'
  | 'unreachable';

export interface McpProbeDiagnostic {
  ok: boolean;
  toolCount?: number;
  reason?: McpProbeReason;
  /** Human-readable outcome; the typed `reason` drives remediation. */
  detail: string;
}

/** stdio command PATH resolution outcome; http rows are `not_applicable`. */
export type McpCommandPathStatus = 'not_applicable' | 'missing' | 'not_found' | 'found';

export interface McpServerDiagnostic {
  slug: string;
  transport: McpTransport;
  enabled: boolean;
  command: string | null;
  commandPathStatus: McpCommandPathStatus;
  /** Namespaced tool names over the provider cap (probe only; empty otherwise). */
  longToolNames: string[];
  /** Present only when the probe ran (enabled servers, `--probe`). */
  probe?: McpProbeDiagnostic;
}

export interface McpDiagnostics {
  servers: McpServerDiagnostic[];
  /** A running MangoStudio instance holds the pid file; the probe adds a 2nd child. */
  serverRunning: boolean;
  probed: boolean;
}

export interface McpDiagnosticsOptions {
  probe: boolean;
  serverRunning: boolean;
}

/** Result of one live probe attempt, before classification into the public shape. */
interface ProbeAttempt {
  ok: boolean;
  tools?: McpToolDescriptor[];
  reason?: McpProbeReason;
  detail?: string;
}

/** Seams so the collector runs against fakes (fake PATH, fake client handles). */
export interface McpDiagnosticsDeps {
  resolveCommandOnPath(command: string): boolean;
  probeServer(userId: string, config: McpServerRuntimeConfig): Promise<ProbeAttempt>;
}

export function createMcpDiagnosticsDeps(): McpDiagnosticsDeps {
  return {
    resolveCommandOnPath: commandResolvesOnPath,
    probeServer: realProbeServer,
  };
}

/**
 * Builds one diagnostic per server row. stdio commands are PATH-checked even
 * without `--probe`; with it, enabled servers are connected under the hard
 * timeout and their tool names checked against the provider cap.
 * // Usage: await collectMcpDiagnostics(rows, { probe, serverRunning })
 */
export async function collectMcpDiagnostics(
  rows: readonly McpServerSelect[],
  options: McpDiagnosticsOptions,
  deps: McpDiagnosticsDeps = createMcpDiagnosticsDeps()
): Promise<McpDiagnostics> {
  const servers: McpServerDiagnostic[] = [];

  for (const row of rows) {
    const enabled = row.enabled !== 0;
    const commandPathStatus = resolveCommandPathStatus(
      row.transport,
      row.command,
      deps.resolveCommandOnPath
    );

    const diagnostic: McpServerDiagnostic = {
      slug: row.slug,
      transport: row.transport,
      enabled,
      command: row.command,
      commandPathStatus,
      longToolNames: [],
    };

    // Disabled servers are never used at runtime, so probing them would spawn a
    // child for nothing. Structurally invalid stdio rows (no command) are skipped
    // too — the passive check already reports why spawn would fail.
    if (options.probe && enabled && commandPathStatus !== 'missing') {
      const attempt = await deps.probeServer(row.userId, toMcpRuntimeConfig(row));
      diagnostic.probe = toProbeDiagnostic(attempt);
      diagnostic.longToolNames = overlongToolNames(row.slug, attempt.tools ?? []);
    }

    servers.push(diagnostic);
  }

  return { servers, serverRunning: options.serverRunning, probed: options.probe };
}

function resolveCommandPathStatus(
  transport: McpTransport,
  command: string | null,
  resolveCommandOnPath: (command: string) => boolean
): McpCommandPathStatus {
  if (transport !== 'stdio') return 'not_applicable';
  if (!command?.trim()) return 'missing';
  return resolveCommandOnPath(command) ? 'found' : 'not_found';
}

/** Namespaced (`mcp__<slug>__<tool>`) names that exceed the provider cap. */
function overlongToolNames(slug: string, tools: readonly McpToolDescriptor[]): string[] {
  return tools
    .map((tool) => buildMcpToolName(slug, tool.name))
    .filter((name) => name.length > MCP_TOOL_NAME_MAX_LENGTH);
}

function toProbeDiagnostic(attempt: ProbeAttempt): McpProbeDiagnostic {
  if (attempt.ok) {
    const toolCount = attempt.tools?.length ?? 0;
    return { ok: true, toolCount, detail: `connected, ${toolCount} tool(s)` };
  }
  return {
    ok: false,
    reason: attempt.reason ?? 'unreachable',
    detail: attempt.detail ?? 'unreachable',
  };
}

async function realProbeServer(
  userId: string,
  config: McpServerRuntimeConfig
): Promise<ProbeAttempt> {
  try {
    const tools = await withHardTimeout(
      (async () => {
        const handle = await getMcpClient(userId, config);
        return handle.listTools({ timeoutMs: MCP_PROBE_TIMEOUT_MS });
      })(),
      MCP_PROBE_TIMEOUT_MS
    );
    return { ok: true, tools };
  } catch (error) {
    return { ok: false, ...classifyMcpProbeError(error) };
  } finally {
    // Never leave a half-open or still-connecting session behind a CLI probe.
    await disposeMcpServer(userId, config.id);
  }
}

/**
 * Maps a probe failure onto a typed reason. Matches the SDK/transport error
 * text MCP surfaces for the common cases operators hit.
 * // Usage: classifyMcpProbeError(error)
 */
export function classifyMcpProbeError(error: unknown): {
  reason: McpProbeReason;
  detail: string;
} {
  const message = error instanceof Error && error.message ? error.message : String(error);

  if (/ENOENT/.test(message)) {
    return { reason: 'spawn-enoent', detail: 'command not found on PATH (spawn ENOENT)' };
  }
  if (/ECONNREFUSED|connection refused/i.test(message)) {
    return { reason: 'connection-refused', detail: 'connection refused' };
  }
  if (/\b40[13]\b|unauthorized|forbidden/i.test(message)) {
    return { reason: 'auth', detail: 'authentication rejected (HTTP 401/403)' };
  }
  if (/protocol version|unsupported protocol|version mismatch/i.test(message)) {
    return { reason: 'protocol', detail: 'MCP protocol/handshake mismatch' };
  }
  if (/tim(?:ed)?\s*out|did not respond/i.test(message)) {
    return { reason: 'timeout', detail: `no response within ${MCP_PROBE_TIMEOUT_MS / 1000}s` };
  }
  return { reason: 'unreachable', detail: message };
}

async function withHardTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`MCP probe timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
