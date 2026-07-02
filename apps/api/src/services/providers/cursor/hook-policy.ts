/**
 * Pure policy for Cursor hook scripts that gate built-in tools.
 * Allows only the SDK custom-user-tools MCP server; denies everything else.
 */

export const CURSOR_CUSTOM_USER_TOOLS_SERVER = 'custom-user-tools';

export interface CursorHookDecision {
  permission: 'allow' | 'deny';
  user_message?: string;
  agent_message?: string;
}

const DENY_USER_MESSAGE =
  'Built-in Cursor tools are disabled. Use the MangoStudio tools exposed for this chat.';
const DENY_AGENT_MESSAGE =
  'Built-in Cursor tools are blocked by MangoStudio policy. Use the custom-user-tools MCP tools instead.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** True when the hook payload targets the SDK custom-user-tools MCP server. */
export function isCustomUserToolsMcpCall(payload: unknown): boolean {
  if (!isRecord(payload)) return false;

  const provider =
    readString(payload.provider_identifier) ??
    readString(payload.providerIdentifier) ??
    readString(payload.mcp_server) ??
    readString(payload.server);

  if (provider === CURSOR_CUSTOM_USER_TOOLS_SERVER) return true;

  const toolName = readString(payload.tool_name) ?? readString(payload.toolName) ?? '';
  if (toolName.includes(CURSOR_CUSTOM_USER_TOOLS_SERVER)) return true;

  const name = readString(payload.name) ?? '';
  if (name.includes(CURSOR_CUSTOM_USER_TOOLS_SERVER)) return true;

  return false;
}

/** Evaluates a Cursor preToolUse / beforeShellExecution hook payload. */
export function evaluateCursorBuiltinToolHook(payload: unknown): CursorHookDecision {
  if (isCustomUserToolsMcpCall(payload)) {
    return { permission: 'allow' };
  }

  return {
    permission: 'deny',
    user_message: DENY_USER_MESSAGE,
    agent_message: DENY_AGENT_MESSAGE,
  };
}
