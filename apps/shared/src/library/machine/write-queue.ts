/**
 * One queue per backup root for every library write this host performs.
 *
 * The hub has its own queue, and it is not enough. The hub releases its lock
 * when its RPC deadline fires, but the deadline only rejects the caller's
 * promise — the work carries on here until the cancel lands and the
 * compensation finishes. Between those two moments the hub would happily start
 * a retry that raced the rollback over the same destinations and the same
 * backup set. Serializing where the files are closes that window, and it is
 * the right place regardless: this host owns them, and a permission or an
 * ordering the untrusted side enforces on itself is neither.
 *
 * Keyed by backup root because that is what a set of writes actually contends
 * over — the destinations and the backup store beneath them.
 */

const queues = new Map<string, Promise<unknown>>();

export function serializeRuntimeLibraryWrite<T>(
  backupRoot: string,
  task: () => Promise<T>
): Promise<T> {
  const pending = queues.get(backupRoot) ?? Promise.resolve();
  const run = pending.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  queues.set(backupRoot, settled);
  // Drop the entry once nothing is waiting on it, so a process that writes to
  // many roots over its lifetime does not accumulate one promise each.
  void settled.then(() => {
    if (queues.get(backupRoot) === settled) queues.delete(backupRoot);
  });
  return run;
}
