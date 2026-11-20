/**
 * Says why a test's runtime does or does not stage snapshots.
 *
 * `runtimeStagesSnapshots` turns every failure into `false`, which is right for
 * the hub but leaves a failing test with only "snapshotMaxBytes is missing". A
 * test that depends on staging puts this explanation in its assertion message,
 * so a dropped connection or a failed `runtime.discover` names itself.
 */

import { STAGED_SNAPSHOT_METHODS } from '../../src/services/runtime-client/staged-snapshot-support';

/** The slice of the connection manager the probe reads. */
export interface StagedSnapshotProbeSource {
  getStatus(userId: string, environmentId: string): unknown;
  getClient(userId: string, environmentId: string): Promise<unknown>;
  discoverImplementation(
    userId: string,
    environmentId: string
  ): Promise<{ readonly methods: readonly string[] } | undefined>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

/**
 * One line naming the connection status and what discovery answered: the
 * missing staging methods, `no implementation announced`, or the error of the
 * step that failed.
 *
 * @example
 * expect(params, await explainStagedSnapshotSupport(getRuntimeConnectionManager(), userId, 'local')).toEqual(...)
 */
export async function explainStagedSnapshotSupport(
  source: StagedSnapshotProbeSource,
  userId: string,
  environmentId: string
): Promise<string> {
  const status = `status before probe: ${JSON.stringify(source.getStatus(userId, environmentId))}`;
  try {
    await source.getClient(userId, environmentId);
  } catch (error) {
    return `(staged snapshots, ${environmentId}): getClient failed: ${messageOf(error)} | ${status}`;
  }
  let surface: { readonly methods: readonly string[] } | undefined;
  try {
    surface = await source.discoverImplementation(userId, environmentId);
  } catch (error) {
    return `(staged snapshots, ${environmentId}): runtime.discover failed: ${messageOf(error)} | ${status}`;
  }
  if (surface === undefined) {
    return `(staged snapshots, ${environmentId}): no implementation announced | ${status}`;
  }
  const missing = STAGED_SNAPSHOT_METHODS.filter((method) => !surface.methods.includes(method));
  const answer =
    missing.length === 0 ? 'every staging method present' : `missing ${missing.join(', ')}`;
  return `(staged snapshots, ${environmentId}): ${answer} | ${status}`;
}
