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

function assertFixtureDependencies(manifest: SharedPackageManifest): void {
  const runtime = manifest.dependencies?.['@faker-js/faker'];
  const development = manifest.devDependencies?.['@faker-js/faker'];
  if (runtime === undefined && development === undefined) return;
  throw new Error(
    `Invalid fixture dependency: dependencies=${JSON.stringify(runtime)}, devDependencies=${JSON.stringify(development)}; expected no @faker-js/faker declaration for the owned public test-utils export`
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

  it('uses the public owned fixture export without Faker declarations', async () => {
    const manifest = await readSharedManifest();

    assertFixtureDependencies(manifest);
    const { fixtures, createMockUser } = await import('@mangostudio/shared/test-utils');
    expect(fixtures.uuid()).toMatch(/^[0-9a-f-]{36}$/);
    expect(createMockUser().email).toEndWith('@mangostudio.test');
  });

  it('bundles the public test-utils entry for a browser without the retired dependency', async () => {
    const result = await Bun.build({
      entrypoints: [resolve(SHARED_DIR, 'src/test-utils/index.ts')],
      target: 'browser',
      metafile: true,
    });
    expect(result.success).toBe(true);
    if (!result.metafile) {
      throw new Error('test-utils browser build: expected a metafile object | received: undefined');
    }
    expect(Object.keys(result.metafile.inputs).some((path) => path.includes('@faker-js'))).toBe(
      false
    );
  });

  it.each([
    ['runtime dependency', { dependencies: { '@faker-js/faker': '^10.6.0' } }],
    ['moved to development', { devDependencies: { '@faker-js/faker': '^10.6.0' } }],
    ['empty version', { dependencies: { '@faker-js/faker': '' } }],
    [
      'duplicated in development',
      {
        dependencies: { '@faker-js/faker': '^10.6.0' },
        devDependencies: { '@faker-js/faker': '^10.6.0' },
      },
    ],
  ] as const)('rejects the retired fixture dependency when it is %s', (_, manifest) => {
    expect(() => assertFixtureDependencies(manifest)).toThrow(
      'expected no @faker-js/faker declaration for the owned public test-utils export'
    );
  });
});
