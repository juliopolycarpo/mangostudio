import { describe, expect, it } from 'bun:test';
import { loadRuntimeConfig } from '../../src/config';

/**
 * The two checks that are on outside production share one discriminator, and
 * both are load-bearing in opposite directions: on, they catch drift before a
 * runtime generated from the same catalog in another language copies it; off,
 * they keep a shape the schema refuses from becoming a 500 for a user who did
 * nothing wrong.
 *
 * So the direction is asserted rather than assumed. Nothing else in the tree
 * would notice a `loadRuntimeConfig` edit that turned result validation on in
 * production — every test process runs outside it.
 */
describe('loadRuntimeConfig validation switches', () => {
  it('checks frames and handler results everywhere but production', () => {
    for (const env of [{}, { NODE_ENV: 'test' }, { NODE_ENV: 'development' }]) {
      const config = loadRuntimeConfig(env);
      expect(config.validateInProcessFrames, JSON.stringify(env)).toBe(true);
      expect(config.validateHandlerResults, JSON.stringify(env)).toBe(true);
    }
  });

  it('turns both off in production', () => {
    const config = loadRuntimeConfig({ NODE_ENV: 'production' });

    expect(config.validateInProcessFrames).toBe(false);
    expect(config.validateHandlerResults).toBe(false);
  });
});
