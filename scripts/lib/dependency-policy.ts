import { join } from 'node:path';
import { ALL_WORKSPACE_NAMES, ROOT_DIR } from './config';

const MANIFEST_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

type ManifestSection = (typeof MANIFEST_SECTIONS)[number];
export type PackageManifest = Partial<Record<ManifestSection, Record<string, string>>>;

export interface DisallowedWorkspaceDependency {
  readonly workspacePath: string;
  readonly packageName: string;
  readonly reason: string;
  readonly sections?: readonly ManifestSection[];
}

export interface DisallowedWorkspaceDependencyViolation extends DisallowedWorkspaceDependency {
  readonly section: ManifestSection;
}

export const DISALLOWED_WORKSPACE_DEPENDENCIES = [
  {
    workspacePath: 'apps/api',
    packageName: '@ai-sdk/openai-compatible',
    reason: 'OpenAI-compatible providers use the project-owned OpenAI SDK wrapper.',
  },
  {
    workspacePath: 'apps/frontend',
    packageName: 'shiki',
    reason: 'The syntax highlighter imports granular @shikijs/* packages directly.',
  },
  {
    workspacePath: 'apps/frontend',
    packageName: '@tanstack/router-devtools',
    reason: 'Router devtools are not mounted by the application shell.',
  },
] as const satisfies readonly DisallowedWorkspaceDependency[];

interface RetiredDependencyRule {
  /** Human-readable specifier or family, used in the failure message. */
  readonly label: string;
  readonly reason: string;
  readonly matches: (packageName: string) => boolean;
}

/**
 * Specifiers that must not reappear in any manifest, root included.
 *
 * These are not "unused packages" like the deny list above — installing one
 * alongside its replacement produces two copies of the same library, and both
 * of these libraries key behaviour on object identity. A second TypeBox means
 * schemas built by one copy fail validation compiled by the other; a second
 * Elysia scope means plugins built against a different core. Neither shows up
 * as a type error, so the manifests are where it has to be caught.
 */
export const RETIRED_DEPENDENCIES = [
  {
    label: '@sinclair/typebox',
    reason: 'TypeBox ships unscoped as `typebox`; use that.',
    matches: (packageName) => packageName === '@sinclair/typebox',
  },
  {
    label: '@elysiajs/*',
    reason: 'Elysia 2 publishes its official plugins under the `@elysia/*` scope.',
    matches: (packageName) => packageName.startsWith('@elysiajs/'),
  },
] as const satisfies readonly RetiredDependencyRule[];

/**
 * Packages that must carry one version specifier everywhere they are declared.
 *
 * Same reasoning as above, one step further: declaring `elysia` at two
 * different versions lets the isolated linker give workspaces separate copies,
 * and a schema or plugin crossing that boundary is silently not recognised.
 */
export const COHORT_DEPENDENCIES = ['elysia', 'typebox'] as const;

export interface ManifestEntry {
  /** Repo-relative manifest location, e.g. `apps/api`. Empty string for root. */
  readonly workspacePath: string;
  readonly manifest: PackageManifest;
}

export interface RetiredDependencyViolation {
  readonly workspacePath: string;
  readonly section: ManifestSection;
  readonly packageName: string;
  readonly reason: string;
}

export interface CohortVersionConflict {
  readonly packageName: string;
  /** Declared specifier → the manifests declaring it, sorted for stable output. */
  readonly declarations: ReadonlyArray<readonly [string, readonly string[]]>;
}

const manifestLabel = (workspacePath: string): string =>
  workspacePath === '' ? 'package.json' : `${workspacePath}/package.json`;

/**
 * Find retired specifiers across a set of manifests.
 * Usage: findRetiredDependencies(entries)
 */
export const findRetiredDependencies = (
  entries: readonly ManifestEntry[]
): RetiredDependencyViolation[] => {
  const violations: RetiredDependencyViolation[] = [];

  for (const { workspacePath, manifest } of entries) {
    for (const section of MANIFEST_SECTIONS) {
      for (const packageName of Object.keys(manifest[section] ?? {})) {
        const rule = RETIRED_DEPENDENCIES.find((candidate) => candidate.matches(packageName));
        if (rule) violations.push({ workspacePath, section, packageName, reason: rule.reason });
      }
    }
  }

  return violations;
};

/**
 * Find cohort packages declared at more than one version specifier.
 * Usage: findCohortVersionConflicts(entries)
 */
