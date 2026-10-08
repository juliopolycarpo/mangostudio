import { afterEach, describe, expect, test } from 'bun:test';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRouteTree, routeTreeIsCurrent, updateRouteTree } from '../../scripts/routes';

const FRONTEND_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const fixtureRoots: string[] = [];

afterEach(async () => {
  for (const root of fixtureRoots.splice(0)) await rm(root, { recursive: true, force: true });
});

/** Report the first changed line instead of dumping the entire generated tree. */
function expectSameTree(actual: string, expected: string): void {
  const actualLines = actual.split('\n');
  const expectedLines = expected.split('\n');
  const line = Array.from({ length: Math.max(actualLines.length, expectedLines.length) }).findIndex(
    (_, index) => actualLines[index] !== expectedLines[index]
  );
  expect(
    actual,
    `First differing line ${line + 1}: expected ${JSON.stringify(expectedLines[line] ?? '<EOF>')}, received ${JSON.stringify(actualLines[line] ?? '<EOF>')}`
  ).toBe(expected);
}

/** Copy the real route inputs so generation cannot modify the checkout. */
async function createRouteFixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'frontend-routes-'));
  fixtureRoots.push(root);
  await mkdir(join(root, 'src'));
  await cp(join(FRONTEND_ROOT, 'src/routes'), join(root, 'src/routes'), { recursive: true });
  await cp(join(FRONTEND_ROOT, 'tsr.config.json'), join(root, 'tsr.config.json'));
  return root;
}

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

/** Copy the manual entrypoint and its package script into an isolated frontend root. */
async function prepareManualFixture(root: string): Promise<void> {
  await mkdir(join(root, 'scripts'));
  await cp(join(FRONTEND_ROOT, 'scripts/routes.ts'), join(root, 'scripts/routes.ts'));
  await cp(join(FRONTEND_ROOT, 'package.json'), join(root, 'package.json'));
  await symlink(join(FRONTEND_ROOT, 'node_modules'), join(root, 'node_modules'), 'junction');
}

describe('route generation', () => {
  test('matches the checked-in route tree byte for byte', async () => {
    const root = await createRouteFixture();
    await generateRouteTree(root);
    expectSameTree(
      await readFile(join(root, 'src/routeTree.gen.ts'), 'utf8'),
      await readFile(join(FRONTEND_ROOT, 'src/routeTree.gen.ts'), 'utf8')
    );
  });

  test('reports the first differing line', () => {
    expect(() => expectSameTree('same\nchanged\n', 'same\nexpected\n')).toThrow(
      'First differing line 2: expected "expected", received "changed"'
    );
  });

  test('reports a missing trailing line', () => {
    expect(() => expectSameTree('same', 'same\n')).toThrow(
      'First differing line 2: expected "", received "<EOF>"'
    );
  });

  test('resolves configured route, output and temporary paths relative to the frontend root', async () => {
    const root = await createRouteFixture();
    await rename(join(root, 'src/routes'), join(root, 'route-source'));
    await writeFile(
      join(root, 'tsr.config.json'),
      JSON.stringify({
        routesDirectory: './route-source',
        generatedRouteTree: './generated/tree.ts',
        tmpDir: './route-temp',
        quoteStyle: 'double',
      })
    );

    await generateRouteTree(root);

    const generated = await readFile(join(root, 'generated/tree.ts'), 'utf8');
    expect(
      generated.split('\n').find((line) => line.includes('import { Route as rootRouteImport }'))
    ).toBe('import { Route as rootRouteImport } from "./../route-source/__root"');
    expect((await stat(join(root, 'route-temp'))).isDirectory()).toBe(true);
  });

  test('supports the manual package command with byte-identical output', async () => {
    const root = await createRouteFixture();
    await prepareManualFixture(root);
    const command = Bun.spawn([process.execPath, 'run', 'routes'], {
      cwd: root,
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const stderr = await new Response(command.stderr).text();
    expect(await command.exited, stderr).toBe(0);
    expectSameTree(
      await readFile(join(root, 'src/routeTree.gen.ts'), 'utf8'),
      await readFile(join(FRONTEND_ROOT, 'src/routeTree.gen.ts'), 'utf8')
    );
  });

  test('runs the manual entrypoint from another cwd and resolves TSR_TMP_DIR from its frontend root', async () => {
    const root = await createRouteFixture();
    await prepareManualFixture(root);
    const command = Bun.spawn([process.execPath, join(root, 'scripts/routes.ts')], {
      cwd: tmpdir(),
      env: { ...process.env, TSR_TMP_DIR: './environment-temp' },
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const stderr = await new Response(command.stderr).text();
    expect(await command.exited, stderr).toBe(0);
    expect((await stat(join(root, 'environment-temp'))).isDirectory()).toBe(true);
    expectSameTree(
      await readFile(join(root, 'src/routeTree.gen.ts'), 'utf8'),
      await readFile(join(FRONTEND_ROOT, 'src/routeTree.gen.ts'), 'utf8')
    );
  });
});

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
