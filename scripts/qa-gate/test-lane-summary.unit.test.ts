import { describe, expect, it } from 'bun:test';

import { parseTestLanePassCounts } from './test-lane-summary';

describe('parseTestLanePassCounts', () => {
  it('sums root and workspace test output from nested scripts', () => {
    const stats = parseTestLanePassCounts(`
  6 pass
@mangostudio/frontend test:unit:bun:  31 pass
@mangostudio/frontend test:unit:vitest: Tests 42 passed
@mangostudio/api test:unit:  120 pass
@mangostudio/shared test:unit:  18 pass
`);

    expect(stats).toEqual({
      root: 6,
      frontend: 73,
      api: 120,
      shared: 18,
    });
  });
});
