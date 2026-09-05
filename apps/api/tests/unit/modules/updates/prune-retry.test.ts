import { describe, expect, it } from 'bun:test';
import { shouldRetryPrune } from '../../../../src/modules/updates/domain/prune-retry';

describe('shouldRetryPrune', () => {
  it('retries on Windows when a prune left versions pending', () => {
    expect(shouldRetryPrune({ platform: 'win32', prunePending: ['0.4.0'] })).toBe(true);
  });

  it('does not retry on Windows when nothing is pending', () => {
    expect(shouldRetryPrune({ platform: 'win32', prunePending: [] })).toBe(false);
  });

  it('does not retry on Windows when prunePending is absent entirely', () => {
    expect(shouldRetryPrune({ platform: 'win32', prunePending: undefined })).toBe(false);
  });

  it('never retries on POSIX, pending or not — a POSIX prune never leaves one', () => {
    expect(shouldRetryPrune({ platform: 'linux', prunePending: ['0.4.0'] })).toBe(false);
  });
});
