import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { routeTreeIsCurrent, updateRouteTree } from '../../scripts/routes';

const fixtureRoots: string[] = [];

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Named fake for the generator call, preserving on-disk output to exercise restamping. */
class RecordingGeneration {
  readonly roots: string[] = [];
  failure?: Error;

  readonly generate = (root: string): Promise<void> => {
    this.roots.push(root);
    return this.failure ? Promise.reject(this.failure) : Promise.resolve();
  };
}

const INPUT_TIME = new Date('2020-01-01T00:00:00Z');
const OUTPUT_TIME = new Date('2020-01-02T00:00:00Z');
const CHANGED_TIME = new Date('2020-01-03T00:00:00Z');

/** Build a small fixture with stable timestamps independent of filesystem precision. */
async function createCurrentFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'frontend-route-freshness-'));
  fixtureRoots.push(root);
  await mkdir(join(root, 'src/routes/nested'), { recursive: true });
  await mkdir(join(root, 'scripts'));
  await writeFile(join(root, 'scripts/routes.ts'), 'route generation helper');
  await writeFile(join(root, 'tsr.config.json'), '{}');
  await writeFile(join(root, 'src/routes/nested/index.tsx'), 'route input');
  await writeFile(join(root, 'src/routeTree.gen.ts'), 'generated output');
  for (const path of [
    'tsr.config.json',
    'scripts/routes.ts',
    'src/routes/nested/index.tsx',
    'src/routes/nested',
    'src/routes',
  ]) {
    await utimes(join(root, path), INPUT_TIME, INPUT_TIME);
  }
  await utimes(join(root, 'src/routeTree.gen.ts'), OUTPUT_TIME, OUTPUT_TIME);
  return root;
}

describe('routeTreeIsCurrent', () => {
  test('accepts output newer than every route input', async () => {
    const root = await createCurrentFixture();
    expect(routeTreeIsCurrent(root)).toBe(true);
  });

  test.each([
    'src/routes/nested/index.tsx',
    'src/routes/nested',
    'src/routes',
    'tsr.config.json',
    'scripts/routes.ts',
  ])('rejects newer %s', async (input) => {
    const root = await createCurrentFixture();
    await utimes(join(root, input), CHANGED_TIME, CHANGED_TIME);
    expect(routeTreeIsCurrent(root)).toBe(false);
  });

  test.each(['src/routeTree.gen.ts', 'src/routes', 'tsr.config.json', 'scripts/routes.ts'])(
    'rejects missing %s',
    async (input) => {
      const root = await createCurrentFixture();
      await rm(join(root, input), { recursive: true });
      expect(routeTreeIsCurrent(root)).toBe(false);
    }
  );

  test('detects a deleted route through its directory mtime', async () => {
    const root = await createCurrentFixture();
    await rm(join(root, 'src/routes/nested/index.tsx'));
    expect(routeTreeIsCurrent(root)).toBe(false);
  });

  test('detects a renamed route through its directory mtime', async () => {
    const root = await createCurrentFixture();
    await rename(
      join(root, 'src/routes/nested/index.tsx'),
      join(root, 'src/routes/nested/new.tsx')
    );
    await utimes(join(root, 'src/routes/nested/new.tsx'), INPUT_TIME, INPUT_TIME);
    expect(routeTreeIsCurrent(root)).toBe(false);
  });
});

describe('updateRouteTree', () => {
  test('skips a current dev tree', async () => {
    const root = await createCurrentFixture();
    const generation = new RecordingGeneration();
    expect(await updateRouteTree({ root }, generation.generate)).toBe(false);
    expect(generation.roots).toEqual([]);
  });

  test.each(['src/routes/nested/index.tsx', 'scripts/routes.ts'])(
    'generates after changing %s and restamps unchanged output so the next build skips',
    async (input) => {
      const root = await createCurrentFixture();
      const generation = new RecordingGeneration();
      await utimes(join(root, input), CHANGED_TIME, CHANGED_TIME);
      expect(await updateRouteTree({ root }, generation.generate)).toBe(true);
      expect(generation.roots).toEqual([root]);
      expect(await readFile(join(root, 'src/routeTree.gen.ts'), 'utf8')).toBe('generated output');
      expect(routeTreeIsCurrent(root)).toBe(true);
      expect(await updateRouteTree({ root }, generation.generate)).toBe(false);
      expect(generation.roots).toEqual([root]);
    }
  );

  test('ignores other scripts and their directory mtime when deciding to skip', async () => {
    const root = await createCurrentFixture();
    const generation = new RecordingGeneration();
    for (const file of ['routes.test.ts', 'generation.log']) {
      await writeFile(join(root, 'scripts', file), 'unrelated input');
      await utimes(join(root, 'scripts', file), CHANGED_TIME, CHANGED_TIME);
    }
    await utimes(join(root, 'scripts'), CHANGED_TIME, CHANGED_TIME);
    expect(routeTreeIsCurrent(root)).toBe(true);
    expect(await updateRouteTree({ root }, generation.generate)).toBe(false);
    expect(generation.roots).toEqual([]);
  });

  test('always generates a production tree without restamping unchanged output', async () => {
    const root = await createCurrentFixture();
    const generation = new RecordingGeneration();
    expect(await updateRouteTree({ force: true, root }, generation.generate)).toBe(true);
    expect(generation.roots).toEqual([root]);
    expect((await stat(join(root, 'src/routeTree.gen.ts'))).mtimeMs).toBe(OUTPUT_TIME.getTime());
  });

  test('propagates generator failure without restamping stale output', async () => {
    const root = await createCurrentFixture();
    const generation = new RecordingGeneration();
    generation.failure = new Error('invalid route "/conflict": expected unique route paths');
    await utimes(join(root, 'tsr.config.json'), CHANGED_TIME, CHANGED_TIME);
    await expect(updateRouteTree({ root }, generation.generate)).rejects.toThrow(
      generation.failure
    );
    expect((await stat(join(root, 'src/routeTree.gen.ts'))).mtimeMs).toBe(OUTPUT_TIME.getTime());
    expect(routeTreeIsCurrent(root)).toBe(false);
  });
});
