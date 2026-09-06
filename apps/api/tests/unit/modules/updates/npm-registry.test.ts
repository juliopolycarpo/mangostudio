import { describe, expect, it } from 'bun:test';
import {
  canaryPrereleaseSha,
  fetchNpmPackument,
  findCanaryVersionForSha,
  npmPackageForPlatform,
  parseNpmPackument,
} from '../../../../src/modules/updates/infrastructure/npm-registry';
import { FakeReleaseHost } from './support/fake-release-host';

const PACKUMENT_FIXTURE = JSON.stringify({
  name: '@mangostudio/cli-linux-x64',
  versions: {
    '0.1.1-canary.g0123456': { dist: { tarball: 'https://registry.npmjs.org/t/-/t-0.1.1.tgz' } },
    '0.1.1-canary.abc1234': { dist: { tarball: 'https://registry.npmjs.org/t/-/t-0.1.1.tgz' } },
  },
});

describe('npmPackageForPlatform', () => {
  it('maps every non-musl release platform to its npm optional-dependency package', () => {
    expect(npmPackageForPlatform('linux-x64')).toBe('@mangostudio/cli-linux-x64');
    expect(npmPackageForPlatform('linux-arm64')).toBe('@mangostudio/cli-linux-arm64');
    expect(npmPackageForPlatform('darwin-x64')).toBe('@mangostudio/cli-darwin-x64');
    expect(npmPackageForPlatform('darwin-arm64')).toBe('@mangostudio/cli-darwin-arm64');
    expect(npmPackageForPlatform('windows-x64')).toBe('@mangostudio/cli-win32-x64');
    expect(npmPackageForPlatform('windows-arm64')).toBe('@mangostudio/cli-win32-arm64');
  });

  it('has no npm package for a musl target', () => {
    expect(npmPackageForPlatform('linux-x64-musl')).toBeNull();
    expect(npmPackageForPlatform('linux-arm64-musl')).toBeNull();
  });
});

describe('canaryPrereleaseSha', () => {
  it('reads a git-describe-style g-prefixed identifier', () => {
    expect(canaryPrereleaseSha('0.1.1-canary.g0123456')).toBe('0123456');
  });

  it('reads a bare hex identifier', () => {
    expect(canaryPrereleaseSha('0.1.1-canary.abc1234')).toBe('abc1234');
  });

  it('returns null for a version with no canary identifier', () => {
    expect(canaryPrereleaseSha('0.1.1')).toBeNull();
  });
});

describe('findCanaryVersionForSha', () => {
  const packument = parseNpmPackument(PACKUMENT_FIXTURE);
  if (!packument) throw new Error('fixture must parse');

  it('finds the g-prefixed key from a bare 7-char sha', () => {
    expect(findCanaryVersionForSha(packument, '0123456')).toBe('0.1.1-canary.g0123456');
  });

  it('finds the bare-hex key from a longer sha sharing its first 7 characters', () => {
    expect(findCanaryVersionForSha(packument, 'abc1234def')).toBe('0.1.1-canary.abc1234');
  });

  it('returns null when no published version matches', () => {
    expect(findCanaryVersionForSha(packument, 'deadbee')).toBeNull();
  });
});

describe('fetchNpmPackument', () => {
  it('requests the abbreviated packument with the scope slash encoded, @ kept literal', async () => {
    const host = new FakeReleaseHost({
      'https://registry.npmjs.org/@mangostudio%2Fcli-linux-x64': { body: PACKUMENT_FIXTURE },
    });

    const packument = await fetchNpmPackument('@mangostudio/cli-linux-x64', {
      fetch: host.fetch,
      resolveHostname: host.resolveHostname,
    });

    expect(packument.name).toBe('@mangostudio/cli-linux-x64');
    expect(Object.keys(packument.versions)).toHaveLength(2);
    expect(host.calls).toEqual(['https://registry.npmjs.org/@mangostudio%2Fcli-linux-x64']);
  });

  it('throws when the registry does not answer with a packument', async () => {
    const host = new FakeReleaseHost({
      'https://registry.npmjs.org/@mangostudio%2Fcli-linux-x64': { status: 404, body: 'Not Found' },
    });

    await expect(
      fetchNpmPackument('@mangostudio/cli-linux-x64', {
        fetch: host.fetch,
        resolveHostname: host.resolveHostname,
      })
    ).rejects.toThrow();
  });
});
