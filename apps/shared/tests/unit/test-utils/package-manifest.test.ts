import { describe, expect, it } from 'bun:test';

async function readSharedManifest() {
  return (await Bun.file(new URL('../../../package.json', import.meta.url)).json()) as {
    exports?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
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

    expect(manifest.dependencies?.['@faker-js/faker']).toBeDefined();
    expect(manifest.devDependencies?.['@faker-js/faker']).toBeUndefined();
  });
});
