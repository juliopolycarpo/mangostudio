// The Windows helper and its probe only execute on a Windows runner. These cases read their
// source on every host, so a contract another file depends on cannot drift unnoticed.

import { describe, expect, test } from 'bun:test';

import { NATIVE_BUILDS } from '../lib/native-bun-qualification-source';
import { readText } from './support/read-text';

const HELPER = 'scripts/lib/native-windows-job.ps1';
const PROBE = 'scripts/lib/native-windows-job.probe.ps1';
const WORKFLOW = '.github/workflows/native-bun-qualification.yml';

/** A script's statements in order, without blank lines or whole-line comments. */
function statements(source: string): string[] {
  return source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
}

/** The items of each `@('a', 'b')` literal on the line that assigns `$name`, in order. */
function assignedArrays(source: string, name: string): string[][] {
  const line = source.split(/\r?\n/).find((each) => each.trim().startsWith(`$${name} = `));
  if (line === undefined)
    throw new Error(`Missing $${name} assignment; expected $${name} = ... in ${HELPER}`);
  return [...line.matchAll(/@\(([^)]*)\)/g)].map((literal) =>
    [...literal[1].matchAll(/'([^']*)'/g)].map((item) => item[1])
  );
}

describe('native Windows Job helper compiler policy', () => {
  const helper = readText(HELPER);

  // The helper decides cleanup eligibility from its own copy of the argv. A flag added to the
  // producer's command alone would drop Windows to strict mode and fail on a surviving VCTIP.
  test.each(['runtime', 'fake'] as const)(
    'grants %s compiler cleanup to exactly the argv the producer runs',
    (target) => {
      const [received] = assignedArrays(helper, `${target}Args`);
      const expected = NATIVE_BUILDS[target].command.slice(1);
      expect(
        received,
        `expected $${target}Args: ${expected.join(' ')} | received: ${received?.join(' ')}`
      ).toEqual(expected);
    }
  );

  test('expects the SDK features the producer requires of each build', () => {
    const [fake, runtime] = assignedArrays(helper, 'sdkFeatures');
    expect(
      { fake, runtime },
      `expected $sdkFeatures branches: fake then runtime | received: ${JSON.stringify({ fake, runtime })}`
    ).toEqual({
      fake: [...NATIVE_BUILDS.fake.sdkFeatures],
      runtime: [...NATIVE_BUILDS.runtime.sdkFeatures],
    });
  });
});

describe('native Windows Job helper census', () => {
  const helper = readText(HELPER);

  // The receipt validator refuses a foreign command line, but only on a Windows runner. Here the
  // source shows where the helper could read one at all, and that every census it persists
  // after the Job exists is told which processes are the Job's own.
  test('reads a command line only to judge it or to keep it for a Job member', () => {
    const reads = statements(helper).filter((line) => line.includes('$_.CommandLine'));
    expect(
      reads,
      `expected two CommandLine reads: the helper verdict and the owned branch | received: ${reads.length}`
    ).toEqual([
      '$isHelper = Test-NativeJobCompilerHelper $_.Name $_.ExecutablePath $_.CommandLine',
      '$command = if ($owned.ContainsKey($identity)) { $_.CommandLine } else { $null }',
    ]);
    expect(helper).toContain('command = $command; compilerHelper = $isHelper }');
  });

  test('names the observed members to every census taken once the Job exists', () => {
    const taken = statements(helper).filter((line) =>
      /^\$\w+(\.\w+)? = Get-NativeJobCensus/.test(line)
    );
    // The baseline precedes the Job, so nothing is owned and no command line is kept. The
    // comment-based help repeats two of these as its examples.
    expect(
      taken.filter((line) => !line.startsWith('$current = ')),
      `expected the baseline and two member-aware censuses | received: ${taken.join(' ; ')}`
    ).toEqual([
      '$before = Get-NativeJobCensus',
      expect.stringMatching(/^\$before = Get-NativeJobCensus; \$receipt\.before = \$before;/),
      '$receipt.preCleanupCensus = Get-NativeJobCensus @($seen.Values)',
      '$receipt.postCleanupCensus = Get-NativeJobCensus @($seen.Values)',
    ]);
    expect(helper).toContain(
      'Complete-NativeJobEvidence $receipt $child $before $out -CensusContext $receipt.observed'
    );
    expect(helper).toContain('$full = & $Census $CensusContext');
  });
});

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
