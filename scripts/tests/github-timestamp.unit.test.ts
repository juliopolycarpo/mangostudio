import { describe, expect, test } from 'bun:test';

import { parseGitHubTimestamp } from '../lib/github-timestamp';

describe('canonical GitHub UTC timestamps', () => {
  test.each([
    ['2026-11-04T10:05:00Z', Date.UTC(2026, 10, 4, 10, 5, 0)],
    ['2026-11-04T10:05:00.123Z', Date.UTC(2026, 10, 4, 10, 5, 0, 123)],
    ['2024-02-29T00:00:00.000Z', Date.UTC(2024, 1, 29)],
    ['1970-01-01T00:00:00Z', 0],
  ] as const)('parses exact supported representation %s', (value, expected) => {
    expect(parseGitHubTimestamp(value, 'artifact created_at')).toBe(expected);
  });
  test.each([
    '2026-02-31T00:00:00Z',
    '2025-02-29T00:00:00Z',
    '2026-13-04T10:05:00Z',
    '2026-11-04',
    '2026-11-04T10:05:00+00:00',
    '2026-11-04T10:05:00.000000Z',
    '2026-11-04T10:05:00.1Z',
    '2026-11-04T10:05:00z',
    '2026-11-04T10:05:00Z\n',
    '2026-11-04T10:05:00.000Z\n',
    ' 2026-11-04T10:05:00Z',
    '',
  ])('rejects noncanonical timestamp %j with its field and invalid value', (value) => {
    expect(() => parseGitHubTimestamp(value, 'artifact created_at')).toThrow(
      `artifact created_at: expected UTC ISO timestamp; received ${JSON.stringify(value)}`
    );
  });
  test.each([undefined, null, 42, {}, []].map((value) => [value]))(
    'rejects nonstring shape %j',
    (value) => {
      expect(() => parseGitHubTimestamp(value, 'job completed_at')).toThrow(
        'job completed_at: expected UTC ISO timestamp'
      );
    }
  );
});
