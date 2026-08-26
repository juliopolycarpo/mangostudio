import { describe, expect, it } from 'bun:test';
import { withMutationLock } from '../../../../src/modules/git/application/git-write-service';

/** A mutation that records when it entered and left, and finishes on demand. */
function tracked(name: string, log: string[]) {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const run = async () => {
    log.push(`${name}:enter`);
    await finished;
    log.push(`${name}:exit`);
  };
  return { run, finish };
}

describe('withMutationLock', () => {
  it('serializes two mutations that share a scope', async () => {
    const log: string[] = [];
    const first = tracked('first', log);
    const second = tracked('second', log);

    const firstCall = withMutationLock('local', '/repo/.git', first.run);
    const secondCall = withMutationLock('local', '/repo/.git', second.run);
    await Promise.resolve();
    expect(log).toEqual(['first:enter']);

    first.finish();
    second.finish();
    await Promise.all([firstCall, secondCall]);

    expect(log).toEqual(['first:enter', 'first:exit', 'second:enter', 'second:exit']);
  });

  it('lets mutations on different scopes overlap', async () => {
    const log: string[] = [];
    const first = tracked('first', log);
    const second = tracked('second', log);

    const firstCall = withMutationLock('local', '/repo-a/.git', first.run);
    const secondCall = withMutationLock('local', '/repo-b/.git', second.run);
    await Promise.resolve();

    first.finish();
    second.finish();
    await Promise.all([firstCall, secondCall]);

    expect(log.slice(0, 2).sort()).toEqual(['first:enter', 'second:enter']);
  });

  it('separates the same path on two environments', async () => {
    const log: string[] = [];
    const first = tracked('first', log);
    const second = tracked('second', log);

    const firstCall = withMutationLock('local', '/repo/.git', first.run);
    const secondCall = withMutationLock('remote', '/repo/.git', second.run);
    await Promise.resolve();

    first.finish();
    second.finish();
    await Promise.all([firstCall, secondCall]);

    expect(log.slice(0, 2).sort()).toEqual(['first:enter', 'second:enter']);
  });

  it('releases the lock when a mutation throws', async () => {
    const log: string[] = [];
    const failing = withMutationLock('local', '/repo/.git', () => {
      log.push('failing');
      return Promise.reject(new Error('boom'));
    });

    await expect(failing).rejects.toThrow('boom');
    await withMutationLock('local', '/repo/.git', () => {
      log.push('after');
      return Promise.resolve();
    });

    expect(log).toEqual(['failing', 'after']);
  });
});
