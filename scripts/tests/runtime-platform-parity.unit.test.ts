import { describe, expect, it } from 'bun:test';
import { RUNTIME_PLATFORM_IDS } from '../../apps/shared/src/runtime-home/platform';
import { ALL_BINARY_TARGETS } from '../lib/release-targets';

describe('runtime platform parity', () => {
  it('pins every RuntimePlatformId to an ALL_BINARY_TARGETS arch (posix only)', () => {
    const arches = new Set(ALL_BINARY_TARGETS.map((target) => target.arch));
    for (const id of RUNTIME_PLATFORM_IDS) {
      expect(arches.has(id)).toBe(true);
    }
    // Windows targets exist in the release plan but are not push platforms.
    expect(arches.has('windows-x64')).toBe(true);
    expect(RUNTIME_PLATFORM_IDS.includes('windows-x64' as never)).toBe(false);
  });
});
