import { describe, expect, test } from 'bun:test';

import { pickPlatformBudgetMs } from '../lib/platform-budget';
import { stubProcessPlatform } from './support/process-platform';

const DEFAULT_MS = 10_000;
const WIN32_MS = 60_000;

describe('scripts/lib/platform-budget', () => {
  test('returns the Windows budget on win32', () => {
    const restore = stubProcessPlatform('win32');
    try {
      expect(pickPlatformBudgetMs(DEFAULT_MS, WIN32_MS)).toBe(WIN32_MS);
    } finally {
      restore();
    }
  });

  test.each(['linux', 'darwin', 'freebsd'] as const)('returns the default on %s', (platform) => {
    const restore = stubProcessPlatform(platform);
    try {
      expect(pickPlatformBudgetMs(DEFAULT_MS, WIN32_MS)).toBe(DEFAULT_MS);
    } finally {
      restore();
    }
  });
});

describe('scripts/tests/support/process-platform', () => {
  // `bun test scripts` runs the whole directory in one process, so anything this
  // helper leaves behind outlives the file that stubbed.
  test('puts the property back exactly as it found it', () => {
    const before = Object.getOwnPropertyDescriptor(process, 'platform');

    const restore = stubProcessPlatform('win32');
    expect(process.platform).toBe('win32');
    restore();

    expect(Object.getOwnPropertyDescriptor(process, 'platform')).toEqual(before);
  });
});
