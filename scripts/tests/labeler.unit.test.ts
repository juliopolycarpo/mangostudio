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

  test('fails the labeler workflow when no classification label is applied', () => {
    const workflow = readText('.github/workflows/labeler.yml');

    expect(workflow).toContain('name: Verify classification labels');
    expect(workflow).toContain("name.startsWith('area: ')");
    expect(workflow).toContain("name.startsWith('type: ')");
    expect(workflow).toContain('No area: or type: label was applied');
  });
});
