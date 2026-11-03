import { describe, expect, it } from 'bun:test';

import Value from 'typebox/value';

import { ToolIdentitySchema, ToolIdentityUpdateSchema } from '../../src/tool-identity';

const identity = {
  subjectKey: 'agent:claude',
  displayName: null,
  monogram: null,
  image: { source: 'upload', url: null, cached: true },
  updatedAt: 1000,
};

describe('tool identity image cache contract', () => {
  it('accepts legacy responses and opaque cache keys', () => {
    expect(Value.Check(ToolIdentitySchema, identity)).toBe(true);
    expect(
      Value.Check(ToolIdentitySchema, {
        ...identity,
        image: { ...identity.image, cacheKey: 'opaque/image-identity' },
      })
    ).toBe(true);
  });

  it.each(['', null, 1])('rejects invalid response cache key %j', (cacheKey) => {
    expect(
      Value.Check(ToolIdentitySchema, {
        ...identity,
        image: { ...identity.image, cacheKey },
      })
    ).toBe(false);
  });

  it('keeps response cache keys out of the strict write contract', () => {
    const image = { source: 'url', url: 'https://cdn.example.test/logo.png', cache: false };
    expect(Value.Check(ToolIdentityUpdateSchema, { image })).toBe(true);
    expect(Value.Check(ToolIdentityUpdateSchema, { image: { ...image, cacheKey: 'forged' } })).toBe(
      false
    );
  });
});
