/** A directory retained until its cleanup has succeeded. */
export interface GithubFixtureDirectory {
  readonly role: 'workdir' | 'fake-gh-bin' | 'fake-gh-build';
  readonly path: string;
}

interface GithubFixtureCleanupDependencies {
  readonly closeRuntime: () => Promise<void>;
  readonly removeDirectory: (path: string) => Promise<void>;
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
