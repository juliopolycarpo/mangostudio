import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT_DIR } from '../../lib/config';

const DEPENDENCY_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

/** A workspace manifest, reduced to what the typecheck graph depends on. */
export interface WorkspaceManifest {
  /** Repo-relative directory, e.g. `apps/api`. */
  readonly directory: string;
  readonly packageName: string;
  readonly hasTypecheckScript: boolean;
  /** Every package named in a dependency section, workspace or not. */
  readonly dependencyNames: readonly string[];
}

/** The task id Turbo gives a workspace's typecheck. // Usage: typecheckTaskId('@mangostudio/api'); */
export function typecheckTaskId(packageName: string): string {
  return `${packageName}#typecheck`;
}

/**
 * Read the manifest of every workspace matched by the root `workspaces` globs.
 *
 * @example
 * readWorkspaceManifests().map((workspace) => workspace.packageName);
 */
export function readWorkspaceManifests(root: string = ROOT_DIR): WorkspaceManifest[] {
  const rootManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    workspaces?: string[];
  };
  const manifests: WorkspaceManifest[] = [];
  for (const pattern of rootManifest.workspaces ?? []) {
    const glob = new Bun.Glob(`${pattern.replace(/\/$/, '')}/package.json`);
    for (const match of glob.scanSync({ cwd: root, onlyFiles: true })) {
      const directory = match.replace(/\\/g, '/').replace(/\/package\.json$/, '');
      manifests.push(readWorkspaceManifest(root, directory));
    }
  }
  return manifests.sort((left, right) => left.packageName.localeCompare(right.packageName));
}

function readWorkspaceManifest(root: string, directory: string): WorkspaceManifest {
  const manifest = JSON.parse(readFileSync(join(root, directory, 'package.json'), 'utf8')) as {
    name: string;
    scripts?: Record<string, string>;
  } & Partial<Record<(typeof DEPENDENCY_SECTIONS)[number], Record<string, string>>>;
  const dependencyNames = DEPENDENCY_SECTIONS.flatMap((section) =>
    Object.keys(manifest[section] ?? {})
  );
  return {
    directory,
    packageName: manifest.name,
    hasTypecheckScript: manifest.scripts?.typecheck !== undefined,
    dependencyNames: [...new Set(dependencyNames)],
  };
}

/**
 * The typechecks a run filtered to `filtered` has to execute: their own and
 * those of every workspace they depend on, directly or through another
 * workspace, that defines a `typecheck` script. Sorted task ids.
 *
 * @example
 * typecheckClosure(readWorkspaceManifests(), ['@mangostudio/api']);
 * // ['@mangostudio/api#typecheck', '@mangostudio/protocol#typecheck', '@mangostudio/shared#typecheck']
 */
export function typecheckClosure(
  manifests: readonly WorkspaceManifest[],
  filtered: readonly string[]
): string[] {
  const byName = new Map(manifests.map((manifest) => [manifest.packageName, manifest]));
  const reached = new Set<string>();
  const visit = (name: string): void => {
    const manifest = byName.get(name);
    if (!manifest || reached.has(name)) return;
    reached.add(name);
    for (const dependency of manifest.dependencyNames) visit(dependency);
  };
  for (const name of filtered) visit(name);
  return [...reached]
    .filter((name) => byName.get(name)?.hasTypecheckScript)
    .map(typecheckTaskId)
    .sort();
}

/**
 * Compare the typechecks a run filtered to `filtered` executed with the ones
 * the manifests call for. One message per task, naming the workspaces.
 *
 * @example
 * findClosureViolations(manifests, ['@mangostudio/api'], executedTaskIds); // [] when they agree
 */
export function findClosureViolations(
  manifests: readonly WorkspaceManifest[],
  filtered: readonly string[],
  executedTaskIds: readonly string[]
): string[] {
  const expected = typecheckClosure(manifests, filtered);
  const executed = executedTaskIds.filter((id) => id.endsWith('#typecheck')).sort();
  const run = filtered.join(', ');
  return [
    ...expected
      .filter((id) => !executed.includes(id))
      .map(
        (id) =>
          `expected a run filtered to ${run} to execute ${id}, which its manifests depend on | received: ${executed.join(', ')}`
      ),
    ...executed
      .filter((id) => !expected.includes(id))
      .map(
        (id) =>
          `expected a run filtered to ${run} to execute only [${expected.join(', ')}] | received: ${id}`
      ),
  ];
}
