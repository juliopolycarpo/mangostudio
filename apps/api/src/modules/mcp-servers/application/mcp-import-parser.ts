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
  McpPortabilitySecretReference,
} from '@mangostudio/shared/mcp';
import {
  MCP_SERVER_NAME_MAX_LENGTH,
  MCP_SERVER_SLUG_MAX_LENGTH,
  McpPortableDocumentSchema,
} from '@mangostudio/shared/mcp';
import { Value } from '@sinclair/typebox/value';
import { isHttpUrl, isValidMcpServerSlug, McpServerError } from '../domain/mcp-server';
import { analyzeMcpHttpUrl, looksCredentialShaped } from './mcp-credential-policy';

export interface ParsedImportEntry {
  preview: McpImportPreviewEntry;
  /** Present only when `preview.action` is `create`; may carry header secrets. */
  body?: AddMcpServerBody;
  /** Secret-safe preview metadata plus write-only values kept server-side. */
  secrets: {
    references: McpPortabilitySecretReference[];
    secretEnv: Record<string, string>;
    headers: Record<string, string>;
    unresolvedSecretEnvNames: string[];
    unresolvedHeaderNames: string[];
  };
}

/** `${VAR}`, `${env:VAR}`, `${input:id}` — editor-specific expansions v1 rejects. */
const PLACEHOLDER_PATTERN = /\$\{[^}]*\}/;

/**
 * Parse a raw import source and map every server entry.
 * // Usage: parseMcpImportSource('{"mcpServers":{"github":{"command":"bunx"}}}')
 */
export function parseMcpImportSource(source: string): ParsedImportEntry[] {
  const { map, metadata } = extractServerDocument(source);
  const entries: ParsedImportEntry[] = [];
  const seenSlugs = new Set<string>();

  for (const [key, value] of Object.entries(map)) {
    const entry = mapServerEntry(key, value, readPortableMetadata(metadata[key]));
    if (entry.preview.action === 'create') {
      if (seenSlugs.has(entry.preview.slug)) {
        entries.push({
          ...entry,
          preview: skip(entry.preview, 'duplicate-in-source'),
          body: undefined,
        });
        continue;
      }
      seenSlugs.add(entry.preview.slug);
    }
    entries.push(entry);
  }

  return entries;
}

function extractServerDocument(source: string): {
  map: Record<string, unknown>;
  metadata: Record<string, unknown>;
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new McpServerError('Import source is not valid JSON.', 422, ERROR_CODES.VALIDATION);
  }
  if (!isPlainObject(parsed)) {
    throw new McpServerError('Import source must be a JSON object.', 422, ERROR_CODES.VALIDATION);
  }
  if (parsed.version !== undefined) {
    if (parsed.version !== 1) {
      throw new McpServerError(
        'Unsupported MCP portability document version.',
        422,
        ERROR_CODES.VALIDATION
      );
    }
    const validPortableDocument: boolean = Value.Check(McpPortableDocumentSchema, parsed);
    if (!validPortableDocument) {
      throw new McpServerError(
        'Portable MCP document does not match the v1 schema.',
        422,
        ERROR_CODES.VALIDATION
      );
    }
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
      return {
        map: inner,
        metadata: readPortableMetadataMap(parsed['x-mangostudio']),
      };
    }
  }
  return { map: parsed, metadata: {} };
}

interface PortableMetadataInput {
  name?: string;
  enabled?: boolean;
  timeoutMs?: number | null;
  secretEnvNames: string[];
  headerNames: string[];
}

function mapServerEntry(
  key: string,
  value: unknown,
  metadata: PortableMetadataInput
): ParsedImportEntry {
  const slug = deriveSlug(key);
  const base: McpImportPreviewEntry = {
    key,
    slug,
    name: (metadata.name ?? key).slice(0, MCP_SERVER_NAME_MAX_LENGTH),
    headerNames: [],
    action: 'create',
  };

  if (!isPlainObject(value)) {
    return invalid(base, 'invalid-entry', 'entry is not an object');
  }
  if (!isValidMcpServerSlug(slug) || base.name.length === 0) {
    return invalid(base, 'invalid-slug');
  }

  const transport = classifyTransport(value);
  if (transport.kind === 'unsupported') {
    return invalid(base, 'unsupported-transport', transport.detail);
  }

  return transport.kind === 'stdio'
    ? mapStdioEntry(base, value, metadata)
    : mapHttpEntry(base, value, metadata);
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
  value: Record<string, unknown>,
  metadata: PortableMetadataInput
): ParsedImportEntry {
  const command = value.command;
  if (typeof command !== 'string' || command.trim().length === 0) {
    return invalid(base, 'invalid-entry', 'command must be a non-empty string');
  }
  const args = readStringArray(value.args);
  if (args === null) {
    return invalid(base, 'invalid-entry', 'args must be an array of strings');
  }
  const env = readStringRecord(value.env);
  if (env === null) {
    return invalid(base, 'invalid-entry', 'env must map names to strings');
  }

  const placeholder = findPlaceholder([command, ...args, ...Object.values(env)]);
  if (placeholder) return invalid(base, 'placeholder-value', placeholder);

  const publicEnv: Record<string, string> = {};
  const secretEnv: Record<string, string> = {};
  const explicitSecretNames = new Set(metadata.secretEnvNames);
  for (const [name, item] of Object.entries(env)) {
    if (explicitSecretNames.has(name) || looksCredentialShaped(name, item)) secretEnv[name] = item;
    else publicEnv[name] = item;
  }
  const unresolvedSecretEnvNames = metadata.secretEnvNames
    .filter((name) => !Object.hasOwn(secretEnv, name))
    .sort();
  const literalNames = Object.keys(secretEnv).sort();
  const references: McpPortabilitySecretReference[] = [
    ...literalNames.map((name) => ({
      kind: 'env' as const,
      name,
      source: 'literal' as const,
      required: false,
    })),
    ...unresolvedSecretEnvNames.map((name) => ({
      kind: 'env' as const,
      name,
      source: 'reference' as const,
      required: true,
    })),
  ];

  return {
    preview: { ...base, transport: 'stdio', command },
    body: {
      name: base.name,
      slug: base.slug,
      transport: 'stdio',
      command: command.trim(),
      args,
      env: publicEnv,
      ...(literalNames.length > 0 && { secretEnv }),
      ...(metadata.enabled !== undefined && { enabled: metadata.enabled }),
      ...(metadata.timeoutMs !== undefined && { timeoutMs: metadata.timeoutMs }),
    },
    secrets: {
      references,
      secretEnv,
      headers: {},
      unresolvedSecretEnvNames,
      unresolvedHeaderNames: [],
    },
  };
}

