import { describe, expect, it } from 'bun:test';

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
