/**
 * Pure form-state model for the MCP server add/edit form. Kept free of React
 * so validation and body-building are unit-testable; the shared TypeBox
 * schemas remain the source of truth for server-side rules — this layer only
 * covers required-field feedback before a request is made.
 */

import type { Messages } from '@mangostudio/shared/i18n';
import type {
  AddMcpServerBody,
  McpServer,
  McpTransport,
  UpdateMcpServerBody,
} from '@mangostudio/shared/mcp';
import { MCP_SERVER_SLUG_PATTERN } from '@mangostudio/shared/mcp';

export interface KeyValueEntry {
  key: string;
  value: string;
}

export interface McpServerFormState {
  name: string;
  slug: string;
  transport: McpTransport;
  command: string;
  args: string[];
  env: KeyValueEntry[];
  url: string;
  /**
   * Replacement auth-header bundle. Stored values are write-only, so this
   * starts empty on edit; non-empty rows replace the whole stored set.
   */
  headers: KeyValueEntry[];
  /** Kept as text so the numeric input can be cleared while typing. */
  timeoutMs: string;
  enabled: boolean;
}

export interface McpServerFormErrors {
  name?: string;
  slug?: string;
  command?: string;
  url?: string;
}

const slugPattern = new RegExp(MCP_SERVER_SLUG_PATTERN);

export function createEmptyFormState(): McpServerFormState {
  return {
    name: '',
    slug: '',
    transport: 'stdio',
    command: '',
    args: [],
    env: [],
    url: '',
    headers: [],
    timeoutMs: '',
    enabled: true,
  };
}

export function formStateFromServer(server: McpServer): McpServerFormState {
  return {
    name: server.name,
    slug: server.slug,
    transport: server.transport,
    command: server.command ?? '',
    args: [...server.args],
    env: Object.entries(server.env).map(([key, value]) => ({ key, value })),
    url: server.url ?? '',
    headers: [],
    timeoutMs: server.timeoutMs === null ? '' : String(server.timeoutMs),
    enabled: server.enabled,
  };
}

export function validateFormState(
  state: McpServerFormState,
  messages: Messages['settings']['mcp']
): McpServerFormErrors {
  const errors: McpServerFormErrors = {};
  if (!state.name.trim()) errors.name = messages.nameRequired;
  if (!state.slug.trim()) errors.slug = messages.slugRequired;
  else if (!slugPattern.test(state.slug.trim())) errors.slug = messages.slugInvalid;
  if (state.transport === 'stdio' && !state.command.trim()) {
    errors.command = messages.commandRequired;
  }
  if (state.transport === 'http' && !state.url.trim()) {
    errors.url = messages.urlRequired;
  }
  return errors;
}

function entriesToRecord(entries: KeyValueEntry[]): Record<string, string> {
  const record: Record<string, string> = {};
  for (const { key, value } of entries) {
    const trimmedKey = key.trim();
    if (trimmedKey) record[trimmedKey] = value;
  }
  return record;
}

function parseTimeoutMs(timeoutMs: string): number | null {
  const parsed = Number(timeoutMs.trim());
  return timeoutMs.trim() && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/** Only the active transport's fields make it into the request body. */
export function buildAddBody(state: McpServerFormState): AddMcpServerBody {
  const common = {
    name: state.name.trim(),
    slug: state.slug.trim(),
    enabled: state.enabled,
    timeoutMs: parseTimeoutMs(state.timeoutMs),
  };
  if (state.transport === 'stdio') {
    return {
      ...common,
      transport: 'stdio',
      command: state.command.trim(),
      args: state.args.filter((arg) => arg.trim().length > 0),
      env: entriesToRecord(state.env),
    };
  }
  return {
    ...common,
    transport: 'http',
    url: state.url.trim(),
    headers: entriesToRecord(state.headers),
  };
}

/**
 * Update body mirrors the add body for the active transport. The stored
 * header bundle is only replaced when the form contains header rows —
 * an untouched (empty) editor keeps the saved, write-only values.
 */
export function buildUpdateBody(state: McpServerFormState): UpdateMcpServerBody {
  const body = buildAddBody(state);
  if (body.transport === 'http' && Object.keys(body.headers ?? {}).length === 0) {
    const { headers: _headers, ...rest } = body;
    return rest;
  }
  return body;
}
