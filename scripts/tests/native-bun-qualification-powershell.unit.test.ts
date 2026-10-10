// The Windows helper and its probe only execute on a Windows runner. These cases read their
// source on every host, so a contract another file depends on cannot drift unnoticed.

import { describe, expect, test } from 'bun:test';

import { readText } from './support/read-text';

const PROBE = 'scripts/lib/native-windows-job.probe.ps1';
const WORKFLOW = '.github/workflows/native-bun-qualification.yml';

/** A script's statements in order, without blank lines or whole-line comments. */
function statements(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

describe('native Windows Job probe exit status', () => {
  test('ends with an explicit status for the workflow gate that reads $LASTEXITCODE', () => {
    const probe = statements(readText(PROBE));

    // The gate: a probe that only falls off its end leaves $LASTEXITCODE at whatever the last
    // native command inside a probe returned, or unset when none ran.
    expect(readText(WORKFLOW)).toContain('if ($LASTEXITCODE -ne 0) { throw');
    expect(probe.at(-1), `expected final probe statement: exit 0 | received: ${probe.at(-1)}`).toBe(
      'exit 0'
    );
    expect(probe.at(-2)).toBe("if ($receipt.status -ne 'passed') { exit 1 }");
  });
});
