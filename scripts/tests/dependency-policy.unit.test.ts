import { describe, expect, test } from 'bun:test';

import {
  assertDependencyCohort,
  assertNoDisallowedWorkspaceDependencies,
  assertTailwindCohort,
  COHORT_DEPENDENCIES,
  DISALLOWED_WORKSPACE_DEPENDENCIES,
  findCohortVersionConflicts,
  findDisallowedWorkspaceDependencies,
  findManifestDependencyViolations,
  findRetiredDependencies,
  formatDependencyPolicyViolation,
  readAllManifests,
  RETIRED_DEPENDENCIES,
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
      'ai',
      '@ai-sdk/deepseek',
      'date-fns',
      'shiki',
      '@tanstack/router-devtools',
      'kysely-bun-sqlite',
    ]);
  });

  test('the real manifests carry no retired specifier and one cohort version', async () => {
    const entries = await readAllManifests();

    expect(entries.map((entry) => entry.workspacePath)).toEqual([
      '',
      'apps/api',
      'apps/frontend',
      'apps/shared',
      'packages/cli',
      'packages/protocol',
    ]);
    expect(findRetiredDependencies(entries)).toEqual([]);
    expect(findCohortVersionConflicts(entries)).toEqual([]);
    await expect(assertDependencyCohort()).resolves.toBeUndefined();
  });

  test('documents the retired specifiers and the version-locked cohort', () => {
    expect(RETIRED_DEPENDENCIES.map((rule) => rule.label)).toEqual([
      '@sinclair/typebox',
      '@elysiajs/*',
    ]);
    expect([...COHORT_DEPENDENCIES]).toEqual(['elysia', 'typebox', '@mangostudio/protocol']);
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
      { workspacePath: 'packages/protocol', manifest: { devDependencies: { typebox: '1.3.13' } } },
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

describe('Tailwind compiler cohort', () => {
  const declarations = {
    tailwindcss: '4.3.3',
    '@tailwindcss/node': '4.3.3',
    '@tailwindcss/oxide': '4.3.3',
  };
  const packages = Object.fromEntries(
    Object.entries(declarations).map(([name, version]) => [name, [`${name}@${version}`] as const])
  );
  test('accepts one exact stylesheet/compiler/scanner release', () => {
    expect(() => assertTailwindCohort({ devDependencies: declarations }, packages)).not.toThrow();
  });
  test('rejects ranges, declaration drift, missing and duplicate resolved compiler versions', () => {
    expect(() =>
      assertTailwindCohort(
        { devDependencies: { ...declarations, tailwindcss: '^4.3.3' } },
        packages
      )
    ).toThrow('expected exact compiler cohort version');
    expect(() =>
      assertTailwindCohort(
        { devDependencies: { ...declarations, '@tailwindcss/node': '4.1.14' } },
        packages
      )
    ).toThrow('@tailwindcss/node: expected exact compiler cohort 4.3.3');
    expect(() =>
      assertTailwindCohort(
        { devDependencies: declarations },
        { ...packages, '@tailwindcss/oxide': ['@tailwindcss/oxide@4.1.14'] }
      )
    ).toThrow('@tailwindcss/oxide: expected resolved compiler cohort 4.3.3');
    expect(() =>
      assertTailwindCohort(
        { devDependencies: declarations },
        { ...packages, 'other/tailwindcss': ['tailwindcss@4.1.14'] }
      )
    ).toThrow('tailwindcss: expected resolved compiler cohort 4.3.3');
    expect(() => assertTailwindCohort({ devDependencies: declarations }, {})).toThrow(
      'received: []'
    );
  });
});
