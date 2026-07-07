import { ERROR_CODES } from '@mangostudio/shared/errors';
import { MCP_SERVER_SLUG_MAX_LENGTH, MCP_SERVER_SLUG_PATTERN } from '@mangostudio/shared/mcp';

export class McpServerError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = 'McpServerError';
  }
}

const SLUG_REGEX = new RegExp(MCP_SERVER_SLUG_PATTERN);

/** True when `slug` is a well-formed server slug. // Usage: isValidMcpServerSlug('github-tools') */
export function isValidMcpServerSlug(slug: string): boolean {
  return slug.length <= MCP_SERVER_SLUG_MAX_LENGTH && SLUG_REGEX.test(slug);
}

/** The transport-discriminated fields a server row must keep consistent. */
export interface McpTransportFields {
  transport: 'stdio' | 'http';
  command: string | null;
  url: string | null;
}

/**
 * Enforces the transport invariants (stdio ⇒ non-empty command, http ⇒
 * http(s) URL) against a complete row — callers merge partial updates first.
 */
export function assertTransportInvariants(fields: McpTransportFields): void {
  if (fields.transport === 'stdio') {
    if (!fields.command?.trim()) {
      throw new McpServerError('stdio MCP servers require a command.', 422, ERROR_CODES.VALIDATION);
    }
    return;
  }

  if (!isHttpUrl(fields.url ?? '')) {
    throw new McpServerError(
      'http MCP servers require an http(s) URL.',
      422,
      ERROR_CODES.VALIDATION
    );
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}
