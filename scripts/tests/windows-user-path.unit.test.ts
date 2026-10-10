import { describe, expect, test } from 'bun:test';

import {
  assertPruneSucceeded,
  FIXTURE_DIR_PREFIX,
  type PowerShellOutcome,
  pruneFixtureUserPath,
  runUserPathPrune,
  type UserPathAccess,
} from './support/windows-user-path';

// The cleanup normally reads and writes the real HKCU\Environment\Path. Every
// case here swaps in a named fake for both ends, so a run launches a real
// Windows PowerShell (the part under test is the PowerShell script) but never
// touches the registry. Like the install.ps1 fixtures, the PowerShell cases
// skip where powershell.exe is not on PATH; the outcome checks need no host.
const POWERSHELL = Bun.which('powershell.exe');

const ORIGINAL = 'C:\\Tools;C:\\Bin;C:\\Tools';
const FIXTURE_ENTRY = `C:\\Users\\u\\AppData\\Local\\Temp\\${FIXTURE_DIR_PREFIX}AbC123\\bin`;

function psQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** `null` and `""` are different PATHs, so a failure message has to tell them apart. */
function show(value: string | number | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

/**
 * A user PATH held in the script text: the read answers `current` (null is an
 * absent value) and a write is echoed on stdout as `SET[value]`, one line per
 * setter call, so a case can count writes and see what each carried.
 */
function fakeUserPath(current: string | null): UserPathAccess {
  return {
    read: current === null ? '$null' : psQuote(current),
    write: "Write-Output ('SET[' + $value + ']')",
  };
}

/**
 * A .NET method that throws, the way a refused registry write does. Unlike a
 * script `throw` it is only a statement-terminating error, which a script
 * runs past unless it sets `$ErrorActionPreference = 'Stop'`.
 */
function failingDotNetCall(marker: string): string {
  return `[IO.File]::ReadAllText('C:\\no-such-dir\\${marker}')`;
}

function writesOf(outcome: PowerShellOutcome): string[] {
  return outcome.stdout
    .split('\n')
    .map((line) => /^SET\[(.*)\]\r?$/.exec(line)?.[1])
    .filter((value): value is string => value !== undefined);
}

/** Runs the cleanup against `current` and reports what it wrote and what the PATH holds afterwards. */
function cleanUp(current: string | null): { writes: string[]; finalPath: string | null } {
  const outcome = runUserPathPrune(POWERSHELL as string, fakeUserPath(current));
  expect(
    outcome.exitCode,
    `expected cleanup exit code: 0 | received: ${outcome.exitCode}, stderr: ${outcome.stderr}`
  ).toBe(0);
  const writes = writesOf(outcome);
  return { writes, finalPath: writes.length > 0 ? (writes.at(-1) as string) : current };
}

function expectWrites(writes: string[], expected: number): void {
  expect(
    writes.length,
    `expected PATH setter calls: ${expected} | received: ${writes.length} (${writes.map(show).join(', ')})`
  ).toBe(expected);
}

function expectPath(finalPath: string | null, expected: string | null): void {
  expect(finalPath, `expected PATH: ${show(expected)} | received: ${show(finalPath)}`).toBe(
    expected
  );
}

describe('fixture user PATH cleanup', () => {
  test.skipIf(!POWERSHELL)(
    'writes the original PATH back once when a case appended its bin dir',
    () => {
      const { writes, finalPath } = cleanUp(`${ORIGINAL};${FIXTURE_ENTRY}`);

      expectWrites(writes, 1);
      expectPath(finalPath, ORIGINAL);
    }
  );

  test.skipIf(!POWERSHELL)('removes every fixture entry, wherever it sits', () => {
    const other = `C:\\Users\\u\\AppData\\Local\\Temp\\${FIXTURE_DIR_PREFIX}Zz9\\bin`;
    const { writes, finalPath } = cleanUp(`${FIXTURE_ENTRY};C:\\Tools;${other};C:\\Bin`);

    expectWrites(writes, 1);
    expectPath(finalPath, 'C:\\Tools;C:\\Bin');
  });

  test.skipIf(!POWERSHELL)(
    'writes the empty string when fixture entries were the whole PATH',
    () => {
      const { writes, finalPath } = cleanUp(FIXTURE_ENTRY);

      expectWrites(writes, 1);
      expectPath(finalPath, '');
    }
  );

  test.skipIf(!POWERSHELL)('does not write when no fixture entry is on the PATH', () => {
    const { writes, finalPath } = cleanUp(ORIGINAL);

    expectWrites(writes, 0);
    expectPath(finalPath, ORIGINAL);
  });

  test.skipIf(!POWERSHELL)('does not rewrite a PATH that only has empty entries to drop', () => {
    const withEmpties = 'C:\\Tools;;C:\\Bin;';
    const { writes, finalPath } = cleanUp(withEmpties);

    expectWrites(writes, 0);
    expectPath(finalPath, withEmpties);
  });

  test.skipIf(!POWERSHELL)('keeps an absent PATH absent instead of writing an empty one', () => {
    const { writes, finalPath } = cleanUp(null);

    expectPath(finalPath, null);
    expectWrites(writes, 0);
  });

  test.skipIf(!POWERSHELL)('fails when the required write fails', () => {
    const access: UserPathAccess = {
      read: psQuote(`${ORIGINAL};${FIXTURE_ENTRY}`),
      write: failingDotNetCall('registry-write-refused'),
    };

    expect(() => pruneFixtureUserPath(POWERSHELL as string, access)).toThrow(
      /expected PowerShell exit 0 with no signal \| received: exit 1.*registry-write-refused/s
    );
  });

  test.skipIf(!POWERSHELL)('fails when the PATH cannot be read', () => {
    const access: UserPathAccess = {
      read: `$(${failingDotNetCall('registry-read-refused')})`,
      write: fakeUserPath(null).write,
    };

    expect(() => pruneFixtureUserPath(POWERSHELL as string, access)).toThrow(
      /expected PowerShell exit 0 with no signal \| received: exit 1.*registry-read-refused/s
    );
  });

  test.skipIf(!POWERSHELL)('accepts a clean run, whatever Bun reports for the signal', () => {
    expect(() =>
      pruneFixtureUserPath(POWERSHELL as string, fakeUserPath(`${ORIGINAL};${FIXTURE_ENTRY}`))
    ).not.toThrow();
  });
});

describe('PowerShell cleanup outcome check', () => {
  const outcome = (over: Partial<PowerShellOutcome>): PowerShellOutcome => ({
    exitCode: 0,
    stdout: '',
    stderr: '',
    ...over,
  });

  test('accepts exit 0 when the runtime reports no signalCode', () => {
    expect(() => assertPruneSucceeded(outcome({ signalCode: undefined }))).not.toThrow();
    expect(() => assertPruneSucceeded(outcome({ signalCode: null }))).not.toThrow();
  });

  test('accepts what a real Bun child that exits 0 reports', () => {
    const child = Bun.spawnSync({ cmd: [process.execPath, '-e', 'process.exit(0)'] });

    expect(() =>
      assertPruneSucceeded({
        exitCode: child.exitCode,
        signalCode: child.signalCode,
        stdout: child.stdout.toString(),
        stderr: child.stderr.toString(),
      })
    ).not.toThrow();
  });

  test('rejects a non-zero exit and reports the code and stderr', () => {
    expect(() => assertPruneSucceeded(outcome({ exitCode: 1, stderr: 'boom' }))).toThrow(
      'expected PowerShell exit 0 with no signal | received: exit 1, signal none, stderr: boom'
    );
  });

  test('rejects a signal even when the exit code is 0', () => {
    expect(() => assertPruneSucceeded(outcome({ signalCode: 'SIGKILL' }))).toThrow(
      'expected PowerShell exit 0 with no signal | received: exit 0, signal SIGKILL, stderr: '
    );
  });
});
