import { afterEach, describe, expect, test } from 'bun:test';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateRouteTree } from '../../scripts/routes';

// Load the cold generator graph during collection, before per-test deadlines start.
await import('@tanstack/router-generator');

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

/** Copy the manual entrypoint and its package script into an isolated frontend root. */
async function prepareManualFixture(root: string): Promise<void> {
  await mkdir(join(root, 'scripts'));
  await cp(join(FRONTEND_ROOT, 'scripts/routes.ts'), join(root, 'scripts/routes.ts'));
  await cp(join(FRONTEND_ROOT, 'package.json'), join(root, 'package.json'));
  await mkdir(join(root, 'node_modules/@tanstack'), { recursive: true });
  await symlink(
    await realpath(join(FRONTEND_ROOT, 'node_modules/@tanstack/router-generator')),
    join(root, 'node_modules/@tanstack/router-generator'),
    'junction'
  );
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
