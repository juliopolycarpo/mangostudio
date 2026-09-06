import { describe, expect, test } from 'bun:test';
import {
  parseReleasePlatformId,
  RELEASE_PLATFORM_IDS,
  resolveBuildPlatformId,
} from '../../../../src/modules/updates/domain/platform-id';

describe('parseReleasePlatformId', () => {
  test('accepts every id in the frozen release platform list', () => {
    for (const id of RELEASE_PLATFORM_IDS) {
      expect(parseReleasePlatformId(id)).toBe(id);
    }
  });

  test('rejects a string that is not a release platform id', () => {
    expect(parseReleasePlatformId('linux-x86')).toBeNull();
  });
});

describe('resolveBuildPlatformId', () => {
  test('trusts a valid baked BUILD_PLATFORM_ID over the host guess', () => {
    const resolved = resolveBuildPlatformId(
      { BUILD_PLATFORM_ID: 'linux-x64-musl' },
      { platform: 'darwin', arch: 'arm64' }
    );

    expect(resolved).toBe('linux-x64-musl');
  });

  test('falls back to a host guess when no id was baked in', () => {
    const resolved = resolveBuildPlatformId({}, { platform: 'darwin', arch: 'arm64' });

    expect(resolved).toBe('darwin-arm64');
  });

  test('falls back to a host guess when the baked value is not a release platform id', () => {
    const resolved = resolveBuildPlatformId(
      { BUILD_PLATFORM_ID: 'not-a-real-target' },
      { platform: 'win32', arch: 'x64' }
    );

    expect(resolved).toBe('windows-x64');
  });

  test('guesses glibc, never musl, since a checkout cannot detect it at runtime', () => {
    const resolved = resolveBuildPlatformId({}, { platform: 'linux', arch: 'x64' });

    expect(resolved).toBe('linux-x64');
  });

  test('guesses x64 for an unrecognised host arch rather than refusing to answer', () => {
    const resolved = resolveBuildPlatformId({}, { platform: 'linux', arch: 'ia32' });

    expect(resolved).toBe('linux-x64');
  });
});
