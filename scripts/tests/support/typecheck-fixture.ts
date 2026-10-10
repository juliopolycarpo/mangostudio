import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { ROOT_DIR } from '../../lib/config';
import { SLOW_MARKER, TYPE_ERROR_MARKER } from './fake-typecheck';
import { readWorkspaceManifests, type WorkspaceManifest } from './typecheck-closure';

// Forward slashes: the path sits inside a double-quoted `bun run` script line.
const FAKE_TYPECHECK = join(import.meta.dir, 'fake-typecheck.ts').replace(/\\/g, '/');

/** The pristine content of a fixture source file; every edit is this plus extra lines. */
const PRISTINE_SOURCE = 'export const value: number = 1;\n';

/**
 * A throwaway monorepo with the real workspace layout, the real root
 * `turbo.jsonc` and the real per-workspace `turbo.json` files, whose
 * `typecheck` scripts run the fake checker instead of `tsc`. It exercises the
 * shipped Turbo graph without editing the working tree or paying for `tsc`.
 *
 * Each workspace has a `src/` that every dependent also reads, and a
 * `private/` that only its own check reads, like a file no other workspace
 * imports.
 */
export interface TypecheckFixture {
  readonly root: string;
  /** Package names of the fixture's workspaces, e.g. `@mangostudio/api`. */
  readonly packageNames: readonly string[];
  /** Turbo arguments that keep this fixture's cache away from the real one. */
  readonly turboArgs: readonly string[];
  /** Rewrite a workspace's `src/` as the pristine source plus `extraLines`. */
  writeSource(packageName: string, extraLines?: string): void;
  /** Make a workspace's `src/` a type error, as an upstream edit would. */
  breakSource(packageName: string): void;
  /** Make a workspace's `private/` a type error that takes a long time to report. */
  breakPrivateSlowly(packageName: string): void;
  dispose(): void;
}

/**
 * Build the fixture from the repository's own workspace manifests.
 *
 * @example
 * const fixture = createTypecheckFixture();
 * fixture.breakSource('@mangostudio/protocol');
 * fixture.dispose();
 */
export function createTypecheckFixture(): TypecheckFixture {
  const workspaces = readWorkspaceManifests().filter((workspace) => workspace.hasTypecheckScript);
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'mango-typecheck-graph-')));
  const byName = new Map(workspaces.map((workspace) => [workspace.packageName, workspace]));

  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: 'typecheck-graph-fixture',
      private: true,
      packageManager: 'bun@1.4.2',
      workspaces: ['apps/*', 'packages/*'],
    })
  );
  // Turbo writes `.turbo/` logs into each workspace; unignored they would
  // change the next run's hash, because this tree is not a git checkout.
  writeFileSync(join(root, '.gitignore'), '.turbo\n.turbo-cache\n');
  copyFileSync(join(ROOT_DIR, 'turbo.jsonc'), join(root, 'turbo.jsonc'));
  for (const workspace of workspaces) {
    mkdirSync(join(root, workspace.directory, 'src'), { recursive: true });
    mkdirSync(join(root, workspace.directory, 'private'), { recursive: true });
    writeFileSync(
      join(root, workspace.directory, 'package.json'),
      JSON.stringify(fixtureManifest(workspace, byName))
    );
    const turboJson = join(ROOT_DIR, workspace.directory, 'turbo.json');
    if (existsSync(turboJson))
      copyFileSync(turboJson, join(root, workspace.directory, 'turbo.json'));
  }

  const fileOf = (packageName: string, directory: 'src' | 'private'): string => {
    const workspace = byName.get(packageName);
    if (!workspace) {
      throw new Error(
        `expected a workspace among [${[...byName.keys()].join(', ')}] | received: ${packageName}`
      );
    }
    return join(root, workspace.directory, directory, 'index.ts');
  };
  const writeSource = (packageName: string, extraLines = ''): void =>
    writeFileSync(fileOf(packageName, 'src'), PRISTINE_SOURCE + extraLines);
  const writePrivate = (packageName: string, extraLines = ''): void =>
    writeFileSync(fileOf(packageName, 'private'), PRISTINE_SOURCE + extraLines);
  for (const packageName of byName.keys()) {
    writeSource(packageName);
    writePrivate(packageName);
  }

  return {
    root,
    packageNames: [...byName.keys()],
    turboArgs: [
      '--cache-dir',
      join(root, '.turbo-cache'),
      '--ui=stream',
      '--log-order=stream',
      '--log-prefix=task',
    ],
    writeSource,
    breakSource: (packageName) => writeSource(packageName, `// ${TYPE_ERROR_MARKER}\n`),
    breakPrivateSlowly: (packageName) =>
      writePrivate(packageName, `// ${TYPE_ERROR_MARKER}\n// ${SLOW_MARKER}\n`),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * A fixture `package.json`: the workspace dependencies, and a fake `typecheck`
 * and, where the real workspace has one, `test:unit`. Both read the workspace's
 * own sources and those of every workspace it imports, as the real ones do:
 * `tsc` resolves them through the workspace link and a unit test imports them.
 */
function fixtureManifest(
  workspace: WorkspaceManifest,
  byName: ReadonlyMap<string, WorkspaceManifest>
): object {
  const dependencies = workspace.dependencyNames.filter((name) => byName.has(name));
  const dependencySources = transitiveDependencies(workspace, byName).map((entry) =>
    posix.relative(workspace.directory, posix.join(entry.directory, 'src'))
  );
  const check = `bun "${FAKE_TYPECHECK}" src private ${dependencySources.join(' ')}`;
  return {
    name: workspace.packageName,
    version: '0.0.0',
    private: true,
    scripts: {
      typecheck: check,
      ...(workspace.hasUnitTestScript ? { 'test:unit': check } : {}),
    },
    dependencies: Object.fromEntries(dependencies.map((name) => [name, 'workspace:*'])),
  };
}

/** Every workspace `workspace` imports, directly or through another workspace. */
function transitiveDependencies(
  workspace: WorkspaceManifest,
  byName: ReadonlyMap<string, WorkspaceManifest>,
  seen = new Set<string>()
): WorkspaceManifest[] {
  for (const name of workspace.dependencyNames) {
    const dependency = byName.get(name);
    if (!dependency || seen.has(name)) continue;
    seen.add(name);
    transitiveDependencies(dependency, byName, seen);
  }
  return [...seen].map((name) => byName.get(name) as WorkspaceManifest);
}
