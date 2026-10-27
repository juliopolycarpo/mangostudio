import { onTestFinished } from 'bun:test';
import { rm } from 'node:fs/promises';

import type { BuildFixtureDiagnostics } from './build-fixture-diagnostics';

/** Own the fixture directory, setup operations and direct build child until they settle.
 * @example const owner = new BuildFixtureOwner(diagnostics); await owner.run(buildFixture);
 */
export class BuildFixtureOwner {
  private path?: string;
  private pending = new Set<Promise<unknown>>();
  private closing?: Promise<void>;

  constructor(
    private readonly diagnostics: BuildFixtureDiagnostics,
    private readonly options: {
      register?: (cleanup: () => Promise<void>) => void;
      remove?: (path: string) => Promise<void>;
      timeoutMs?: number;
    } = {}
  ) {
    (options.register ?? onTestFinished)(() => this.close());
  }

  /** Track an operation that can still write to the fixture, for example `await owner.prepare(copy)`. */
  prepare<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error('fixture is closing'));
    const running = operation();
    this.pending.add(running);
    void running.then(
      () => this.pending.delete(running),
      () => this.pending.delete(running)
    );
    return running.then((value) => {
      if (this.closing) throw new Error('fixture closed during preparation');
      return value;
    });
  }

  /** Take ownership immediately after allocation, for example `owner.own(directory)`. */
  own(path: string): void {
    this.path = path;
  }

  /** Run a fixture body and preserve both body and cleanup failures, for example `await owner.run(body)`. */
  async run(body: () => Promise<void>): Promise<void> {
    let failed = false;
    let primary: unknown;
    try {
      await body();
    } catch (error) {
      failed = true;
      primary = error;
    }
    try {
      await this.close();
    } catch (error) {
      if (failed) throw new AggregateError([primary, error], 'fixture and cleanup failed');
      throw error;
    }
    if (failed) return Promise.reject(primary);
  }

  /** Stop and settle owned work before removing the fixture, for example `await owner.close()`. */
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.closeOnce();
    return this.closing;
  }

  private async closeOnce(): Promise<void> {
    this.diagnostics.record('fixture:cleanup-started');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([this.diagnostics.close(), Promise.allSettled([...this.pending])]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('fixture cleanup deadline exceeded; retaining fixture')),
            this.options.timeoutMs ?? 3000
          );
        }),
      ]);
    } catch (error) {
      throw new Error(
        `fixture cleanup could not establish settlement; retaining ${this.path ?? 'pending fixture'}`,
        { cause: error }
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (this.path) {
      const remove =
        this.options.remove ?? ((path: string) => rm(path, { recursive: true, force: true }));
      let removalTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          remove(this.path),
          new Promise<never>((_, reject) => {
            removalTimer = setTimeout(
              () =>
                reject(new Error(`fixture removal did not settle; path may remain: ${this.path}`)),
              this.options.timeoutMs ?? 3000
            );
          }),
        ]);
      } finally {
        if (removalTimer) clearTimeout(removalTimer);
      }
    }
    this.diagnostics.record('fixture:cleanup-complete');
  }
}
