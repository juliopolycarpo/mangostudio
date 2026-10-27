import { describe, expect, it } from 'bun:test';

import { fixtures } from '../../../src/test-utils/fixtures';

const V4_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sample() {
  return [
    fixtures.uuid(),
    fixtures.name(),
    fixtures.email(),
    fixtures.suffix(),
    fixtures.words(3),
    fixtures.sentence(),
    fixtures.fileName(),
    fixtures.companyName(),
  ];
}

describe('owned fixture sequence', () => {
  it('provides usable values before explicit seeding', () => {
    expect(fixtures.uuid()).toMatch(V4_ID);
    expect(fixtures.name()).toMatch(/^Test [a-z0-9]{8}$/);
  });

  it('repeats the complete sequence after seeding, including interleaved values', () => {
    fixtures.seed(42);
    const first = sample();
    const second = sample();
    expect(second).not.toEqual(first);
    fixtures.seed(42);
    expect(sample()).toEqual(first);
    expect(sample()).toEqual(second);
    fixtures.seed(43);
    expect(sample()).not.toEqual(first);
  });

  it('normalizes seeds to uint32 consistently', () => {
    fixtures.seed(-1);
    const negative = sample();
    fixtures.seed(0xffff_ffff);
    expect(sample()).toEqual(negative);
    fixtures.seed(0x1_0000_0000);
    const wrapped = sample();
    fixtures.seed(0);
    expect(sample()).toEqual(wrapped);
  });

  it('creates 10,000 distinct v4-shaped identifiers within a sequence', () => {
    fixtures.seed(20261023);
    const ids = new Set<string>();
    for (let index = 0; index < 10_000; index += 1) {
      const id = fixtures.uuid();
      expect(id).toMatch(V4_ID);
      ids.add(id);
    }
    expect(ids.size).toBe(10_000);
  });

  it('generates only the narrow text, suffix and filename shapes callers use', () => {
    expect(fixtures.email()).toMatch(/^[a-z0-9]{16}@mangostudio\.test$/);
    expect(fixtures.suffix()).toMatch(/^[a-z0-9]{4}$/);
    expect(fixtures.words(3).split(' ')).toHaveLength(3);
    expect(fixtures.words(0)).toBe('');
    expect(fixtures.sentence()).toMatch(/^(?:[a-z0-9]{6} ){4}[a-z0-9]{6}\.$/);
    expect(fixtures.fileName()).toMatch(/^fixture-[a-z0-9]{8}$/);
    expect(fixtures.companyName()).toMatch(/^Fixture [a-z0-9]{8} Ltd$/);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid word count %s',
    (count) => {
      expect(() => fixtures.words(count)).toThrow(
        `fixtures.words: expected a nonnegative safe integer | received: ${count}`
      );
    }
  );
});
