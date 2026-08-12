/**
 * `incremental` stays off, and this test is the reason written down.
 *
 * TypeScript 7.0.2 reports `TS2589: Type instantiation is excessively deep and
 * possibly infinite` when a project is checked against a `.tsbuildinfo`
 * produced from different sources — while a cold check of the very same tree
 * passes. Reproduced deterministically: warm the build info on `main`, switch
 * to a branch that adds two Elysia routes, run `tsc --noEmit` without deleting
 * it, and the error appears every time. Delete it first and the check is clean
 * every time.
 *
 * That made the typecheck disagree with itself. CI restored the build info
 * across commits and failed; every local run deleted it and passed. The error
 * carries no file and no line, so there is nothing to chase — the only signal
 * is which cache the run happened to start from.
 *
 * The false-failure direction is what we hit. The false-*pass* direction is
 * worse and equally available: a build info that skips re-checking a file lets
 * CI go green over code that was never checked. Neither is acceptable in a gate.
 *
 * Nothing is lost by removing it. Turbo already skips a workspace whose inputs
 * hash unchanged, which is the same optimization keyed on something that cannot
 * disagree with a cold run, and a cold check of every workspace costs a few
 * seconds in parallel.
 *
 * If a future TypeScript fixes this, deleting this test is the deliberate act
 * that turns it back on.
 */

import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

const TSCONFIGS = [
  'tsconfig.json',
  'apps/api/tsconfig.json',
  'apps/frontend/tsconfig.json',
  'apps/shared/tsconfig.json',
  'apps/runtime/tsconfig.json',
];

describe('typecheck determinism', () => {
  test('no tsconfig enables incremental build info', () => {
    for (const path of TSCONFIGS) {
      const text = readText(path);
      expect(text, path).not.toContain('"incremental"');
      expect(text, path).not.toContain('"tsBuildInfoFile"');
    }
  });

  test('no workflow restores a TypeScript build info directory', () => {
    expect(readText('.github/workflows/lint.yml')).not.toContain('.mango/artifacts/tsbuildinfo');
  });
});
