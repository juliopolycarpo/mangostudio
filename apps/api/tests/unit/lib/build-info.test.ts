import { describe, expect, it } from 'bun:test';
import {
  type BuildInfoDeps,
  getCurrentCheckoutBuildInfo,
  resolveBuildInfo,
} from '../../../src/lib/build-info';

function gitFrom(values: Record<string, string | Error>): BuildInfoDeps['runGit'] {
  return (args) => {
    const key = args.join(' ');
    const value = values[key];
    if (value instanceof Error) {
      throw value;
    }
    if (value === undefined) {
      throw new Error(`unexpected git command: ${key}`);
    }
    return value;
  };
}

describe('build-info', () => {
  it('uses compile-time build metadata when present', () => {
    const info = resolveBuildInfo({
      env: {
        BUILD_GIT_SHA: 'abc123',
        BUILD_GIT_DIRTY: 'true',
        BUILD_BUILT_AT: '2026-07-04T12:00:00.000Z',
        BUILD_TYPE: 'production',
      },
      runGit: () => {
        throw new Error('git should not be probed for stamped builds');
      },
    });

    expect(info).toEqual({
      gitSha: 'abc123',
      gitDirty: true,
      builtAt: '2026-07-04T12:00:00.000Z',
      buildType: 'production',
    });
  });

  it('falls back to unknown dev metadata when git is unavailable', () => {
    const info = resolveBuildInfo({
      env: {},
      runGit: () => {
        throw new Error('git unavailable');
      },
    });

    expect(info).toEqual({
      gitSha: 'unknown',
      gitDirty: 'unknown',
      builtAt: 'dev',
      buildType: 'dev',
    });
  });

  it('reports checkout dirtiness from git status', () => {
    const info = getCurrentCheckoutBuildInfo({
      runGit: gitFrom({
        'rev-parse --short=12 HEAD': 'abcdef123456\n',
        'status --porcelain': ' M apps/api/src/lib/build-info.ts\n',
      }),
    });

    expect(info).toEqual({
      gitSha: 'abcdef123456',
      gitDirty: true,
      builtAt: 'dev',
      buildType: 'dev',
    });
  });
});
