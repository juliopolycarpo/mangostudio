/**
 * The CLI's handle for releasing runtime connections without importing the
 * connection manager.
 *
 * The manager's module graph reaches the environment repository, every
 * runtime connector and the database, so a CLI command that never touched a
 * runtime should not evaluate it just to learn it has nothing to close. The
 * manager registers its release here when it creates the connection
 * singleton, and a process that never created one has no connection to
 * release.
 */

type RuntimeConnectionRelease = () => Promise<void>;

let registeredRelease: RuntimeConnectionRelease | undefined;

/**
 * Record how to release this process's runtime connections. Called by the
 * connection manager as it creates (or a test installs) the singleton that
 * owns them; a later call replaces the earlier one.
 *
 * // Usage: registerRuntimeConnectionRelease(closeAllRuntimeConnections)
 */
export function registerRuntimeConnectionRelease(release: RuntimeConnectionRelease): void {
  registeredRelease = release;
}

/**
 * Release every runtime connection this process opened, or do nothing when
 * no connection manager was ever created.
 *
 * // Usage: await releaseRuntimeConnections()
 */
export async function releaseRuntimeConnections(): Promise<void> {
  await registeredRelease?.();
}

/**
 * Forget the registered release so a test starts from a process that never
 * created a connection manager.
 *
 * // Usage: afterEach(() => resetRuntimeConnectionReleaseForTests())
 */
export function resetRuntimeConnectionReleaseForTests(): void {
  registeredRelease = undefined;
}
