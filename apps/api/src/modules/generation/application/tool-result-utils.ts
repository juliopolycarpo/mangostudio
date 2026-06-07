import { safeJsonParse } from '../../../lib/safe-parse';

/**
 * Parse a tool-call arguments JSON string into a plain object, defaulting to an
 * empty object when the payload is missing or malformed.
 *
 * // Usage: const args = parseToolArgs('{"agentId":"researcher"}');
 */
export function parseToolArgs(argsStr: string): Record<string, unknown> {
  return safeJsonParse(argsStr) ?? {};
}

/**
 * Serialize a tool result to a JSON string without ever throwing, so a single
 * unserializable result cannot abort the surrounding turn.
 *
 * // Usage: const resultStr = stringifyToolResult({ status: 'ok' });
 */
export function stringifyToolResult(result: unknown): string {
  try {
    const serialized = JSON.stringify(result);
    return typeof serialized === 'string' ? serialized : 'null';
  } catch {
    return JSON.stringify({ error: 'Tool result serialization failed.' });
  }
}

/**
 * Reduce an unknown thrown value to a concise, user-facing tool error message.
 *
 * // Usage: catch (error) { result = { error: errorToToolMessage(error) }; }
 */
export function errorToToolMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Tool execution failed';
}
