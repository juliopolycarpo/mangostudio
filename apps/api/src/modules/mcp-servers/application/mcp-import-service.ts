/**
 * One-shot import of MCP servers from an mcp.json source. The DB stays the
 * single source of truth: preview/apply copy entries into normal managed rows
 * and never keep a link back to the file.
 */

import { homedir } from 'node:os';
import { extname, isAbsolute, join } from 'node:path';
import { ERROR_CODES } from '@mangostudio/shared/errors';
import type {
  ImportMcpServersBody,
  ImportMcpServersResponse,
  McpImportPreviewResponse,
  McpImportResultEntry,
  PreviewMcpImportBody,
} from '@mangostudio/shared/mcp';
import { MCP_IMPORT_MAX_SOURCE_BYTES } from '@mangostudio/shared/mcp';
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types';
import { RegularFileReadError, readRegularFileUtf8 } from '../../../lib/safe-file';
import { McpServerError } from '../domain/mcp-server';
import { listMcpServerRows } from '../infrastructure/mcp-server-repository';
import { type ParsedImportEntry, parseMcpImportSource } from './mcp-import-parser';
import { createMcpServer } from './mcp-server-service';

export async function previewMcpImport(
  db: Kysely<Database>,
  userId: string,
  body: PreviewMcpImportBody
): Promise<McpImportPreviewResponse> {
  const entries = await parseSourceAgainstExisting(db, userId, body);
  return { entries: entries.map((entry) => entry.preview) };
}

/**
 * Create the selected entries as managed rows. Idempotent on duplicate slugs:
 * an entry that already exists (or races into existence) is reported as
 * skipped, never an error.
 */
export async function importMcpServers(
  db: Kysely<Database>,
  userId: string,
  body: ImportMcpServersBody
): Promise<ImportMcpServersResponse> {
  const entries = await parseSourceAgainstExisting(db, userId, body);
  const selected = new Set(body.slugs);

  const results: McpImportResultEntry[] = [];
  for (const { preview, body: addBody } of entries) {
    if (!selected.has(preview.slug)) continue;

    if (preview.action !== 'create' || !addBody) {
      results.push({
        slug: preview.slug,
        result: preview.action === 'skip-duplicate' ? 'skip-duplicate' : 'unsupported',
        ...(preview.reason !== undefined && { reason: preview.reason }),
      });
      continue;
    }

    try {
      const server = await createMcpServer(db, userId, addBody);
      results.push({ slug: preview.slug, result: 'created', serverId: server.id });
    } catch (error) {
      if (error instanceof McpServerError && error.status === 409) {
        results.push({ slug: preview.slug, result: 'skip-duplicate', reason: 'duplicate-slug' });
        continue;
      }
      throw error;
    }
  }

  return { results };
}

/** Parse the source and demote entries whose slug already has a managed row. */
async function parseSourceAgainstExisting(
  db: Kysely<Database>,
  userId: string,
  body: PreviewMcpImportBody
): Promise<ParsedImportEntry[]> {
  const source = loadMcpImportSource(body);
  const entries = parseMcpImportSource(source);
  const existingSlugs = new Set((await listMcpServerRows(db, userId)).map((row) => row.slug));

  return entries.map((entry) => {
    if (entry.preview.action !== 'create' || !existingSlugs.has(entry.preview.slug)) return entry;
    return {
      ...entry,
      preview: { ...entry.preview, action: 'skip-duplicate', reason: 'duplicate-slug' },
      body: undefined,
    };
  });
}

export function loadMcpImportSource(body: PreviewMcpImportBody): string {
  if ((body.path === undefined) === (body.json === undefined)) {
    throw new McpServerError(
      'Provide exactly one of "path" or "json".',
      422,
      ERROR_CODES.VALIDATION
    );
  }
  if (body.json !== undefined) return body.json;
  return readImportFile(body.path ?? '');
}

function readImportFile(rawPath: string): string {
  const resolved = resolveImportPath(rawPath);
  if (extname(resolved) !== '.json') {
    throw new McpServerError('Only .json files can be imported.', 422, ERROR_CODES.VALIDATION);
  }

  try {
    return readRegularFileUtf8(resolved, { maxBytes: MCP_IMPORT_MAX_SOURCE_BYTES }).content;
  } catch (error) {
    throw toImportFileError(error);
  }
}

/** Same path rules as the rule-file resolver: absolute or `~`-prefixed only. */
function resolveImportPath(rawPath: string): string {
  if (rawPath.startsWith('~')) return join(homedir(), rawPath.slice(1));
  if (!isAbsolute(rawPath)) {
    throw new McpServerError(
      'Import paths must be absolute or start with ~',
      422,
      ERROR_CODES.VALIDATION
    );
  }
  return rawPath;
}

function toImportFileError(error: unknown): McpServerError {
  if (error instanceof RegularFileReadError) {
    if (error.reason === 'not-found') {
      return new McpServerError('File not found.', 404, ERROR_CODES.NOT_FOUND);
    }
    if (error.reason === 'too-large') {
      return new McpServerError(
        `File exceeds the ${MCP_IMPORT_MAX_SOURCE_BYTES / (1024 * 1024)} MiB import limit.`,
        422,
        ERROR_CODES.VALIDATION
      );
    }
    if (error.reason === 'not-regular-file') {
      return new McpServerError('Path is not a regular file.', 422, ERROR_CODES.VALIDATION);
    }
    return new McpServerError('File is not readable.', 422, ERROR_CODES.VALIDATION);
  }
  const message = error instanceof Error ? error.message : 'unknown error';
  return new McpServerError(`Cannot access file: ${message}`, 422, ERROR_CODES.VALIDATION);
}
