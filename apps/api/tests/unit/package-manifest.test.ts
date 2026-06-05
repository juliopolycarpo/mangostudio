import { describe, expect, it } from 'bun:test';

async function readApiManifest() {
  return (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
    devDependencies?: Record<string, string>;
  };
}

describe('api package manifest', () => {
  it('declares faker for test-only fixtures used by the workspace', async () => {
    const manifest = await readApiManifest();

    expect(manifest.devDependencies?.['@faker-js/faker']).toBe('^10.4.0');
  });
});
