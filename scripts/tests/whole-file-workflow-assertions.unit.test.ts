import { describe, expect, test } from 'bun:test';

import { wholeFileWorkflowAssertions } from './support/whole-file-workflow-assertions';

/** Joins fixture lines so each test reads as the source it scans. */
function source(...lines: string[]): string {
  return lines.join('\n');
}

function flaggedLines(text: string): number[] {
  return wholeFileWorkflowAssertions(text).map(({ line }) => line);
}

describe('wholeFileWorkflowAssertions', () => {
  test('flags a positive toContain on a name bound to a workflow file', () => {
    const text = source(
      `test('x', () => {`,
      `  const workflow = readText('.github/workflows/ci.yml');`,
      `  expect(workflow).toContain('needs: changes');`,
      `});`
    );
    expect(wholeFileWorkflowAssertions(text)).toEqual([
      { line: 3, subject: 'workflow', matcher: 'toContain' },
    ]);
  });

  test('flags toMatch, composite actions, a message argument and a wrapped call', () => {
    const text = source(
      `test('x', () => {`,
      `  const action = readText('.github/actions/setup/action.yml');`,
      `  expect(action, 'cache key').toMatch(/shared-key: x/);`,
      `  expect(`,
      `    action`,
      `  ).toContain('a');`,
      `  expect(action,`,
      `    'wrapped message'`,
      `  ).toContain('b');`,
      `});`
    );
    expect(flaggedLines(text)).toEqual([3, 7]);
  });

  test('flags an inline readText of a workflow path', () => {
    const text = `expect(readText('.github/workflows/ci.yml')).toContain('x');`;
    expect(wholeFileWorkflowAssertions(text)).toEqual([
      { line: 1, subject: "readText('.github/workflows/ci.yml')", matcher: 'toContain' },
    ]);
  });

  test('reads a path identifier that names a workflow', () => {
    const text = source(
      `const workflow = readText(workflowPath);`,
      `expect(workflow).toContain('x');`,
      `const text = readText(QA_METRICS_PATH);`,
      `expect(text).toContain('y');`
    );
    expect(flaggedLines(text)).toEqual([2, 4]);
  });

  test('ignores a block, a non-workflow file and absence assertions', () => {
    const text = source(
      `const workflow = readText('.github/workflows/ci.yml');`,
      `const job = extractJobBlock(workflow, 'changes');`,
      `expect(job).toContain('x');`,
      `expect(workflow).not.toContain('y');`,
      `expect(workflow).not.toMatch(/z/);`,
      `const dockerfile = readText(file);`,
      `expect(dockerfile).toContain('ENV A=1');`,
      `const doc = readText('.github/CONTRIBUTING.md');`,
      `expect(doc).toContain('w');`
    );
    expect(flaggedLines(text)).toEqual([]);
  });

  test('a rebinding to a block in another test does not inherit the whole-file reading', () => {
    const text = source(
      `describe('a', () => {`,
      `  const workflow = readText('.github/workflows/ci.yml');`,
      `  test('uses the file', () => {`,
      `    expect(workflow).toContain('x');`,
      `  });`,
      `  test('shadows it', () => {`,
      `    const workflow = extractJobBlock(readText('.github/workflows/ci.yml'), 'changes');`,
      `    expect(workflow).toContain('y');`,
      `  });`,
      `  test('uses the file again', () => {`,
      `    expect(workflow).toContain('z');`,
      `  });`,
      `});`
    );
    expect(flaggedLines(text)).toEqual([4, 11]);
  });

  test('a name bound inside a test does not leak into the next one', () => {
    const text = source(
      `test('a', () => {`,
      `  const workflow = readText('.github/workflows/ci.yml');`,
      `});`,
      `test('b', () => {`,
      `  const workflow = somethingElse();`,
      `  expect(workflow).toContain('x');`,
      `});`
    );
    expect(flaggedLines(text)).toEqual([]);
  });

  test('allows a column-zero anchored toMatch, which can only match a top-level key', () => {
    const text = source(
      `const workflow = readText('.github/workflows/ci.yml');`,
      `expect(workflow).toMatch(/^permissions: \\{\\}$/m);`,
      `expect(workflow).toMatch(/^ {2}contents: read$/m);`,
      `expect(workflow).toMatch(/permissions: x/);`
    );
    expect(flaggedLines(text)).toEqual([3, 4]);
  });

  test('honours a whole-file reason above the statement or trailing it, but not a bare marker', () => {
    const text = source(
      `const action = readText('.github/actions/require-secret/action.yml');`,
      `// whole-file: single-step composite`,
      `expect(action).toContain('a');`,
      `expect(action).toContain('b'); // whole-file: single-step composite`,
      `// whole-file:`,
      `expect(action).toContain('c');`
    );
    expect(flaggedLines(text)).toEqual([6]);
  });
});
