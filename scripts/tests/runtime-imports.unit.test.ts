import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { walkRuntimeImports } from './support/runtime-imports';

const SPECIFIER = '@mangostudio/api/test-support/chatgpt/fake-server';
const EXPORT = './test-support/chatgpt/fake-server';
const TARGET = './tests/support/chatgpt/fake-server.ts';
let fixtureRoot: string;

function writeFixture(path: string, source: string): void {
  const target = join(fixtureRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
}

function writeAlias(targets: string[]): void {
  writeFixture(
    'scripts/tsconfig.json',
    JSON.stringify({ compilerOptions: { paths: { [SPECIFIER]: targets } } })
  );
}

function writeApiManifest(exports: Record<string, string>, name = '@mangostudio/api'): void {
  writeFixture('apps/api/package.json', JSON.stringify({ name, exports }));
}

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), 'mangostudio-workspace-imports-'));
  writeFixture('package.json', JSON.stringify({ name: '@mangostudio/root' }));
  writeFixture('scripts/entry.ts', `import { fixture } from '${SPECIFIER}';\n`);
  writeAlias([`../apps/api/${TARGET.slice(2)}`]);
  writeApiManifest({ [EXPORT]: TARGET });
  writeFixture('apps/api/tests/support/chatgpt/fake-server.ts', "export * from './index';\n");
  writeFixture('apps/api/tests/support/chatgpt/index.ts', 'export const fixture = 1;\n');
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('runtime import walker workspace aliases', () => {
  test('follows the export and still reports a transitive external runtime dependency', () => {
    writeFixture(
      'apps/api/tests/support/chatgpt/index.ts',
      "import 'external-runtime';\nimport type { Model } from 'type-only-model';\n"
    );

    const walk = walkRuntimeImports('scripts/entry.ts', fixtureRoot);

    expect(walk.files.has(join(fixtureRoot, 'apps/api/tests/support/chatgpt/fake-server.ts'))).toBe(
      true
    );
    expect([...walk.externalSpecifiers]).toEqual([
      ['external-runtime', ['apps/api/tests/support/chatgpt/index.ts']],
    ]);
  });

  test('accepts a relative fixture root while following the same original source', () => {
    const walk = walkRuntimeImports('scripts/entry.ts', relative(process.cwd(), fixtureRoot));

    expect(walk.files.size).toBe(3);
    expect([...walk.externalSpecifiers]).toEqual([]);
  });

  test('keeps unmapped workspace imports external instead of trusting their prefix', () => {
    rmSync(join(fixtureRoot, 'scripts/tsconfig.json'));

    expect([...walkRuntimeImports('scripts/entry.ts', fixtureRoot).externalSpecifiers]).toEqual([
      [SPECIFIER, ['scripts/entry.ts']],
    ]);
  });

  test('rejects an alias when the API no longer deliberately exports it', () => {
    writeApiManifest({});

    expect(() => walkRuntimeImports('scripts/entry.ts', fixtureRoot)).toThrow(
      `expected one file matching @mangostudio/api export "${EXPORT}"; received package "@mangostudio/api" with export target undefined`
    );
  });

  test('rejects an alias that points to a different file than the API export', () => {
    writeFixture('apps/api/tests/support/alternate.ts', 'export const fixture = 2;\n');
    writeAlias(['../apps/api/tests/support/alternate.ts']);

    expect(() => walkRuntimeImports('scripts/entry.ts', fixtureRoot)).toThrow(
      `Workspace alias "${SPECIFIER}" -> ["../apps/api/tests/support/alternate.ts"] | expected one file matching @mangostudio/api export "${EXPORT}"; received different manifest export target ${TARGET}`
    );
  });

  test('rejects the wrong package owner even if its export target matches', () => {
    writeApiManifest({ [EXPORT]: TARGET }, '@mangostudio/other');

    expect(() => walkRuntimeImports('scripts/entry.ts', fixtureRoot)).toThrow(
      `received package "@mangostudio/other" with export target "${TARGET}"`
    );
  });

  test('rejects fallback and wildcard alias targets', () => {
    for (const targets of [
      [`../apps/api/${TARGET.slice(2)}`, '../apps/api/fallback.ts'],
      ['../apps/api/tests/support/*'],
    ]) {
      writeAlias(targets);

      expect(() => walkRuntimeImports('scripts/entry.ts', fixtureRoot)).toThrow(
        `Workspace alias "${SPECIFIER}" -> ${JSON.stringify(targets)} | expected one file matching @mangostudio/api export "${EXPORT}"; wildcard or fallback targets are not allowed`
      );
    }
  });

  test('rejects a target outside the fixture without reading that path', () => {
    writeAlias(['../../outside.ts']);

    expect(() => walkRuntimeImports('scripts/entry.ts', fixtureRoot)).toThrow(
      `Workspace alias "${SPECIFIER}" -> ["../../outside.ts"] | expected one file matching @mangostudio/api export "${EXPORT}"; received a path outside the repository`
    );
  });

  test('rejects a missing exported file with the intended target-shape error', () => {
    rmSync(join(fixtureRoot, 'apps/api', TARGET));

    expect(() => walkRuntimeImports('scripts/entry.ts', fixtureRoot)).toThrow(
      `expected one file matching @mangostudio/api export "${EXPORT}"; received a missing or non-file target`
    );
  });
});