function mapHttpEntry(
  base: McpImportPreviewEntry,
  value: Record<string, unknown>,
  metadata: PortableMetadataInput
): ParsedImportEntry {
  const rawUrl = value.url;
  if (typeof rawUrl !== 'string' || !isHttpUrl(rawUrl)) {
    return invalid(base, 'invalid-entry', 'url must be an http(s) URL');
  }
  const headers = readStringRecord(value.headers);
  if (headers === null) {
    return invalid(base, 'invalid-entry', 'headers must map names to strings');
  }

  const placeholder = findPlaceholder([rawUrl, ...Object.values(headers)]);
  if (placeholder) return invalid(base, 'placeholder-value', placeholder);

  const analyzedUrl = analyzeMcpHttpUrl(rawUrl);
  if (analyzedUrl.credentialQueryNames.length > 0) {
    return invalid(
      base,
      'invalid-entry',
      `credential query parameters are not portable: ${analyzedUrl.credentialQueryNames.join(', ')}`
    );
  }
  if (analyzedUrl.embeddedAuthorization !== undefined) {
    const authorizationName = Object.keys(headers).find(
      (name) => name.toLowerCase() === 'authorization'
    );
    if (authorizationName !== undefined) {
      return invalid(
        base,
        'invalid-entry',
        'URL credentials conflict with an Authorization header'
      );
    }
    headers.Authorization = analyzedUrl.embeddedAuthorization;
  }
  const url = analyzedUrl.normalizedUrl;

  const unresolvedHeaderNames = metadata.headerNames
    .filter((name) => !Object.hasOwn(headers, name))
    .sort();
  const literalNames = Object.keys(headers).sort();
  const headerNames = [...new Set([...literalNames, ...unresolvedHeaderNames])].sort();
  const references: McpPortabilitySecretReference[] = [
    ...literalNames.map((name) => ({
      kind: 'header' as const,
      name,
      source: 'literal' as const,
      required: false,
    })),
    ...unresolvedHeaderNames.map((name) => ({
      kind: 'header' as const,
      name,
      source: 'reference' as const,
      required: true,
    })),
  ];

  return {
    preview: { ...base, transport: 'http', url, headerNames },
    body: {
      name: base.name,
      slug: base.slug,
      transport: 'http',
      url,
      ...(literalNames.length > 0 && { headers }),
      ...(metadata.enabled !== undefined && { enabled: metadata.enabled }),
      ...(metadata.timeoutMs !== undefined && { timeoutMs: metadata.timeoutMs }),
    },
    secrets: {
      references,
      secretEnv: {},
      headers,
      unresolvedSecretEnvNames: [],
      unresolvedHeaderNames,
    },
  };
}

function readPortableMetadataMap(extension: unknown): Record<string, unknown> {
  if (!isPlainObject(extension) || !isPlainObject(extension.servers)) return {};
  return extension.servers;
}

function readPortableMetadata(value: unknown): PortableMetadataInput {
  if (!isPlainObject(value)) return { secretEnvNames: [], headerNames: [] };
  return {
    ...(typeof value.name === 'string' && value.name.length > 0 && { name: value.name }),
    ...(typeof value.enabled === 'boolean' && { enabled: value.enabled }),
    ...((value.timeoutMs === null ||
      (typeof value.timeoutMs === 'number' && value.timeoutMs > 0)) && {
      timeoutMs: value.timeoutMs,
    }),
    secretEnvNames: readUniqueStringArray(value.secretEnvNames),
    headerNames: readUniqueStringArray(value.headerNames),
  };
}

function readUniqueStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0)),
  ].sort();
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

function emptySecrets(): ParsedImportEntry['secrets'] {
  return {
    references: [],
    secretEnv: {},
    headers: {},
    unresolvedSecretEnvNames: [],
    unresolvedHeaderNames: [],
  };
}

function invalid(
  entry: McpImportPreviewEntry,
  reason: McpImportReason,
  detail?: string
): ParsedImportEntry {
  return { preview: unsupported(entry, reason, detail), secrets: emptySecrets() };
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
