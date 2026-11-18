import { rm } from 'node:fs/promises';
import { basename } from 'node:path';

/** A directory retained until its cleanup has succeeded. */
export interface GithubFixtureDirectory {
  readonly role: 'workdir' | 'fake-gh-bin' | 'fake-gh-build';
  readonly path: string;
}

interface GithubFixtureCleanupDependencies {
  readonly closeRuntime: () => Promise<void>;
  readonly removeDirectory: (path: string) => Promise<void>;
}

/** How long a refused removal is retried before it is reported. */
const REMOVAL_RETRY_DEADLINE_MS = 5_000;

/** First pause between removal attempts; it doubles up to {@link REMOVAL_RETRY_MAX_DELAY_MS}. */
const REMOVAL_RETRY_FIRST_DELAY_MS = 50;
const REMOVAL_RETRY_MAX_DELAY_MS = 500;

/** The Windows refusals that clear once the last handle on the directory closes. */
const TRANSIENT_REMOVAL_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY']);

/** The effects {@link removeDirectoryWithRetry} owns, replaceable by a test. */
export interface RemovalRetryDependencies {
  readonly remove: (path: string) => Promise<void>;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
  /** Called once, at the first refusal, to learn who might hold the path. Never throws. */
  readonly describeHolders: (path: string) => Promise<string>;
  /** Called when a refusal cleared on its own, so a green run still records that it happened. */
  readonly onRecovered: (report: string) => void;
}

/**
 * Process listing for a path that refuses removal. Windows only: elsewhere a directory in use
 * does not refuse `rm`. Matches by the directory's leaf name because the temp path reaches the
 * test in its 8.3 short form while a process reports its long one.
 */
async function describeWindowsHolders(path: string): Promise<string> {
  if (process.platform !== 'win32') return 'not collected: not a Windows host';
  const script =
    "$leaf = $env:MANGO_REMOVAL_LEAF; Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like ('*\\' + $leaf + '\\*') -or $_.Name -in 'gh.exe','git.exe','mangostudio-runtime.exe' } | Select-Object ProcessId,ParentProcessId,Name,ExecutablePath,CreationDate | ConvertTo-Json -Compress";
  try {
    const probe = Bun.spawn(
      ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', script],
      {
        env: { ...process.env, MANGO_REMOVAL_LEAF: basename(path) },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 4_000,
      }
    );
    const [stdout, stderr] = await Promise.all([
      new Response(probe.stdout).text(),
      new Response(probe.stderr).text(),
      probe.exited,
    ]);
    return stdout.trim() || stderr.trim() || 'no matching process';
  } catch (error) {
    return `not collected: ${String(error)}`;
  }
}

const defaultRemovalRetryDependencies: RemovalRetryDependencies = {
  remove: (path) => rm(path, { recursive: true, force: true }),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  describeHolders: describeWindowsHolders,
  onRecovered: (report) => console.error(`[github-fixture-cleanup] ${report}`),
};

/**
 * Remove a directory a compiled fake `gh` ran from, retrying the refusals Windows clears on its own.
 *
 * A just-exited executable stays open for a moment: its image section lingers, the antivirus
 * scans it, and a child the runtime started may still be tearing down after the runtime exits.
 * `rm` reports all of that as EBUSY, EPERM or ENOTEMPTY. Those retry with a doubling pause up to
 * `deadlineMs`; any other error, and the last transient one at the deadline, fails naming the path,
 * the attempts and the last error. The first refusal also snapshots the processes that could hold
 * the path, so a failure (or a recovery) carries evidence of the holder.
 *
 * @example
 * await removeDirectoryWithRetry(binDir);
 */
export async function removeDirectoryWithRetry(
  path: string,
  deadlineMs: number = REMOVAL_RETRY_DEADLINE_MS,
  dependencies: RemovalRetryDependencies = defaultRemovalRetryDependencies
): Promise<void> {
  const startedAt = dependencies.now();
  let delay = REMOVAL_RETRY_FIRST_DELAY_MS;
  let holders: Promise<string> | undefined;
  const codes: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      await dependencies.remove(path);
      if (codes.length > 0) {
        dependencies.onRecovered(
          `removal of ${JSON.stringify(path)} succeeded on attempt ${attempt} after ${dependencies.now() - startedAt} ms | refusals: ${codes.join(', ')} | holders at first refusal: ${await holders}`
        );
      }
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'no code';
      if (!TRANSIENT_REMOVAL_CODES.has(code)) throw error;
      codes.push(code);
      holders ??= dependencies.describeHolders(path).catch((cause: unknown) => String(cause));
      const elapsed = dependencies.now() - startedAt;
      if (elapsed >= deadlineMs) {
        throw new Error(
          `directory ${JSON.stringify(path)}: expected removal within ${deadlineMs} ms | received ${codes.length} refusals over ${elapsed} ms, last: ${String(error)} | holders at first refusal: ${await holders}`,
          { cause: error }
        );
      }
      await dependencies.sleep(Math.min(delay, deadlineMs - elapsed));
      delay = Math.min(delay * 2, REMOVAL_RETRY_MAX_DELAY_MS);
    }
  }
}

/**
 * Close the runtime before removing fixtures, retaining failed paths and draining every removal.
 * @example
 * await cleanupGithubFixtureDirectories(directories, { closeRuntime, removeDirectory });
 */
export async function cleanupGithubFixtureDirectories(
  directories: GithubFixtureDirectory[],
  dependencies: GithubFixtureCleanupDependencies
): Promise<void> {
  try {
    await dependencies.closeRuntime();
  } catch (cause) {
    throw new Error(
      `GitHub fixture cleanup: expected runtime closure before removal of ${JSON.stringify(directories)} | received: ${String(cause)}`,
      { cause }
    );
  }

  const batch = [...directories];
  const results = await Promise.allSettled(
    batch.map(async (directory) => {
      await dependencies.removeDirectory(directory.path);
      const index = directories.indexOf(directory);
      if (index !== -1) directories.splice(index, 1);
    })
  );
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          new Error(
            `GitHub ${batch[index].role} fixture ${JSON.stringify(batch[index].path)}: expected removal after runtime closure | received: ${String(result.reason)}`,
            { cause: result.reason }
          ),
        ]
      : []
  );
  if (failures.length)
    throw new AggregateError(failures, failures.map((failure) => failure.message).join('; '));
}
