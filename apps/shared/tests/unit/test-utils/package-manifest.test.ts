import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SHARED_ROOT = '@mangostudio/shared';
const SHARED_DIR = fileURLToPath(new URL('../../../', import.meta.url));

interface SharedPackageManifest {
  exports?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function readSharedManifest(): Promise<SharedPackageManifest> {
  return Bun.file(new URL('../../../package.json', import.meta.url)).json();
}

function assertFakerDependencyPlacement(manifest: SharedPackageManifest): void {
  const runtime = manifest.dependencies?.['@faker-js/faker'];
  const development = manifest.devDependencies?.['@faker-js/faker'];
  if (runtime?.trim() && development === undefined) return;
  throw new Error(
    `Invalid @faker-js/faker placement: dependencies=${JSON.stringify(runtime)}, devDependencies=${JSON.stringify(development)}; expected a non-empty version in dependencies only for the public @mangostudio/shared/test-utils export`
  );
}

describe('shared package manifest', () => {
  it('removes the private root export and source barrel', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['.']).toBeUndefined();
    expect(await Bun.file(new URL('../../../src/index.ts', import.meta.url)).exists()).toBe(false);
    expect(() => Bun.resolveSync(SHARED_ROOT, SHARED_DIR)).toThrow('Cannot find package');
  });

  it('resolves every retained subpath, including the compatibility contracts barrel', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['./contracts']).toBe('./src/contracts/index.ts');
    expect(manifest.exports?.['./generation']).toBe('./src/generation/index.ts');
    expect(Object.keys(manifest.exports ?? {}).length).toBeGreaterThan(30);
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      expect(subpath.startsWith('./')).toBe(true);
      expect(Bun.resolveSync(`${SHARED_ROOT}/${subpath.slice(2)}`, SHARED_DIR)).toBe(
        resolve(SHARED_DIR, target)
      );
    }
  });

  it('keeps test-utils as an explicit public export', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['./test-utils']).toBe('./src/test-utils/index.ts');
  });

  it('keeps runtime-env as an explicit public export', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['./runtime-env']).toBe('./src/runtime-env/index.ts');
  });

  it('keeps library as an explicit public export', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['./library']).toBe('./src/library/index.ts');
  });

  it('keeps environments as an explicit public export', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['./environments']).toBe('./src/environments/index.ts');
  });

  it('keeps profiles as an explicit public export', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['./profiles']).toBe('./src/profiles/index.ts');
  });

  it('keeps utils/dist-files as an explicit public export', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.exports?.['./utils/dist-files']).toBe('./src/utils/dist-files.ts');
  });

  it('declares faker as a runtime dependency for the exported test-utils entrypoint', async () => {
    const manifest = await readSharedManifest();

    // Public test-utils imports Faker at runtime. Consumers of that export need it
    // installed even when they omit shared's development dependencies.
    assertFakerDependencyPlacement(manifest);
  });

  it.each([
    ['missing', {}],
    ['moved to development', { devDependencies: { '@faker-js/faker': '^10.6.0' } }],
    ['empty version', { dependencies: { '@faker-js/faker': '' } }],
    [
      'duplicated in development',
      {
        dependencies: { '@faker-js/faker': '^10.6.0' },
        devDependencies: { '@faker-js/faker': '^10.6.0' },
      },
    ],
  ] as const)('names dependencies as the expected section when Faker is %s', (_, manifest) => {
    expect(() => assertFakerDependencyPlacement(manifest)).toThrow(
      'expected a non-empty version in dependencies only for the public @mangostudio/shared/test-utils export'
    );
  });
});
