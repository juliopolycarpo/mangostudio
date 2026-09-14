import { describe, expect, test } from 'bun:test';
import { touchesContractArtifactSurface } from '../lib/contract-artifacts';

describe('contract artifact check scoping', () => {
  test('runs for any shared source, the artifacts, and the emitter', () => {
    for (const file of [
      'apps/shared/src/runtime-contract/contract.ts',
      'apps/shared/src/runtime-contract/methods/fs.ts',
      // Deliberately the whole workspace: a method's params reach library, MCP
      // and environment shapes, so an edit two modules away moves the catalog.
      'apps/shared/src/library/schemas.ts',
      'apps/shared/src/runtime-home/schemas.ts',
      // A hand-edited artifact is the other case the gate exists for, and it is
      // JSON, which the TypeScript pattern does not reach.
      'apps/shared/src/runtime-contract/generated/catalog.json',
      'apps/shared/src/runtime-contract/generated/strings.json',
      'scripts/runtime-contract/artifacts.ts',
      'scripts/runtime-contract/emit.ts',
      // Neither `typebox` nor `@mangostudio/protocol` writes its bytes here, so
      // bumping one moves the catalog without touching a `.ts` file at all.
      'package.json',
      'apps/shared/package.json',
      'bun.lock',
    ]) {
      expect(touchesContractArtifactSurface([file]), file).toBe(true);
    }
  });

  test('skips everything that cannot change what is emitted', () => {
    for (const file of [
      'apps/frontend/src/main.tsx',
      'apps/api/src/app.ts',
      'apps/runtime/src/session.ts',
      'apps/shared/AGENTS.md',
      'apps/shared/tests/unit/runtime-contract.test.ts',
      'docs/architecture/hub-runtime.md',
      'scripts/check.ts',
    ]) {
      expect(touchesContractArtifactSurface([file]), file).toBe(false);
    }
  });

  test('reads a Windows path the same as a posix one', () => {
    expect(
      touchesContractArtifactSurface(['apps\\shared\\src\\runtime-contract\\contract.ts'])
    ).toBe(true);
  });
});
