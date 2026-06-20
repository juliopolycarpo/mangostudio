import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

describe('labeler coverage', () => {
  test('classifies scripts and test-only changes', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('"area: build":');
    expect(labeler).toContain('- "scripts/**"');
    expect(labeler).toContain('"type: test":');
    expect(labeler).toContain('- "**/*.test.ts"');
    expect(labeler).toContain('- "**/*.spec.ts"');
    expect(labeler).toContain('- "scripts/tests/**"');
    expect(labeler).toContain('- "tests/**"');
  });

  test('classifies root dependency and tooling changes so the verify gate passes', () => {
    const labeler = readText('.github/labeler.yml');

    // Dependabot's bun ecosystem opens PRs touching only these two files; both
    // must map to a label or the "Verify classification labels" gate fails.
    expect(labeler).toContain('- "package.json"');
    expect(labeler).toContain('- "bun.lock"');
    expect(labeler).toContain('- "Dockerfile*"');
    expect(labeler).toContain('- "playwright.config.ts"');
  });

  test('classifies repo-meta and .github changes so the verify gate passes', () => {
    const labeler = readText('.github/labeler.yml');

    expect(labeler).toContain('- "LICENSE"');
    expect(labeler).toContain('- ".gitignore"');
    expect(labeler).toContain('- ".github/**/*.md"');
    expect(labeler).toContain('- ".github/dependabot.yml"');
  });

  test('fails the labeler workflow when no classification label is applied', () => {
    const workflow = readText('.github/workflows/labeler.yml');

    expect(workflow).toContain('name: Verify classification labels');
    expect(workflow).toContain("name.startsWith('area: ')");
    expect(workflow).toContain("name.startsWith('type: ')");
    expect(workflow).toContain('No area: or type: label was applied');
  });

  test('reads applied labels from the labeler output, not a second API call', () => {
    const workflow = readText('.github/workflows/labeler.yml');

    expect(workflow).toContain('ALL_LABELS: ${{ steps.label.outputs.all-labels }}');
    expect(workflow).not.toContain('listLabelsOnIssue');
    expect(workflow).not.toContain('issues: read');
  });
});
