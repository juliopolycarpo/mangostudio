import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

function expectWorkflowHasPinnedAction(workflow: string, action: string): void {
  const escapedAction = action.replaceAll('/', String.raw`\/`);
  expect(workflow).toMatch(new RegExp(`uses: ${escapedAction}@[a-f0-9]{40} # v\\d`));
}

describe('security workflows', () => {
  test('CodeQL uses explicit advanced setup for the repository languages', () => {
    const workflow = readText('.github/workflows/codeql.yml');
    const languageExpression = '$' + '{{ matrix.language }}';

    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).toContain('push:\n    branches: [main]');
    expect(workflow).toContain('schedule:');
    expect(workflow).toContain('workflow_dispatch:');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('security-events: write');

    expect(workflow).toContain('language: javascript-typescript');
    expect(workflow).toContain('build-mode: none');
    expect(workflow).toContain('queries: security-extended');
    expect(workflow).toContain(`category: "/language:${languageExpression}"`);
    expect(workflow).not.toContain('autobuild');
    expect(workflow).not.toContain('setup-mango');
    expectWorkflowHasPinnedAction(workflow, 'github/codeql-action/init');
    expectWorkflowHasPinnedAction(workflow, 'github/codeql-action/analyze');
  });

  test('dependency review is a PR-only vulnerability gate with no license policy', () => {
    const workflow = readText('.github/workflows/dependency-review.yml');

    expect(workflow).toContain('pull_request:\n    branches: [main]');
    expect(workflow).not.toContain('push:');
    expect(workflow).toContain('permissions:\n  contents: read');
    expect(workflow).toContain('fail-on-severity: moderate');
    expect(workflow).toContain('license-check: false');
    expectWorkflowHasPinnedAction(workflow, 'actions/dependency-review-action');
  });

  test('contributor and security docs describe the bot-facing security checks', () => {
    const contributing = readText('.github/CONTRIBUTING.md');
    const security = readText('.github/SECURITY.md');

    for (const doc of [contributing, security]) {
      expect(doc).toContain('.github/workflows/codeql.yml');
      expect(doc).toContain('.github/workflows/dependency-review.yml');
      expect(doc).toContain('security-extended');
      expect(doc).toContain('Code scanning results / CodeQL');
      expect(doc).toContain('Dependency Review');
    }
  });
});
