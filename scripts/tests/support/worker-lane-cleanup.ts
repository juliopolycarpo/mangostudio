import type { WorkerHandle } from '../../lib/test-workers';

interface WorkerLaneOptions {
  readonly timeoutMs?: number;
}

type Outcome = { readonly error?: unknown };

/** Own a worker lane and its readiness callback across test teardown.
 * @example const owner = new WorkerLaneOwner(controller); const running = owner.start(startLane);
 */
export class WorkerLaneOwner {
  private readonly observations: Promise<Outcome>[] = [];
  private readonly observationFailures: unknown[] = [];
  private readonly checks: Array<() => void | Promise<void>> = [];
  private running?: Promise<unknown>;
  private callback?: Promise<Outcome>;
  private closing?: Promise<void>;
  private sealed = false;

  constructor(
    readonly controller: AbortController,
    private readonly options: WorkerLaneOptions = {}
  ) {}

  /** Start and immediately observe the owned lane, for example `owner.start(startLane)`. */
  start<T>(start: () => Promise<T>): Promise<T> {
    if (this.running || this.closing) throw new Error('worker lane already started or closing');
    const running = start();
    this.running = running;
    this.track(running);
    return running;
  }

  /** Retain a native exit or reader-completion promise, for example `owner.track(child.exited)`. */
  track(task: Promise<unknown>): void {
    if (this.sealed) throw new Error('worker lane already settled');
    this.observations.push(
      task.then(
        () => ({}),
        (error: unknown) => {
          this.observationFailures.push(error);
          return { error };
        }
      )
    );
  }

  /** Check native settlement before removal, for example `owner.verify(checkWorkers)`. */
  verify(check: () => void | Promise<void>): void {
    if (this.closing) throw new Error('worker lane already closing');
    this.checks.push(check);
  }

  /** Run the readiness/assertion callback and settle before returning, for example `await owner.run(check)`. */
  async run<T>(run: () => Promise<T>): Promise<T> {
    if (this.closing || this.callback)
      throw new Error('worker lane callback already started or closing');
    const operation = Promise.resolve().then(() => {
      this.controller.signal.throwIfAborted();
      return run();
    });
    this.callback = operation.then(
      () => ({}),
      (error: unknown) => ({ error })
    );
    let value: T | undefined;
    let failure: unknown;
    let failed = false;
    try {
      value = await operation;
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      await this.close();
    } catch (error) {
      const causes = error instanceof AggregateError ? error.errors : [error];
      const distinct = [
        ...new Set(causes.filter((cause: unknown) => !failed || cause !== failure)),
      ];
      if (failed && distinct.length)
        throw new AggregateError(
          [failure, ...distinct],
          'worker cancellation assertion and lane cleanup failed',
          { cause: failure }
        );
      if (failed) return Promise.reject(failure);
      throw error;
    }
    if (failed) return Promise.reject(failure);
    return value as T;
  }

  /** Abort and verify the owned lane before removing its storage, for example `await owner.close()`. */
  close(): Promise<void> {
    if (!this.closing) this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.controller.abort();
    const callback = this.callback ?? Promise.resolve({});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadlineError = new Error('worker lane cleanup did not settle; storage retained');
    try {
      await Promise.race([
        (async () => {
          let cursor = 0;
          const results: Outcome[] = [];
          await callback;
          while (cursor < this.observations.length) {
            const batch = this.observations.slice(cursor);
            cursor += batch.length;
            results.push(...(await Promise.all(batch)));
          }
          const failures = [
            ...new Set(results.flatMap((outcome) => ('error' in outcome ? [outcome.error] : []))),
          ];
          for (const check of this.checks) {
            try {
              await check();
            } catch (error) {
              failures.push(error);
            }
          }
          while (cursor < this.observations.length) {
            const batch = this.observations.slice(cursor);
            cursor += batch.length;
            for (const outcome of await Promise.all(batch))
              if ('error' in outcome) failures.push(outcome.error);
          }
          this.sealed = true;
          if (failures.length === 1) return Promise.reject(failures[0]);
          if (failures.length)
            throw new AggregateError(failures, 'worker lane cleanup failed', {
              cause: failures[0],
            });
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(deadlineError), this.options.timeoutMs ?? 6000);
        }),
      ]);
    } catch (error) {
      if (error === deadlineError && this.observationFailures.length) {
        const failures = [...new Set(this.observationFailures)];
        throw new AggregateError(
          [...failures, error],
          'worker lane cleanup failed before deadline',
          { cause: failures[0] }
        );
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/** Retain a started lane until cancellation and settlement finish.
 * @example await withWorkerLaneCleanup(controller, running, checkCancellation);
 */
export async function withWorkerLaneCleanup<T>(
  controller: AbortController,
  running: Promise<unknown>,
  run: () => Promise<T>
): Promise<T> {
  const owner = new WorkerLaneOwner(controller);
  void owner.start(() => running);
  return owner.run(run);
}

/** Settle registered lanes before removing their storage.
 * @example await settleWorkerLanesBeforeRemoval(lanes, removeFixtures);
 */
export async function settleWorkerLanesBeforeRemoval(
  lanes: readonly WorkerLaneOwner[],
  remove: () => void | Promise<void>
): Promise<void> {
  const results = await Promise.allSettled(lanes.map((lane) => lane.close()));
  const failures = results.flatMap((result) =>
    result.status === 'rejected' ? [result.reason] : []
  );
  if (failures.length)
    throw new AggregateError(failures, 'worker lane cleanup failed; storage retained');
  await remove();
}

/** Forward a worker stream while recording cancellation settlement on the owner.
 * @example const observed = trackWorkerStream(child.stdout, owner);
 */
export function trackWorkerStream(
  stream: ReadableStream<Uint8Array>,
  owner: WorkerLaneOwner
): ReadableStream<Uint8Array> {
  return new Proxy(stream, {
    get(target, key) {
      if (key === 'getReader') {
        return (...args: unknown[]) => {
          const reader = Reflect.apply(
            target.getReader,
            target,
            args
          ) as ReadableStreamDefaultReader<Uint8Array>;
          return new Proxy(reader, {
            get(source, property) {
              if (property === 'cancel')
                return (...args: Parameters<typeof reader.cancel>) => {
                  try {
                    const cancellation = reader.cancel(...args);
                    owner.track(cancellation);
                    return cancellation;
                  } catch (error) {
                    owner.track(Promise.reject(error));
                    throw error;
                  }
                };
              const value = Reflect.get(source, property, source);
              return typeof value === 'function' ? value.bind(source) : value;
            },
          });
        };
      }
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/** Observe a worker's existing exit/drain and native settlement without changing its result.
 * @example const observed = trackWorkerHandle(handle, owner);
 */
export function trackWorkerHandle(handle: WorkerHandle, owner: WorkerLaneOwner): WorkerHandle {
  owner.track(handle.exited);
  const settle = handle.settle?.bind(handle);
  if (!settle) return handle;
  return {
    exited: handle.exited,
    kill: (signal) => handle.kill(signal),
    settle: () => {
      const settlement = settle();
      owner.track(
        settlement.then((leftovers) => {
          if (leftovers.length)
            throw new Error(
              `worker settlement: expected no unconfirmed leftovers | received: ${leftovers.length}`
            );
        })
      );
      return settlement;
    },
  };
}
