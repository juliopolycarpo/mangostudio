import { describe, expect, it } from 'bun:test';

async function readApiManifest() {
  return (await Bun.file(new URL('../../package.json', import.meta.url)).json()) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

describe('api package manifest', () => {
  it('uses owned shared test fixtures without declaring Faker', async () => {
    const manifest = await readApiManifest();
    expect(manifest.dependencies?.['@mangostudio/shared']).toBe('workspace:*');
    expect(manifest.dependencies?.['@faker-js/faker']).toBeUndefined();
    expect(manifest.devDependencies?.['@faker-js/faker']).toBeUndefined();
    const { fixtures } = await import('@mangostudio/shared/test-utils');
    expect(fixtures.uuid()).toMatch(/^[0-9a-f-]{36}$/);
  });
});
