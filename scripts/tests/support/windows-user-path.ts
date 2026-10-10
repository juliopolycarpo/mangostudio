// Clean-up of the Windows user PATH that the install.ps1 fixtures leave behind.
//
// Fresh installs, -Use and -Rollback call install.ps1's Add-UserPath, which
// writes the fixture's bin dir into the real HKCU\Environment\Path: a
// machine-wide side effect that outlives the temp dir it points at. The
// layout suite sweeps it after every case. The sweep lives here, behind an
// injectable read and write, so the decision to write can be tested against a
// fake PATH instead of the registry.

/** The mkdtemp prefix of every fixture directory, and so of every PATH entry a case can leave. */
export const FIXTURE_DIR_PREFIX = 'mango-ps1-';

/**
 * How the cleanup script reaches the user PATH, as PowerShell source: `read`
 * is an expression that yields the string (or `$null` when no Path value
 * exists), `write` a statement that stores `$value`.
 */
export interface UserPathAccess {
  readonly read: string;
  readonly write: string;
}

/** The real thing: HKCU\Environment\Path. The write broadcasts a settings change, about 7 s a call. */
const REAL_USER_PATH: UserPathAccess = {
  read: "[Environment]::GetEnvironmentVariable('Path','User')",
  write: "[Environment]::SetEnvironmentVariable('Path', $value, 'User')",
};

/** What a finished PowerShell child reported. `signalCode` is absent when the runtime reports none. */
export interface PowerShellOutcome {
  readonly exitCode: number;
  readonly signalCode?: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The PowerShell that removes every `FIXTURE_DIR_PREFIX` entry from the user
 * PATH. It writes only when there is such an entry: a PATH the cases left
 * alone costs a read, not a registry write plus the settings broadcast, and
 * is never rewritten (an absent PATH stays absent, empty entries stay put).
 * Any failure ends the script with a non-zero exit instead of being swallowed.
 *
 * @example
 * buildUserPathPruneScript(REAL_USER_PATH); // run with `powershell.exe -NoProfile -Command`
 */
function buildUserPathPruneScript(
  access: UserPathAccess,
  prefix: string = FIXTURE_DIR_PREFIX
): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    `$path = ${access.read}`,
    // An absent value ($null) splits to one empty entry, which carries no
    // fixture prefix, so it falls through to the exit below: nothing is
    // written and the PATH stays absent rather than becoming ''.
    "$entries = @($path -split ';')",
    `if (@($entries | Where-Object { $_ -match '${prefix}' }).Count -eq 0) { exit 0 }`,
    `$value = ($entries | Where-Object { $_ -and $_ -notmatch '${prefix}' }) -join ';'`,
    access.write,
    'exit 0',
  ].join('; ');
}

/**
 * Throws unless the cleanup child exited 0 and was not killed by a signal.
 * Bun leaves `signalCode` off a child that exited normally, so absence is the
 * success shape; only an actual signal name counts against the child.
 *
 * @example
 * assertPruneSucceeded({ exitCode: 1, stdout: '', stderr: 'denied' }); // throws
 */
export function assertPruneSucceeded(outcome: PowerShellOutcome): void {
  if (outcome.exitCode === 0 && !outcome.signalCode) return;
  throw new Error(
    `expected PowerShell exit 0 with no signal | received: exit ${outcome.exitCode}, signal ${
      outcome.signalCode || 'none'
    }, stderr: ${outcome.stderr.trim()}`
  );
}

/**
 * Runs the cleanup script once and returns what the child reported, without
 * judging it.
 *
 * @example
 * const outcome = runUserPathPrune('powershell.exe', REAL_USER_PATH);
 */
export function runUserPathPrune(powershell: string, access: UserPathAccess): PowerShellOutcome {
  const result = Bun.spawnSync({
    cmd: [powershell, '-NoProfile', '-Command', buildUserPathPruneScript(access)],
  });
  return {
    exitCode: result.exitCode,
    signalCode: result.signalCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

/**
 * Removes the fixtures' entries from the real user PATH and throws if the
 * child failed, so a restore that did not happen fails the case that asked
 * for it.
 *
 * @example
 * afterEach(() => pruneFixtureUserPath(POWERSHELL as string));
 */
export function pruneFixtureUserPath(
  powershell: string,
  access: UserPathAccess = REAL_USER_PATH
): void {
  assertPruneSucceeded(runUserPathPrune(powershell, access));
}
