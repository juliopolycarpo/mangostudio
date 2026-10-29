import { describe, expect, test } from 'bun:test';

import { preparedFrontendBuildStamp } from '../lib/prepared-frontend';

const expected = {
  gitSha: 'a'.repeat(12),
  gitDirty: false,
  buildType: 'production',
  builtAt: '2026-10-29T00:01:00.000Z',
};

describe('preparedFrontendBuildStamp', () => {
  test('reuses the prepared build time while requiring the same source and mode', () => {
    const prepared = { ...expected, builtAt: '2026-10-29T00:00:00.000Z' };
    expect(preparedFrontendBuildStamp(prepared, expected)).toEqual(prepared);
  });

  test.each([true, 'unknown'] as const)(
    'refuses reuse when both source stamps are %j dirty',
    (gitDirty) => {
      const dirty = { ...expected, gitDirty };
      expect(() => preparedFrontendBuildStamp(dirty, dirty)).toThrow(
        `expected prepared frontend source: clean | received gitDirty: ${String(gitDirty)}`
      );
    }
  );

  test.each([
    ['gitSha', 'b'.repeat(12)],
    ['gitDirty', true],
    ['buildType', 'development'],
  ] as const)('rejects a prepared %s mismatch', (field, value) => {
    expect(() => preparedFrontendBuildStamp({ ...expected, [field]: value }, expected)).toThrow(
      `expected frontend ${field}: ${String(expected[field])} | received: ${String(value)}`
    );
  });

  test.each([null, [], 'stamp'].map((value) => [value] as const))(
    'rejects non-object stamp %j',
    (value) => {
      expect(() => preparedFrontendBuildStamp(value, expected)).toThrow(
        'expected frontend build-info object'
      );
    }
  );

  test.each([null, '', '1', 'yesterday'])('rejects invalid build time %j', (builtAt) => {
    expect(() => preparedFrontendBuildStamp({ ...expected, builtAt }, expected)).toThrow(
      `expected frontend builtAt: ISO date string | received: ${String(builtAt)}`
    );
  });
});
