import { describe, expect, it } from 'bun:test';

import { parseTestPassCounts } from './test-pass-counts';

describe('parseTestPassCounts', () => {
  it('sums root and workspace test output from nested scripts', () => {
    const stats = parseTestPassCounts(`
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

  it('counts the coverage-pass task names emitted by the single CI test run', () => {
    const stats = parseTestPassCounts(`
  470 pass
@mangostudio/frontend test:coverage: Tests  254 passed (254)
@mangostudio/frontend test:coverage:  31 pass
@mangostudio/api test:coverage:  812 pass
@mangostudio/shared test:coverage:  96 pass
`);

    expect(stats).toEqual({
      root: 470,
      frontend: 285,
      api: 812,
      shared: 96,
    });
  });
});
