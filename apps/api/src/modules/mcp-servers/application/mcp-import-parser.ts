/**
 * Pure parsing for mcp.json imports. Turns the ecosystem's `mcpServers` map
 * (Claude Code `.mcp.json` / `~/.claude.json`, Cursor `mcp.json`, VS Code
 * `mcp.json` with its `servers` key) into preview entries plus, for importable
 * ones, the same add body the manual form submits. Anything this parser cannot
 * map losslessly is reported as unsupported with a reason code — never guessed.
 */

import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  AddMcpServerBody,
  McpImportPreviewEntry,
  McpImportReason,
} from '@mangostudio/shared/mcp';
import { MCP_SERVER_NAME_MAX_LENGTH, MCP_SERVER_SLUG_MAX_LENGTH } from '@mangostudio/shared/mcp';
import { isValidMcpServerSlug, McpServerError } from '../domain/mcp-server';

export interface ParsedImportEntry {
  preview: McpImportPreviewEntry;
  /** Present only when `preview.action` is `create`; may carry header secrets. */
  body?: AddMcpServerBody;
}

/** `${VAR}`, `${env:VAR}`, `${input:id}` — editor-specific expansions v1 rejects. */
const PLACEHOLDER_PATTERN = /\$\{[^}]*\}/;

/**
 * Parse a raw import source and map every server entry.
 * // Usage: parseMcpImportSource('{"mcpServers":{"github":{"command":"bunx"}}}')
 */
export function parseMcpImportSource(source: string): ParsedImportEntry[] {
  const map = extractServerMap(source);
  const entries: ParsedImportEntry[] = [];
  const seenSlugs = new Set<string>();

  for (const [key, value] of Object.entries(map)) {
    const entry = mapServerEntry(key, value);
    if (entry.preview.action === 'create') {
      if (seenSlugs.has(entry.preview.slug)) {
        entries.push({ preview: skip(entry.preview, 'duplicate-in-source') });
        continue;
      }
      seenSlugs.add(entry.preview.slug);
    }
    entries.push(entry);
  }

  return entries;
}

function extractServerMap(source: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new McpServerError('Import source is not valid JSON.', 422, ERROR_CODES.VALIDATION);
  }
  if (!isPlainObject(parsed)) {
    throw new McpServerError('Import source must be a JSON object.', 422, ERROR_CODES.VALIDATION);
  }

  // Claude Code / Cursor wrap the map in `mcpServers`; VS Code uses `servers`;
  // a bare map (the inner object pasted directly) is accepted as-is.
  for (const wrapper of ['mcpServers', 'servers']) {
    const inner = parsed[wrapper];
    if (inner !== undefined) {
      if (!isPlainObject(inner)) {
        throw new McpServerError(
          `"${wrapper}" must be an object mapping names to server configs.`,
          422,
          ERROR_CODES.VALIDATION
        );
      }
      return inner;
    }
  }
  return parsed;
}

function mapServerEntry(key: string, value: unknown): ParsedImportEntry {
  const slug = deriveSlug(key);
  const base: McpImportPreviewEntry = {
    key,
    slug,
    name: key.slice(0, MCP_SERVER_NAME_MAX_LENGTH),
    headerNames: [],
    action: 'create',
  };

  if (!isPlainObject(value)) {
    return { preview: unsupported(base, 'invalid-entry', 'entry is not an object') };
  }
  if (!isValidMcpServerSlug(slug) || base.name.length === 0) {
    return { preview: unsupported(base, 'invalid-slug') };
  }

  const transport = classifyTransport(value);
  if (transport.kind === 'unsupported') {
    return { preview: unsupported(base, 'unsupported-transport', transport.detail) };
  }

  return transport.kind === 'stdio' ? mapStdioEntry(base, value) : mapHttpEntry(base, value);
}

type TransportClass =
  | { kind: 'stdio' | 'http' }
  | { kind: 'unsupported'; detail: string | undefined };

function classifyTransport(value: Record<string, unknown>): TransportClass {
  const type = value.type;
  if (type !== undefined) {
    if (type === 'stdio') return { kind: 'stdio' };
    if (type === 'http' || type === 'streamable-http') return { kind: 'http' };
    return { kind: 'unsupported', detail: typeof type === 'string' ? type : undefined };
  }
  if (typeof value.command === 'string') return { kind: 'stdio' };
  if (typeof value.url === 'string') return { kind: 'http' };
  return { kind: 'unsupported', detail: 'no command or url' };
}

function mapStdioEntry(
  base: McpImportPreviewEntry,
  value: Record<string, unknown>
): ParsedImportEntry {
  const command = value.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    return { preview: unsupported(base, 'invalid-entry', 'command must be a non-empty string') };
  }
  const args = readStringArray(value.args);
  if (args === null) {
    return { preview: unsupported(base, 'invalid-entry', 'args must be an array of strings') };
  }
  const env = readStringRecord(value.env);
  if (env === null) {
    return { preview: unsupported(base, 'invalid-entry', 'env must map names to strings') };
  }

  const placeholder = findPlaceholder([command, ...args, ...Object.values(env)]);
  if (placeholder) return { preview: unsupported(base, 'placeholder-value', placeholder) };

  return {
    preview: { ...base, transport: 'stdio', command },
    body: { name: base.name, slug: base.slug, transport: 'stdio', command, args, env },
  };
}

function mapHttpEntry(
  base: McpImportPreviewEntry,
  value: Record<string, unknown>
): ParsedImportEntry {
  const url = value.url;
  if (typeof url !== 'string' || !isHttpUrl(url)) {
    return { preview: unsupported(base, 'invalid-entry', 'url must be an http(s) URL') };
  }
  const headers = readStringRecord(value.headers);
  if (headers === null) {
    return { preview: unsupported(base, 'invalid-entry', 'headers must map names to strings') };
  }

  const placeholder = findPlaceholder([url, ...Object.values(headers)]);
  if (placeholder) return { preview: unsupported(base, 'placeholder-value', placeholder) };

  return {
    preview: { ...base, transport: 'http', url, headerNames: Object.keys(headers) },
    body: { name: base.name, slug: base.slug, transport: 'http', url, headers },
  };
}

/** Lowercase the map key and collapse everything else into single dashes. */
function deriveSlug(key: string): string {
  return key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MCP_SERVER_SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

function findPlaceholder(values: string[]): string | undefined {
  for (const value of values) {
    const match = PLACEHOLDER_PATTERN.exec(value);
    if (match) return match[0];
  }
  return undefined;
}

function readStringArray(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
  return value as string[];
}

function readStringRecord(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isPlainObject(value)) return null;
  const record: Record<string, string> = {};
  for (const [name, item] of Object.entries(value)) {
    if (typeof item !== 'string') return null;
    record[name] = item;
  }
  return record;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

function unsupported(
  entry: McpImportPreviewEntry,
  reason: McpImportReason,
  detail?: string
): McpImportPreviewEntry {
  return { ...entry, action: 'unsupported', reason, ...(detail !== undefined && { detail }) };
}

function skip(entry: McpImportPreviewEntry, reason: McpImportReason): McpImportPreviewEntry {
  return { ...entry, action: 'skip-duplicate', reason };
}
