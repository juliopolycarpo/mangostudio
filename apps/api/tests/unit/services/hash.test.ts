import { describe, expect, it } from 'bun:test';
import { computeHash, computeToolsetHash } from '../../../src/utils/hash';
import type { ToolDefinition } from '../../../src/services/providers/types';

describe('computeHash', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const hash = computeHash('hello');
    expect(hash).toHaveLength(64);
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it('returns the same hash for the same input', () => {
    expect(computeHash('test')).toBe(computeHash('test'));
  });

  it('returns different hashes for different inputs', () => {
    expect(computeHash('a')).not.toBe(computeHash('b'));
  });
});

describe('computeToolsetHash', () => {
  const tools: ToolDefinition[] = [
    { name: 'b_tool', description: 'B', parameters: { type: 'object' } },
    { name: 'a_tool', description: 'A', parameters: { type: 'object' } },
  ];

  it('produces a deterministic hash regardless of tool order', () => {
    const reversed = [...tools].reverse();
    expect(computeToolsetHash(tools)).toBe(computeToolsetHash(reversed));
  });

  it('changes when a tool definition changes', () => {
    const modified = [
      ...tools.slice(0, 1),
      { ...tools[1], description: 'Modified' },
    ];
    expect(computeToolsetHash(tools)).not.toBe(computeToolsetHash(modified));
  });

  it('returns consistent hash for empty array', () => {
    expect(computeToolsetHash([])).toBe(computeToolsetHash([]));
  });
});
