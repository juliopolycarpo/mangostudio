import { join } from 'node:path';
import { ROOT_DIR } from './config';

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
