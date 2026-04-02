import { createHash } from 'node:crypto';
import type { ToolDefinition } from '../services/providers/types';

/** Computes a SHA-256 hex digest of the given string. */
export function computeHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/** Computes a stable hash of tool definitions (sorted by name for determinism). */
export function computeToolsetHash(tools: ToolDefinition[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const serialized = JSON.stringify(
    sorted.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  );
  return computeHash(serialized);
}
