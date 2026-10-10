import { describe, expect, it } from 'bun:test';

import { BUN_ORPHAN_POLICY_ENV, fixtureChildEnvironment } from './support/child-supervision';

describe('controlled child supervision', () => {
  it.each(['1', '0', undefined])('preserves the parent environment with policy %p', (policy) => {
    const ambient = Object.freeze({ PATH: '/fixture/bin', [BUN_ORPHAN_POLICY_ENV]: policy });

    expect(fixtureChildEnvironment(ambient)).toEqual({
      PATH: '/fixture/bin',
      [BUN_ORPHAN_POLICY_ENV]: '0',
    });
    expect(ambient[BUN_ORPHAN_POLICY_ENV]).toBe(policy);
  });

  it('copies the default environment without changing the worker policy', () => {
    const policy = process.env[BUN_ORPHAN_POLICY_ENV];

    const childEnv = fixtureChildEnvironment();

    expect(childEnv).not.toBe(process.env);
    expect(childEnv).toEqual({ ...process.env, [BUN_ORPHAN_POLICY_ENV]: '0' });
    expect(process.env[BUN_ORPHAN_POLICY_ENV]).toBe(policy);
  });
});
