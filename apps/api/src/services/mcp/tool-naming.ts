/**
 * Namespaced MCP tool names: `mcp__<serverSlug>__<toolName>`. The slug charset
 * (lowercase alphanumerics and single dashes, no underscores) guarantees the
 * first `__` after the prefix unambiguously terminates the slug. This file is
 * the only place that builds or parses the format.
 */

import { MCP_SERVER_SLUG_PATTERN } from '@mangostudio/shared/mcp';

export const MCP_TOOL_PREFIX = 'mcp__';
export const MCP_TOOL_SEPARATOR = '__';

/**
 * Some providers cap tool names around 64 characters; longer names are
 * skipped at definition time rather than failing the provider request.
 */
export const MCP_TOOL_NAME_MAX_LENGTH = 64;

const slugPattern = new RegExp(MCP_SERVER_SLUG_PATTERN);

export interface ParsedMcpToolName {
  serverSlug: string;
  toolName: string;
}

/** // Usage: buildMcpToolName('github', 'create_issue') → 'mcp__github__create_issue' */
export function buildMcpToolName(serverSlug: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${serverSlug}${MCP_TOOL_SEPARATOR}${toolName}`;
}

export function isMcpToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Returns null for anything that is not a well-formed namespaced MCP name. */
export function parseMcpToolName(name: string): ParsedMcpToolName | null {
  if (!isMcpToolName(name)) return null;
  const rest = name.slice(MCP_TOOL_PREFIX.length);
  const separatorIndex = rest.indexOf(MCP_TOOL_SEPARATOR);
  if (separatorIndex <= 0) return null;

  const serverSlug = rest.slice(0, separatorIndex);
  const toolName = rest.slice(separatorIndex + MCP_TOOL_SEPARATOR.length);
  if (!slugPattern.test(serverSlug) || toolName.length === 0) return null;
  return { serverSlug, toolName };
}

/** Allowlist entry that admits every tool of one server. */
export function buildMcpServerWildcard(serverSlug: string): string {
  return `${MCP_TOOL_PREFIX}${serverSlug}${MCP_TOOL_SEPARATOR}*`;
}

/**
 * Agent allowlist check: exact names, the global `'*'`, and the per-server
 * `mcp__<slug>__*` wildcard.
 *
 * // Usage: toolNameMatches(new Set(profile.toolNames), 'mcp__github__create_issue')
 */
export function toolNameMatches(allowlist: ReadonlySet<string>, name: string): boolean {
  if (allowlist.has('*') || allowlist.has(name)) return true;
  const parsed = parseMcpToolName(name);
  return parsed !== null && allowlist.has(buildMcpServerWildcard(parsed.serverSlug));
}
