import { describe, expect, test } from 'bun:test';
import {
  assertDependencyCohort,
  assertNoDisallowedWorkspaceDependencies,
  COHORT_DEPENDENCIES,
  DISALLOWED_WORKSPACE_DEPENDENCIES,
  findCohortVersionConflicts,
  findDisallowedWorkspaceDependencies,
  findManifestDependencyViolations,
  findRetiredDependencies,
  formatDependencyPolicyViolation,
  RETIRED_DEPENDENCIES,
  readAllManifests,
} from '../lib/dependency-policy';

describe('dependency policy', () => {
  test('keeps removed unused packages out of workspace manifests', async () => {
    expect(await findDisallowedWorkspaceDependencies()).toEqual([]);
    await expect(assertNoDisallowedWorkspaceDependencies()).resolves.toBeUndefined();
  });

  test('documents the removed package deny list', () => {
    const blockedPackages = DISALLOWED_WORKSPACE_DEPENDENCIES.map((rule) => rule.packageName);

    expect(blockedPackages).toEqual([
      '@ai-sdk/openai-compatible',
      'shiki',
      '@tanstack/router-devtools',
    ]);
  });

  test('the real manifests carry no retired specifier and one cohort version', async () => {
    const entries = await readAllManifests();

    expect(findRetiredDependencies(entries)).toEqual([]);
    expect(findCohortVersionConflicts(entries)).toEqual([]);
    await expect(assertDependencyCohort()).resolves.toBeUndefined();
  });

  test('documents the retired specifiers and the version-locked cohort', () => {
    expect(RETIRED_DEPENDENCIES.map((rule) => rule.label)).toEqual([
      '@sinclair/typebox',
      '@elysiajs/*',
    ]);
    expect([...COHORT_DEPENDENCIES]).toEqual(['elysia', 'typebox']);
  });

  test('rejects a retired specifier in any manifest and any section', () => {
    const violations = findRetiredDependencies([
      { workspacePath: '', manifest: { dependencies: { '@sinclair/typebox': '0.34.41' } } },
      { workspacePath: 'apps/api', manifest: { devDependencies: { '@elysiajs/cors': '1.4.0' } } },
      { workspacePath: 'apps/shared', manifest: { dependencies: { typebox: '1.3.13' } } },
    ]);

    expect(violations.map((entry) => `${entry.workspacePath}:${entry.packageName}`)).toEqual([
      ':@sinclair/typebox',
      'apps/api:@elysiajs/cors',
    ]);
  });

  test('rejects a cohort package declared at two versions', () => {
    const conflicts = findCohortVersionConflicts([
      { workspacePath: 'apps/api', manifest: { dependencies: { elysia: '2.0.0-beta.4' } } },
      { workspacePath: 'apps/shared', manifest: { peerDependencies: { elysia: '1.4.29' } } },
    ]);

    expect(conflicts).toEqual([
      {
        packageName: 'elysia',
        declarations: [
          ['1.4.29', ['apps/shared/package.json peerDependencies']],
          ['2.0.0-beta.4', ['apps/api/package.json dependencies']],
        ],
      },
    ]);
  });

  test('accepts one cohort version declared across several workspaces', () => {
    const entries = [
      { workspacePath: 'apps/api', manifest: { dependencies: { typebox: '1.3.13' } } },
      { workspacePath: 'apps/shared', manifest: { dependencies: { typebox: '1.3.13' } } },
      { workspacePath: 'apps/runtime', manifest: { devDependencies: { typebox: '1.3.13' } } },
    ];

    expect(findCohortVersionConflicts(entries)).toEqual([]);
  });

  test('reports the manifest section that reintroduces a blocked package', () => {
    const [rule] = DISALLOWED_WORKSPACE_DEPENDENCIES;
    const violations = findManifestDependencyViolations(
      { devDependencies: { '@ai-sdk/openai-compatible': '2.0.47' } },
      rule
    );

    expect(violations).toEqual([{ ...rule, section: 'devDependencies' }]);
    expect(formatDependencyPolicyViolation(violations[0])).toContain(
      'apps/api/package.json devDependencies.@ai-sdk/openai-compatible'
    );
  });
});
