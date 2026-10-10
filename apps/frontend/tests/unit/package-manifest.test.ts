import { describe, expect, it } from 'bun:test';

interface PackageManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const BUN_TYPES_RANGE = '^1.4.2';
const FRONTEND_MANIFEST = new URL('../../package.json', import.meta.url);

function readManifest(url: URL): Promise<PackageManifest> {
  return Bun.file(url).json();
}

function assertBunTypesDeclaration(manifest: PackageManifest): void {
  const declared = manifest.devDependencies?.['@types/bun'];
  if (declared === BUN_TYPES_RANGE) return;
  throw new Error(
    `Invalid @types/bun declaration ${JSON.stringify(declared)}; expected devDependencies["@types/bun"] to be "${BUN_TYPES_RANGE}" so the workspace resolves its own Bun types`
  );
}

describe('frontend package manifest', () => {
  it('declares Bun types in the frontend workspace instead of inheriting the root copy', async () => {
    assertBunTypesDeclaration(await readManifest(FRONTEND_MANIFEST));
  });

  it('uses the same Bun type range as the root and other TypeScript workspaces', async () => {
    for (const path of [
      '../../package.json',
      '../api/package.json',
      '../shared/package.json',
      '../../packages/protocol/package.json',
    ]) {
      assertBunTypesDeclaration(await readManifest(new URL(path, FRONTEND_MANIFEST)));
    }
  });

  it.each([
    ['missing', {}],
    ['wrong section', { dependencies: { '@types/bun': BUN_TYPES_RANGE } }],
    ['different range', { devDependencies: { '@types/bun': '^1.3.0' } }],
  ] as const)('names the expected section for a %s declaration', (_, manifest) => {
    expect(() => assertBunTypesDeclaration(manifest)).toThrow(
      `expected devDependencies["@types/bun"] to be "${BUN_TYPES_RANGE}"`
    );
  });
});
