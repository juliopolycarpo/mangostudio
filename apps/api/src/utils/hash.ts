import { createHash, timingSafeEqual } from 'node:crypto';
import type { ToolDefinition } from '../services/providers/types';

/** Computes a SHA-256 hex digest of the given string. */
export function computeHash(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` throws on a length mismatch, so the length check comes
 * first — which does reveal the length, the one property a caller comparing
 * fixed-width digests or opaque tokens is not trying to hide.
 */
export function constantTimeEquals(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

/** Computes a stable hash of tool definitions (sorted by name for determinism). */
export function computeToolsetHash(tools: ToolDefinition[]): string {
  const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  const serialized = JSON.stringify(
    sorted.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }))
  );
  return computeHash(serialized);
}
