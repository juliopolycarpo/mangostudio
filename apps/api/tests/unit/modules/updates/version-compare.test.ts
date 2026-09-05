import { describe, expect, it } from 'bun:test';
import {
  compareStableVersions,
  isVersionShaped,
  sharesShaPrefix,
  stripLeadingV,
} from '../../../../src/modules/updates/domain/version-compare';

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

describe('isVersionShaped', () => {
  it('accepts release and prerelease versions, with or without a leading v', () => {
    expect(isVersionShaped('0.1.1')).toBe(true);
    expect(isVersionShaped('v0.1.1')).toBe(true);
    expect(isVersionShaped('0.1.1-canary.abc1234')).toBe(true);
  });

  it('rejects anything that is not a version', () => {
    expect(isVersionShaped('../../../../../evil')).toBe(false);
    expect(isVersionShaped('latest')).toBe(false);
    expect(isVersionShaped('0.1')).toBe(false);
  });
});

describe('stripLeadingV', () => {
  it("drops one leading v, matching install.sh's normalize_version", () => {
    expect(stripLeadingV('v0.1.1')).toBe('0.1.1');
    expect(stripLeadingV('0.1.1')).toBe('0.1.1');
  });

  it('leaves a v that is not the first character alone', () => {
    expect(stripLeadingV('0.1.1-canary.v123')).toBe('0.1.1-canary.v123');
  });
});

describe('sharesShaPrefix', () => {
  it('matches on the first seven characters, ignoring case and extra length', () => {
    expect(sharesShaPrefix('abc1234def567', 'ABC1234')).toBe(true);
  });

  it('refuses a sha too short to carry a seven-character prefix', () => {
    // A short value must not read as "the same commit" just because
    // everything it does have happens to line up.
    expect(sharesShaPrefix('abc12', 'abc1234')).toBe(false);
  });

  it('refuses shas that diverge inside the prefix', () => {
    expect(sharesShaPrefix('abc1234', 'abc1235')).toBe(false);
  });
});
