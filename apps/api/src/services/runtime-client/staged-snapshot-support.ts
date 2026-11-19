/**
 * Whether a connected runtime can stage snapshots: the capture-size limit
 * (`snapshotMaxBytes`) and the chunked `snapshot.*` methods arrived together.
 *
 * Remote runtimes (SSH, HTTP) connect without requiring the hub's release, so
 * one can be a build that predates them. It captures at most 8 MiB inline, has
 * no staging methods, and rejects a revert operation that names `stagedId`
 * instead of `contentBase64`. The hub reads the runtime's own method list
 * (`runtime.discover`, cached by the build fingerprint the handshake announced)
 * rather than inferring support from a version number, and treats a runtime that
 * cannot answer as not supporting it.
 */

import { LOCAL_ENVIRONMENT_ID } from '@mangostudio/shared/environments';

import { getRuntimeConnectionManager } from './runtime-connection-manager';

/** Methods a runtime must implement for the hub to capture into, or restore from, staged snapshots. */
export const STAGED_SNAPSHOT_METHODS = [
  'snapshot.read-chunk',
  'snapshot.stage-chunk',
  'snapshot.release',
] as const;

/**
 * Whether the environment's connected runtime implements every method in
 * {@link STAGED_SNAPSHOT_METHODS}. False for a build that announced no
 * implementation, one whose `runtime.discover` fails, or one missing any of them.
 *
 * // Usage: if (await runtimeStagesSnapshots(userId, environmentId)) params.snapshotMaxBytes = limit
 */
export async function runtimeStagesSnapshots(
  userId: string,
  environmentId: string = LOCAL_ENVIRONMENT_ID
): Promise<boolean> {
  const manager = getRuntimeConnectionManager();
  try {
    // `discoverImplementation` reads a connection that already exists; opening
    // it here is what the mutation about to run would do next anyway.
    await manager.getClient(userId, environmentId);
    const surface = await manager.discoverImplementation(userId, environmentId);
    if (surface === undefined) return false;
    return STAGED_SNAPSHOT_METHODS.every((method) => surface.methods.includes(method));
  } catch {
    // The discovery cache already reported a failed `runtime.discover`.
    return false;
  }
}
