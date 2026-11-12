import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const FRONTEND_MANIFEST = new URL('../../package.json', import.meta.url);
const ROOT_MANIFEST = new URL('../../package.json', FRONTEND_MANIFEST);
const { catalog, packageManager } = JSON.parse(readFileSync(ROOT_MANIFEST, 'utf8')) as {
  catalog?: Record<string, string>;
  packageManager: string;
};
const BUN_TYPES_RANGE = `^${packageManager.replace(/^bun@/, '')}`;

function readManifest(url: URL): Promise<PackageManifest> {
  return Bun.file(url).json();
}

function assertBunTypesDeclaration(manifest: PackageManifest): void {
  const declared = manifest.devDependencies?.['@types/bun'];
  if (declared === 'catalog:') return;
  throw new Error(
    `Invalid @types/bun declaration ${JSON.stringify(declared)}. Expected devDependencies["@types/bun"] to reference the root catalog with "catalog:".`
  );
}

describe('frontend package manifest', () => {
  it('declares the cataloged Bun types in frontend devDependencies', async () => {
    assertBunTypesDeclaration(await readManifest(FRONTEND_MANIFEST));
  });

  it('uses the default catalog for Bun types in every TypeScript workspace', async () => {
    for (const path of [
      '../../package.json',
      '../api/package.json',
      '../shared/package.json',
      '../../packages/protocol/package.json',
    ]) {
      assertBunTypesDeclaration(await readManifest(new URL(path, FRONTEND_MANIFEST)));
    }
  });

  it('uses the Bun toolchain version for the shared Bun types range', () => {
    const declared = catalog?.['@types/bun'];
    expect(
      declared,
      `root package.json catalog["@types/bun"]: expected ${BUN_TYPES_RANGE} | received: ${JSON.stringify(declared)}`
    ).toBe(BUN_TYPES_RANGE);
  });

  it.each([
    ['a missing declaration', {}],
    ['a declaration in dependencies', { dependencies: { '@types/bun': 'catalog:' } }],
    ['an inline range', { devDependencies: { '@types/bun': BUN_TYPES_RANGE } }],
  ] as const)('names the expected section for %s', (_, manifest) => {
    expect(() => assertBunTypesDeclaration(manifest)).toThrow(
      'Expected devDependencies["@types/bun"] to reference the root catalog with "catalog:".'
    );
  });
});
