/**
 * One queue for every library write, whatever its shape.
 *
 * Applies run one at a time. Two browser tabs applying at once would otherwise
 * interleave backups and swaps; serialized, the second waits and then fails its
 * own state-hash check, which is exactly the outcome the user should get.
 *
 * Propagation, removal, and undo share this queue rather than keeping one each.
 * Separate queues would serialize each operation against itself while leaving
 * the interesting race — an overwrite and a removal of the same resource — wide
 * open, which is the one ordering where the loser's backup describes a
 * destination that no longer exists.
 */

let queue: Promise<unknown> = Promise.resolve();

export function serializeLibraryWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}
