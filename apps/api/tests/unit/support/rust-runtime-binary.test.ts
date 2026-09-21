/**
 * Regression tests for `resolveRustRuntimeBinary`'s CI-vs-local-dev split:
 * outside CI, a missing fallback binary is tolerated (the qualification
 * suite skips); in CI, the same missing fallback must fail loudly instead
 * of silently skipping every test and reporting a false-green result.
 */

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const ORIGINAL_CI = process.env.CI;
const ORIGINAL_OVERRIDE = process.env.MANGOSTUDIO_RUNTIME_BINARY;

function restoreEnv(): void {
  if (ORIGINAL_CI === undefined) {
    delete process.env.CI;
  } else {
    process.env.CI = ORIGINAL_CI;
  }
  if (ORIGINAL_OVERRIDE === undefined) {
    delete process.env.MANGOSTUDIO_RUNTIME_BINARY;
  } else {
    process.env.MANGOSTUDIO_RUNTIME_BINARY = ORIGINAL_OVERRIDE;
  }
}

describe('resolveRustRuntimeBinary', () => {
  beforeEach(() => {
    delete process.env.MANGOSTUDIO_RUNTIME_BINARY;
  });

  afterEach(() => {
    mock.restore();
    restoreEnv();
  });

  it('fails loudly in CI when neither the override nor the fallback binary exists', async () => {
    process.env.CI = 'true';
    mock.module('node:fs', () => ({ existsSync: () => false }));

    const { resolveRustRuntimeBinary } = await import('../../support/rust-runtime-binary');
    expect(() => resolveRustRuntimeBinary()).toThrow(/never built the Rust runtime/);
  });

  it('stays tolerant outside CI when the fallback binary is missing', async () => {
    delete process.env.CI;
    mock.module('node:fs', () => ({ existsSync: () => false }));

    const { resolveRustRuntimeBinary } = await import('../../support/rust-runtime-binary');
    expect(resolveRustRuntimeBinary()).toEqual({
      path: expect.stringContaining('mangostudio-runtime'),
      available: false,
    });
  });

  it('reports the fallback as available in CI when it actually exists on disk', async () => {
    process.env.CI = 'true';
    mock.module('node:fs', () => ({ existsSync: () => true }));

    const { resolveRustRuntimeBinary } = await import('../../support/rust-runtime-binary');
    expect(resolveRustRuntimeBinary().available).toBe(true);
  });
});
