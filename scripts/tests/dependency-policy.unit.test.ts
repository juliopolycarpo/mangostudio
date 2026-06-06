import { describe, expect, test } from 'bun:test';
import {
  assertNoDisallowedWorkspaceDependencies,
  DISALLOWED_WORKSPACE_DEPENDENCIES,
  findDisallowedWorkspaceDependencies,
  findManifestDependencyViolations,
  formatDependencyPolicyViolation,
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
