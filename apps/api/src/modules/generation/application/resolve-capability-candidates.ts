/**
 * Diagnostic tool-capability resolution: the same eligibility gates the turn
 * pipeline applies (agent allowlist, per-tool settings, provider name cap),
 * but keeping the rejected candidates with a typed reason instead of dropping
 * them. `resolveAgentRuntime` derives its provider definitions from these
 * candidates, so generation and the capability inspector cannot diverge.
 */

import type { AgentProfile } from '@mangostudio/shared/agents';
import type { CapabilityReasonCode } from '@mangostudio/shared/capabilities';
import type { ToolSettingsCategory } from '@mangostudio/shared/tool-settings';
import type { McpBridgeServerSnapshot } from '../../../services/mcp/tool-bridge';
import { parseMcpToolName, toolNameMatches } from '../../../services/mcp/tool-naming';
import type { ToolDefinition } from '../../../services/providers/types';
import { getSafeEffectiveToolSettings } from '../../../services/tools';
import type { EffectiveToolSettings, RegisteredTool } from '../../../services/tools/types';

/** Reasons a candidate can be rejected at runtime resolution. */
export type ToolCandidateReason = Extract<
  CapabilityReasonCode,
  'agent-tools-disabled' | 'agent-allowlist' | 'tool-setting-disabled' | 'name-over-provider-limit'
>;

export interface ToolCapabilityCandidate {
  /** Normalized provider-facing name (`mcp__<slug>__<tool>` for MCP). */
  readonly name: string;
  /** Display title: builtin settings title, or the raw MCP tool name. */
  readonly title: string;
  readonly source: 'builtin' | 'mcp';
  /** Settings category — builtin tools only. */
  readonly category?: ToolSettingsCategory;
  /** Owning server provenance — MCP tools only. */
  readonly serverSlug?: string;
  readonly serverName?: string;
  /** Provider definition; present exactly when the candidate is effective. */
  readonly definition?: ToolDefinition;
  readonly reason?: ToolCandidateReason;
}

export interface ResolveToolCandidatesInput {
  readonly profile: AgentProfile;
  readonly toolSettings: ReadonlyMap<string, EffectiveToolSettings>;
  readonly registeredTools: ReadonlyArray<RegisteredTool>;
  readonly mcpServers: ReadonlyArray<McpBridgeServerSnapshot>;
}

/**
 * Resolves every known tool candidate for a turn, effective and rejected
 * alike, preserving the definition order the turn pipeline sends to the
 * provider (builtins in registry order, then MCP tools per server).
 * // Usage: const candidates = resolveToolCandidates({ profile, toolSettings, registeredTools, mcpServers })
 */
export function resolveToolCandidates(
  input: ResolveToolCandidatesInput
): ToolCapabilityCandidate[] {
  const allowlist = new Set(input.profile.toolNames);
  return [
    ...input.registeredTools.map((tool) => resolveBuiltinCandidate(tool, input, allowlist)),
    ...input.mcpServers.flatMap((server) => resolveMcpCandidates(server, input, allowlist)),
  ];
}

/** Effective provider definitions, in the order candidates were resolved. */
export function effectiveToolDefinitions(
  candidates: ReadonlyArray<ToolCapabilityCandidate>
): ToolDefinition[] {
  return candidates
    .map((candidate) => candidate.definition)
    .filter((definition): definition is ToolDefinition => definition !== undefined);
}

function resolveBuiltinCandidate(
  tool: RegisteredTool,
  input: ResolveToolCandidatesInput,
  allowlist: ReadonlySet<string>
): ToolCapabilityCandidate {
  const name = tool.definition.name;
  const base = {
    name,
    title: tool.settings.title,
    source: 'builtin' as const,
    category: tool.settings.category,
  };

  if (!input.profile.toolsEnabled) return { ...base, reason: 'agent-tools-disabled' };
  if (!toolNameMatches(allowlist, name)) return { ...base, reason: 'agent-allowlist' };

  const settings = getSafeEffectiveToolSettings(tool, input.toolSettings.get(name));
  if (!settings.enabled) return { ...base, reason: 'tool-setting-disabled' };
  return { ...base, definition: tool.buildDefinition?.(settings) ?? tool.definition };
}

function resolveMcpCandidates(
  server: McpBridgeServerSnapshot,
  input: ResolveToolCandidatesInput,
  allowlist: ReadonlySet<string>
): ToolCapabilityCandidate[] {
  const provenance = {
    source: 'mcp' as const,
    serverSlug: server.slug,
    serverName: server.name,
  };

  const candidates = server.tools.map((tool): ToolCapabilityCandidate => {
    const base = { name: tool.name, title: tool.toolName, ...provenance };
    if (!input.profile.toolsEnabled) return { ...base, reason: 'agent-tools-disabled' };
    if (!toolNameMatches(allowlist, tool.name)) return { ...base, reason: 'agent-allowlist' };
    if (!(input.toolSettings.get(tool.name)?.enabled ?? true)) {
      return { ...base, reason: 'tool-setting-disabled' };
    }
    return { ...base, definition: tool.definition };
  });

  const overlong = server.overlongToolNames.map(
    (name): ToolCapabilityCandidate => ({
      name,
      title: parseMcpToolName(name)?.toolName ?? name,
      ...provenance,
      reason: 'name-over-provider-limit',
    })
  );

  return [...candidates, ...overlong];
}
