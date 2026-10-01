import { registerRuntimeConnectionRelease } from '../../../src/services/runtime-client/runtime-connection-release';

/**
 * One fake `mangostudio-runtime --stdio` child. `close()` settles only after a
 * timer turn, the way a real child's exit does, so a caller that does not await
 * it observes `reaped === false`.
 */
export class FakeRuntimeChild {
  reaped = false;

  close(): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(() => {
        this.reaped = true;
        resolve();
      }, 1);
    });
  }
}

/**
 * Stands in for the connection manager's Local spawn: opening a connection
 * starts a {@link FakeRuntimeChild} and registers the process-wide release that
 * closes every child, exactly the wiring `getRuntimeConnectionManager()` does.
 * No process is spawned.
 *
 * @example
 * const spawner = new FakeRuntimeSpawner();
 * spawner.spawn();
 * await releaseRuntimeConnections();
 * spawner.allReaped(); // true
 */
export class FakeRuntimeSpawner {
  readonly children: FakeRuntimeChild[] = [];

  spawn(): FakeRuntimeChild {
    const child = new FakeRuntimeChild();
    this.children.push(child);
    registerRuntimeConnectionRelease(async () => {
      await Promise.all(this.children.map((entry) => entry.close()));
    });
    return child;
  }

  /** True once at least one child was spawned and every one has exited. */
  allReaped(): boolean {
    return this.children.length > 0 && this.children.every((child) => child.reaped);
  }
}
