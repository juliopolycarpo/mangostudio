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

  it('declares faker as a runtime dependency for the exported test-utils entrypoint', async () => {
    const manifest = await readSharedManifest();

    expect(manifest.dependencies?.['@faker-js/faker']).toBe('^10.4.0');
    expect(manifest.devDependencies?.['@faker-js/faker']).toBeUndefined();
  });
});