export const findCohortVersionConflicts = (
  entries: readonly ManifestEntry[]
): CohortVersionConflict[] => {
  const conflicts: CohortVersionConflict[] = [];

  for (const packageName of COHORT_DEPENDENCIES) {
    const byVersion = new Map<string, string[]>();

    for (const { workspacePath, manifest } of entries) {
      for (const section of MANIFEST_SECTIONS) {
        // `peerDependencies` deliberately included: a peer range that disagrees
        // with the installed version is the same hazard, declared differently.
        const version = manifest[section]?.[packageName];
        if (!version) continue;
        const sources = byVersion.get(version) ?? [];
        sources.push(`${manifestLabel(workspacePath)} ${section}`);
        byVersion.set(version, sources);
      }
    }

    if (byVersion.size > 1) {
      conflicts.push({
        packageName,
        declarations: [...byVersion.entries()]
          .map(([version, sources]) => [version, [...sources].sort()] as const)
          .sort(([a], [b]) => a.localeCompare(b)),
      });
    }
  }

  return conflicts;
};

const sectionsFor = (rule: DisallowedWorkspaceDependency): readonly ManifestSection[] =>
  rule.sections ?? MANIFEST_SECTIONS;

/**
 * Find package manifest entries blocked by a workspace dependency policy rule.
 * Usage: findManifestDependencyViolations(manifest, rule)
 */
export const findManifestDependencyViolations = (
  manifest: PackageManifest,
  rule: DisallowedWorkspaceDependency
): DisallowedWorkspaceDependencyViolation[] => {
  const violations: DisallowedWorkspaceDependencyViolation[] = [];

  for (const section of sectionsFor(rule)) {
    if (manifest[section]?.[rule.packageName]) violations.push({ ...rule, section });
  }

  return violations;
};

const readWorkspaceManifest = async (workspacePath: string): Promise<PackageManifest> => {
  const packageJsonPath = join(ROOT_DIR, workspacePath, 'package.json');
  return JSON.parse(await Bun.file(packageJsonPath).text()) as PackageManifest;
};

/**
 * Format one blocked dependency violation for CLI and test output.
 * Usage: formatDependencyPolicyViolation(violation)
 */
export const formatDependencyPolicyViolation = (
  violation: DisallowedWorkspaceDependencyViolation
): string =>
  `${violation.workspacePath}/package.json ${violation.section}.${violation.packageName}: ${violation.reason}`;

/**
 * Find blocked direct dependencies across the repository workspace manifests.
 * Usage: await findDisallowedWorkspaceDependencies()
 */
export const findDisallowedWorkspaceDependencies = async (): Promise<
  DisallowedWorkspaceDependencyViolation[]
> => {
  const violations: DisallowedWorkspaceDependencyViolation[] = [];

  for (const rule of DISALLOWED_WORKSPACE_DEPENDENCIES) {
    const manifest = await readWorkspaceManifest(rule.workspacePath);
    violations.push(...findManifestDependencyViolations(manifest, rule));
  }

  return violations;
};

/**
 * Fail when blocked direct dependencies appear in workspace manifests.
 * Usage: await assertNoDisallowedWorkspaceDependencies()
 */
export const assertNoDisallowedWorkspaceDependencies = async (): Promise<void> => {
  const violations = await findDisallowedWorkspaceDependencies();
  if (violations.length === 0) return;

  const details = violations.map(formatDependencyPolicyViolation).join('\n');
  throw new Error(`Disallowed workspace dependencies found:\n${details}`);
};

/**
 * Read the root manifest plus every workspace manifest.
 * Usage: await readAllManifests()
 */
export const readAllManifests = (): Promise<ManifestEntry[]> => {
  const workspacePaths = ['', ...ALL_WORKSPACE_NAMES.map((name) => `apps/${name}`)];

  return Promise.all(
    workspacePaths.map(async (workspacePath) => ({
      workspacePath,
      manifest: await readWorkspaceManifest(workspacePath),
    }))
  );
};

/**
 * Fail when a retired specifier reappears or a cohort package splits versions.
 * Usage: await assertDependencyCohort()
 */
export const assertDependencyCohort = async (): Promise<void> => {
  const entries = await readAllManifests();
  const problems: string[] = [];

  for (const violation of findRetiredDependencies(entries)) {
    problems.push(
      `${manifestLabel(violation.workspacePath)} ${violation.section}.${violation.packageName}: ${violation.reason}`
    );
  }

  for (const conflict of findCohortVersionConflicts(entries)) {
    const declared = conflict.declarations
      .map(([version, sources]) => `    ${version} — ${sources.join(', ')}`)
      .join('\n');
    problems.push(`${conflict.packageName} is declared at more than one version:\n${declared}`);
  }

  if (problems.length === 0) return;

  throw new Error(`Dependency cohort violations found:\n${problems.join('\n')}`);
};
