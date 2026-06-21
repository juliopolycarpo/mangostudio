import { describe, expect, it } from 'bun:test';
import { generateId } from '../../../src/utils/id';

describe('generateId', () => {
  it('returns a timestamp-prefixed ID with a secure random suffix', () => {
    const id = generateId();

    expect(id).toMatch(/^\d+-[0-9a-f]{16}$/);
  });

  it('returns unique values across calls', () => {
    const ids = Array.from({ length: 100 }, () => generateId());

    expect(new Set(ids).size).toBe(ids.length);
  });
});
