/**
 * A Linux stand-in for the Windows pointer calls.
 *
 * Junctions do not exist here, so a directory symlink plays one and `rmdir`
 * unlinks it. What a test using this checks is the *sequence* of operations and
 * the paths they name — that a junction really behaves this way is what the
 * `windows-latest` lane in `.github/workflows/test.yml` proves.
 */

import { readlink, rename, symlink, unlink } from 'node:fs/promises';
import type { SlotPublishFs } from '../../../../src/services/slot-publish';

export interface RecordedSlotCall {
  readonly op: 'symlink' | 'rename' | 'unlink' | 'rmdir';
  readonly args: readonly (string | undefined)[];
}

export interface JunctionFs {
  readonly fs: SlotPublishFs;
  readonly calls: RecordedSlotCall[];
  /** Just the operation names, which is usually the whole assertion. */
  ops(): string[];
}

/**
 * // Usage: const pointer = junctionFs(); createRuntimeUpdateService({ slotPublish: { fs: pointer.fs } })
 *
 * `fail` makes one operation reject, so a test can drive the half-published
 * states only Windows can reach.
 */
export function junctionFs(
  fail: (call: RecordedSlotCall) => Error | null = () => null
): JunctionFs {
  const calls: RecordedSlotCall[] = [];
  const record = async <T>(
    op: RecordedSlotCall['op'],
    args: readonly (string | undefined)[],
    run: () => Promise<T>
  ): Promise<T> => {
    const call = { op, args };
    calls.push(call);
    const refusal = fail(call);
    if (refusal) throw refusal;
    return await run();
  };

  return {
    calls,
    ops: () => calls.map((call) => call.op),
    fs: {
      symlink: (target, path, type) =>
        record('symlink', [target, path, type], () => symlink(target, path)),
      rename: (from, to) => record('rename', [from, to], () => rename(from, to)),
      unlink: (path) => record('unlink', [path], () => unlink(path)),
      rmdir: (path) => record('rmdir', [path], () => unlink(path)),
      readlink: (path) => readlink(path),
    },
  };
}

/** The shape a Windows sharing violation arrives as. */
export function lockedError(): NodeJS.ErrnoException {
  return Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
}
