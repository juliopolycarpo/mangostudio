import { describe, expect, it } from 'bun:test';

import type { RemovalRetryDependencies } from '../support/github-fixture-cleanup';
import {
  type FixtureDirectory,
  removeFixtureDir,
  removeTrackedFixtureDirs,
} from '../support/remove-fixture-dir';

/** A file system that refuses removal with `code` for the first `refusals` attempts, per path. */
class RefusingFixtureFileSystem implements RemovalRetryDependencies {
  clock = 0;
  readonly attempts = new Map<string, number>();

  constructor(
    private readonly refusals: (path: string) => number,
    private readonly code = 'EBUSY'
  ) {}

  remove = (path: string): Promise<void> => {
    const attempt = (this.attempts.get(path) ?? 0) + 1;
    this.attempts.set(path, attempt);
    if (attempt <= this.refusals(path)) {
      return Promise.reject(
        Object.assign(new Error(`${this.code}: resource busy or locked, rm '${path}'`), {
          code: this.code,
        })
      );
    }
    return Promise.resolve();
  };
  sleep = (milliseconds: number): Promise<void> => {
    this.clock += milliseconds;
    return Promise.resolve();
  };
  now = (): number => this.clock;
  describeHolders = (): Promise<string> => Promise.resolve('controlled holder');
  onRecovered = (): void => {};
}

const WORK: FixtureDirectory = { role: 'fake-gh-build', path: '/controlled/work' };

describe('removeFixtureDir', () => {
  it('succeeds once EBUSY clears within the retry window', async () => {
    const fileSystem = new RefusingFixtureFileSystem(() => 3);

    await removeFixtureDir(WORK, fileSystem);

    expect(fileSystem.attempts.get(WORK.path)).toBe(4);
  });

  it('names the role, path and errno when removal never succeeds', async () => {
    const fileSystem = new RefusingFixtureFileSystem(() => Infinity, 'EPERM');

    const error = (await removeFixtureDir(WORK, fileSystem).catch((cause: unknown) => cause)) as
      Error | undefined;

    expect(error, 'expected a rejection | received: resolved').toBeInstanceOf(Error);
    expect(error?.message).toContain('fake-gh-build fixture');
    expect(error?.message).toContain('/controlled/work');
    expect(error?.message).toContain('EPERM');
  });

  it('does not retry an error that is not a transient Windows refusal', async () => {
    const fileSystem = new RefusingFixtureFileSystem(() => Infinity, 'EACCES');

    const error = (await removeFixtureDir(WORK, fileSystem).catch((cause: unknown) => cause)) as
      Error | undefined;

    expect(fileSystem.attempts.get(WORK.path)).toBe(1);
    expect(error?.message).toContain('EACCES');
  });
});

describe('removeTrackedFixtureDirs', () => {
  it('untracks removed directories and keeps the failed one tracked', async () => {
    const stuck: FixtureDirectory = { role: 'capture-root', path: '/controlled/stuck' };
    const fine: FixtureDirectory = { role: 'workdir', path: '/controlled/fine' };
    const tracked = [stuck, fine];
    const fileSystem = new RefusingFixtureFileSystem((path) =>
      path === stuck.path ? Infinity : 0
    );

    const error = (await removeTrackedFixtureDirs(tracked, fileSystem).catch(
      (cause: unknown) => cause
    )) as AggregateError | undefined;

    expect(error, 'expected an AggregateError | received: resolved').toBeInstanceOf(AggregateError);
    expect(error?.message).toContain('capture-root fixture');
    expect(
      tracked,
      `expected only the stuck directory tracked | received: ${JSON.stringify(tracked)}`
    ).toEqual([stuck]);
    expect(fileSystem.attempts.get(fine.path)).toBe(1);
  });
});
