import { describe, expect, it } from 'bun:test';

import {
  SNAPSHOT_INLINE_MAX_BYTES,
  SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS,
  SNAPSHOT_MESSAGE_STAGED_MAX_BYTES,
} from '@mangostudio/shared/runtime-contract';

import { stagedCaptureLimit } from '../../../../src/modules/file-checkpoints/application/staged-capture-limit';

const MIB = 1024 * 1024;
const PER_FILE_LIMIT = 128 * MIB;

describe('stagedCaptureLimit', () => {
  it('allows the per-file limit while the message has budget to spare', () => {
    expect(stagedCaptureLimit(PER_FILE_LIMIT, { blobs: 0, bytes: 0 })).toBe(PER_FILE_LIMIT);
  });

  it('shrinks to the bytes the message has left', () => {
    const used = SNAPSHOT_MESSAGE_STAGED_MAX_BYTES - 40 * MIB;

    expect(stagedCaptureLimit(PER_FILE_LIMIT, { blobs: 8, bytes: used })).toBe(40 * MIB);
  });

  it('allows a file that exactly fills the remaining bytes', () => {
    const used = SNAPSHOT_MESSAGE_STAGED_MAX_BYTES - PER_FILE_LIMIT;

    expect(stagedCaptureLimit(PER_FILE_LIMIT, { blobs: 7, bytes: used })).toBe(PER_FILE_LIMIT);
  });

  it('falls back to inline size once the bytes are spent', () => {
    expect(
      stagedCaptureLimit(PER_FILE_LIMIT, { blobs: 8, bytes: SNAPSHOT_MESSAGE_STAGED_MAX_BYTES })
    ).toBe(SNAPSHOT_INLINE_MAX_BYTES);
  });

  it('falls back to inline size when less than inline size is left', () => {
    const used = SNAPSHOT_MESSAGE_STAGED_MAX_BYTES - 100;

    expect(stagedCaptureLimit(PER_FILE_LIMIT, { blobs: 8, bytes: used })).toBe(
      SNAPSHOT_INLINE_MAX_BYTES
    );
  });

  it('falls back to inline size once the message holds its blob count, bytes to spare', () => {
    expect(
      stagedCaptureLimit(PER_FILE_LIMIT, { blobs: SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS, bytes: 0 })
    ).toBe(SNAPSHOT_INLINE_MAX_BYTES);
  });

  it('allows one more blob while it is under the count', () => {
    expect(
      stagedCaptureLimit(PER_FILE_LIMIT, { blobs: SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS - 1, bytes: 0 })
    ).toBe(PER_FILE_LIMIT);
  });

  it('never raises the limit above what the user configured', () => {
    expect(stagedCaptureLimit(512 * 1024, { blobs: 0, bytes: 0 })).toBe(512 * 1024);
    expect(
      stagedCaptureLimit(512 * 1024, { blobs: SNAPSHOT_MESSAGE_STAGED_MAX_BLOBS, bytes: 0 })
    ).toBe(512 * 1024);
  });
});
