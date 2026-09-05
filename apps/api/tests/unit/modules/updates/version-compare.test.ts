import { describe, expect, it } from 'bun:test';
import { compareStableVersions } from '../../../../src/modules/updates/domain/version-compare';

describe('compareStableVersions', () => {
  it('reports a newer patch version', () => {
    expect(compareStableVersions('0.1.5', '0.1.4')).toBe(1);
  });

  it('reports an older patch version — the yanked-release case', () => {
    // Latest still says 0.1.4 after 0.1.5 was deleted from the release
    // index; this must not read as "0.1.4 is an update".
    expect(compareStableVersions('0.1.4', '0.1.5')).toBe(-1);
  });

  it('reports equal versions as equal', () => {
    expect(compareStableVersions('0.1.5', '0.1.5')).toBe(0);
  });

  it('compares numerically, not lexically', () => {
    expect(compareStableVersions('0.1.10', '0.1.9')).toBe(1);
  });

  it('ignores a leading v on either side', () => {
    expect(compareStableVersions('v0.1.5', '0.1.4')).toBe(1);
  });

  it('counts a same-root stable release as newer than its own prerelease', () => {
    expect(compareStableVersions('0.1.5', '0.1.5-canary.deadbee')).toBe(1);
    expect(compareStableVersions('0.1.5-canary.deadbee', '0.1.5')).toBe(-1);
  });
});
